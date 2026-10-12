import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const activationStorage = vi.hoisted(() => vi.fn());
vi.mock("./billing/credit-activation", () => ({
	configureCreditBillingHandler: activationStorage,
}));

const rateStorage = vi.hoisted(() => ({ list: vi.fn(), publish: vi.fn() }));
vi.mock("@tedix/db/queries/billing/provider-model-rates", () => ({
	listProviderModelRates: rateStorage.list,
	publishProviderModelRate: rateStorage.publish,
}));
const overageStorage = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("@tedix/db/queries/billing/overage", () => ({
	setBillingOverageSettings: overageStorage.set,
}));
const resolveEnvironment = vi.hoisted(() => vi.fn());
vi.mock("../../lib/stripe-environment", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/stripe-environment")>()),
	resolveStripeEnvironment: resolveEnvironment,
}));
import {
	billingContractRouter,
	requirePlatformBillingAuthority,
} from "./billing";

const organizationId = "5eed0026-0000-4000-8000-000000000026";
function context(scopes: string[], human = false): BaseContext {
	return {
		authType: human ? "user" : "apikey",
		organizationId,
		userRole: scopes.length === 0 ? "viewer" : "owner",
		db: {},
		env: {
			ENVIRONMENT: "test",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			DB: {},
		},
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/billing"),
		...(human
			? { user: { sub: "owner", permissions: scopes, roles: [] } }
			: { apiKey: { id: "key", name: "tenant", organizationId, scopes } }),
	} as BaseContext;
}

describe("own-organization billing authorization", () => {
	beforeEach(() => {
		resolveEnvironment.mockReset();
		resolveEnvironment.mockImplementation(() => {
			throw new Error("authorized read reached storage");
		});
	});
	for (const human of [false, true]) {
		it(`rejects missing billing read authority (human=${human})`, async () => {
			const client = createRouterClient(billingContractRouter, {
				context: context([], human),
			});
			await expect(client.getOverview()).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(resolveEnvironment).not.toHaveBeenCalled();
		});
		it(`admits own-org reads without platform admin (human=${human})`, async () => {
			const ctx = context(["billing:read"], human);
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(client.getOverview()).rejects.toThrow(
				"authorized read reached storage",
			);
			expect(resolveEnvironment).toHaveBeenCalledWith(ctx.env);
		});
	}
	it("does not let a tenant owner mint capacity", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:read", "billing:manage"], true),
		});
		await expect(
			client.grantInferenceCapacity({
				organizationId,
				tokenAmount: 1,
				spendAmountMicros: 0,
				idempotencyKey: "denied",
				description: "must not mint capacity",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(resolveEnvironment).not.toHaveBeenCalled();
	});
});

describe("checkout and customer portal authority", () => {
	beforeEach(() => {
		resolveEnvironment.mockReset();
		resolveEnvironment.mockImplementation(() => {
			throw new Error("authorized call reached Stripe");
		});
	});
	const tedi = {
		...context(["billing:read", "billing:write"]),
		authType: "tedi",
		apiKey: undefined,
		userRole: undefined,
		user: {
			sub: "tedi-principal",
			scopes: ["billing:read", "billing:write"],
			permissions: [],
			roles: [],
		},
		tediScopes: ["billing:read", "billing:write"],
		tediId: "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11",
	} as BaseContext;
	const denied: Array<[string, BaseContext]> = [
		["a member without billing authority", context([], true)],
		["an API key without billing:write", context(["billing:read"])],
		["a tedi", tedi],
	];
	for (const [who, ctx] of denied) {
		it(`refuses ${who}`, async () => {
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(
				client.createPortal({ returnUrl: "https://os.tedix.test/billing" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				client.createCheckout({ tier: "growth" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(resolveEnvironment).not.toHaveBeenCalled();
		});
	}
	it("admits an owner with billing:manage", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:read", "billing:manage"], true),
		});
		await expect(
			client.createPortal({ returnUrl: "https://os.tedix.test/billing" }),
		).rejects.toThrow("authorized call reached Stripe");
	});
});

describe("credit activation authority", () => {
	const input = {
		organizationId,
		expectedEntitlementVersion: 1,
		idempotencyKey: "activation-authority",
		reason: "authorized test",
		includedMonthlyCreditMicros: 100000000,
		monthlyCapMicros: 100000000,
		perRunBudgetMicros: 5000000,
		rateBindings: [
			{
				rateVersionId: "published",
				inputConvention: "inclusive" as const,
				requestModelAliases: [],
			},
		],
	};
	beforeEach(() => {
		activationStorage.mockReset();
		activationStorage.mockResolvedValue({
			organizationId,
			planVersionId: "private-plan",
			entitlementVersion: 2,
			creditBalanceMicros: 100000000,
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2026-11-01T00:00:00.000Z",
			includedCreditCarryForward: true,
			alreadyConfigured: false,
		});
	});
	it("accepts platform OAuth scope on a human JWT without tenant permissions", async () => {
		const ctx = context([], true);
		ctx.user = {
			sub: "platform-human",
			scopes: ["platform:admin"],
			permissions: [],
			roles: [],
		};
		await createRouterClient(billingContractRouter, {
			context: ctx,
		}).configureCreditBilling(input);
		expect(activationStorage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ authType: "user", user: ctx.user }),
			input,
			"platform-human",
		);
	});
	it("refuses tenant owners even when they manage their own billing", async () => {
		await expect(
			createRouterClient(billingContractRouter, {
				context: context(["billing:manage"], true),
			}).configureCreditBilling(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(activationStorage).not.toHaveBeenCalled();
	});
	it("accepts an operator API key with platform authority", async () => {
		const ctx = context(["platform:admin"]);
		await createRouterClient(billingContractRouter, {
			context: ctx,
		}).configureCreditBilling(input);
		expect(activationStorage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ authType: "apikey" }),
			input,
			"key",
		);
	});
	it("refuses a tedi even when its token carries platform authority", async () => {
		const ctx = {
			...context([]),
			authType: "tedi",
			apiKey: undefined,
			// Already-authenticated context fixture; its principal type remains tedi.
			user: {
				sub: "tedi-principal",
				scopes: ["platform:admin"],
				permissions: [],
				roles: [],
			},
			tediScopes: ["platform:admin"],
			tediId: "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11",
		} as BaseContext;
		await expect(
			createRouterClient(billingContractRouter, {
				context: ctx,
			}).configureCreditBilling(input),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("never held by a tedi principal"),
		});
		expect(activationStorage).not.toHaveBeenCalled();
	});
});

describe("credit budget authority", () => {
	for (const ctx of [
		context(["billing:read"]),
		{ ...context(["billing:manage"], true), userRole: "member" },
	]) {
		it(`denies credit budget writes for ${ctx.authType}/${ctx.userRole}`, async () => {
			const client = createRouterClient(billingContractRouter, {
				context: ctx as BaseContext,
			});
			await expect(
				client.setCreditBudget({ monthlyCapMicros: 10000 }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});
	}
});

describe("overage opt-in authority", () => {
	beforeEach(() => {
		overageStorage.set.mockReset();
	});
	it("refuses a member without billing:manage", async () => {
		const ctx = { ...context(["billing:manage"], true), userRole: "member" };
		const client = createRouterClient(billingContractRouter, {
			context: ctx as BaseContext,
		});
		await expect(
			client.setOverageSettings({ enabled: true, monthlyCapMicros: 1 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(overageStorage.set).not.toHaveBeenCalled();
	});
	it("refuses an API key without billing:write", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:read"]),
		});
		await expect(
			client.setOverageSettings({ enabled: true, monthlyCapMicros: 1 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(overageStorage.set).not.toHaveBeenCalled();
	});
	it("refuses reading overage settings without billing:read", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context([]),
		});
		await expect(client.getOverageSettings()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rejects enabling without a cap before touching storage", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:manage"], true),
		});
		await expect(
			client.setOverageSettings({ enabled: true, monthlyCapMicros: null }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(overageStorage.set).not.toHaveBeenCalled();
	});
	it("reports an unconfigured billing account for an owner", async () => {
		overageStorage.set.mockResolvedValue(false);
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:manage"], true),
		});
		await expect(
			client.setOverageSettings({ enabled: true, monthlyCapMicros: 5 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(overageStorage.set).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId,
				enabled: true,
				monthlyCapMicros: 5,
			}),
		);
	});
});

/**
 * A tedi could not write its own `budgets` field — that has been owner-held
 * since the capability-tier gate — but `isPlatformPrincipal` answered true for
 * a tedi token carrying `platform:admin`, and granted capacity is added to the
 * same ceiling by the enforcing SQL. That was a second door to raising your own
 * limit, so it is closed on the principal TYPE, which a tedi cannot vary, and
 * not on the scope, which it might be granted.
 */
describe("platform billing authority excludes tedi principals", () => {
	function tedi(tediScopes: string[]): BaseContext {
		return {
			authType: "tedi",
			organizationId,
			tediId: "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11",
			tediScopes,
		} as unknown as BaseContext;
	}

	for (const scopes of [["platform:admin"], ["*"], []]) {
		it(`refuses a tedi carrying ${JSON.stringify(scopes)}`, () => {
			expect(() => requirePlatformBillingAuthority(tedi(scopes))).toThrow(
				/never held by a tedi principal/,
			);
		});
	}

	it("still admits an operator API key holding platform:admin", () => {
		expect(
			requirePlatformBillingAuthority({
				authType: "apikey",
				organizationId,
				apiKey: {
					id: "key",
					name: "platform",
					organizationId,
					scopes: ["platform:admin"],
				},
			} as unknown as BaseContext),
		).toBe("key");
	});

	it("still refuses an API key without platform authority", () => {
		expect(() =>
			requirePlatformBillingAuthority({
				authType: "apikey",
				organizationId,
				apiKey: {
					id: "key",
					name: "tenant",
					organizationId,
					scopes: ["billing:read"],
				},
			} as unknown as BaseContext),
		).toThrow(/Platform billing authority is required/);
	});
});

describe("provider model rate publication authority", () => {
	beforeEach(() => {
		rateStorage.list.mockReset();
		rateStorage.publish.mockReset();
	});
	const rate = {
		provider: "workers-ai",
		modelId: "native/model",
		deploymentScope: "account/region/deployment",
		effectiveFrom: "2099-01-01T00:00:00.000Z",
		inputMicrousdPerMillion: 0,
		outputMicrousdPerMillion: 1,
		cacheReadMicrousdPerMillion: 0,
		cacheWriteMicrousdPerMillion: 0,
		currency: "USD" as const,
		evidenceUri: "https://evidence.test/artifact",
		evidenceDigest: "a".repeat(64),
		verifiedAt: "2026-09-20T00:00:00.000Z",
		changeReason: "reviewed evidence",
		supersedesRateVersionId: null,
	};
	for (const human of [false, true]) {
		it(`denies ordinary tenant list/publication (human=${human})`, async () => {
			const client = createRouterClient(billingContractRouter, {
				context: context(["billing:read", "billing:manage"], human),
			});
			await expect(client.listProviderModelRates({})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(client.publishProviderModelRate(rate)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
			expect(rateStorage.publish).not.toHaveBeenCalled();
			expect(rateStorage.list).not.toHaveBeenCalled();
		});
	}
	it("rejects tedi platform scopes for provider price publication", async () => {
		const ctx = {
			...context(["platform:admin"]),
			authType: "tedi",
			tediId: "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11",
			tediScopes: ["platform:admin"],
		} as BaseContext;
		const client = createRouterClient(billingContractRouter, { context: ctx });
		await expect(client.publishProviderModelRate(rate)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(rateStorage.publish).not.toHaveBeenCalled();
		expect(rateStorage.list).not.toHaveBeenCalled();
	});
	it("records authenticated publisher and server timestamps for platform publication", async () => {
		rateStorage.publish.mockImplementation(async (_db, input) => input);
		const client = createRouterClient(billingContractRouter, {
			context: context(["platform:admin"]),
		});
		const published = await client.publishProviderModelRate(rate);
		expect(published).toMatchObject({ ...rate, publishedBy: "key" });
		expect(published.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Number.isFinite(Date.parse(published.publishedAt))).toBe(true);
		expect(rateStorage.publish).toHaveBeenCalledOnce();
		rateStorage.list.mockResolvedValue([published]);
		expect(await client.listProviderModelRates({ limit: 1 })).toEqual({
			rates: [published],
		});
	});
	it("surfaces a competing interval or stale correction as conflict", async () => {
		rateStorage.publish.mockResolvedValue(null);
		const client = createRouterClient(billingContractRouter, {
			context: context(["platform:admin"]),
		});
		await expect(client.publishProviderModelRate(rate)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});
	it("rejects misspelled rate filters instead of returning an unfiltered page", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["platform:admin"]),
		});
		await expect(
			client.listProviderModelRates({ providerTypo: "workers-ai" } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(rateStorage.list).not.toHaveBeenCalled();
	});
	it.each(["", "   ", "\t\n"])(
		"rejects blank publication scope %j",
		async (deploymentScope) => {
			const client = createRouterClient(billingContractRouter, {
				context: context(["platform:admin"]),
			});
			await expect(
				client.publishProviderModelRate({ ...rate, deploymentScope }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(rateStorage.publish).not.toHaveBeenCalled();
		},
	);
	it.each([
		["disabled", "NOT_FOUND"],
		["unknown", "SERVICE_UNAVAILABLE"],
	])(
		"denies unavailable fleet mode %s before rate storage",
		async (mode, code) => {
			const ctx = context(["platform:admin"]);
			ctx.env.TEDIX_FLEET_AUTHORITY_MODE = mode;
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(client.listProviderModelRates({})).rejects.toMatchObject({
				code,
			});
			await expect(client.publishProviderModelRate(rate)).rejects.toMatchObject(
				{ code },
			);
			expect(rateStorage.list).not.toHaveBeenCalled();
			expect(rateStorage.publish).not.toHaveBeenCalled();
		},
	);
});

const historicalMember = vi.hoisted(() => vi.fn());
vi.mock(
	"@tedix/db/queries/billing/historical-exposure",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/billing/historical-exposure")
		>()),
		getHistoricalBillingMember: historicalMember,
	}),
);
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: async () => null,
}));
describe("historical records require actual human membership, never platform bypass", () => {
	const userId = "00000000-0000-4000-8000-000000000003";
	const audit = { tediId: "00000000-0000-4000-8000-000000000002" };
	for (const authType of [
		"apikey",
		"tedi",
		"m2m",
		"service-binding",
	] as const) {
		it(`rejects ${authType} even with platform/wildcard authority`, async () => {
			historicalMember.mockReset();
			const ctx = {
				...context(
					["platform:admin", "billing:write", "billing:manage", "*"],
					false,
				),
				authType,
			};
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(client.listHistoricalExposures(audit)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
			expect(historicalMember).not.toHaveBeenCalled();
		});
	}
	for (const role of ["owner", "admin"]) {
		it(`admits actual ${role} human to canonical custody check`, async () => {
			historicalMember.mockResolvedValue({
				organizationId,
				userId,
				descopeUserId: "owner",
				role,
				status: "active",
			});
			const ctx = { ...context(["billing:manage"], true), userId };
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(client.listHistoricalExposures(audit)).rejects.toMatchObject(
				{
					code: "CONFLICT",
					message: "Canonical historical custody unavailable",
				},
			);
		});
	}
	for (const member of [
		null,
		{ role: "viewer", userId },
		{ role: "owner", userId: "foreign" },
		{ role: "admin", userId, status: "invited" },
	]) {
		it(`denies stale/foreign member ${JSON.stringify(member)}`, async () => {
			historicalMember.mockResolvedValue(member);
			const client = createRouterClient(billingContractRouter, {
				context: {
					...context(["platform:admin", "billing:manage"], true),
					userId,
				},
			});
			await expect(client.listHistoricalExposures(audit)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
		});
	}
});

describe("historical billing records reject disabled commercial plane", () => {
	it("denies every historical procedure before human membership/storage or audit reads", async () => {
		historicalMember.mockReset();
		const ctx = context(["billing:manage"], true);
		ctx.userId = "00000000-0000-4000-8000-000000000003";
		ctx.env = { ...ctx.env, TEDIX_FLEET_AUTHORITY_MODE: "disabled" };
		const client = createRouterClient(billingContractRouter, { context: ctx });
		const tediId = "00000000-0000-4000-8000-000000000002",
			id = "00000000-0000-4000-8000-000000000003",
			hash = "a".repeat(64);
		const requests = [
			() => client.listHistoricalExposures({ tediId }),
			() =>
				client.recordHistoricalFreshDecision({
					tediId,
					operationId: "decision",
					objectId: hash,
					expectedRevision: 0,
					exposureSetHash: hash,
					permittedGeneration: 2,
					permittedClasses: ["AgentTediDO"],
					funding: {
						accountId: organizationId,
						entitlementVersion: 1,
						settlementMode: "managed",
						billingMode: "internal",
						status: "active",
						planVersionId: id,
						planVersion: 1,
						periodStart: "2026-10-01T00:00:00.000Z",
						periodEnd: "2026-11-01T00:00:00.000Z",
						stripeEnvironment: null,
					},
					expiresAt: "2026-10-20T00:00:00.000Z",
					acknowledgeUnboundedUnknownExposure: true,
				}),
			() =>
				client.revokeHistoricalFreshDecision({
					tediId,
					operationId: "revoke",
					expectedRevision: 1,
					decisionId: id,
				}),
		];
		for (const request of requests)
			await expect(request()).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Fleet authority is disabled for this installation",
			});
		expect(historicalMember).not.toHaveBeenCalled();
	});
});

describe("finite execution revocation human-only routing", () => {
	const userId = "00000000-0000-4000-8000-000000000003",
		tediId = "00000000-0000-4000-8000-000000000002";
	const revoke = {
		kind: "revoke_fresh_execution" as const,
		tediId,
		operationId: "revoke-permit",
		expectedRevision: 1,
		authorizationId: userId,
	};
	for (const authType of ["apikey", "tedi", "m2m", "service-binding"] as const)
		it(`rejects ${authType} despite wildcard/platform scopes`, async () => {
			historicalMember.mockReset();
			const ctx = {
				...context(["*", "platform:admin", "billing:manage", "billing:write"]),
				authType,
			};
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(
				client.revokeHistoricalFreshExecution(revoke),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(historicalMember).not.toHaveBeenCalled();
		});
	for (const role of ["owner", "admin"])
		it(`verified active ${role} reaches real current custody check, not a machine bypass`, async () => {
			historicalMember.mockResolvedValue({
				organizationId,
				userId,
				descopeUserId: "owner",
				role,
				status: "active",
			});
			const client = createRouterClient(billingContractRouter, {
				context: { ...context(["billing:manage"], true), userId },
			});
			await expect(
				client.revokeHistoricalFreshExecution(revoke),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});
	it("disabled fleet denies revocation before membership", async () => {
		historicalMember.mockReset();
		const ctx = { ...context(["billing:manage"], true), userId };
		ctx.env.TEDIX_FLEET_AUTHORITY_MODE = "disabled";
		const client = createRouterClient(billingContractRouter, { context: ctx });
		await expect(
			client.revokeHistoricalFreshExecution(revoke),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(historicalMember).not.toHaveBeenCalled();
	});
});
