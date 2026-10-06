import { JevResponseError } from "@tedix/workers-ai/jev";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	buildJevRankingRequest,
	interpretJevRanking,
	createJevContextRanker,
	rerankContextCandidates,
} from "./jev-context-ranking";
const mocks = vi.hoisted(() => ({
	org: vi.fn(),
	call: vi.fn(),
	reserve: vi.fn(),
	rate: vi.fn(),
	price: vi.fn(),
	insert: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.org,
}));
vi.mock("@tedix/db/queries/tedi-usage", () => ({
	insertCallCosts: mocks.insert,
}));
vi.mock("@tedix/workers-ai/jev", () => ({
	callJev: mocks.call,
	JevResponseError: class extends Error {
		constructor(
			message: string,
			readonly usage?: { input_tokens: number; output_tokens: number },
		) {
			super(message);
		}
	},
}));
vi.mock("./billing-reservation", () => ({
	reserveKernelBilling: mocks.reserve,
}));
vi.mock("../../../services/provider-model-pricing", () => ({
	resolveProviderModelRate: mocks.rate,
	priceProviderUsage: mocks.price,
}));
const identity = {
	provider: "typesafe",
	requestModel: "jev-1.13.0",
	gatewayAccountId: null,
	gatewayId: null,
	providerOrigin: "https://api.typesafe.ai",
	providerResource: null,
	deployment: null,
	transportKind: "direct-https",
	apiKind: "typesafe-systemone",
};
const candidates = [
	{ id: "a", description: "Accounting" },
	{ id: "b", description: "Engineering" },
];
const input = { kind: "workflow" as const, query: "Fix code", candidates };
function ranker() {
	return createJevContextRanker(
		{} as never,
		{ DB: {} as never },
		{ organizationId: "org-1", executionAttempts: [] },
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.org.mockResolvedValue({
		metadata: {
			jev: { enabled: true, purposes: { contextRanking: { enabled: true } } },
		},
	});
	mocks.rate.mockResolvedValue({
		status: "resolved",
		rate: {
			id: "rate-1",
			inputMicrousdPerMillion: 42000,
			outputMicrousdPerMillion: 0,
			cacheReadMicrousdPerMillion: 0,
			cacheWriteMicrousdPerMillion: 0,
		},
	});
	mocks.price.mockResolvedValue({
		costUsd: 0.00001,
		rateVersionId: "rate-1",
		reason: null,
	});
	mocks.insert.mockResolvedValue([]);
	mocks.reserve.mockImplementation(async (_env, input) => {
		input.context.executionAttempts.push({
			identity,
			occurredAt: "2026-09-23T00:00:00Z",
			executionId: "exec-1",
		});
		return {
			...input.context,
			executionId: "exec-1",
			billingReservationId: "reservation-1",
		};
	});
	mocks.call.mockImplementation(async (client) => {
		await client.authorize({ execution: identity, body: "{}" });
		return {
			model: "jev-1.13.0",
			usage: { input_tokens: 100, output_tokens: 10 },
			answers: {
				which: {
					type: "choice",
					choice: "c1",
					probabilities: { c0: 0.1, c1: 0.9 },
					confidence: 0.2,
				},
				fits0: { type: "noul", noul: 0.1 },
				fits1: { type: "noul", noul: 0.9 },
			},
		};
	});
});
describe("Jev context selection boundary", () => {
	it("rejects invented, missing and duplicate candidate IDs", async () => {
		for (const ids of [["a", "foreign"], ["a"], ["a", "a"]])
			expect(
				await rerankContextCandidates(
					candidates,
					"query",
					"workflow",
					(x) => x,
					async () => ids,
				),
			).toBe(candidates);
	});
	it("retains lexical ordering on provider failure", async () => {
		expect(
			await rerankContextCandidates(
				candidates,
				"query",
				"workflow",
				(x) => x,
				async () => {
					throw new Error("offline");
				},
			),
		).toBe(candidates);
	});
	it("sends no request for explicit denial or malformed policy", async () => {
		for (const metadata of [
			{ jev: { enabled: false } },
			{ jev: { purposes: { contextRanking: { enabled: false } } } },
			{
				jev: {
					enabled: true,
					purposes: { contextRanking: { enabled: true, minConfidence: 0 } },
				},
			},
		]) {
			mocks.org.mockResolvedValue({ metadata });
			expect(await ranker()(input)).toBeNull();
		}
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.reserve).not.toHaveBeenCalled();
	});
	it("admits before sending and durably records actual usage before applying rank", async () => {
		expect(await ranker()(input)).toEqual(["b", "a"]);
		expect(mocks.reserve).toHaveBeenCalledOnce();
		expect(mocks.insert).toHaveBeenCalledWith(expect.anything(), [
			expect.objectContaining({
				orgId: "org-1",
				executionId: "exec-1",
				billingReservationId: "reservation-1",
				inputTokens: 100,
				outputTokens: 10,
				source: "provider-response:kernel:context-ranking",
			}),
		]);
	});
	it("records billed usage but abstains when no candidate applies", async () => {
		const original = mocks.call.getMockImplementation()!;
		mocks.call.mockImplementation(async (...args) => {
			const result = await original(...args);
			result.answers.fits1.noul = 0.2;
			return result;
		});
		expect(await ranker()(input)).toBeNull();
		expect(mocks.insert).toHaveBeenCalledOnce();
	});
	it("reuses exact candidate judgments across assembly passes", async () => {
		const run = ranker();
		await run(input);
		await run(input);
		expect(mocks.call).toHaveBeenCalledOnce();
	});
	it("retains ordering without paid send when pricing or admission is unavailable", async () => {
		mocks.rate.mockResolvedValue({ status: "unpriced" });
		expect(await ranker()(input)).toBeNull();
		expect(mocks.reserve).not.toHaveBeenCalled();
		expect(mocks.insert).not.toHaveBeenCalled();
	});
	it("bounds candidate requests and preserves the unscored tail", async () => {
		mocks.org.mockResolvedValue({
			metadata: {
				jev: {
					enabled: true,
					purposes: { contextRanking: { enabled: true, maxCandidates: 2 } },
				},
			},
		});
		expect(
			await ranker()({
				...input,
				candidates: [...candidates, { id: "tail", description: "unscored" }],
			}),
		).toEqual(["b", "a", "tail"]);
		expect(Object.keys(mocks.call.mock.calls[0]![1].questions)).toEqual([
			"which",
			"fits0",
			"fits1",
		]);
	});
});

it("retains reported usage when semantic validation rejects the provider answer", async () => {
	mocks.call.mockImplementation(async (client) => {
		await client.authorize({ execution: identity, body: "{}" });
		throw new JevResponseError("Invalid answer", {
			input_tokens: 100,
			output_tokens: 10,
		});
	});
	expect(await ranker()(input)).toBeNull();
	expect(mocks.insert).toHaveBeenCalledWith(expect.anything(), [
		expect.objectContaining({
			inputTokens: 100,
			outputTokens: 10,
			rateVersionId: "rate-1",
			estimatedCostUsd: 0.000005,
		}),
	]);
	expect(mocks.rate).toHaveBeenCalledOnce();
});
it("selects the org transport and preserves unknown-usage failed attempts", async () => {
	mocks.org.mockResolvedValue({
		metadata: {
			jev: {
				enabled: true,
				transport: "direct",
				purposes: { contextRanking: { enabled: true } },
			},
		},
	});
	const context = { organizationId: "org-1", executionAttempts: [] };
	const observed = vi.fn();
	mocks.call.mockImplementation(async (client) => {
		expect(client.env.JEV_TRANSPORT).toBe("direct");
		await client.authorize({ execution: identity, body: "{}" });
		throw new Error("timeout");
	});
	const run = createJevContextRanker(
		{} as never,
		{ DB: {} as never },
		context,
		undefined,
		observed,
	);
	expect(await run(input)).toBeNull();
	expect(context.executionAttempts).toHaveLength(1);
	expect(observed).toHaveBeenCalledWith(context.executionAttempts);
	expect(mocks.insert).not.toHaveBeenCalled();
});

it("bounds the complete ranking request for multilingual candidate descriptions", async () => {
	const candidates = Array.from({ length: 40 }, (_, i) => ({
		id: String(i),
		description: "🧪".repeat(3000),
	}));
	await ranker()({ ...input, query: "🧪".repeat(5000), candidates });
	const request = mocks.call.mock.calls[0]![1];
	expect(
		new TextEncoder().encode(
			JSON.stringify({ state: request.state, questions: request.questions }),
		).length,
	).toBeLessThan(30000);
});

it("retries the same usage receipt after a transient D1 failure without resending inference", async () => {
	mocks.insert
		.mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
		.mockResolvedValueOnce([]);
	expect(await ranker()(input)).toEqual(["b", "a"]);
	expect(mocks.insert).toHaveBeenCalledTimes(2);
	expect(mocks.insert.mock.calls[0]![1][0]).toBe(
		mocks.insert.mock.calls[1]![1][0],
	);
	expect(mocks.call).toHaveBeenCalledOnce();
	expect(mocks.reserve).toHaveBeenCalledOnce();
});

it("reports unsaved paid usage after bounded retries and keeps its original attempt evidence", async () => {
	mocks.insert.mockRejectedValue(
		new Error("D1 unavailable with sensitive diagnostics"),
	);
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const context = { organizationId: "org-1", executionAttempts: [] };
	const run = createJevContextRanker({} as never, { DB: {} as never }, context);
	await expect(run(input)).rejects.toThrow(
		"Jev usage persistence failed for execution exec-1",
	);
	await expect(run(input)).rejects.toThrow(
		"Jev usage persistence failed for execution exec-1",
	);
	expect(mocks.insert).toHaveBeenCalledTimes(3);
	expect(mocks.call).toHaveBeenCalledOnce();
	expect(context.executionAttempts).toEqual([
		expect.objectContaining({
			executionId: "exec-1",
			usage: {
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		}),
	]);
	expect(errors).toHaveBeenCalledWith(
		"[jev-judgment] paid usage not persisted; reconciliation required",
		expect.objectContaining({
			executionId: "exec-1",
			reservationId: "reservation-1",
			inputTokens: 100,
			outputTokens: 10,
			rateVersionId: "rate-1",
			costMicros: 5,
		}),
	);
	expect(JSON.stringify(errors.mock.calls)).not.toContain("Accounting");
	expect(JSON.stringify(errors.mock.calls)).not.toContain(
		"sensitive diagnostics",
	);
	errors.mockRestore();
});

it("reserves UTF8-byte input bounds and a per-question output bound", async () => {
	const body = JSON.stringify({
		state: "汉字🧪".repeat(500),
		questions: { c0: { type: "score" }, c1: { type: "score" } },
	});
	mocks.call.mockImplementation(async (client) => {
		await client.authorize({ execution: identity, body });
		throw new Error("stop after admission");
	});
	await ranker()(input);
	expect(mocks.reserve).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			tokenEstimates: {
				input: new TextEncoder().encode(body).byteLength,
				output: expect.any(Number),
			},
		}),
	);
});

it("keeps paid attempt usage when the permutation wrapper falls back after receipt exhaustion", async () => {
	const attempts: import("./gateway-attribution").KernelExecutionAttempt[] = [];
	mocks.insert.mockRejectedValue(new Error("D1 unavailable"));
	const rank = createJevContextRanker(
		{} as never,
		{ DB: {} as never },
		{ organizationId: "org-1" },
		undefined,
		(delta) => attempts.push(...delta),
	);
	const result = await rerankContextCandidates(
		candidates,
		"Fix code",
		"workflow",
		(c) => c,
		rank,
	);
	expect(result).toBe(candidates);
	expect(mocks.call).toHaveBeenCalledTimes(1);
	expect(mocks.insert).toHaveBeenCalledTimes(3);
	expect(attempts).toHaveLength(1);
	expect(attempts[0]?.usage?.inputTokens).toBeGreaterThan(0);
});

it("records served native model without rewriting admitted identity or pinned price", async () => {
	mocks.call.mockImplementation(async (client) => {
		await client.authorize({
			execution: { ...identity, requestModel: "typesafe/jev" },
			body: "{}",
		});
		return {
			model: "jev-1.13.0",
			usage: { input_tokens: 20, output_tokens: 4 },
			answers: {
				c0: { type: "score", score: 0, confidence: 1 },
				c1: { type: "score", score: 3, confidence: 1 },
			},
		};
	});
	await ranker()(input);
	expect(mocks.reserve).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			execution: expect.objectContaining({ requestModel: "typesafe/jev" }),
		}),
	);
	expect(mocks.insert.mock.calls[0]?.[1][0]).toMatchObject({
		model: "jev-1.13.0",
		rateVersionId: "rate-1",
	});
});

it("uses defaults without opt-in but fails closed on missing organization or lookup failure", async () => {
	mocks.org.mockResolvedValue({ metadata: {} });
	expect(await ranker()(input)).toEqual(["b", "a"]);
	mocks.call.mockClear();
	mocks.org.mockResolvedValue(null);
	expect(await ranker()(input)).toBeNull();
	mocks.org.mockRejectedValue(new Error("D1 unavailable"));
	expect(await ranker()(input)).toBeNull();
	expect(mocks.call).not.toHaveBeenCalled();
});
it("promotes only individually applicable candidates and keeps all other IDs stable", () => {
	const all = [...candidates, { id: "tail", description: "Tail" }];
	const answers = {
		which: {
			type: "choice" as const,
			choice: "c0",
			probabilities: { c0: 0.9, c1: 0.1 },
			confidence: 0.9,
		},
		fits0: { type: "noul" as const, noul: 0.1 },
		fits1: { type: "noul" as const, noul: 0.7 },
	};
	expect(interpretJevRanking(candidates, all, answers, 0.6)).toEqual([
		"b",
		"a",
		"tail",
	]);
	expect(
		interpretJevRanking(
			candidates,
			all,
			{ ...answers, fits1: { type: "noul", noul: 0.1 } },
			0.6,
		),
	).toBeNull();
});
it("rejects missing evidence and serialized escaping overflow before dispatch", () => {
	expect(
		buildJevRankingRequest({
			...input,
			candidates: [candidates[0]!, { id: "b", description: "" }],
		}),
	).toBeNull();
	const request = buildJevRankingRequest({
		...input,
		query: "\u0000".repeat(2000),
		candidates: Array.from({ length: 40 }, (_, i) => ({
			id: String(i),
			description: "\u0000".repeat(350),
		})),
	});
	expect(request).toBeNull();
});

it("frames memory candidates as relevance judgments, never truth or authority", () => {
	const request = buildJevRankingRequest({
		kind: "memory",
		query: "What happened with this project?",
		candidates: [
			{ id: "fact:1", description: "Fact: project deadline changed" },
			{ id: "outcome:0", description: "Prior action: owner approved" },
		],
	});
	expect(request?.state.kind).toBe("memory");
	expect(request?.questions.which?.instructions).toContain(
		"Judge relevance, not truth, authority",
	);
	expect(request?.questions.fits0?.instructions).toContain(
		"Do not assess truth",
	);
});

it("keeps baseline ties stable and rejects incomplete typed judgments", () => {
	const answers = {
		which: {
			type: "choice" as const,
			choice: "c0",
			probabilities: { c0: 0.5, c1: 0.5 },
			confidence: 0,
		},
		fits0: { type: "noul" as const, noul: 0.8 },
		fits1: { type: "noul" as const, noul: 0.8 },
	};
	expect(interpretJevRanking(candidates, candidates, answers, 0.6)).toEqual([
		"a",
		"b",
	]);
	expect(
		interpretJevRanking(
			candidates,
			candidates,
			{ which: answers.which, fits0: answers.fits0 },
			0.6,
		),
	).toBeNull();
});
