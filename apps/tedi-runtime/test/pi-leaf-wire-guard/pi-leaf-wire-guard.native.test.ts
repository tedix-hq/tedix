import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, it, expect } from "vite-plus/test";
import type { AgentTediDO } from "./worker";
const binding = (
	env as unknown as { TEDI_AGENT: DurableObjectNamespace<AgentTediDO> }
).TEDI_AGENT;
describe("genuine registered leaf final wire", () => {
	for (const kind of ["conversation", "judge", "synthesis"] as const)
		for (const change of [
			"quarantine",
			"held",
			"owner",
			"storedOwner",
			"configuration",
			"preFactory",
			"preFactoryModel",
			"preFactoryMarkers",
			"preFactoryIdentity",
			"abort",
			"seal",
			"operationSeal",
			"input",
			"journal",
			"claim",
			"coherentIdentity",
			"generation",
			"markers",
			"positive",
			"retry",
		])
			it(`${kind} ${change} preserves original unknown facts`, async () => {
				const root = await getAgentByName(binding, crypto.randomUUID());
				await root.setup(kind);
				const result = await root.scenario(kind, change);
				expect(result.sends).toBe(
					change === "positive" || change === "retry" ? 1 : 0,
				);
				expect(result.bills).toBe(change.startsWith("preFactory") ? 0 : 1);
				expect(result.unknownPreserved).toBe(true);
				expect(result.receipts).toBe(0);
				if (result.signedOrigins.length) {
					expect(result.signedOrigins[0]!.kind).toBe("accepted_native");
					expect(result.signedOrigins[0]!.rootRun).not.toBe(
						result.signedOrigins[0]!.selectedRun,
					);
					expect(result.signedOrigins[0]!.rootGeneration).toBeGreaterThan(0);
				}
				if (change === "seal" || change === "operationSeal") {
					expect(result.error?.cause).toContain("permanently sealed");
					expect(result.claimStatus).toBe("running");
				}
				if (change === "retry")
					expect(result.error?.lastPhase).toBe("before_dispatch");
			});
	for (const change of ["quarantine", "positive"])
		it(`actual compaction model ${change} after billing`, async () => {
			const root = await getAgentByName(binding, crypto.randomUUID());
			await root.setup("conversation");
			const result = await root.scenario("conversation", change, true);
			expect(result.sends).toBe(change === "positive" ? 1 : 0);
			expect(result.bills).toBe(1);
			expect(result.unknownPreserved).toBe(true);
		});
	it("cold real registered leaf reconstructs the original journal and guard", async () => {
		const name = crypto.randomUUID();
		let root = await getAgentByName(binding, name);
		await root.setup("conversation");
		await abortAllDurableObjects();
		root = await getAgentByName(binding, name);
		const result = await root.scenario("conversation", "positive");
		expect(result.sends).toBe(1);
		expect(result.unknownPreserved).toBe(true);
		expect(result.acceptedRun).not.toBeNull();
	});
	for (const change of ["positive", "selected"])
		it(`genuine unselected generation zero ${change}`, async () => {
			const root = await getAgentByName(binding, crypto.randomUUID());
			await root.setup("conversation", false);
			const result = await root.scenario("conversation", change);
			expect(result.sends).toBe(change === "positive" ? 1 : 0);
			expect(result.acceptedRun).toBeNull();
			expect(result.signedOrigins[0]).toEqual({
				kind: "unselected_native",
				rootRun: null,
				selectedRun: null,
				rootGeneration: 0,
				selectedGeneration: 0,
			});
			expect(result.unknownPreserved).toBe(true);
		});
	it("historical Synthesis original without model pin is not promoted", async () => {
		const root = await getAgentByName(binding, crypto.randomUUID());
		await root.setup("synthesis", true, true);
		const result = await root.scenario("synthesis", "positive");
		expect(result.sends).toBe(0);
		expect(result.unknownPreserved).toBe(true);
	});
});

for (const kind of ["conversation", "judge", "synthesis"] as const) {
	it(`${kind} actual SDK retry cannot renew original logical capture deadline`, async () => {
		const root = await getAgentByName(binding, crypto.randomUUID());
		await root.setup(kind);
		const result = await root.scenario(kind, "logicalRetry");
		expect(result.sends).toBe(1);
		expect(result.bills).toBe(1);
		expect(result.error?.lastPhase).toBe("before_dispatch");
		expect(result.unknownPreserved).toBe(true);
		expect(result.executions).toHaveLength(1);
	});
	it(`${kind} distinct actual retries keep separate execution evidence after unknown 503`, async () => {
		const root = await getAgentByName(binding, crypto.randomUUID());
		await root.setup(kind);
		const result = await root.scenario(kind, "retryDistinct");
		expect(result.sends).toBe(2);
		expect(result.bills).toBe(2);
		expect(new Set(result.executions).size).toBe(2);
		expect(result.unknownPreserved).toBe(true);
	});
}
