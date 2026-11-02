import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	modelCatalogConfig,
	modelCatalogEntry,
} from "@tedix/api-contract/test/model-catalog";
import { EvaluateLedgerModelInputSchema } from "@tedix/api-contract/schemas/ledger-model-evaluation";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	catalog: vi.fn(),
	policy: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@tedix/db/queries/model-catalog", () => ({
	getModelCatalogConfig: mocks.catalog,
}));
vi.mock("@tedix/db/queries/data-residency", () => ({
	getOrganizationResidencyPolicy: mocks.policy,
}));
vi.mock("@tedix/workers-ai/gateway-transport", async (original) => ({
	...(await original<typeof import("@tedix/workers-ai/gateway-transport")>()),
	resolveAiGatewayTransport: () => ({
		providerRoot: "https://gateway.invalid/azure-openai",
		authorization: "fictional-managed-token",
		fetch: mocks.fetch,
	}),
}));
import { workAgentSessionsContractRouter } from "./work-agent-sessions";
const input = {
	surface: "status",
	caseId: "trim-tabs",
	promptVariant: "production",
	modelRef: "azure-openai/gpt-6.1-sol",
	evaluationId: "10000000-0000-4000-8000-000000000001",
} as const;
function client(overrides: Partial<BaseContext> = {}) {
	return createRouterClient(workAgentSessionsContractRouter, {
		context: {
			authType: "user",
			db: {},
			env: { AZURE_OPENAI_RESOURCE: "fictional-resource" },
			headers: new Headers(),
			organizationId: "org-example",
			user: {
				sub: "admin",
				scope: "platform:admin",
				permissions: ["settings:manage"],
				roles: [],
			},
			...overrides,
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.catalog.mockResolvedValue(
		modelCatalogConfig([modelCatalogEntry(input.modelRef)]),
	);
	mocks.policy.mockResolvedValue(null);
	mocks.fetch.mockResolvedValue(
		Response.json(
			{
				status: "completed",
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: '{"updates":[]}' }],
					},
				],
				usage: {
					input_tokens: 20,
					output_tokens: 4,
					total_tokens: 24,
					input_tokens_details: { cached_tokens: 12 },
					output_tokens_details: { reasoning_tokens: 2 },
				},
			},
			{ headers: { "x-request-id": "fictional-request" } },
		),
	);
});
describe("managed fixed-corpus ledger qualification", () => {
	it("makes one attributed bounded call and returns usage and hashes without credentials", async () => {
		const result = await client().evaluateLedgerModel(input);
		expect(result).toMatchObject({
			status: "completed",
			output: '{"updates":[]}',
			providerRequestId: "fictional-request",
			usage: {
				inputTokens: 20,
				outputTokens: 4,
				totalTokens: 24,
				cachedInputTokens: 12,
				reasoningTokens: 2,
			},
		});
		expect(result.systemHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const [url, request] = mocks.fetch.mock.calls[0]!;
		expect(url).toBe(
			"https://gateway.invalid/azure-openai/fictional-resource/openai/v1/responses",
		);
		expect(JSON.parse(request.body)).toMatchObject({
			model: "gpt-6.1-sol",
			max_output_tokens: 6000,
			reasoning: { effort: "low" },
		});
		expect(JSON.parse(request.headers["cf-aig-metadata"])).toEqual({
			surface: "ledger-qualification",
			orgId: "org-example",
			evaluationId: input.evaluationId,
			modelRef: input.modelRef,
			case: "status:trim-tabs:production",
		});
		expect(request.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.stringify(result)).not.toContain("fictional-managed-token");
	});
	it.each([
		{ caseId: "missing" },
		{ surface: "reply", promptVariant: "shorter_status" },
		{ modelRef: "azure-openai/not-allowed" },
		{ prompt: "caller-controlled" },
		{ organizationId: "foreign" },
	])(
		"rejects unknown or untrusted inputs before a paid call: %j",
		async (patch) => {
			await expect(
				client().evaluateLedgerModel({ ...input, ...patch } as never),
			).rejects.toBeDefined();
			expect(mocks.fetch).not.toHaveBeenCalled();
		},
	);
	it("requires the model to remain registered", async () => {
		mocks.catalog.mockResolvedValue(
			modelCatalogConfig([modelCatalogEntry("azure-openai/gpt-6-astra")]),
		);
		await expect(client().evaluateLedgerModel(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("rejects superseded candidates before dispatch", async () => {
		mocks.catalog.mockResolvedValue(
			modelCatalogConfig([
				modelCatalogEntry(input.modelRef, { lifecycle: "superseded" }),
			]),
		);
		await expect(client().evaluateLedgerModel(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("enforces organization egress policy before dispatch", async () => {
		mocks.policy.mockResolvedValue({ mode: "eu", revision: 1 });
		await expect(client().evaluateLedgerModel(input)).rejects.toBeDefined();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("denies non-admin and absent-org principals", async () => {
		await expect(
			client({
				user: {
					sub: "user",
					scope: "mcp:work.write",
					permissions: [],
					roles: [],
				} as never,
			}).evaluateLedgerModel(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client({ organizationId: undefined }).evaluateLedgerModel(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("does not retry provider or transport failures or expose response secrets", async () => {
		mocks.fetch.mockResolvedValue(
			new Response("private-provider-failure", { status: 503 }),
		);
		expect(await client().evaluateLedgerModel(input)).toMatchObject({
			status: "http_error",
			error: "Evaluation provider HTTP 503",
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		mocks.fetch.mockRejectedValue(new Error("private-credential"));
		const failed = await client().evaluateLedgerModel(input);
		expect(failed.status).toBe("transport_error");
		expect(JSON.stringify(failed)).not.toContain("private-credential");
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});
	it("denies a machine credential without platform-admin scope", async () => {
		await expect(
			client({
				authType: "apikey",
				apiKey: { id: "fictional-key", scopes: ["mcp:work.write"] } as never,
			}).evaluateLedgerModel(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("passes the 24-second deadline signal and does not retry its abort", async () => {
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		let started!: () => void;
		const dispatched = new Promise<void>((resolve) => {
			started = resolve;
		});
		try {
			mocks.fetch.mockImplementation(
				(_url, request) =>
					new Promise((_resolve, reject) => {
						started();
						request.signal.addEventListener(
							"abort",
							() => reject(request.signal.reason),
							{ once: true },
						);
					}),
			);
			const pending = client().evaluateLedgerModel(input);
			await dispatched;
			expect(timeout).toHaveBeenCalledWith(24_000);
			controller.abort(new DOMException("fictional deadline", "TimeoutError"));
			expect(await pending).toMatchObject({
				status: "transport_error",
			});
			expect(mocks.fetch).toHaveBeenCalledTimes(1);
		} finally {
			timeout.mockRestore();
		}
	});
	it("strictly excludes arbitrary systems and model refs at the contract", () => {
		expect(
			EvaluateLedgerModelInputSchema.safeParse({ ...input, system: "override" })
				.success,
		).toBe(false);
	});
});
