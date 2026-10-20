import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	policy: vi.fn(),
	pool: vi.fn(),
	secret: vi.fn(),
	decrypt: vi.fn(),
}));
vi.mock("@tedix/db/queries/data-residency", () => ({
	getOrganizationResidencyPolicy: mocks.policy,
	listResidencyProviders: mocks.pool,
}));
vi.mock("@tedix/db/queries/organization-secrets", () => ({
	getOrgSecret: mocks.secret,
}));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptSecret: mocks.decrypt,
}));
import {
	authorizeDataResidency,
	eligibleResidencyProvider,
} from "./data-residency";
import { ResidencyProviderSchema } from "@tedix/api-contract/schemas/data-residency";
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
	expiresAt: "2027-01-01T00:00:00.000Z",
	execution,
};
const input = {
	db: {} as never,
	organizationId: "org_lark",
	execution,
	masterKey: "fictional-master",
	now: Date.parse("2026-10-18T00:00:00.000Z"),
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.policy.mockResolvedValue({
		organizationId: "org_lark",
		mode: "eu",
		revision: 1,
	});
	mocks.pool.mockResolvedValue([member]);
	mocks.secret.mockResolvedValue({ encryptedValue: "fictional-encrypted" });
	mocks.decrypt.mockResolvedValue("fictional-provider-key");
});
describe("EU model egress admission", () => {
	it.each([null, { mode: "unrestricted", revision: 1 }])(
		"keeps unrestricted routes without catalog or credential reads",
		async (policy) => {
			mocks.policy.mockResolvedValue(policy);
			expect(await authorizeDataResidency(input)).toBeNull();
			expect(mocks.pool).not.toHaveBeenCalled();
			expect(mocks.secret).not.toHaveBeenCalled();
		},
	);
	it("admits the exact verified member using only the selected organization's encrypted credential", async () => {
		expect(await authorizeDataResidency(input)).toMatchObject({
			apiKey: "fictional-provider-key",
			member,
		});
		expect(mocks.secret).toHaveBeenCalledWith(
			input.db,
			"org_lark",
			"REGIONAL_MODEL_KEY",
		);
		expect(mocks.decrypt).toHaveBeenCalledWith(
			"fictional-master",
			"org_lark",
			"fictional-encrypted",
		);
	});
	it("names the actual missing credential before any send", async () => {
		mocks.secret.mockResolvedValue(undefined);
		await expect(authorizeDataResidency(input)).rejects.toThrow(
			/EU_PROVIDER_CREDENTIAL_REQUIRED.*REGIONAL_MODEL_KEY/,
		);
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});
	it("does not invent a credential when the pool is empty", async () => {
		mocks.pool.mockResolvedValue([]);
		await expect(authorizeDataResidency(input)).rejects.toThrow(
			/EU_PROVIDER_POOL_REQUIRED.*administrator must add/,
		);
		expect(mocks.secret).not.toHaveBeenCalled();
	});
	it.each([
		{ enabled: false },
		{ expiresAt: "2026-10-17T00:00:00.000Z" },
		{ jurisdiction: "unknown" as const },
		{ jurisdiction: "global" as const },
	])(
		"excludes disabled, expired and unverified entries: %j",
		async (overrides) => {
			mocks.pool.mockResolvedValue([{ ...member, ...overrides }]);
			await expect(authorizeDataResidency(input)).rejects.toThrow(
				"EU_PROVIDER_POOL_REQUIRED",
			);
		},
	);
	it.each([
		{ requestModel: "other-model" },
		{ gatewayId: "unverified-gateway" },
		{ transportKind: "gateway-binding" as const },
	])(
		"pins every part of provider and intermediary identity: %j",
		(overrides) => {
			expect(() =>
				eligibleResidencyProvider(
					[member],
					{ ...execution, ...overrides },
					input.now,
				),
			).toThrow("EU_PROVIDER_ROUTE_REQUIRED");
		},
	);
	it("selects the verified EU resource for the same permitted model", () => {
		expect(
			eligibleResidencyProvider(
				[member],
				{
					...execution,
					providerResource: "lark-global",
					providerOrigin: "https://lark-global.openai.azure.com",
				},
				input.now,
			),
		).toBe(member);
	});
	it("does not grant an unsupported image modality", () => {
		expect(() =>
			eligibleResidencyProvider(
				[{ ...member, modalities: ["text"] }],
				execution,
				input.now,
				"image",
			),
		).toThrow("EU_PROVIDER_ROUTE_REQUIRED");
	});
	it("blocks auto and Workers AI fallback", () => {
		expect(() =>
			eligibleResidencyProvider(
				[member],
				{
					...execution,
					provider: "workers-ai",
					requestModel: "cloudflare/auto",
					autoRouting: {
						version: 1,
						modality: "text",
						mode: "unrestricted",
						allowedModels: null,
						allowedProviders: null,
					},
				},
				input.now,
			),
		).toThrow("EU_PROVIDER_ROUTE_REQUIRED");
	});
	it("retries one transient policy read instead of failing the turn", async () => {
		mocks.policy
			.mockRejectedValueOnce(
				Error("D1_ERROR: database temporarily unavailable"),
			)
			.mockResolvedValueOnce({
				organizationId: "org_lark",
				mode: "unrestricted",
				revision: 1,
			});
		expect(await authorizeDataResidency(input)).toBeNull();
		expect(mocks.policy).toHaveBeenCalledTimes(2);
	});
	it("fails closed on a policy read failure and hides decryption details", async () => {
		mocks.policy.mockRejectedValue(Error("db unavailable"));
		await expect(authorizeDataResidency(input)).rejects.toThrow(
			"RESIDENCY_POLICY_UNAVAILABLE",
		);
		mocks.policy.mockResolvedValue({
			organizationId: "org_lark",
			mode: "eu",
			revision: 1,
		});
		mocks.decrypt.mockRejectedValue(Error("private-decryption-detail"));
		await expect(authorizeDataResidency(input)).rejects.toThrow(
			"EU_PROVIDER_CREDENTIAL_REQUIRED",
		);
	});
	it.each([
		"https://user:pass@provider.example.test",
		"https://lark-eu.openai.azure.com:444",
		"https://lark-eu.openai.azure.com/path",
		"https://lark-eu.openai.azure.com.evil.example",
	])("rejects origin spoofing: %s", (origin) => {
		expect(
			ResidencyProviderSchema.safeParse({
				...member,
				execution: { ...execution, providerOrigin: origin },
			}).success,
		).toBe(false);
	});
});
