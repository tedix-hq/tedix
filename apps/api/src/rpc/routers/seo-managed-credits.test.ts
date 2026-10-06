import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { seoContractRouter } from "./seo";

const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
	getBillingServiceCreditSnapshot: vi.fn(),
	getOrgSecret: vi.fn(),
	getOrganizationById: vi.fn(),
	recordBillingProviderUsage: vi.fn(),
	releaseBillingServiceCreditReservation: vi.fn(),
	reserveBillingServiceCredits: vi.fn(),
	settleBillingServiceCreditUsage: vi.fn(),
	updateApp: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: mocks.getAppById,
	updateApp: mocks.updateApp,
}));
vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingProviderUsage: mocks.recordBillingProviderUsage,
}));
vi.mock("@tedix/db/queries/billing-service-credits", () => ({
	getBillingServiceCreditSnapshot: mocks.getBillingServiceCreditSnapshot,
	releaseBillingServiceCreditReservation:
		mocks.releaseBillingServiceCreditReservation,
	reserveBillingServiceCredits: mocks.reserveBillingServiceCredits,
	settleBillingServiceCreditUsage: mocks.settleBillingServiceCreditUsage,
}));
vi.mock("@tedix/db/queries/organization-secrets", () => ({
	getOrgSecret: mocks.getOrgSecret,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
}));

const APP_ID = "019fb001-d4e5-76d0-b9ad-72ce5939392a";
const ORG_ID = "019fb002-622c-782a-919d-26327502d9c8";

function context(headers = new Headers()): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			DATAFORSEO_MANAGED_ENABLED: "true",
			DATAFORSEO_API_KEY: "base64-login-password",
		} as unknown as CloudflareEnv,
		headers,
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/seo"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions: ["apps:read"],
			roles: [],
		},
	};
}

function providerResponse() {
	return new Response(
		JSON.stringify({
			status_code: 20000,
			status_message: "Ok.",
			tasks: [
				{
					id: "provider-task-1",
					status_code: 20000,
					status_message: "Ok.",
					cost: 0.0125,
					path: [
						"v3",
						"dataforseo_labs",
						"google",
						"keyword_suggestions",
						"live",
					],
					result: [
						{
							items: [
								{
									keyword: "managed seo research",
									keyword_info: { search_volume: 42 },
								},
							],
						},
					],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function providerFailureResponse() {
	return new Response(
		JSON.stringify({
			status_code: 20000,
			status_message: "Ok.",
			tasks: [
				{
					id: "provider-task-failed",
					status_code: 40201,
					status_message: "Provider account access is temporarily paused.",
					cost: 0,
					path: [
						"v3",
						"dataforseo_labs",
						"google",
						"keyword_suggestions",
						"live",
					],
					result: null,
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("managed SEO credits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAppById.mockResolvedValue({
			id: APP_ID,
			organizationId: ORG_ID,
			metadata: {},
		});
		mocks.reserveBillingServiceCredits.mockResolvedValue({
			allowed: true,
			replayed: false,
			reservation: {
				id: "reservation-1",
				rateCardId: "seo-research-keywords-v1",
				creditsReserved: 4,
			},
			rateCard: {},
			snapshot: {},
		});
		mocks.settleBillingServiceCreditUsage.mockResolvedValue({
			id: "reservation-1",
			status: "settled",
		});
		mocks.getBillingServiceCreditSnapshot.mockResolvedValue({
			availableCredits: 96,
		});
		mocks.releaseBillingServiceCreditReservation.mockResolvedValue(null);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => providerResponse()),
		);
	});

	it("reserves before a managed call and settles from its provider receipt", async () => {
		const headers = new Headers({ "Idempotency-Key": "workflow-call-1" });
		const client = createRouterClient(seoContractRouter, {
			context: context(headers),
		});

		const result = await client.researchKeywords({
			appId: APP_ID,
			keyword: "managed seo",
		});

		expect(mocks.reserveBillingServiceCredits).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				serviceKey: "seo",
				operationKey: "research_keywords",
				idempotencyKey: `seo:${ORG_ID}:research_keywords:workflow-call-1`,
			}),
		);
		expect(mocks.settleBillingServiceCreditUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: "reservation-1",
				providerUsageId: "dataforseo:provider-task-1",
				providerCostMicros: 12_500,
				providerSucceeded: true,
			}),
		);
		expect(result.receipt).toMatchObject({
			providerTaskId: "provider-task-1",
			costMicros: 12_500,
			billing: {
				credentialMode: "managed",
				rateCardId: "seo-research-keywords-v1",
				creditsDebited: 4,
				creditsRemaining: 96,
			},
		});
	});

	it("records a cost-only receipt and returns a defined error for a failed provider task", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => providerFailureResponse()),
		);
		const client = createRouterClient(seoContractRouter, {
			context: context(),
		});

		await expect(
			client.researchKeywords({
				appId: APP_ID,
				keyword: "managed seo",
			}),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			data: {
				provider: "dataforseo",
				providerStatusCode: null,
				recoveryAction: null,
				receipt: {
					providerTaskId: "provider-task-failed",
					costMicros: 0,
					statusCode: 40201,
				},
			},
		});
		expect(mocks.settleBillingServiceCreditUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: "reservation-1",
				providerUsageId: "dataforseo:provider-task-failed",
				providerCostMicros: 0,
				providerSucceeded: false,
			}),
		);
	});

	it("does not make a second paid call for an in-flight idempotency key", async () => {
		mocks.reserveBillingServiceCredits.mockResolvedValue({
			allowed: true,
			replayed: true,
			reservation: {
				id: "reservation-1",
				rateCardId: "seo-research-keywords-v1",
				creditsReserved: 4,
			},
			rateCard: {},
			snapshot: {},
		});
		const client = createRouterClient(seoContractRouter, {
			context: context(new Headers({ "Idempotency-Key": "workflow-call-1" })),
		});

		await expect(
			client.researchKeywords({
				appId: APP_ID,
				keyword: "managed seo",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.settleBillingServiceCreditUsage).not.toHaveBeenCalled();
	});

	it("releases a reservation when no provider receipt exists", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status_code: 40104,
							status_message:
								"Please verify your account before using the API.",
							cost: 0,
							tasks: null,
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
		);
		const client = createRouterClient(seoContractRouter, {
			context: context(),
		});

		await expect(
			client.researchKeywords({
				appId: APP_ID,
				keyword: "managed seo",
			}),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			data: {
				provider: "dataforseo",
				providerStatusCode: 40104,
				recoveryAction: "verify_account",
				receipt: null,
			},
		});
		expect(mocks.releaseBillingServiceCreditReservation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: "reservation-1",
				reason: "provider_call_failed",
			}),
		);
		expect(mocks.settleBillingServiceCreditUsage).not.toHaveBeenCalled();
	});

	it("serializes provider recovery metadata over the oRPC wire", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status_code: 40104,
							status_message:
								"Please verify your account before using the API.",
							cost: 0,
							tasks: null,
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
		);
		const handler = new RPCHandler({ seo: seoContractRouter });
		const result = await handler.handle(
			new Request("https://api.tedix.test/rpc/seo/researchKeywords", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					json: {
						appId: APP_ID,
						keyword: "managed seo",
					},
				}),
			}),
			{ prefix: "/rpc", context: context() },
		);

		expect(result.matched).toBe(true);
		expect(result.response?.status).toBe(502);
		await expect(result.response?.json()).resolves.toMatchObject({
			json: {
				code: "BAD_GATEWAY",
				data: {
					provider: "dataforseo",
					providerStatusCode: 40104,
					recoveryAction: "verify_account",
					receipt: null,
				},
			},
		});
		expect(mocks.releaseBillingServiceCreditReservation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: "reservation-1",
				reason: "provider_call_failed",
			}),
		);
	});
});
