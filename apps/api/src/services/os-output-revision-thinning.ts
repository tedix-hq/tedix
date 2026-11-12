import { OS_OUTPUT_AUTOSAVE_NOTE } from "@tedix/api-contract/utils/os-output-limits";
import {
	deleteThinnedOutputRevisions,
	getOsOutputRevisionMaxRowid,
	listOutputThinningCandidates,
} from "@tedix/db/queries/os-workspaces/output-revision-thinning";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	D1ReadTimeoutError,
	isTransientD1ReadError,
} from "@tedix/db/utils/d1-retry";
import type { OutputBodyBucket } from "./os-output-revision-body-store";

/**
 * Thins editor auto-save revisions out of file history.
 *
 * An editor saves a moment after each pause in typing. Every one of those
 * revisions is kept for an hour. After that this job keeps one auto-save per
 * ten minutes per file and person and removes the rest, together with their
 * rows in the output index. What is always kept, and every reference that
 * protects a revision, is listed with the query that picks the candidates
 * (`listOutputThinningCandidates`).
 *
 * Stored bodies are not deleted here. They are shared by content inside an
 * organization, and the nightly body sweep (`runOutputRevisionBodyGc`)
 * already removes a body once no revision references it and it is a day old.
 * Stored images belong to the file and are not touched.
 *
 * It never starts on its own, because a deleted revision cannot be brought
 * back and two kinds of reference are not checked by the query: revision
 * numbers kept inside card-review feedback, and files that live in a
 * workspace's own store. An operator arms it by writing the state object
 * (`OUTPUT_THINNING_STATE_KEY`) in the platform bucket with
 * `{"version":1,"mode":"dry_run"}` or `{"version":1,"mode":"apply"}`. Armed,
 * it runs on the two-minute tick, a few revisions per tick, and stops the tick
 * when the database is busy. A dry run deletes nothing and reports what an
 * apply pass would remove. When a pass reaches the newest revision it writes
 * a report and, in dry-run mode, turns itself off. An apply pass starts over
 * after `passPauseMs`, so history keeps being thinned until the mode is set
 * to `"off"`.
 */

export const OUTPUT_THINNING_PREFIX = "os-output-revision-thinning/v1/";
export const OUTPUT_THINNING_STATE_KEY = `${OUTPUT_THINNING_PREFIX}state.json`;

export type OutputThinningMode = "off" | "dry_run" | "apply";

export interface OutputThinningTotals {
	/** Revisions removed (apply) or that an apply pass would remove (dry run). */
	revisions: number;
	/** Stored body bytes of those revisions; shared bodies count each time. */
	bytes: number;
	/** Distinct files those revisions belong to, counted per tick. */
	files: number;
}

export interface OutputThinningState {
	version: 1;
	mode: OutputThinningMode;
	/** Which mode the cursor and totals belong to; a mode change restarts. */
	passMode?: Exclude<OutputThinningMode, "off">;
	cursor: number;
	totals: OutputThinningTotals;
	/** Apply only: when the last pass finished; the next waits `passPauseMs`. */
	passCompletedAt?: string;
	updatedAt?: string;
	lastReportKey?: string;
}

export interface OutputThinningLimits {
	/** Revision rows scanned per tick. */
	windowRows: number;
	/** Revisions removed per tick, in one batch. */
	maxRows: number;
	/** Wall-clock budget per tick. */
	maxMs: number;
	/** Revisions younger than this are never removed. */
	keepAllMs: number;
	/** Apply only: pause between two passes over the table. */
	passPauseMs: number;
}

export const DEFAULT_OUTPUT_THINNING_LIMITS: OutputThinningLimits = {
	windowRows: 2_000,
	maxRows: 40,
	maxMs: 15_000,
	keepAllMs: 60 * 60_000,
	passPauseMs: 60 * 60_000,
};

const EMPTY_TOTALS: OutputThinningTotals = { revisions: 0, bytes: 0, files: 0 };

function initialState(): OutputThinningState {
	return { version: 1, mode: "off", cursor: 0, totals: { ...EMPTY_TOTALS } };
}

export async function readOutputThinningState(
	bucket: OutputBodyBucket,
): Promise<OutputThinningState> {
	const object = await bucket.get(OUTPUT_THINNING_STATE_KEY);
	if (!object) return initialState();
	const parsed = JSON.parse(
		new TextDecoder().decode(await object.arrayBuffer()),
	) as Partial<OutputThinningState>;
	if (
		parsed.version !== 1 ||
		!["off", "dry_run", "apply"].includes(parsed.mode as string) ||
		(parsed.cursor !== undefined && !Number.isSafeInteger(parsed.cursor))
	)
		throw new Error("Output revision thinning state is unreadable");
	return {
		...initialState(),
		...parsed,
		totals: { ...EMPTY_TOTALS, ...parsed.totals },
	} as OutputThinningState;
}

async function writeJson(
	bucket: OutputBodyBucket,
	key: string,
	value: unknown,
) {
	await bucket.put(key, await new Blob([JSON.stringify(value)]).arrayBuffer());
}

export interface OutputThinningTickResult {
	status: "off" | "waiting" | "swept" | "completed";
	mode: OutputThinningMode;
	cursor: number;
	maxRowid: number;
	/** This tick only. */
	tick: OutputThinningTotals;
	/** The whole pass so far. */
	pass: OutputThinningTotals;
	stoppedBy: "window" | "budget" | "database_busy";
	reportKey: string | null;
}

function isBusy(error: unknown) {
	return error instanceof D1ReadTimeoutError || isTransientD1ReadError(error);
}

export async function runOutputRevisionThinningTick(input: {
	db: DbQueryClient;
	bucket: OutputBodyBucket;
	now: Date;
	limits?: Partial<OutputThinningLimits>;
}): Promise<OutputThinningTickResult> {
	const { db, bucket } = input;
	const limits = { ...DEFAULT_OUTPUT_THINNING_LIMITS, ...input.limits };
	const startedAt = input.now.toISOString();
	const started = Date.now();
	const state = await readOutputThinningState(bucket);
	const tick = { ...EMPTY_TOTALS };
	const idle = (status: "off" | "waiting"): OutputThinningTickResult => ({
		status,
		mode: state.mode,
		cursor: state.cursor,
		maxRowid: 0,
		tick,
		pass: state.totals,
		stoppedBy: "window",
		reportKey: null,
	});
	if (state.mode === "off") return idle("off");
	const mode = state.mode;
	if (state.passMode !== mode) {
		// A new pass, or a switch between dry run and apply: start from the top.
		state.passMode = mode;
		state.cursor = 0;
		state.totals = { ...EMPTY_TOTALS };
		delete state.passCompletedAt;
	}
	if (
		state.passCompletedAt &&
		input.now.getTime() - Date.parse(state.passCompletedAt) < limits.passPauseMs
	)
		return idle("waiting");
	if (state.passCompletedAt) {
		delete state.passCompletedAt;
		state.cursor = 0;
		state.totals = { ...EMPTY_TOTALS };
	}

	let cursor = state.cursor;
	let maxRowid = cursor;
	let stoppedBy: OutputThinningTickResult["stoppedBy"] = "window";
	const olderThan = new Date(
		input.now.getTime() - limits.keepAllMs,
	).toISOString();
	try {
		maxRowid = await getOsOutputRevisionMaxRowid(db);
		// Each round looks at one window of rows and removes at most one batch.
		while (cursor < maxRowid) {
			if (Date.now() - started >= limits.maxMs) {
				stoppedBy = "budget";
				break;
			}
			const through = Math.min(cursor + limits.windowRows, maxRowid);
			const candidates = await listOutputThinningCandidates(db, {
				after: cursor,
				through,
				limit: limits.maxRows,
				olderThan,
				autosaveNote: OS_OUTPUT_AUTOSAVE_NOTE,
			});
			const removed =
				mode === "apply"
					? new Set(
							await deleteThinnedOutputRevisions(
								db,
								candidates.map((candidate) => candidate.revisionId),
							),
						)
					: null;
			const counted = candidates.filter(
				(candidate) => !removed || removed.has(candidate.revisionId),
			);
			tick.revisions += counted.length;
			tick.bytes += counted.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
			tick.files += new Set(counted.map((row) => row.outputId)).size;
			// A full batch may leave more candidates in this window.
			cursor =
				candidates.length === limits.maxRows
					? candidates[candidates.length - 1]!.rowid
					: through;
			// One batch of deletes per tick keeps the write load flat.
			if (mode === "apply" && candidates.length > 0 && cursor < maxRowid) {
				stoppedBy = "budget";
				break;
			}
		}
	} catch (error) {
		if (!isBusy(error)) throw error;
		stoppedBy = "database_busy";
	}

	for (const field of Object.keys(tick) as (keyof OutputThinningTotals)[])
		state.totals[field] += tick[field];
	state.cursor = cursor;
	state.updatedAt = startedAt;
	const completed = stoppedBy === "window" && cursor >= maxRowid;
	const pass = { ...state.totals };
	let reportKey: string | null = null;
	if (completed) {
		reportKey = `${OUTPUT_THINNING_PREFIX}reports/${startedAt}-${mode}.json`;
		await writeJson(bucket, reportKey, {
			version: 1,
			mode,
			completedAt: startedAt,
			maxRowid,
			keptYoungerThan: olderThan,
			...state.totals,
		});
		state.lastReportKey = reportKey;
		state.cursor = 0;
		if (mode === "dry_run") {
			state.mode = "off";
			delete state.passMode;
		} else state.passCompletedAt = startedAt;
	}
	await writeJson(bucket, OUTPUT_THINNING_STATE_KEY, state);
	return {
		status: completed ? "completed" : "swept",
		mode,
		cursor,
		maxRowid,
		tick,
		pass,
		stoppedBy,
		reportKey,
	};
}
