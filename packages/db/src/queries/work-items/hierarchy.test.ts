import { describe, expect, it } from "vite-plus/test";
import { computeWorkItemRollupTotals } from "./hierarchy";

describe("computeWorkItemRollupTotals", () => {
	it("returns an honest empty rollup", () => {
		expect(computeWorkItemRollupTotals([])).toEqual({
			total: 0,
			byDisposition: {},
			byWorkKind: {},
			percentDone: 0,
			aggregateDisposition: "empty",
			distinctExecutors: [],
		});
	});

	it.each([
		["proposed", "proposed"],
		["accepted", "accepted"],
		["completed", "completed"],
		["cancelled", "cancelled"],
	] as const)(
		"maps a sole %s item to %s aggregate disposition",
		(status, expected) => {
			expect(
				computeWorkItemRollupTotals([
					{ workKind: "coding", disposition: status },
				]).aggregateDisposition,
			).toBe(expected);
		},
	);

	it("keeps specification acceptance independent from completion", () => {
		const result = computeWorkItemRollupTotals([
			{ workKind: "coding", disposition: "completed" },
			{ workKind: "research", disposition: "accepted" },
		]);
		expect(result.aggregateDisposition).toBe("accepted");
		expect(result.percentDone).toBe(0.5);
	});

	it("gives proposed specifications precedence over accepted work", () => {
		const result = computeWorkItemRollupTotals([
			{ workKind: "document", disposition: "accepted" },
			{ workKind: "design", disposition: "proposed" },
		]);
		expect(result.aggregateDisposition).toBe("proposed");
	});

	it("excludes cancelled work from the completion denominator", () => {
		const result = computeWorkItemRollupTotals([
			{ workKind: "coding", disposition: "completed" },
			{ workKind: "coding", disposition: "cancelled" },
		]);
		expect(result.percentDone).toBe(1);
	});

	it("reports zero completion when every item is cancelled", () => {
		const result = computeWorkItemRollupTotals([
			{ workKind: "operations", disposition: "cancelled" },
			{ workKind: "research", disposition: "cancelled" },
		]);
		expect(result.percentDone).toBe(0);
		expect(result.aggregateDisposition).toBe("cancelled");
	});

	it("counts artifact-neutral work kinds independently", () => {
		const result = computeWorkItemRollupTotals([
			{ workKind: "coding", disposition: "completed" },
			{ workKind: "coding", disposition: "accepted" },
			{ workKind: "communication", disposition: "proposed" },
		]);
		expect(result.byWorkKind).toEqual({ coding: 2, communication: 1 });
		expect(result.byDisposition).toEqual({
			completed: 1,
			accepted: 1,
			proposed: 1,
		});
	});
});
