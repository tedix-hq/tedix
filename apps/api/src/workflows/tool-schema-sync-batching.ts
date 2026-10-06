/**
 * Batching, step naming, and bounded reporting for ToolSchemaSyncWorkflow.
 *
 * Kept free of contract, D1, and Workflow imports so the batch arithmetic is
 * testable on its own — the same split the repo already uses for
 * `tool-test-batching.ts` and `catalog-sync-files.ts`.
 */

import type { ToolSchemaSyncResult } from "@tedix/api-contract/contracts/tool-schema-sync";

type ToolSchemaSyncItem = ToolSchemaSyncResult["items"][number];

/**
 * Endpoints (or stored tool ids) per durable step.
 *
 * Sized off measured production behaviour, against two independent ceilings:
 *
 * 1. Memory. Generating JSON Schemas for the whole 835-endpoint surface in one
 *    allocation exhausted the Worker memory limit on three retries (instance
 *    e3c7100c-f3d9-48ad-abb6-4600526238ad); a nine-endpoint scoped run
 *    completed. Per-endpoint churn — `z.toJSONSchema`, its re-validation,
 *    four `stableStringify` diffs, and the projected-row `sha256` — is the
 *    dominant term and scales with batch size, so bounding the batch bounds the
 *    peak.
 * 2. Subrequests. `upsertTool` issues up to three D1 round trips per applied
 *    write (read by id → write → read back). Fifty endpoints is ~150
 *    subrequests per step, comfortably inside the 1000-per-invocation budget
 *    that the unbatched 800+ endpoint run blew through on its own.
 */
export const TOOL_SCHEMA_SYNC_BATCH_SIZE = 50;

/**
 * Hard cap on the items carried in a step return.
 *
 * Every `message` on an item is a raw error string, so a systemic failure (D1
 * rejecting every write, a bad migration) produces one unbounded message per
 * endpoint. At ~1.5 KB each that is >1 MB across the surface, which crosses the
 * per-step persisted-state ceiling — and a step whose *return value* is
 * rejected loses the work it just did, reported as an unrelated error.
 */
export const TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS = 100;

/** Per-item message cap. Enough to identify a failure class, never a payload. */
export const TOOL_SCHEMA_SYNC_MAX_MESSAGE_LENGTH = 200;

/**
 * Statuses worth a slot in a bounded report, most diagnostic first. Anything
 * not listed (inSync, created, updated, wouldCreate, wouldUpdate) is routine
 * and is represented by the counters, which are never truncated.
 */
const REPORT_PRIORITY: Record<string, number> = {
	failed: 0,
	converterUnsupported: 1,
	noContract: 2,
	skipped: 3,
	deleted: 4,
	wouldDelete: 5,
};

function reportPriority(item: ToolSchemaSyncItem): number {
	return REPORT_PRIORITY[item.status] ?? 100;
}

/**
 * Deterministic fixed-size slices of an already-ordered work list.
 *
 * The caller freezes the order (codepoint-sorted endpoint paths / tool ids), so
 * batch N holds the same members on every run of the same plan.
 */
export function splitIntoSyncBatches<T>(items: T[], size: number): T[][] {
	if (!Number.isSafeInteger(size) || size <= 0) {
		throw new Error(
			`Tool schema sync batch size must be a positive integer, received ${size}`,
		);
	}
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size));
	}
	return batches;
}

/**
 * FNV-1a over the batch members. Non-cryptographic on purpose: this only has to
 * change when the batch membership changes.
 */
function fingerprint(members: string[]): string {
	const text = members.join("\u0000");
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Durable step name for one batch.
 *
 * The step name is the engine's checkpoint key: a completed step replays from
 * its cached result instead of re-running, which is what makes a retry resume
 * at the first incomplete batch. The name therefore carries a fingerprint of
 * the batch's members, not just its index — if the contract surface changes
 * between runs, batch 7 becomes a different step rather than silently resuming
 * into a different set of endpoints.
 */
export function syncBatchStepName(index: number, members: string[]): string {
	return `project-batch-${index}-${fingerprint(members)}`;
}

export interface BoundedItems {
	items: ToolSchemaSyncItem[];
	dropped: number;
}

/**
 * Truncate messages and keep at most `cap` items, diagnostic statuses first.
 * Counters are the complete record; items are a bounded sample of it.
 */
export function boundSyncItems(
	items: ToolSchemaSyncItem[],
	cap: number = TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS,
): BoundedItems {
	const truncated = items.map((item) =>
		item.message !== undefined &&
		item.message.length > TOOL_SCHEMA_SYNC_MAX_MESSAGE_LENGTH
			? {
					...item,
					message: `${item.message.slice(
						0,
						TOOL_SCHEMA_SYNC_MAX_MESSAGE_LENGTH,
					)}…`,
				}
			: item,
	);
	if (truncated.length <= cap) return { items: truncated, dropped: 0 };
	const ranked = truncated
		.map((item, order) => ({ item, order }))
		.sort(
			(left, right) =>
				reportPriority(left.item) - reportPriority(right.item) ||
				left.order - right.order,
		);
	return {
		items: ranked.slice(0, cap).map((entry) => entry.item),
		dropped: truncated.length - cap,
	};
}

export interface ToolSchemaSyncBatchReport {
	total: number;
	planned: number;
	created: number;
	updated: number;
	deleted: number;
	inSync: number;
	skipped: number;
	failed: number;
	items: ToolSchemaSyncItem[];
	itemsTruncated: number;
}

export interface ToolSchemaSyncBatchAggregate extends ToolSchemaSyncBatchReport {
	appId: string;
	mode: "schema" | "projection";
	source: "rpc";
	target: "input" | "output" | "both";
	apply: boolean;
	batchCount: number;
	batchesCompleted: number;
	batchSize: number;
}

/**
 * Bound one batch's result before it becomes a persisted step return.
 */
export function toBatchReport(
	result: ToolSchemaSyncResult,
): ToolSchemaSyncBatchReport {
	const bounded = boundSyncItems(result.items);
	return {
		total: result.total,
		planned: result.planned,
		created: result.created,
		updated: result.updated,
		deleted: result.deleted,
		inSync: result.inSync,
		skipped: result.skipped,
		failed: result.failed,
		items: bounded.items,
		itemsTruncated: bounded.dropped,
	};
}

export function emptyBatchAggregate(header: {
	appId: string;
	mode: "schema" | "projection";
	source: "rpc";
	target: "input" | "output" | "both";
	apply: boolean;
	batchCount: number;
	batchSize: number;
}): ToolSchemaSyncBatchAggregate {
	// Counter order is load bearing: the deploy waiter greps `"failed":0` out of
	// a truncated `wrangler workflows instances describe` dump, so every counter
	// has to serialize ahead of the item sample.
	return {
		appId: header.appId,
		mode: header.mode,
		source: header.source,
		target: header.target,
		apply: header.apply,
		total: 0,
		planned: 0,
		created: 0,
		updated: 0,
		deleted: 0,
		inSync: 0,
		skipped: 0,
		failed: 0,
		batchCount: header.batchCount,
		batchesCompleted: 0,
		batchSize: header.batchSize,
		itemsTruncated: 0,
		items: [],
	};
}

/** Fold one bounded batch report into the running aggregate. */
export function mergeSyncBatchReport(
	aggregate: ToolSchemaSyncBatchAggregate,
	report: ToolSchemaSyncBatchReport,
): ToolSchemaSyncBatchAggregate {
	const bounded = boundSyncItems([...aggregate.items, ...report.items]);
	return {
		...aggregate,
		total: aggregate.total + report.total,
		planned: aggregate.planned + report.planned,
		created: aggregate.created + report.created,
		updated: aggregate.updated + report.updated,
		deleted: aggregate.deleted + report.deleted,
		inSync: aggregate.inSync + report.inSync,
		skipped: aggregate.skipped + report.skipped,
		failed: aggregate.failed + report.failed,
		batchesCompleted: aggregate.batchesCompleted + 1,
		itemsTruncated:
			aggregate.itemsTruncated + report.itemsTruncated + bounded.dropped,
		items: bounded.items,
	};
}

/**
 * Remaining write budget for the next batch when the caller set `limit`.
 *
 * `limit` bounds writes, never generation, so it is applied across batches
 * rather than per batch: without this, an N-batch run would apply up to
 * N × limit writes. Returns 0 once the budget is spent — the sync treats a
 * zero budget as "plan nothing", which reproduces the unbatched tail of
 * `skipped: Limit reached` items exactly.
 */
export function remainingWriteBudget(
	limit: number | undefined,
	plannedSoFar: number,
): number | undefined {
	if (limit === undefined) return undefined;
	return Math.max(0, limit - plannedSoFar);
}
