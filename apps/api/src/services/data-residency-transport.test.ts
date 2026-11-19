import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	policy: vi.fn(),
	pool: vi.fn(),
	secret: vi.fn(),
	decrypt: vi.fn(),
	budget: vi.fn(),
	receipt: vi.fn(),
	sent: vi.fn(),
	rate: vi.fn(),
	persisted: null as Record<string, unknown> | null,
}));
vi.mock("./provider-model-pricing", () => ({
	resolveProviderModelRate: mocks.rate,
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/data-residency", () => ({
	getOrganizationResidencyPolicy: mocks.policy,
	listResidencyProviders: mocks.pool,
	recordResidencyExecution: mocks.receipt,
}));
vi.mock("@tedix/db/queries/organization-secrets", () => ({
	getOrgSecret: mocks.secret,
}));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptSecret: mocks.decrypt,
}));
import { resetResidencyPolicyCache } from "./data-residency";
vi.mock("./runtime-budget-admission", () => ({
	authorizeRuntimeBudget: mocks.budget,
}));
vi.mock("@tedix/db/queries/provider-executions", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/provider-executions")>()),
	findProviderExecutionAdmission: async () => mocks.persisted,
	buildProviderExecutionInsertStatement: async (
		_db: unknown,
		row: Record<string, unknown>,
	) => {
		mocks.persisted = row;
	},
}));
import { kernelGatewayFetch } from "../rpc/routers/kernel/llm";
const env = {
	DB: {} as D1Database,
	TEDIX_BILLING_SETTLEMENT_MODE: "external",
	AI_GATEWAY_ACCOUNT_ID: "example-account",
	AI_GATEWAY_LLM_ID: "example-gateway",
	CF_AI_GATEWAY_TOKEN: "fictional-gateway-token",
	SECRETS_MASTER_KEY: "fictional-master",
};
const execution = {
	provider: "azure-openai" as const,
	requestModel: "text-model",
	providerResource: "lark-eu",
	providerOrigin: "https://lark-eu.openai.azure.com",
	deployment: "text-model",
	apiKind: "azure-responses" as const,
	transportKind: "gateway-https" as const,
	gatewayAccountId: "example-account",
	gatewayId: "example-gateway",
};
const member = {
	memberKey: "regional-text",
	modalities: ["text" as const, "image" as const],
	revision: 1,
	jurisdiction: "eu" as const,
	enabled: true,
	credentialRef: "REGIONAL_MODEL_KEY",
	evidenceRef: "https://evidence.example/regional-processing",
	expiresAt: "2099-01-01T00:00:00.000Z",
	execution,
};
function send(requestInput = false) {
	const url = "https://lark-eu.openai.azure.com/openai/v1/responses";
	const init = {
		method: "POST",
		body: JSON.stringify({ model: "text-model", input: "fictional prompt" }),
		headers: { "api-key": "sdk-placeholder" },
	};
	const fetcher = kernelGatewayFetch(env, { organizationId: "org_lark" })!;
	return requestInput ? fetcher(new Request(url, init)) : fetcher(url, init);
}
beforeEach(() => {
	vi.resetAllMocks();
	resetResidencyPolicyCache();
	mocks.persisted = null;
	mocks.policy.mockResolvedValue({ mode: "eu", revision: 1 });
	mocks.pool.mockResolvedValue([member]);
	mocks.secret.mockResolvedValue({ encryptedValue: "fictional-encrypted" });
	mocks.decrypt.mockResolvedValue("fictional-regional-key");
	mocks.budget.mockResolvedValue({
		allowed: true,
		settlementMode: "external",
		reservationId: null,
		expiresAt: null,
		estimatedCredits: null,
	});
	mocks.sent.mockResolvedValue(new Response("{}"));
	mocks.rate.mockResolvedValue({ status: "unpriced", reason: "missing_rate" });
	vi.stubGlobal("fetch", mocks.sent);
});
afterEach(() => vi.unstubAllGlobals());
describe("AI Gateway custom cost on the kernel Azure transport", () => {
	it("prices the send at the governed rate of the admitted regional identity", async () => {
		mocks.rate.mockResolvedValue({
			status: "resolved",
			rate: {
				id: "rate-lark",
				inputMicrousdPerMillion: 2_000_000,
				outputMicrousdPerMillion: 8_000_000,
				cacheReadMicrousdPerMillion: 500_000,
				cacheWriteMicrousdPerMillion: 2_000_000,
			},
		});
		await send();
		expect(mocks.rate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				provider: "azure-openai",
				modelId: "text-model",
				deploymentScope: JSON.stringify([
					"azure-openai",
					"example-account",
					"example-gateway",
					"https://lark-eu.openai.azure.com",
					"text-model",
				]),
			}),
		);
		const [, init] = mocks.sent.mock.calls[0]!;
		expect(JSON.parse(init.headers.get("cf-aig-custom-cost"))).toEqual({
			per_token_in: 0.000002,
			per_token_out: 0.000008,
			per_cache_read_token: 0.0000005,
			per_cache_write_token: 0,
		});
	});

	it("sends no custom cost when no governed rate resolves", async () => {
		await send();
		const [, init] = mocks.sent.mock.calls[0]!;
		expect(init.headers.has("cf-aig-custom-cost")).toBe(false);
	});
});
describe("EU restriction at the actual kernel provider transport", () => {
	it.each([false, true])(
		"rejects redirects with their status (Request input: %s)",
		async (requestInput) => {
			for (const status of [300, 307, 399]) {
				const before = mocks.sent.mock.calls.length;
				mocks.sent.mockResolvedValueOnce(
					new Response(null, {
						status,
						headers: { location: "https://elsewhere.example/model" },
					}),
				);
				await expect(send(requestInput)).rejects.toThrow(`HTTP ${status}`);
				expect(mocks.sent).toHaveBeenCalledTimes(before + 1);
				const [input, init] = mocks.sent.mock.calls[before]!;
				const request = new Request(input, init);
				expect(request.redirect).toBe("manual");
				expect(request.headers.get("api-key")).toBe("fictional-regional-key");
				expect(request.url).toContain("/azure-openai/lark-eu/");
			}
		},
	);

	it("sends only the exact EU endpoint and tenant key; keeps credentials out of persisted evidence", async () => {
		await send();
		expect(mocks.sent).toHaveBeenCalledOnce();
		const [url, init] = mocks.sent.mock.calls[0]!;
		expect(url).toBe(
			"https://gateway.ai.cloudflare.com/v1/example-account/example-gateway/azure-openai/lark-eu/openai/v1/responses",
		);
		expect(init.headers.get("api-key")).toBe("fictional-regional-key");
		expect(init.headers.get("cf-aig-collect-log")).toBe("false");
		expect(init.redirect).toBe("manual");
		expect(JSON.stringify(mocks.persisted)).not.toContain(
			"fictional-regional-key",
		);
		expect(JSON.stringify(mocks.receipt.mock.calls)).not.toContain(
			"fictional-regional-key",
		);
		expect(mocks.receipt.mock.calls[0]![1]).toMatchObject({
			policyRevision: 1,
			credentialRef: "REGIONAL_MODEL_KEY",
			poolRevision: 1,
		});
	});
	it.each(["pool", "credential", "region", "expired"])(
		"blocks %s before transport and budget",
		async (kind) => {
			if (kind === "pool") mocks.pool.mockResolvedValue([]);
			if (kind === "credential") mocks.secret.mockResolvedValue(undefined);
			if (kind === "region")
				mocks.pool.mockResolvedValue([{ ...member, jurisdiction: "unknown" }]);
			if (kind === "expired")
				mocks.pool.mockResolvedValue([
					{ ...member, expiresAt: "2020-01-01T00:00:00.000Z" },
				]);
			await expect(send()).rejects.toThrow(/EU_PROVIDER_/);
			expect(mocks.sent).not.toHaveBeenCalled();
			expect(mocks.budget).not.toHaveBeenCalled();
		},
	);
	it("blocks transport and budget after policy read retries are exhausted", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			mocks.policy.mockRejectedValue(Error("unavailable"));
			const rejected = expect(send()).rejects.toThrow(
				/RESIDENCY_POLICY_UNAVAILABLE/,
			);
			await vi.runAllTimersAsync();
			await rejected;
			expect(mocks.sent).not.toHaveBeenCalled();
			expect(mocks.budget).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("revalidates a queued request before returning dispatch authority", async () => {
		mocks.policy
			.mockResolvedValueOnce({ mode: "eu", revision: 1 })
			.mockResolvedValue({ mode: "eu", revision: 2 });
		await expect(send()).rejects.toThrow(
			/changed while this request was queued/,
		);
		expect(mocks.sent).not.toHaveBeenCalled();
	});
	it("reroutes the same model from an unrestricted resource to the verified EU resource", async () => {
		await kernelGatewayFetch(env, { organizationId: "org_lark" })!(
			"https://lark-global.openai.azure.com/openai/v1/responses",
			{
				method: "POST",
				body: JSON.stringify({
					model: "text-model",
					input: "fictional prompt",
				}),
			},
		);
		expect(mocks.sent.mock.calls[0]![0]).toContain("/azure-openai/lark-eu/");
		expect(mocks.persisted?.providerOrigin).toBe(
			"https://lark-eu.openai.azure.com",
		);
	});
	it("rejects a restriction enabled while an unrestricted request was queued", async () => {
		mocks.policy
			.mockResolvedValueOnce(null)
			.mockResolvedValue({ mode: "eu", revision: 1 });
		await expect(send()).rejects.toThrow(
			"changed while this request was queued",
		);
		expect(mocks.sent).not.toHaveBeenCalled();
	});
	it("keeps an absent policy's original BYOK transport and credentials", async () => {
		mocks.policy.mockResolvedValue(null);
		await send();
		const [, init] = mocks.sent.mock.calls[0]!;
		expect(init.headers.has("api-key")).toBe(false);
		expect(init.redirect).toBeUndefined();
		expect(mocks.pool).not.toHaveBeenCalled();
		expect(mocks.secret).not.toHaveBeenCalled();
	});
});
