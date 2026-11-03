import { describe, expect, it, vi } from "vite-plus/test";
import candidate from "@tedix/api-contract/assets/decision-cascade.v1.json";
import {
	DecisionCascadePolicySchema,
	readDecisionCascadePolicy,
	type CascadeReceipt,
} from "@tedix/api-contract/schemas/decision-cascade";
import {
	evaluateDecisionCascade,
	type CascadeAdapters,
	type CascadeDispatch,
	type CascadeInput,
	type CascadeResponse,
} from "./decision-cascade";

const policy = DecisionCascadePolicySchema.parse({
	...candidate,
	mode: "evaluate",
});
const input: CascadeInput = {
	request: "Does the exact revision have delivery evidence?",
	labels: ["SUPPORTED", "UNKNOWN"],
	evidence: [
		{
			id: "readback",
			revision: "2",
			excerpt: "Revision 2 delivered and acknowledged.",
		},
	],
	risky: false,
	reserved: false,
	synthesis: false,
};
const judgment = {
	label: "SUPPORTED",
	confidence: 0.95,
	citations: [{ id: "readback", revision: "2" }],
};
function harness(values: unknown[] = []) {
	let calls = 0;
	const dispatch = vi.fn(
		async (request: CascadeDispatch): Promise<CascadeResponse> => {
			const value = values[calls];
			calls++;
			return {
				status: "ok",
				value:
					value ??
					(request.tier === "judgment"
						? judgment
						: {
								...judgment,
								brief: "Revision 2 has matching delivery evidence.",
							}),
				receipt: receipt(request.model, `execution-${calls}`),
			};
		},
	);
	return {
		dispatch,
		validateCitations: vi.fn(() => true),
	} satisfies CascadeAdapters;
}
function receipt(model: string, id: string): CascadeReceipt {
	return {
		executionId: id,
		requestedModel: model,
		resolvedModel: model,
		latencyMs: 10,
		costMicros: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		usagePersisted: true,
	};
}

describe("decision cascade evaluation boundary", () => {
	it.each(["draftModelRef", "strongModelRef"])(
		"rejects Clef as prose in %s",
		(slot) => {
			expect(
				DecisionCascadePolicySchema.safeParse({
					...policy,
					[slot]: "workers-ai/@cf/cloudflare/clef-flash",
				}).success,
			).toBe(false);
		},
	);
	it("ships off; absent, invalid and rolled-back config never enables calls", async () => {
		const adapters = harness();
		expect(readDecisionCascadePolicy({})).toBeNull();
		expect(
			readDecisionCascadePolicy({
				decisionCascade: { ...candidate, mode: "enforce" },
			}),
		).toBeNull();
		expect(
			readDecisionCascadePolicy({
				decisionCascade: { ...candidate, version: 2 },
			}),
		).toBeNull();
		expect(
			readDecisionCascadePolicy({ decisionCascade: candidate }),
		).toBeNull();
		expect(
			(
				await evaluateDecisionCascade(
					DecisionCascadePolicySchema.parse(candidate),
					input,
					adapters,
				)
			).status,
		).toBe("off");
		expect(adapters.dispatch).not.toHaveBeenCalled();
	});
	it("uses configured judgment then drafting models and never grants authority", async () => {
		const adapters = harness();
		const result = await evaluateDecisionCascade(policy, input, adapters);
		expect(result).toMatchObject({
			status: "proposed",
			reason: "bounded_draft",
			authorized: false,
			policyRevision: "candidate-1",
		});
		expect(adapters.dispatch.mock.calls.map(([row]) => row.model)).toEqual([
			policy.judgmentModel,
			policy.draftModelRef,
		]);
		expect(result.receipts).toHaveLength(2);
	});
	it("uses K=3 distinct sends, perspectives and sample identities before drafting", async () => {
		const adapters = harness();
		const result = await evaluateDecisionCascade(
			policy,
			{ ...input, risky: true },
			adapters,
		);
		const samples = adapters.dispatch.mock.calls
			.slice(0, 3)
			.map(([row]) => row);
		expect(result.status).toBe("proposed");
		expect(result.receipts).toHaveLength(4);
		expect(new Set(samples.map((row) => row.sampleId)).size).toBe(3);
		expect(new Set(samples.map((row) => row.perspective)).size).toBe(3);
		expect(samples.every((row) => row.skipResponseCache)).toBe(true);
	});
	it("escalates disagreement instead of using a majority", async () => {
		const adapters = harness([
			judgment,
			{ ...judgment, label: "UNKNOWN" },
			judgment,
		]);
		const result = await evaluateDecisionCascade(
			policy,
			{ ...input, risky: true },
			adapters,
		);
		expect(result.reason).toBe("disagreement");
		expect(adapters.dispatch.mock.calls.map(([row]) => row.tier)).toEqual([
			"judgment",
			"judgment",
			"judgment",
			"strong",
		]);
	});
	it.each([
		{ ...judgment, confidence: 0.89 },
		{ ...judgment, label: "ABSTAIN" },
		{ ...judgment, brief: "Invented brief from a bounded judge" },
		{ ...judgment, citations: [] },
		{ ...judgment, citations: [{ id: "readback", revision: "1" }] },
		{ ...judgment, citations: [judgment.citations[0], judgment.citations[0]] },
	])(
		"escalates uncertain/abstained/malformed/unsupported judgment %#",
		async (value) => {
			const adapters = harness([value]);
			expect(
				(await evaluateDecisionCascade(policy, input, adapters)).reason,
			).toBe("uncertain_or_unavailable");
			expect(adapters.dispatch.mock.calls.map(([row]) => row.tier)).toEqual([
				"judgment",
				"strong",
			]);
		},
	);
	it("rejects citations that exist but do not support the claim", async () => {
		const adapters = harness();
		adapters.validateCitations.mockReturnValue(false);
		expect(
			(await evaluateDecisionCascade(policy, input, adapters)).status,
		).toBe("abstained");
	});
	it("uses the strong model directly for synthesis", async () => {
		const adapters = harness();
		expect(
			(
				await evaluateDecisionCascade(
					policy,
					{ ...input, synthesis: true },
					adapters,
				)
			).reason,
		).toBe("synthesis");
		expect(adapters.dispatch.mock.calls.map(([row]) => row.model)).toEqual([
			policy.strongModelRef,
		]);
	});
	it("reserved acts do not acquire approval through votes", async () => {
		const adapters = harness();
		expect(
			await evaluateDecisionCascade(
				policy,
				{ ...input, reserved: true, risky: true },
				adapters,
			),
		).toMatchObject({ status: "reserved", authorized: false, receipts: [] });
		expect(adapters.dispatch).not.toHaveBeenCalled();
	});
	it.each(["budget", "admission", "accounting"] as const)(
		"stops on %s without escalation",
		async (reason) => {
			const adapters = harness();
			adapters.dispatch.mockResolvedValueOnce({ status: "blocked", reason });
			expect(
				await evaluateDecisionCascade(policy, input, adapters),
			).toMatchObject({ status: "stopped", reason });
			expect(adapters.dispatch).toHaveBeenCalledTimes(1);
		},
	);
	it("a failed provider call retains paid usage before strong escalation", async () => {
		const adapters = harness();
		adapters.dispatch.mockResolvedValueOnce({
			status: "unavailable",
			receipt: receipt(policy.judgmentModel, "failed-paid-send"),
		});
		const result = await evaluateDecisionCascade(policy, input, adapters);
		expect(result.status).toBe("proposed");
		expect(result.receipts[0]?.executionId).toBe("failed-paid-send");
	});
	it("stops at the call limit even when stronger reasoning would help", async () => {
		const adapters = harness([{ ...judgment, confidence: 0.1 }]);
		expect(
			await evaluateDecisionCascade(
				{ ...policy, maxCalls: 1 },
				input,
				adapters,
			),
		).toMatchObject({ status: "stopped", reason: "call_budget" });
		expect(adapters.dispatch).toHaveBeenCalledTimes(1);
	});
	it.each(["usage", "resolved", "duplicate", "requested"])(
		"stops on broken %s attribution",
		async (kind) => {
			const adapters = harness();
			adapters.dispatch.mockImplementation(async (request) => ({
				status: "ok",
				value: judgment,
				receipt: {
					...receipt(
						request.model,
						kind === "duplicate" ? "same" : crypto.randomUUID(),
					),
					...(kind === "usage" ? { usagePersisted: false } : {}),
					...(kind === "resolved" ? { resolvedModel: null } : {}),
					...(kind === "requested" ? { requestedModel: "wrong" } : {}),
				},
			}));
			expect(
				(
					await evaluateDecisionCascade(
						policy,
						{ ...input, risky: true },
						adapters,
					)
				).status,
			).toBe("stopped");
		},
	);
	it("does not retry unknown exceptions which may be policy denials", async () => {
		const adapters = harness();
		adapters.dispatch.mockRejectedValueOnce(
			new Error("unknown admission result"),
		);
		expect(
			(await evaluateDecisionCascade(policy, input, adapters)).reason,
		).toBe("adapter_failure");
		expect(adapters.dispatch).toHaveBeenCalledTimes(1);
	});
});
