import { describe, expect, it, vi } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { validateWorkflowSource } from "@tedix/db/queries/cognitive/skill-validation";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import workflow from "./workflow";
const SUBSCRIPTION = "11111111-1111-4111-8111-111111111111";
function harness(
	outcome: "confirmed" | "partial" | "conflict" = "confirmed",
	state: "confirmed" | "uncertain" = "confirmed",
) {
	const call = vi.fn(async () => ({ outcome, mutations: [{ state }] }));
	const doStep = vi.fn(
		async (_name: string, _options: unknown, action: () => Promise<unknown>) =>
			action(),
	);
	return {
		call,
		doStep,
		env: { MCP: { os: { reconcile_calendar_subscription: call } } },
		step: { do: doStep } as Parameters<typeof workflow.run>[1],
	};
}
describe("calendar coordinator provider workflow", () => {
	it("admits the actual formatted asset through canonical write-time source validation", async () => {
		const [source, content] = await Promise.all([
			readFile(new URL("./workflow.ts", import.meta.url), "utf8"),
			readFile(new URL("../SKILL.md", import.meta.url), "utf8"),
		]);
		expect(
			validateWorkflowSource(
				source,
				"scripts/workflow.ts",
				parseCapabilityManifest(content),
			),
		).toEqual([]);
		const invalid = source.replace(
			"async run(event: CallbackEvent, step: Step, env: Environment)",
			"async run(event: CallbackEvent, step: Step, env: Environment,)",
		);
		expect(
			validateWorkflowSource(
				invalid,
				"scripts/workflow.ts",
				parseCapabilityManifest(content),
			).map((issue) => issue.code),
		).toContain("WORKFLOW_RUN_SIGNATURE_INVALID");
	});
	it("calls the exact persisted subscription once and returns only a bounded summary", async () => {
		const h = harness();
		const result = await workflow.run(
			{
				payload: {
					providerEvent: { subscriptionId: SUBSCRIPTION, skillRevision: 7 },
				},
			},
			h.step,
			h.env,
		);
		expect(h.call).toHaveBeenCalledExactlyOnceWith({
			subscriptionId: SUBSCRIPTION,
			expectedSkillRevision: 7,
		});
		expect(h.doStep.mock.calls[0]?.[1]).toEqual({
			retries: { limit: 0 },
			timeout: "5 minutes",
		});
		expect(result).toEqual({ outcome: "confirmed", confirmedChanges: 1 });
	});
	for (const providerEvent of [
		undefined,
		{ subscriptionId: "not-a-subscription", skillRevision: 1 },
		{ subscriptionId: SUBSCRIPTION, skillRevision: 0 },
		{ subscriptionId: SUBSCRIPTION, skillRevision: "1" },
		{ subscriptionId: SUBSCRIPTION, skillRevision: 1.2 },
	]) {
		it(`rejects invalid callback before effects: ${JSON.stringify(providerEvent)}`, async () => {
			const h = harness();
			await expect(
				workflow.run({ payload: { providerEvent } }, h.step, h.env),
			).rejects.toThrow("persisted provider subscription");
			expect(h.call).not.toHaveBeenCalled();
			expect(h.doStep).not.toHaveBeenCalled();
		});
	}
	for (const outcome of ["partial", "conflict"] as const) {
		it(`reports ${outcome} as needs attention without replaying writes`, async () => {
			const h = harness(outcome);
			await expect(
				workflow.run(
					{
						payload: {
							providerEvent: { subscriptionId: SUBSCRIPTION, skillRevision: 1 },
						},
					},
					h.step,
					h.env,
				),
			).rejects.toThrow("needs attention");
			expect(h.call).toHaveBeenCalledTimes(1);
		});
	}
	it("fails even a nominally confirmed receipt containing an uncertain effect", async () => {
		const h = harness("confirmed", "uncertain");
		await expect(
			workflow.run(
				{
					payload: {
						providerEvent: { subscriptionId: SUBSCRIPTION, skillRevision: 1 },
					},
				},
				h.step,
				h.env,
			),
		).rejects.toThrow("needs attention");
		expect(h.call).toHaveBeenCalledTimes(1);
	});
	it("propagates a provider failure without claiming success or retrying it", async () => {
		const h = harness();
		h.call.mockRejectedValueOnce(new Error("provider failed"));
		await expect(
			workflow.run(
				{
					payload: {
						providerEvent: { subscriptionId: SUBSCRIPTION, skillRevision: 1 },
					},
				},
				h.step,
				h.env,
			),
		).rejects.toThrow("provider failed");
		expect(h.call).toHaveBeenCalledTimes(1);
	});
});
