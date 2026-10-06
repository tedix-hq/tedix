import { JevResponseError } from "@tedix/workers-ai/jev";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { executeJevJudgment } from "./jev-judgment";
import type { KernelExecutionAttempt } from "../rpc/routers/kernel/gateway-attribution";
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
vi.mock("../rpc/routers/kernel/billing-reservation", () => ({
	reserveKernelBilling: mocks.reserve,
}));
vi.mock("./provider-model-pricing", () => ({
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
const clefIdentity = {
	provider: "workers-ai",
	requestModel: "@cf/cloudflare/clef-flash",
	gatewayAccountId: "account",
	gatewayId: "gateway",
	providerOrigin: null,
	providerResource: null,
	deployment: null,
	transportKind: "gateway-https",
	apiKind: "workers-ai-chat",
};
function execute(
	overrides: Partial<Parameters<typeof executeJevJudgment>[0]> = {},
) {
	return executeJevJudgment({
		db: {} as never,
		env: { DB: {} as never },
		context: {
			organizationId: "org-1",
			runId: "catalog-run",
			executionAttempts: [],
		},
		state: "Evidence",
		questions: { decision: { type: "noul", instructions: "Relevant?" } },
		source: "system:tool-output-quality",
		billingSource: "system",
		sessionType: "unattributed",
		...overrides,
	});
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
				c0: { type: "score", score: 0, confidence: 0.95 },
				c1: { type: "score", score: 3, confidence: 0.95 },
			},
		};
	});
});

describe("shared Jev execution", () => {
	it("defaults to Cloudflare without consulting experimental tenant ranking opt-ins", async () => {
		expect(await execute()).not.toBeNull();
		expect(mocks.org).not.toHaveBeenCalled();
		expect(mocks.call.mock.calls[0]![0].env.JEV_TRANSPORT).toBe("cloudflare");
		expect(mocks.reserve.mock.calls[0]![1].source).toBe("system");
		expect(mocks.insert.mock.calls[0]![1][0]).toMatchObject({
			source: "provider-response:system:tool-output-quality",
			sessionType: "unattributed",
			runId: "catalog-run",
			billingReservationId: "reservation-1",
			callDurationMs: expect.any(Number),
		});
		expect(
			mocks.insert.mock.calls[0]![1][0].callDurationMs,
		).toBeGreaterThanOrEqual(0);
	});
	it("does not dispatch without tenant attribution or after cancellation", async () => {
		expect(await execute({ context: {} })).toBeNull();
		expect(await execute({ signal: AbortSignal.abort() })).toBeNull();
		expect(mocks.call).not.toHaveBeenCalled();
	});
	it("requires governed rate and admission even for default adopted purposes", async () => {
		mocks.rate.mockResolvedValue({ status: "unresolved" });
		expect(await execute()).toBeNull();
		expect(mocks.reserve).not.toHaveBeenCalled();
		expect(mocks.insert).not.toHaveBeenCalled();
	});
	it("retains actual usage on rejected answers without replaying inference", async () => {
		mocks.call.mockImplementation(async (client) => {
			await client.authorize({ execution: identity, body: "{}" });
			throw new JevResponseError("invalid", {
				input_tokens: 100,
				output_tokens: 10,
			});
		});
		const attempts: KernelExecutionAttempt[] = [];
		expect(
			await execute({
				context: { organizationId: "org-1", executionAttempts: attempts },
			}),
		).toBeNull();
		expect(attempts[0]!.usage!.inputTokens).toBe(100);
		expect(mocks.insert).toHaveBeenCalledTimes(1);
		expect(
			mocks.insert.mock.calls[0]![1][0].callDurationMs,
		).toBeGreaterThanOrEqual(0);
		expect(mocks.call).toHaveBeenCalledTimes(1);
	});
	it("retries only immutable receipt writes and surfaces total persistence failure", async () => {
		mocks.insert.mockRejectedValue(new Error("D1 unavailable"));
		const attempts: KernelExecutionAttempt[] = [];
		await expect(
			execute({
				context: { organizationId: "org-1", executionAttempts: attempts },
			}),
		).rejects.toMatchObject({ name: "JevUsagePersistenceError" });
		expect(mocks.insert).toHaveBeenCalledTimes(3);
		expect(mocks.call).toHaveBeenCalledTimes(1);
		expect(mocks.insert.mock.calls[0]![1][0]).toBe(
			mocks.insert.mock.calls[2]![1][0],
		);
		expect(
			mocks.insert.mock.calls[0]![1][0].callDurationMs,
		).toBeGreaterThanOrEqual(0);
		expect(attempts[0]!.usage!.inputTokens).toBe(100);
	});
});

it("reserves output headroom for copied criteria and honors explicit transport without failover", async () => {
	const instructions = "界".repeat(500);
	await execute({
		transport: "direct",
		questions: {
			decision: {
				type: "score",
				instructions,
				criteria: [instructions, "weak", "strong"],
			},
		},
	});
	expect(mocks.call.mock.calls[0]![0].env.JEV_TRANSPORT).toBe("direct");
	expect(mocks.reserve.mock.calls[0]![1].tokenEstimates.output).toBeGreaterThan(
		3000,
	);
	expect(mocks.call).toHaveBeenCalledTimes(1);
});

it("uses configured direct transport unless the caller explicitly overrides it", async () => {
	await execute({ env: { DB: {} as never, JEV_TRANSPORT: "direct" } });
	expect(mocks.call.mock.calls[0]![0].env.JEV_TRANSPORT).toBe("direct");
	await execute({
		env: { DB: {} as never, JEV_TRANSPORT: "direct" },
		transport: "cloudflare",
	});
	expect(mocks.call.mock.calls[1]![0].env.JEV_TRANSPORT).toBe("cloudflare");
});
it("forwards an explicit per-purpose Clef model and attributes its receipt", async () => {
	mocks.call.mockImplementation(async (client, request) => {
		expect(request.model).toBe("@cf/cloudflare/clef-flash");
		await client.authorize({ execution: clefIdentity, body: "{}" });
		return {
			model: "clef-flash",
			usage: { input_tokens: 90, output_tokens: 0 },
			answers: { decision: { type: "noul", noul: 0.8 } },
		};
	});
	mocks.reserve.mockImplementationOnce(async (_env, input) => {
		input.context.executionAttempts.push({
			identity: clefIdentity,
			occurredAt: "2026-10-01T00:00:00Z",
			executionId: "exec-clef",
		});
		return {
			...input.context,
			executionId: "exec-clef",
			billingReservationId: "reservation-clef",
		};
	});
	expect(await execute({ model: "@cf/cloudflare/clef-flash" })).toMatchObject({
		model: "clef-flash",
	});
	expect(mocks.rate).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			provider: "workers-ai",
			modelId: "@cf/cloudflare/clef-flash",
		}),
	);
	expect(mocks.insert.mock.calls[0]![1][0]).toMatchObject({
		provider: "workers-ai",
		model: "clef-flash",
		gatewayId: "gateway",
		executionId: "exec-clef",
	});
});
it("preserves invalid environment transport for the provider to reject before admission", async () => {
	const provider = await vi.importActual<
		typeof import("@tedix/workers-ai/jev")
	>("@tedix/workers-ai/jev");
	mocks.call.mockImplementation(async (client) => {
		provider.resolveJevExecution(client.env);
		throw new Error("Unexpected accepted transport");
	});
	expect(
		await execute({
			env: { DB: {} as never, JEV_TRANSPORT: "unknown-provider" },
		}),
	).toBeNull();
	expect(mocks.call.mock.calls[0]![0].env.JEV_TRANSPORT).toBe(
		"unknown-provider",
	);
	expect(mocks.reserve).not.toHaveBeenCalled();
	expect(mocks.insert).not.toHaveBeenCalled();
});
