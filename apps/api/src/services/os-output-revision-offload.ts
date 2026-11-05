import type { DbQueryClient } from "@tedix/db/query-client";
import {
	clearOffloadedOutputBody,
	getInlineOutputBody,
	getInlineOutputBodySummary,
	getOutputRevisionMaxRowid,
	listInlineOutputBodyCandidates,
} from "@tedix/db/queries/os-workspaces/output-body-offload";
import {
	type OutputBodyBucket,
	storeOutputRevisionBody,
	verifyStoredOutputRevisionBody,
} from "./os-output-revision-body-store";

/**
 * Scheduled offload of inline output revision bodies from D1 to R2.
 *
 * Each tick walks one rowid window past a cursor kept in R2, and for every
 * row that still has an inline body: writes the gzip body object (idempotent
 * by digest), reads it back and compares every byte, then replaces the
 * inline body with `''` in one fenced UPDATE. A failure is recorded in the
 * tick receipt and skipped; the next pass over the table retries it. When the
 * cursor reaches the newest row the next pass starts from zero after a pause,
 * so rows inserted inline by any remaining legacy path are picked up too.
 *
 * Operator controls live in the state object, not in code: set `paused` to
 * true to stop clearing without a deploy.
 */

export const OUTPUT_BODY_OFFLOAD_PREFIX = "os-output-revision-offload/v1/";
export const OUTPUT_BODY_OFFLOAD_STATE_KEY = `${OUTPUT_BODY_OFFLOAD_PREFIX}state.json`;

export interface OutputBodyOffloadState {
	version: 1;
	cursor: number;
	passes: number;
	paused?: boolean;
	/** Set when a pass reaches the newest row; the next pass starts after `passPauseMs`. */
	passCompletedAt?: string;
	updatedAt?: string;
	totals: {
		rowsCleared: number;
		bytesCleared: number;
		failures: number;
	};
}

export interface OutputBodyOffloadLimits {
	/** Rows scanned per tick; bounds the D1 read even when nothing is inline. */
	windowRows: number;
	/** Inline rows moved per tick. */
	maxRows: number;
	/** Inline bytes moved per tick; the row that crosses it still completes. */
	maxBytes: number;
	/** Wall-clock budget; the rows in flight still complete. */
	maxMs: number;
	/** Rows moved at the same time within one tick. */
	concurrency: number;
	/** Idle time between two full passes over the table. */
	passPauseMs: number;
}

export const DEFAULT_OUTPUT_BODY_OFFLOAD_LIMITS: OutputBodyOffloadLimits = {
	windowRows: 500,
	maxRows: 160,
	maxBytes: 24 * 1024 * 1024,
	maxMs: 20_000,
	concurrency: 4,
	passPauseMs: 60 * 60 * 1000,
};

const INITIAL_STATE: OutputBodyOffloadState = {
	version: 1,
	cursor: 0,
	passes: 0,
	totals: { rowsCleared: 0, bytesCleared: 0, failures: 0 },
};

async function readState(
	bucket: OutputBodyBucket,
): Promise<OutputBodyOffloadState> {
	const object = await bucket.get(OUTPUT_BODY_OFFLOAD_STATE_KEY);
	if (!object) return structuredClone(INITIAL_STATE);
	const parsed = JSON.parse(
		new TextDecoder().decode(await object.arrayBuffer()),
	) as Partial<OutputBodyOffloadState>;
	if (parsed.version !== 1 || !Number.isSafeInteger(parsed.cursor))
		throw new Error("Output body offload state is unreadable");
	return {
		...structuredClone(INITIAL_STATE),
		...parsed,
		totals: { ...INITIAL_STATE.totals, ...parsed.totals },
	} as OutputBodyOffloadState;
}

async function writeJson(
	bucket: OutputBodyBucket,
	key: string,
	value: unknown,
) {
	await bucket.put(key, await new Blob([JSON.stringify(value)]).arrayBuffer());
}

export interface OutputBodyOffloadTickResult {
	status: "paused" | "idle" | "swept";
	cursor: number;
	maxRowid: number;
	passes: number;
	candidates: number;
	rowsCleared: number;
	bytesCleared: number;
	failures: { id: string; rowid: number; reason: string }[];
	receiptKey: string | null;
	summary: Awaited<ReturnType<typeof getInlineOutputBodySummary>> | null;
}

export async function runOutputRevisionBodyOffloadTick(input: {
	db: DbQueryClient;
	bucket: OutputBodyBucket;
	now: Date;
	limits?: Partial<OutputBodyOffloadLimits>;
}): Promise<OutputBodyOffloadTickResult> {
	const { db, bucket } = input;
	const limits = { ...DEFAULT_OUTPUT_BODY_OFFLOAD_LIMITS, ...input.limits };
	const startedAt = input.now.toISOString();
	const started = Date.now();
	const state = await readState(bucket);
	const maxRowid = await getOutputRevisionMaxRowid(db);
	const base = {
		passes: state.passes,
		candidates: 0,
		rowsCleared: 0,
		bytesCleared: 0,
		failures: [] as OutputBodyOffloadTickResult["failures"],
		receiptKey: null as string | null,
		summary: null as OutputBodyOffloadTickResult["summary"],
	};
	if (state.paused)
		return { ...base, status: "paused", cursor: state.cursor, maxRowid };
	let after = state.cursor;
	// A completed pass must rewind even if inserts have moved the table's tail.
	if (state.passCompletedAt || after >= maxRowid) {
		const completedAt = state.passCompletedAt
			? Date.parse(state.passCompletedAt)
			: 0;
		if (input.now.getTime() - completedAt < limits.passPauseMs)
			return { ...base, status: "idle", cursor: after, maxRowid };
		after = 0;
		delete state.passCompletedAt;
	}
	const through = Math.min(after + limits.windowRows, maxRowid);
	const candidates = await listInlineOutputBodyCandidates(db, {
		after,
		through,
		limit: limits.maxRows,
	});
	let cursor = candidates.length === limits.maxRows ? after : through;
	let bytesSeen = 0;
	const result = { ...base, candidates: candidates.length };
	const offloadOne = async (
		candidate: (typeof candidates)[number],
	): Promise<{ bytes: number } | { reason: string } | null> => {
		let phase = "read";
		try {
			const body = await getInlineOutputBody(db, candidate);
			if (!body || body.content === "") return null;
			if (body.organizationId !== candidate.organizationId)
				throw new Error("Output revision organization changed");
			phase = "store";
			const metadata = await storeOutputRevisionBody(
				bucket,
				body.organizationId,
				body.content,
			);
			phase = "pointer";
			if (
				(candidate.bodyR2Key && candidate.bodyR2Key !== metadata.bodyR2Key) ||
				(candidate.contentSha256 &&
					candidate.contentSha256 !== metadata.contentSha256) ||
				(candidate.contentBytes != null &&
					candidate.contentBytes !== metadata.contentBytes)
			)
				throw new Error("Output revision pointer disagrees with its body");
			phase = "verify";
			await verifyStoredOutputRevisionBody(
				bucket,
				body.organizationId,
				body.content,
				metadata,
			);
			phase = "clear";
			const changed = await clearOffloadedOutputBody(db, {
				...metadata,
				rowid: candidate.rowid,
				id: candidate.id,
				organizationId: body.organizationId,
			});
			if (changed.length !== 1)
				throw new Error("Output revision changed during offload");
			return { bytes: metadata.contentBytes };
		} catch (error) {
			// Driver errors can carry body text; receipts keep codes only.
			return {
				reason:
					error instanceof Error &&
					error.message === "Output revision body verification mismatch"
						? "body_mismatch"
						: `${phase}_failed`,
			};
		}
	};
	// Each row costs several sequential D1 and R2 round trips, so rows move a
	// few at a time; the budgets are checked before each group starts.
	let next = 0;
	while (next < candidates.length) {
		if (bytesSeen >= limits.maxBytes || Date.now() - started >= limits.maxMs) {
			// Budget spent: resume from the last row this tick looked at.
			cursor = candidates[next]!.rowid - 1;
			break;
		}
		const group: typeof candidates = [];
		while (
			next < candidates.length &&
			group.length < limits.concurrency &&
			bytesSeen < limits.maxBytes
		) {
			const candidate = candidates[next++]!;
			bytesSeen += candidate.inlineBytes;
			group.push(candidate);
		}
		const outcomes = await Promise.all(group.map(offloadOne));
		group.forEach((candidate, index) => {
			cursor = Math.max(cursor, candidate.rowid);
			const outcome = outcomes[index];
			if (!outcome) return;
			if ("reason" in outcome)
				result.failures.push({
					id: candidate.id,
					rowid: candidate.rowid,
					reason: outcome.reason,
				});
			else {
				result.rowsCleared++;
				result.bytesCleared += outcome.bytes;
			}
		});
	}
	if (cursor >= maxRowid) {
		state.passes++;
		state.passCompletedAt = startedAt;
		result.summary = await getInlineOutputBodySummary(db);
	}
	state.cursor = cursor;
	state.updatedAt = startedAt;
	state.totals.rowsCleared += result.rowsCleared;
	state.totals.bytesCleared += result.bytesCleared;
	state.totals.failures += result.failures.length;
	if (result.candidates > 0) {
		result.receiptKey = `${OUTPUT_BODY_OFFLOAD_PREFIX}receipts/${startedAt}-${crypto.randomUUID()}.json`;
		await writeJson(bucket, result.receiptKey, {
			version: 1,
			startedAt,
			finishedAt: new Date().toISOString(),
			after,
			through,
			cursor,
			maxRowid,
			candidates: result.candidates,
			rowsCleared: result.rowsCleared,
			bytesCleared: result.bytesCleared,
			failures: result.failures,
			summary: result.summary,
		});
	}
	await writeJson(bucket, OUTPUT_BODY_OFFLOAD_STATE_KEY, state);
	return {
		...result,
		status: "swept",
		cursor,
		maxRowid,
		passes: state.passes,
	};
}
