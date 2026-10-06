import { describe, expect, it } from "vite-plus/test";
import { TenantBehavioralEvalRevisionSpecSchema } from "./tenant-behavioral-evals";
describe("tenant behavioral eval schemas", () => {
	it("accepts only the curated observe-only lane and assertions", () => {
		expect(
			TenantBehavioralEvalRevisionSpecSchema.parse({
				lane: "kernel_route_observe_v1",
				cases: [
					{
						id: "route",
						input: "Summarize this",
						assertions: [
							{ type: "route_is", expected: "answer" },
							{ type: "no_effects" },
						],
					},
				],
			}).cases,
		).toHaveLength(1);
		expect(() =>
			TenantBehavioralEvalRevisionSpecSchema.parse({
				lane: "ordinary",
				cases: [],
			}),
		).toThrow();
	});
	it("accepts soft assertions while preserving severity-free historical specs", () => {
		const spec = TenantBehavioralEvalRevisionSpecSchema.parse({
			lane: "kernel_route_observe_v1",
			cases: [
				{
					id: "route",
					input: "Summarize this",
					assertions: [
						{ type: "route_is", expected: "answer" },
						{ type: "no_effects", severity: "soft" },
					],
				},
			],
		});
		expect(spec.cases[0]?.assertions).toEqual([
			{ type: "route_is", expected: "answer" },
			{ type: "no_effects", severity: "soft" },
		]);
	});
	it("bounds and uniquely identifies cases", () => {
		const one = {
			id: "same",
			input: "x",
			assertions: [{ type: "no_effects" }],
		};
		expect(() =>
			TenantBehavioralEvalRevisionSpecSchema.parse({
				lane: "kernel_route_observe_v1",
				cases: [one, one],
			}),
		).toThrow("case ids must be unique");
		expect(() =>
			TenantBehavioralEvalRevisionSpecSchema.parse({
				lane: "kernel_route_observe_v1",
				cases: Array.from({ length: 21 }, (_, i) => ({
					...one,
					id: String(i),
				})),
			}),
		).toThrow();
	});
});
