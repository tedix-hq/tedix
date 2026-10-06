import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const rateStorage = vi.hoisted(() => ({ list: vi.fn(), publish: vi.fn() }));
vi.mock("@tedix/db/queries/billing/provider-model-rates", () => ({
	listProviderModelRates: rateStorage.list,
	publishProviderModelRate: rateStorage.publish,
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
	const audit = {
		tediId: "00000000-0000-4000-8000-000000000002",
		operationId: "audit",
		rootObjectId: "a".repeat(64),
		objectId: "a".repeat(64),
		targetPath: [],
		expectedGeneration: 1,
		snapshotId: "b".repeat(64),
		sourceHash: "c".repeat(64),
	};
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
			await expect(
				client.recordHistoricalExposure(audit),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
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
			await expect(
				client.recordHistoricalExposure(audit),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "Canonical historical custody unavailable",
			});
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
			await expect(
				client.recordHistoricalExposure(audit),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
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
				client.recordHistoricalExposure({
					tediId,
					operationId: "audit",
					rootObjectId: hash,
					objectId: hash,
					targetPath: [],
					expectedGeneration: 1,
					snapshotId: hash,
					sourceHash: hash,
				}),
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

describe("explicit finite execution authorization human-only routing", () => {
	const userId = "00000000-0000-4000-8000-000000000003",
		tediId = "00000000-0000-4000-8000-000000000002";
	const permit = {
		kind: "authorize_fresh_execution" as const,
		tediId,
		operationId: "permit",
		expectedRevision: 0,
		exposureSetHash: "a".repeat(64),
		freshRootName: "fresh",
		freshRootId: "b".repeat(64),
		preparedGeneration: 1,
		executionGeneration: 2,
		leafScopes: [],
		funding: {
			accountId: organizationId,
			entitlementVersion: 1,
			settlementMode: "managed" as const,
			billingMode: "internal" as const,
			status: "active" as const,
			planVersionId: userId,
			planVersion: 1,
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2026-11-01T00:00:00.000Z",
			stripeEnvironment: null,
		},
		maxSendDurationSeconds: 60,
		expiresAt: "2026-10-05T10:00:00.000Z",
		acknowledgeUnboundedUnknownExposure: true as const,
		acknowledgeOutstandingSendWindowAfterRevocation: true as const,
	};
	const revoke = {
		kind: "revoke_fresh_execution" as const,
		tediId,
		operationId: "revoke-permit",
		expectedRevision: 1,
		authorizationId: userId,
	};
	for (const authType of ["apikey", "tedi", "m2m", "service-binding"] as const)
		it(`rejects ${authType} for both new operations despite wildcard/platform scopes`, async () => {
			historicalMember.mockReset();
			const ctx = {
				...context(["*", "platform:admin", "billing:manage", "billing:write"]),
				authType,
			};
			const client = createRouterClient(billingContractRouter, {
				context: ctx,
			});
			await expect(
				client.authorizeHistoricalFreshExecution(permit),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
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
				client.authorizeHistoricalFreshExecution(permit),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				client.revokeHistoricalFreshExecution(revoke),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});
	it("disabled fleet denies both new operations before membership or private audit", async () => {
		historicalMember.mockReset();
		const ctx = { ...context(["billing:manage"], true), userId };
		ctx.env.TEDIX_FLEET_AUTHORITY_MODE = "disabled";
		const client = createRouterClient(billingContractRouter, { context: ctx });
		await expect(
			client.authorizeHistoricalFreshExecution(permit),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client.revokeHistoricalFreshExecution(revoke),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(historicalMember).not.toHaveBeenCalled();
	});
});
