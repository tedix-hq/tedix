import type { ToolSchemaSyncResult } from "@tedix/api-contract/contracts/tool-schema-sync";
import { describe, expect, it } from "vite-plus/test";
import {
	boundSyncItems,
	emptyBatchAggregate,
	mergeSyncBatchReport,
	remainingWriteBudget,
	splitIntoSyncBatches,
	syncBatchStepName,
	toBatchReport,
	TOOL_SCHEMA_SYNC_MAX_MESSAGE_LENGTH,
	TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS,
} from "./tool-schema-sync-batching";

type Item = ToolSchemaSyncResult["items"][number];

function item(overrides: Partial<Item> & { toolId: string }): Item {
	return {
		toolUuid: null,
		endpoint: `router/${overrides.toolId}`,
		status: "updated",
		changed: [],
		...overrides,
	};
}

function header() {
	return {
		appId: "app-1",
		mode: "projection" as const,
		source: "rpc" as const,
		target: "both" as const,
		apply: true,
		batchCount: 3,
		batchSize: 50,
	};
}

describe("splitIntoSyncBatches", () => {
	it("produces deterministic fixed-size slices that cover the work list exactly once", () => {
		const keys = Array.from({ length: 137 }, (_, index) => `endpoint/${index}`);
		const batches = splitIntoSyncBatches(keys, 50);
		expect(batches.map((batch) => batch.length)).toEqual([50, 50, 37]);
		expect(batches.flat()).toEqual(keys);
		expect(splitIntoSyncBatches(keys, 50)).toEqual(batches);
	});

	it("returns no batches for an empty work list", () => {
		expect(splitIntoSyncBatches([], 50)).toEqual([]);
	});

	it("rejects a non-positive or fractional batch size instead of looping forever", () => {
		expect(() => splitIntoSyncBatches(["a"], 0)).toThrow(/positive integer/);
		expect(() => splitIntoSyncBatches(["a"], -1)).toThrow(/positive integer/);
		expect(() => splitIntoSyncBatches(["a"], 1.5)).toThrow(/positive integer/);
	});
});

describe("syncBatchStepName", () => {
	it("is stable for the same batch members", () => {
		const members = ["a/one", "b/two", "c/three"];
		expect(syncBatchStepName(2, members)).toBe(syncBatchStepName(2, members));
		expect(syncBatchStepName(2, [...members])).toBe(
			syncBatchStepName(2, members),
		);
	});

	it("changes when the batch membership or order changes, so a retry cannot resume into a different set", () => {
		const members = ["a/one", "b/two"];
		expect(syncBatchStepName(0, members)).not.toBe(
			syncBatchStepName(0, ["a/one", "b/three"]),
		);
		expect(syncBatchStepName(0, members)).not.toBe(
			syncBatchStepName(0, ["b/two", "a/one"]),
		);
		expect(syncBatchStepName(0, members)).not.toBe(
			syncBatchStepName(1, members),
		);
	});
});

describe("boundSyncItems", () => {
	it("truncates an unbounded error message", () => {
		const bounded = boundSyncItems([
			item({ toolId: "x", status: "failed", message: "e".repeat(5000) }),
		]);
		expect(bounded.items[0]?.message?.length).toBe(
			TOOL_SCHEMA_SYNC_MAX_MESSAGE_LENGTH + 1,
		);
		expect(bounded.items[0]?.message?.endsWith("…")).toBe(true);
		expect(bounded.dropped).toBe(0);
	});

	it("caps the item count and reports how many were dropped", () => {
		const items = Array.from({ length: 250 }, (_, index) =>
			item({ toolId: `tool_${index}` }),
		);
		const bounded = boundSyncItems(items);
		expect(bounded.items).toHaveLength(TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS);
		expect(bounded.dropped).toBe(250 - TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS);
	});

	it("keeps diagnostic statuses over routine ones when it has to drop", () => {
		const routine = Array.from({ length: 150 }, (_, index) =>
			item({ toolId: `ok_${index}`, status: "updated" }),
		);
		const failures = Array.from({ length: 3 }, (_, index) =>
			item({ toolId: `bad_${index}`, status: "failed", message: "boom" }),
		);
		const bounded = boundSyncItems([...routine, ...failures]);
		expect(
			bounded.items.filter((entry) => entry.status === "failed"),
		).toHaveLength(3);
	});

	it("keeps a whole-surface failure report inside the per-step persisted-state ceiling", () => {
		// The failure mode this guards: every endpoint fails with a multi-kilobyte
		// D1 message, the step succeeds, and its return value is then rejected on
		// persist — losing the batch's work behind an unrelated error.
		const items = Array.from({ length: 835 }, (_, index) =>
			item({
				toolId: `tool_${index}`,
				status: "failed",
				message: "D1_ERROR: something went very wrong ".repeat(60),
			}),
		);
		const bounded = boundSyncItems(items);
		expect(JSON.stringify(bounded.items).length).toBeLessThan(64 * 1024);
	});
});

describe("aggregate folding", () => {
	function report(overrides: Partial<ToolSchemaSyncResult> = {}) {
		return toBatchReport({
			appId: "app-1",
			mode: "projection",
			source: "rpc",
			target: "both",
			apply: true,
			total: 50,
			planned: 10,
			created: 4,
			updated: 6,
			deleted: 0,
			inSync: 40,
			skipped: 0,
			failed: 0,
			items: [],
			...overrides,
		} as ToolSchemaSyncResult);
	}

	it("sums every counter across batches", () => {
		let aggregate = emptyBatchAggregate(header());
		aggregate = mergeSyncBatchReport(aggregate, report());
		aggregate = mergeSyncBatchReport(aggregate, report());
		aggregate = mergeSyncBatchReport(
			aggregate,
			report({ total: 37, planned: 1, created: 1, updated: 0, inSync: 36 }),
		);
		expect(aggregate.total).toBe(137);
		expect(aggregate.planned).toBe(21);
		expect(aggregate.created).toBe(9);
		expect(aggregate.updated).toBe(12);
		expect(aggregate.inSync).toBe(116);
		expect(aggregate.batchesCompleted).toBe(3);
	});

	it("keeps the aggregate item sample bounded no matter how many batches fail", () => {
		let aggregate = emptyBatchAggregate(header());
		for (let batch = 0; batch < 20; batch++) {
			aggregate = mergeSyncBatchReport(
				aggregate,
				report({
					failed: 50,
					inSync: 0,
					planned: 50,
					items: Array.from({ length: 50 }, (_, index) =>
						item({
							toolId: `tool_${batch}_${index}`,
							status: "failed",
							message: "x".repeat(4000),
						}),
					),
				}),
			);
		}
		expect(aggregate.failed).toBe(1000);
		expect(aggregate.items.length).toBeLessThanOrEqual(
			TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS,
		);
		expect(aggregate.itemsTruncated).toBe(
			1000 - TOOL_SCHEMA_SYNC_MAX_REPORTED_ITEMS,
		);
		expect(JSON.stringify(aggregate).length).toBeLessThan(64 * 1024);
	});

	it("serializes every counter ahead of the item sample for the deploy waiter", () => {
		// scripts/ci/wait-for-tool-schema-workflow.sh greps `"failed":0` out of a
		// `wrangler workflows instances describe --truncate-output-limit 5000`
		// dump. Counters after `items` would silently break every green deploy.
		let aggregate = emptyBatchAggregate(header());
		aggregate = mergeSyncBatchReport(
			aggregate,
			report({
				items: Array.from({ length: 50 }, (_, index) =>
					item({ toolId: `tool_${index}` }),
				),
			}),
		);
		const json = JSON.stringify(aggregate);
		expect(json.indexOf('"failed":0')).toBeGreaterThan(-1);
		expect(json.indexOf('"failed":0')).toBeLessThan(5000);
		expect(json.indexOf('"failed":0')).toBeLessThan(json.indexOf('"items":'));
	});
});

describe("remainingWriteBudget", () => {
	it("passes through an absent limit", () => {
		expect(remainingWriteBudget(undefined, 12)).toBeUndefined();
	});

	it("spends one shared budget across batches instead of one per batch", () => {
		expect(remainingWriteBudget(25, 0)).toBe(25);
		expect(remainingWriteBudget(25, 10)).toBe(15);
		expect(remainingWriteBudget(25, 25)).toBe(0);
		expect(remainingWriteBudget(25, 40)).toBe(0);
	});
});
