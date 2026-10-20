import { describe, it, expect } from "vite-plus/test";
import { MetricTileSchema } from "./metric-tile";

describe("MetricTile contract", () => {
	it("accepts a measured tile only when value, window and source are all present", () => {
		const measured = {
			state: "measured",
			label: "Runs settled",
			value: "42",
			window: "last 7 days",
			source: "run ledger",
		} as const;
		expect(MetricTileSchema.safeParse(measured).success).toBe(true);
		// A value missing either half of its provenance is not a metric — the
		// contract refuses it rather than letting a bare number through.
		for (const dropped of ["window", "source", "value", "label"] as const) {
			const incomplete: Record<string, unknown> = { ...measured };
			delete incomplete[dropped];
			expect(MetricTileSchema.safeParse(incomplete).success).toBe(false);
		}
		expect(
			MetricTileSchema.safeParse({ ...measured, window: "" }).success,
		).toBe(false);
		expect(
			MetricTileSchema.safeParse({ ...measured, source: "" }).success,
		).toBe(false);
	});

	it("requires an empty tile to have a reason and setup path", () => {
		expect(
			MetricTileSchema.safeParse({
				state: "empty",
				label: "Delegation rate",
				emptyReason: "No decisions recorded yet",
			}).success,
		).toBe(false);
		expect(
			MetricTileSchema.safeParse({
				state: "empty",
				label: "Delegation rate",
				emptyReason: "No decisions recorded yet",
				setupHref: "/work/deck",
				setupLabel: "Open the deck",
			}).success,
		).toBe(true);
		// Empty without a reason is a silent zero by another name.
		expect(
			MetricTileSchema.safeParse({
				state: "empty",
				label: "Delegation rate",
			}).success,
		).toBe(false);
	});

	it("rejects unknown states, extra keys and a value smuggled onto empty", () => {
		expect(
			MetricTileSchema.safeParse({
				state: "loading",
				label: "Runs",
				value: "42",
				window: "today",
				source: "runs",
			}).success,
		).toBe(false);
		expect(
			MetricTileSchema.safeParse({
				state: "empty",
				label: "Runs",
				emptyReason: "Not measured yet",
				value: "0",
			}).success,
		).toBe(false);
	});
});
