import type { DbQueryClient } from "@tedix/db/query-client";
import {
	ensureOsGadgetCodeBlob,
	getLegacyOsGadgetCode,
	getOsGadgetCodeMaxRowid,
	listLegacyOsGadgetCodeCandidates,
	osGadgetCodeBlobExists,
	osGadgetCodeSha256,
	referenceOsGadgetCodeBlob,
} from "@tedix/db/queries/os-workspaces/gadget-code";
import {
	D1ReadTimeoutError,
	isTransientD1ReadError,
} from "@tedix/db/utils/d1-retry";
import type { OutputBodyBucket } from "./os-output-revision-body-store";

/**
 * Backfill for app code rows written before files were shared: every such row
 * in `os_gadget_code` still holds a full copy of its files. For each one this
 * job computes the files' hash, makes sure the organization has that blob,
 * and then points the row at it and empties the inline copy.
 *
 * It never starts on its own. An operator arms it by writing the state object
 * (`GADGET_CODE_DEDUPE_STATE_KEY`) in the platform bucket with
 * `{"version":1,"mode":"dry_run"}` or `{"version":1,"mode":"apply"}`. Armed,
 * it runs on the two-minute tick, a few rows per tick, one statement at a
 * time, and stops the tick at the first database error. When the pass reaches
 * the newest row it writes a report and turns itself off; arm it again for
 * another pass. Setting `mode` to `"off"` stops it at the next tick, and the
 * cursor is kept, so arming it again resumes.
 *
 * A dry run reads and hashes the same rows but writes nothing to D1. Its
 * report says how many rows and bytes an apply pass would clear, how many
 * blobs it would add, and the difference: the bytes that become free.
 */

export const GADGET_CODE_DEDUPE_PREFIX = "os-gadget-code-dedupe/v1/";
export const GADGET_CODE_DEDUPE_STATE_KEY = `${GADGET_CODE_DEDUPE_PREFIX}state.json`;

export type GadgetCodeDedupeMode = "off" | "dry_run" | "apply";

export interface GadgetCodeDedupeTotals {
	/** Legacy rows looked at: rows that still held their files inline. */
	legacyRows: number;
	/** Bytes of inline files in those rows. */
	inlineBytes: number;
	/** Blobs added (apply) or that an apply pass would add (dry run). */
	blobsAdded: number;
	blobBytesAdded: number;
	/** Rows pointed at a blob and emptied (apply), or that would be (dry run). */
	rowsCleared: number;
	/** Inline bytes removed, before subtracting the blobs added. */
	bytesCleared: number;
}

export interface GadgetCodeDedupeState {
	version: 1;
	mode: GadgetCodeDedupeMode;
	/** Which mode the cursor and totals belong to; a mode change restarts. */
	passMode?: Exclude<GadgetCodeDedupeMode, "off">;
	cursor: number;
	totals: GadgetCodeDedupeTotals;
	/** Dry run only: blobs already counted as "would add" in this pass. */
	seen: string[];
	/** The row a tick last failed on, so a row that never works is skipped. */
	stuck?: { rowid: number; attempts: number };
	skipped: { revisionId: string; rowid: number; reason: string }[];
	updatedAt?: string;
	lastReportKey?: string;
}

export interface GadgetCodeDedupeLimits {
	/** Rows scanned per tick; bounds the read even when nothing is legacy. */
	windowRows: number;
	/** Legacy rows handled per tick. */
	maxRows: number;
	/** Inline bytes read per tick; the row that crosses it still completes. */
	maxBytes: number;
	/** Wall-clock budget; the row in flight still completes. */
	maxMs: number;
	/** Pause between two rows, so writes never arrive back to back. */
	rowPauseMs: number;
	/** Failed ticks on the same row before it is skipped and reported. */
	maxRowAttempts: number;
}

export const DEFAULT_GADGET_CODE_DEDUPE_LIMITS: GadgetCodeDedupeLimits = {
	windowRows: 500,
	maxRows: 20,
	maxBytes: 12 * 1024 * 1024,
	maxMs: 20_000,
	rowPauseMs: 250,
	maxRowAttempts: 3,
};

const EMPTY_TOTALS: GadgetCodeDedupeTotals = {
	legacyRows: 0,
	inlineBytes: 0,
	blobsAdded: 0,
	blobBytesAdded: 0,
	rowsCleared: 0,
	bytesCleared: 0,
};

function initialState(): GadgetCodeDedupeState {
	return {
		version: 1,
		mode: "off",
		cursor: 0,
		totals: { ...EMPTY_TOTALS },
		seen: [],
		skipped: [],
	};
}

export async function readGadgetCodeDedupeState(
	bucket: OutputBodyBucket,
): Promise<GadgetCodeDedupeState> {
	const object = await bucket.get(GADGET_CODE_DEDUPE_STATE_KEY);
	if (!object) return initialState();
	const parsed = JSON.parse(
		new TextDecoder().decode(await object.arrayBuffer()),
	) as Partial<GadgetCodeDedupeState>;
	if (
		parsed.version !== 1 ||
		!["off", "dry_run", "apply"].includes(parsed.mode as string) ||
		(parsed.cursor !== undefined && !Number.isSafeInteger(parsed.cursor))
	)
		throw new Error("Gadget code dedupe state is unreadable");
	return {
		...initialState(),
		...parsed,
		totals: { ...EMPTY_TOTALS, ...parsed.totals },
	} as GadgetCodeDedupeState;
}

async function writeJson(
	bucket: OutputBodyBucket,
	key: string,
	value: unknown,
) {
	await bucket.put(key, await new Blob([JSON.stringify(value)]).arrayBuffer());
}

export interface GadgetCodeDedupeTickResult {
	status: "off" | "swept" | "completed";
	mode: GadgetCodeDedupeMode;
	cursor: number;
	maxRowid: number;
	/** This tick only. */
	tick: GadgetCodeDedupeTotals;
	/** The whole pass so far. */
	pass: GadgetCodeDedupeTotals;
	/** `bytesCleared - blobBytesAdded` for the pass: what becomes free. */
	passBytesReclaimed: number;
	stoppedBy: "window" | "budget" | "database_busy" | "row_failed";
	skipped: GadgetCodeDedupeState["skipped"];
	reportKey: string | null;
}

function isBusy(error: unknown) {
	return error instanceof D1ReadTimeoutError || isTransientD1ReadError(error);
}

export async function runGadgetCodeDedupeTick(input: {
	db: DbQueryClient;
	bucket: OutputBodyBucket;
	now: Date;
	limits?: Partial<GadgetCodeDedupeLimits>;
}): Promise<GadgetCodeDedupeTickResult> {
	const { db, bucket } = input;
	const limits = { ...DEFAULT_GADGET_CODE_DEDUPE_LIMITS, ...input.limits };
	const startedAt = input.now.toISOString();
	const started = Date.now();
	const state = await readGadgetCodeDedupeState(bucket);
	const tick = { ...EMPTY_TOTALS };
	if (state.mode === "off")
		return {
			status: "off",
			mode: "off",
			cursor: state.cursor,
			maxRowid: 0,
			tick,
			pass: state.totals,
			passBytesReclaimed:
				state.totals.bytesCleared - state.totals.blobBytesAdded,
			stoppedBy: "window",
			skipped: state.skipped,
			reportKey: null,
		};
	const mode = state.mode;
	if (state.passMode !== mode) {
		// A new pass, or a switch between dry run and apply: start from the top.
		state.passMode = mode;
		state.cursor = 0;
		state.totals = { ...EMPTY_TOTALS };
		state.seen = [];
		state.skipped = [];
		delete state.stuck;
	}
	const seen = new Set(state.seen);
	let cursor = state.cursor;
	let maxRowid = cursor;
	let stoppedBy: GadgetCodeDedupeTickResult["stoppedBy"] = "window";

	let phase = "read";
	const handle = async (candidate: {
		rowid: number;
		revisionId: string;
	}): Promise<void> => {
		phase = "read";
		const row = await getLegacyOsGadgetCode(db, candidate);
		if (!row) return;
		const bytes = new TextEncoder().encode(row.files).byteLength;
		const sha256 = await osGadgetCodeSha256(row.files);
		const key = `${row.organizationId}:${sha256}`;
		const blob = { organizationId: row.organizationId, sha256 };
		tick.legacyRows++;
		tick.inlineBytes += bytes;
		const exists = seen.has(key) || (await osGadgetCodeBlobExists(db, blob));
		if (mode === "apply") {
			phase = "blob";
			if (!exists)
				await ensureOsGadgetCodeBlob(db, {
					...blob,
					files: row.files,
					codeLength: row.codeLength,
					createdAt: startedAt,
				});
			phase = "reference";
			if (
				!(await referenceOsGadgetCodeBlob(db, {
					...blob,
					revisionId: candidate.revisionId,
				}))
			)
				throw new Error("Gadget code row changed during backfill");
		}
		if (!exists) {
			// Later rows with the same files skip the lookup and the insert.
			seen.add(key);
			tick.blobsAdded++;
			tick.blobBytesAdded += bytes;
		}
		tick.rowsCleared++;
		tick.bytesCleared += bytes;
	};

	try {
		maxRowid = await getOsGadgetCodeMaxRowid(db);
		const through = Math.min(cursor + limits.windowRows, maxRowid);
		const candidates = await listLegacyOsGadgetCodeCandidates(db, {
			after: cursor,
			through,
			limit: limits.maxRows,
		});
		const windowEnd =
			candidates.length === limits.maxRows
				? candidates[candidates.length - 1]!.rowid
				: through;
		for (const [index, candidate] of candidates.entries()) {
			if (
				index > 0 &&
				(tick.inlineBytes >= limits.maxBytes ||
					Date.now() - started >= limits.maxMs)
			) {
				stoppedBy = "budget";
				break;
			}
			if (index > 0 && limits.rowPauseMs > 0)
				await new Promise((resolve) => setTimeout(resolve, limits.rowPauseMs));
			try {
				await handle(candidate);
				delete state.stuck;
			} catch (error) {
				if (isBusy(error)) {
					stoppedBy = "database_busy";
					break;
				}
				const attempts =
					(state.stuck?.rowid === candidate.rowid ? state.stuck.attempts : 0) +
					1;
				if (attempts < limits.maxRowAttempts) {
					// Stop here; the next tick tries this row again.
					state.stuck = { rowid: candidate.rowid, attempts };
					stoppedBy = "row_failed";
					break;
				}
				// Driver errors can carry file text; the report keeps a code only.
				state.skipped.push({
					revisionId: candidate.revisionId,
					rowid: candidate.rowid,
					reason: `${phase}_failed`,
				});
				delete state.stuck;
			}
			cursor = candidate.rowid;
		}
		if (stoppedBy === "window") cursor = windowEnd;
	} catch (error) {
		if (!isBusy(error)) throw error;
		stoppedBy = "database_busy";
	}

	for (const field of Object.keys(tick) as (keyof GadgetCodeDedupeTotals)[])
		state.totals[field] += tick[field];
	state.cursor = cursor;
	state.seen = mode === "dry_run" ? [...seen] : [];
	state.updatedAt = startedAt;
	const passBytesReclaimed =
		state.totals.bytesCleared - state.totals.blobBytesAdded;
	const completed = stoppedBy === "window" && cursor >= maxRowid;
	let reportKey: string | null = null;
	if (completed) {
		reportKey = `${GADGET_CODE_DEDUPE_PREFIX}reports/${startedAt}-${mode}.json`;
		await writeJson(bucket, reportKey, {
			version: 1,
			mode,
			completedAt: startedAt,
			maxRowid,
			...state.totals,
			bytesReclaimed: passBytesReclaimed,
			skipped: state.skipped,
		});
		state.lastReportKey = reportKey;
		state.mode = "off";
		delete state.passMode;
		state.cursor = 0;
		state.seen = [];
	}
	const pass = { ...state.totals };
	const skipped = [...state.skipped];
	await writeJson(bucket, GADGET_CODE_DEDUPE_STATE_KEY, state);
	return {
		status: completed ? "completed" : "swept",
		mode,
		cursor,
		maxRowid,
		tick,
		pass,
		passBytesReclaimed,
		stoppedBy,
		skipped,
		reportKey,
	};
}
