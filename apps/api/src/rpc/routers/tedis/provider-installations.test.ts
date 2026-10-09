import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { resolveProviderRouteAssertion } from "../../../services/portable-webmcp-profile";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	getWorkspace: vi.fn(),
	getTedi: vi.fn(),
	issue: vi.fn(),
	capacityOverview: vi.fn(),
	billingBalance: vi.fn(),
	countTransfers: vi.fn(),
	transferCapacity: vi.fn(),
	getPolicies: vi.fn(),
	getOrganization: vi.fn(),
	trackWidgetEvent: vi.fn(),
	getInstallation: vi.fn(),
	portableAdmissions: vi.fn(),
	listPortableConfigurations: vi.fn(),
	publishPortableProfile: vi.fn(),
	providerApp: vi.fn(),
	providerKey: vi.fn(),
	findInstallation: vi.fn(),
	createInstallation: vi.fn(),
	ensureCustomer: vi.fn(),
	ensureGateway: vi.fn(),
}));

vi.mock("../../../services/provider-installation-gateway", () => ({
	ensureProviderInstallationGateway: mocks.ensureGateway,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppByIdForOrganization: mocks.providerApp,
}));
vi.mock("@tedix/db/queries/api-keys", () => ({
	getApiKeyById: mocks.providerKey,
}));
vi.mock("../../../services/provider-customer-provisioning", () => ({
	ensureProviderCustomer: mocks.ensureCustomer,
	ensureProviderCustomerForProvider: mocks.ensureCustomer,
}));
vi.mock("@tedix/db/queries/app-gating", () => ({
	getPortableWebMcpToolAdmissions: mocks.portableAdmissions,
}));

vi.mock("@tedix/db/queries/analytics", () => ({
	trackWidgetEvent: mocks.trackWidgetEvent,
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganization,
}));

vi.mock("@tedix/db/queries/billing/capacity-allocations", () => ({
	countSponsoredCapacityTransfers: mocks.countTransfers,
	getInferenceCapacityDailyOverview: mocks.capacityOverview,
	transferSponsoredCapacity: mocks.transferCapacity,
}));
vi.mock("@tedix/db/queries/billing/credits", () => ({
	getBillingBalanceSnapshot: mocks.billingBalance,
}));
vi.mock("@tedix/db/queries/billing/inference-policies", () => ({
	getEffectiveInferencePolicies: mocks.getPolicies,
}));
vi.mock("../../../lib/stripe-environment", () => ({
	resolveStripeEnvironment: vi.fn().mockReturnValue("live"),
}));

vi.mock("@tedix/db/queries/provider-installations", () => ({
	getProviderInstallation: mocks.findInstallation,
	createProviderInstallationIfAbsent: mocks.createInstallation,
	getProviderInstallationById: mocks.getInstallation,
	listProviderPortableWebMcpConfigurations: mocks.listPortableConfigurations,
	publishProviderPortableWebMcpProfile: mocks.publishPortableProfile,
	provisionProviderInstallation: vi.fn(),
	resolveActiveProviderInstallation: mocks.resolve,
	setProviderInstallationPaused: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: mocks.getWorkspace,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.getTedi,
	getTedisByOrganization: async (...args: unknown[]) => {
		const tedi = await mocks.getTedi(...args);
		return tedi ? [tedi] : [];
	},
}));
vi.mock("./gateway", () => ({
	issueEmbeddedSession: mocks.issue,
}));

import { tedisOs } from "./helpers";
import {
	createEmbeddedProviderSessionProcedure,
	provisionProviderInstallationProcedure,
	provisionInstallation,
	getEmbeddedProviderAvailabilityProcedure,
	listPortableWebMcpConfigurationsProcedure,
	publishPortableWebMcpProfileProcedure,
	validatePortableWebMcpProfileProcedure,
} from "./provider-installations";

const PROVIDER_ORG = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ORG = "22222222-2222-4222-8222-222222222222";
const INSTALLATION = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const TEDI = "55555555-5555-4555-8555-555555555555";

const router = tedisOs.router({
	provisionProviderInstallation: provisionProviderInstallationProcedure,
	createEmbeddedProviderSession: createEmbeddedProviderSessionProcedure,
	getEmbeddedProviderAvailability: getEmbeddedProviderAvailabilityProcedure,
	validatePortableWebMcpProfile: validatePortableWebMcpProfileProcedure,
	listPortableWebMcpConfigurations: listPortableWebMcpConfigurationsProcedure,
	publishPortableWebMcpProfile: publishPortableWebMcpProfileProcedure,
});

const portableProfile = {
	version: 1 as const,
	routes: [
		{
			id: "orders",
			match: { routeKey: "orders" },
			tools: [
				{
					callable: "acme_staging.orders_list",
					name: "list_orders",
					description: "List orders",
					inputSchema: {
						type: "object" as const,
						properties: {},
						additionalProperties: false as const,
					},
					annotations: { readOnlyHint: true as const },
				},
			],
		},
	],
};

describe("authenticated provider route assertion", () => {
	const boundRead = {
		...portableProfile.routes[0]!.tools[0]!,
		callable: "acme_staging.orders_get",
		name: "get_order",
		bind: { orderId: "$context.params.orderId" },
	};
	const boundWrite = {
		...boundRead,
		callable: "acme_staging.orders_update",
		name: "update_order",
		bind: { orderId: "$context.entity.id" },
		annotations: { readOnlyHint: false as const },
		action: {
			prepareCallable: "acme_staging.orders_preview_update",
			convergeCallable: "acme_staging.orders_get_after_update",
			confirmationTitle: "Update this order?",
			confirmationLabel: "Update order",
			prepareFields: ["orderId"],
			convergeFields: ["orderId"],
		},
	};
	const routed = {
		version: 1 as const,
		routes: [
			{ id: "orders", match: { pathname: "/orders" }, tools: [boundRead] },
			{
				id: "order_detail",
				match: { pathname: "/orders/:orderId", routeKey: "order-detail" },
				tools: [boundRead, boundWrite],
			},
		],
	};
	const assertion = {
		routeId: "order_detail",
		pathname: "/orders/42",
		routeKey: "order-detail",
		params: { orderId: "42" },
		entity: { type: "order", id: "42" },
	};

	it("signs one route and target for bound reads and confirmed actions", () => {
		const result = resolveProviderRouteAssertion(routed, assertion);
		expect(result?.profile.routes.map((route) => route.id)).toEqual([
			"order_detail",
		]);
		expect(result?.signedRoute.bindings).toEqual({
			"acme_staging.orders_get": { orderId: "42" },
			"acme_staging.orders_update": { orderId: "42" },
			"acme_staging.orders_preview_update": { orderId: "42" },
			"acme_staging.orders_get_after_update": { orderId: "42" },
		});
	});

	it.each([
		{ ...assertion, routeId: "orders" },
		{ ...assertion, pathname: "/orders/43", entity: undefined },
		{ ...assertion, routeKey: "another" },
		{ ...assertion, params: { orderId: "43" } },
		{ ...assertion, pathname: "//orders/42" },
		{ ...assertion, pathname: "/orders/42?orderId=43" },
	])("denies mismatched route or missing target %#", (attempt) => {
		expect(resolveProviderRouteAssertion(routed, attempt)).toBeNull();
	});

	it("denies a confirmed action projection that drops its signed target", () => {
		const unsafe = {
			...routed,
			routes: [
				{
					...routed.routes[1]!,
					tools: [
						boundRead,
						{
							...boundWrite,
							action: { ...boundWrite.action, prepareFields: [] },
						},
					],
				},
			],
		};
		expect(resolveProviderRouteAssertion(unsafe, assertion)).toBeNull();
	});
});

function context(scopes = ["embedded:session"]): BaseContext {
	return {
		apiKey: {
			id: "66666666-6666-4666-8666-666666666666",
			name: "Acme embedded sessions",
			organizationId: PROVIDER_ORG,
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: PROVIDER_ORG,
		rateLimiter: {} as RateLimit,
		url: new URL("https://api.test/rpc"),
	};
}

function input(externalTenantId = "1") {
	return {
		externalTenantId,
		conversationId: "77777777-7777-4777-8777-777777777777",
		hostOrganizationLabel: "Globex",
		hostRole: "owner",
		hostUserId: "1",
		hostUserLabel: "Owner",
	};
}

describe("provider embedded session exchange", () => {
	it("checks provider-key scoped availability without creating sessions or usage", async () => {
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.getEmbeddedProviderAvailability({
				externalTenantId: "1",
				hostUserId: "42",
			}),
		).resolves.toEqual({ enabled: true });
		expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), {
			providerOrganizationId: PROVIDER_ORG,
			providerApiKeyId: "66666666-6666-4666-8666-666666666666",
			externalTenantId: "1",
		});
		expect(mocks.issue).not.toHaveBeenCalled();
		expect(mocks.transferCapacity).not.toHaveBeenCalled();
		mocks.resolve.mockResolvedValue(null);
		await expect(
			client.getEmbeddedProviderAvailability({
				externalTenantId: "8042",
				hostUserId: "42",
			}),
		).resolves.toEqual({ enabled: false });
	});
	it("rejects a broad credential for availability", async () => {
		const client = createRouterClient(router, { context: context(["*"]) });
		await expect(
			client.getEmbeddedProviderAvailability({
				externalTenantId: "1",
				hostUserId: "42",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it("denies excluded users before issuing a session or allocating capacity", async () => {
		const existing = await mocks.resolve();
		mocks.resolve.mockResolvedValue({
			...existing,
			provenance: {
				widgetAccess: {
					revision: 1,
					updatedAt: "2026-09-11",
					updatedBy: "admin",
					policy: {
						version: 1,
						enabled: true,
						users: "all",
						allowedUserIds: [],
						deniedUserIds: ["1"],
					},
				},
			},
		});
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.getEmbeddedProviderAvailability({
				externalTenantId: "1",
				hostUserId: "1",
			}),
		).resolves.toEqual({ enabled: false });
		await expect(
			client.createEmbeddedProviderSession(input()),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.issue).not.toHaveBeenCalled();
		expect(mocks.transferCapacity).not.toHaveBeenCalled();
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.resolve.mockResolvedValue({
			id: INSTALLATION,
			providerOrganizationId: PROVIDER_ORG,
			providerApiKeyId: "66666666-6666-4666-8666-666666666666",
			providerAppId: "88888888-8888-4888-8888-888888888888",
			externalTenantId: "1",
			customerOrganizationId: CUSTOMER_ORG,
			primaryWorkspaceId: WORKSPACE,
			primaryTediId: TEDI,
			allowedOrigin: "https://staging.acme.example",
			hostTenantArgument: "companyId",
			hostTenantNamespace: "acme_staging",
			status: "active",
		});
		mocks.getWorkspace.mockResolvedValue({ id: WORKSPACE, status: "active" });
		mocks.getTedi.mockResolvedValue({
			id: TEDI,
			name: "Operator",
			organizationId: CUSTOMER_ORG,
			status: "active",
			retiredAt: null,
		});
		mocks.getOrganization.mockResolvedValue({
			id: PROVIDER_ORG,
			metadata: null,
		});
		mocks.issue.mockResolvedValue({
			token: "browser-token",
			expiresAt: 1_800_000_000_000,
			actorCacheKey: "actor:globex-user-1",
			sessionKey: "embed:session",
			streamUrl: "https://globex-operator.tedi.tedix.dev/chat/stream",
		});
		mocks.capacityOverview.mockResolvedValue({
			budgetDay: "2026-08-31",
			usedTokens: 0,
			usedSpendMicros: 0,
			allocatedTokens: 0,
			allocatedSpendMicros: 0,
			earliestExpiryAt: null,
		});
		mocks.billingBalance.mockResolvedValue({
			status: "active",
			allowOverage: true,
			billingMode: "internal",
			isSponsoredCustomer: true,
			stripeEnvironment: "live",
			stripeCustomerId: null,
		});
		mocks.countTransfers.mockResolvedValue(0);
		mocks.getPolicies.mockResolvedValue({
			organization: {
				dailyTokenLimit: 5_000_000,
				dailySpendLimitMicros: 25_000_000,
			},
			tediFound: true,
		});
		mocks.transferCapacity.mockResolvedValue({});
		mocks.trackWidgetEvent.mockResolvedValue(undefined);
		mocks.portableAdmissions.mockResolvedValue([]);
		mocks.getInstallation.mockResolvedValue({
			id: INSTALLATION,
			providerOrganizationId: PROVIDER_ORG,
			providerAppId: "88888888-8888-4888-8888-888888888888",
			hostTenantNamespace: "acme_staging",
		});
		mocks.listPortableConfigurations.mockResolvedValue([]);
		mocks.publishPortableProfile.mockResolvedValue({
			installationId: INSTALLATION,
			revision: 1,
			profile: portableProfile,
		});
	});

	it("derives the target and security constraints from the installation", async () => {
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.createEmbeddedProviderSession(input()),
		).resolves.toEqual({
			analyticsEnabled: false,
			tediSelection: {
				defaultTediId: TEDI,
				selectedTediId: TEDI,
				tedis: [{ id: TEDI, name: "Operator" }],
			},
			installationId: INSTALLATION,
			workspaceId: WORKSPACE,
			token: "browser-token",
			expiresAt: 1_800_000_000_000,
			actorCacheKey: "actor:globex-user-1",
			sessionKey: "embed:session",
			streamUrl: "https://globex-operator.tedi.tedix.dev/chat/stream",
		});
		expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), {
			providerOrganizationId: PROVIDER_ORG,
			providerApiKeyId: "66666666-6666-4666-8666-666666666666",
			externalTenantId: "1",
		});
		expect(mocks.issue).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: TEDI }),
			expect.objectContaining({
				allowedOrigin: "https://staging.acme.example",
				hostOrganizationId: "1",
				hostTenantArgument: "companyId",
				hostTenantNamespace: "acme_staging",
				providerAppId: "88888888-8888-4888-8888-888888888888",
				providerInstallationId: INSTALLATION,
			}),
		);
		expect(mocks.trackWidgetEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: CUSTOMER_ORG,
				appId: "88888888-8888-4888-8888-888888888888",
				sessionId: "embed:session",
				eventType: "embedded_session_started",
				metadata: expect.objectContaining({
					installationId: INSTALLATION,
					hostOrganizationId: "1",
					hostUserId: "1",
				}),
			}),
		);
		expect(mocks.billingBalance).not.toHaveBeenCalled();
	});

	it("forwards a valid installation turn quota and drops a malformed one", async () => {
		const existing = await mocks.resolve();
		mocks.resolve.mockResolvedValue({
			...existing,
			provenance: { turnQuota: { visitorTurnsPerHour: 12 } },
		});
		const client = createRouterClient(router, { context: context() });
		await client.createEmbeddedProviderSession(input());
		expect(mocks.issue).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ turnQuota: { visitorTurnsPerHour: 12 } }),
		);
		mocks.resolve.mockResolvedValue({
			...existing,
			provenance: { turnQuota: { visitorTurnsPerHour: 0 } },
		});
		await client.createEmbeddedProviderSession(input());
		expect(mocks.issue).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ turnQuota: undefined }),
		);
	});

	it("denies an unmapped Acme tenant instead of inheriting Globex", async () => {
		mocks.resolve.mockResolvedValue(undefined);
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.createEmbeddedProviderSession(input("8042")),
		).rejects.toThrow(/No active embedded Tedi installation/);
		expect(mocks.issue).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"returns provider analytics policy %s in the authenticated session",
		async (analyticsEnabled) => {
			mocks.getOrganization.mockResolvedValue({
				id: PROVIDER_ORG,
				metadata: { tediWidget: { analyticsEnabled } },
			});
			const client = createRouterClient(router, { context: context() });
			await expect(
				client.createEmbeddedProviderSession(input()),
			).resolves.toMatchObject({ analyticsEnabled });
		},
	);

	it("requires the dedicated exact API-key scope", async () => {
		const client = createRouterClient(router, {
			context: context(["tedis:write"]),
		});
		await expect(client.createEmbeddedProviderSession(input())).rejects.toThrow(
			/Exact API-key scope required: embedded:session/,
		);
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it("admits a configured route tool only from the installed read-only catalog", async () => {
		mocks.getOrganization.mockResolvedValue({
			id: PROVIDER_ORG,
			metadata: { tediWidget: { webMcpProfile: portableProfile } },
		});
		mocks.portableAdmissions.mockResolvedValue([
			{ toolId: "orders_list", writeCapability: "read" },
		]);
		const client = createRouterClient(router, { context: context() });
		await client.createEmbeddedProviderSession(input());
		expect(mocks.issue).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ webMcpProfile: portableProfile }),
		);
	});

	it("passes only the authenticated provider's asserted route to session signing", async () => {
		const multiRoute = {
			version: 1 as const,
			routes: [
				...portableProfile.routes,
				{
					id: "order_detail",
					match: { pathname: "/orders/:orderId" },
					tools: [
						{
							...portableProfile.routes[0]!.tools[0]!,
							callable: "acme_staging.orders_get",
							name: "get_order",
							bind: { orderId: "$route.orderId" },
						},
					],
				},
			],
		};
		mocks.getOrganization.mockResolvedValue({
			id: PROVIDER_ORG,
			metadata: { tediWidget: { webMcpProfile: multiRoute } },
		});
		mocks.portableAdmissions.mockResolvedValue([
			{ toolId: "orders_list", writeCapability: "read" },
			{ toolId: "orders_get", writeCapability: "read" },
		]);
		const client = createRouterClient(router, { context: context() });
		await client.createEmbeddedProviderSession({
			...input(),
			portableRouteAssertion: {
				routeId: "order_detail",
				pathname: "/orders/42",
			},
		});
		expect(mocks.issue).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				webMcpProfile: { version: 1, routes: [multiRoute.routes[1]] },
				portableRoute: expect.objectContaining({
					id: "order_detail",
					bindings: { "acme_staging.orders_get": { orderId: "42" } },
				}),
			}),
		);
		mocks.issue.mockClear();
		const installation = await mocks.resolve();
		mocks.resolve.mockResolvedValue({
			...installation,
			provenance: { portableRouteAssertionRequired: true },
		});
		await expect(
			client.createEmbeddedProviderSession(input()),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.issue).not.toHaveBeenCalled();
		await expect(
			client.createEmbeddedProviderSession({
				...input(),
				portableRouteAssertion: { routeId: "orders", pathname: "/orders/42" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.issue).not.toHaveBeenCalled();
	});

	it("returns provider-scoped validation diagnostics without granting authority", async () => {
		mocks.portableAdmissions.mockResolvedValue([
			{ toolId: "orders_list", writeCapability: null },
		]);
		const client = createRouterClient(router, {
			context: context(["apps:read"]),
		});
		await expect(
			client.validatePortableWebMcpProfile({
				installationId: INSTALLATION,
				profile: portableProfile,
			}),
		).resolves.toEqual({
			valid: false,
			admittedCallables: [],
			diagnostics: [
				{
					callable: "acme_staging.orders_list",
					status: "rejected",
					reason: "not_declared_read_only",
				},
			],
		});
		expect(mocks.getInstallation).toHaveBeenCalledWith(expect.anything(), {
			organizationId: PROVIDER_ORG,
			installationId: INSTALLATION,
		});
	});

	it("lists only admitted catalog tools and publishes a validated revision", async () => {
		mocks.listPortableConfigurations.mockResolvedValue([
			{
				installationId: INSTALLATION,
				providerAppId: "88888888-8888-4888-8888-888888888888",
				externalTenantId: "1",
				hostTenantNamespace: "acme_staging",
				hostTenantArgument: "companyId",
				revision: 0,
				profile: null,
				history: [],
			},
		]);
		mocks.portableAdmissions.mockResolvedValue([
			{
				toolId: "orders_list",
				title: "Orders",
				description: "List orders",
				inputSchema: {
					type: "object",
					properties: { companyId: { type: "string" } },
				},
				writeCapability: "read",
			},
			{
				toolId: "orders_delete",
				title: "Delete",
				description: "Delete order",
				inputSchema: { type: "object" },
				writeCapability: "destructive",
			},
		]);
		const readClient = createRouterClient(router, {
			context: context(["apps:read"]),
		});
		await expect(
			readClient.listPortableWebMcpConfigurations(),
		).resolves.toEqual([
			expect.objectContaining({
				installationId: INSTALLATION,
				activation: {
					status: "unconfigured",
					routeCount: 0,
					admittedToolCount: 0,
					rejectedToolCount: 0,
					reasonCodes: ["profile_missing"],
				},
				eligibleTools: [
					expect.objectContaining({
						callable: "acme_staging.orders_list",
						inputSchema: { type: "object", properties: {} },
					}),
				],
			}),
		]);
		const writeClient = createRouterClient(router, {
			context: context(["apps:write"]),
		});
		await expect(
			writeClient.publishPortableWebMcpProfile({
				installationId: INSTALLATION,
				expectedRevision: 0,
				profile: portableProfile,
				changeSummary: "Initial routes",
			}),
		).resolves.toEqual({
			installationId: INSTALLATION,
			revision: 1,
			profile: portableProfile,
		});
	});

	it("replenishes a configured customer from the resolved provider before issuing a session", async () => {
		mocks.resolve.mockResolvedValueOnce({
			...(await mocks.resolve.getMockImplementation()?.()),
			id: INSTALLATION,
			providerOrganizationId: PROVIDER_ORG,
			providerApiKeyId: "66666666-6666-4666-8666-666666666666",
			providerAppId: "88888888-8888-4888-8888-888888888888",
			externalTenantId: "1",
			customerOrganizationId: CUSTOMER_ORG,
			primaryWorkspaceId: WORKSPACE,
			primaryTediId: TEDI,
			allowedOrigin: "https://staging.acme.example",
			hostTenantArgument: "companyId",
			hostTenantNamespace: "acme_staging",
			status: "active",
			provenance: {
				sponsoredCapacity: {
					enabled: true,
					budgetRevision: 2,
					maxTransfersPerBudgetDay: 3,
					lowWatermarkTokens: 10_000,
					lowWatermarkSpendMicros: 50_000,
					transferTokens: 100_000,
					transferSpendMicros: 500_000,
				},
			},
		});
		const client = createRouterClient(router, { context: context() });
		await client.createEmbeddedProviderSession(input());
		expect(mocks.transferCapacity).toHaveBeenCalledWith(expect.anything(), {
			transferId: `${INSTALLATION}:2026-08-31:r2:1`,
			sponsorOrganizationId: PROVIDER_ORG,
			customerOrganizationId: CUSTOMER_ORG,
			providerInstallationId: INSTALLATION,
			budgetRevision: 2,
			budgetDay: "2026-08-31",
			tokenAmount: 100_000,
			spendAmountMicros: 500_000,
			customerLowWatermarkTokens: 10_000,
			customerLowWatermarkSpendMicros: 50_000,
			sponsorDailyTokenLimit: 5_000_000,
			sponsorDailySpendLimitMicros: 25_000_000,
			stripeEnvironment: "live",
			expiresAt: "2026-09-01T00:00:00.000Z",
			createdAt: expect.any(String),
		});
		expect(mocks.transferCapacity.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.issue.mock.invocationCallOrder[0]!,
		);
	});

	it("skips obsolete sponsorship for a self-funded embedded customer before parsing policy", async () => {
		mocks.billingBalance.mockResolvedValueOnce({
			status: "active",
			allowOverage: true,
			billingMode: "internal",
			isSponsoredCustomer: false,
			stripeEnvironment: "live",
			stripeCustomerId: null,
		});
		mocks.resolve.mockResolvedValueOnce({
			...(await mocks.resolve.getMockImplementation()?.()),
			provenance: {
				sponsoredCapacity: { enabled: true, budgetRevision: -1 },
			},
		});
		const client = createRouterClient(router, { context: context() });
		await client.createEmbeddedProviderSession(input());
		expect(mocks.issue).toHaveBeenCalledOnce();
		expect(mocks.capacityOverview).not.toHaveBeenCalled();
		expect(mocks.transferCapacity).not.toHaveBeenCalled();
	});

	it("fails closed after the bounded daily allowance is exhausted", async () => {
		mocks.resolve.mockResolvedValueOnce({
			...(await mocks.resolve.getMockImplementation()?.()),
			provenance: {
				sponsoredCapacity: {
					enabled: true,
					budgetRevision: 4,
					maxTransfersPerBudgetDay: 2,
					lowWatermarkTokens: 10_000,
					lowWatermarkSpendMicros: 50_000,
					transferTokens: 100_000,
					transferSpendMicros: 500_000,
				},
			},
		});
		mocks.countTransfers.mockResolvedValueOnce(2);
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.createEmbeddedProviderSession(input()),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "Provider-sponsored inference capacity is unavailable",
			data: { reason: "capacity_unavailable", retryable: true },
		});
		expect(mocks.countTransfers).toHaveBeenCalledWith(expect.anything(), {
			customerOrganizationId: CUSTOMER_ORG,
			providerInstallationId: INSTALLATION,
			budgetRevision: 4,
			budgetDay: "2026-08-31",
			stripeEnvironment: "live",
		});
		expect(mocks.transferCapacity).not.toHaveBeenCalled();
		expect(mocks.issue).not.toHaveBeenCalled();
	});

	it.each(["allowance exhausted", "transfer failed"])(
		"uses remaining credit below refill watermarks when %s",
		async (failure) => {
			mocks.resolve.mockResolvedValueOnce({
				...(await mocks.resolve.getMockImplementation()?.()),
				provenance: {
					sponsoredCapacity: {
						enabled: true,
						budgetRevision: 1,
						maxTransfersPerBudgetDay: 1,
						lowWatermarkTokens: 250_000,
						lowWatermarkSpendMicros: 1_000_000,
						transferTokens: 1_000_000,
						transferSpendMicros: 5_000_000,
					},
				},
			});
			mocks.capacityOverview.mockResolvedValue({
				budgetDay: "2026-08-31",
				allocatedTokens: 1_000_000,
				usedTokens: 755_848,
				allocatedSpendMicros: 5_000_000,
				usedSpendMicros: 444_317,
				earliestExpiryAt: null,
			});
			mocks.countTransfers.mockResolvedValue(
				failure === "allowance exhausted" ? 1 : 0,
			);
			mocks.transferCapacity.mockRejectedValue(
				new Error("Sponsor has insufficient active inference capacity"),
			);
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const client = createRouterClient(router, { context: context() });
				await expect(
					client.createEmbeddedProviderSession(input()),
				).resolves.toMatchObject({ sessionKey: "embed:session" });
				expect(mocks.issue).toHaveBeenCalledOnce();
				expect(mocks.capacityOverview).toHaveBeenCalledTimes(2);
				if (failure === "allowance exhausted")
					expect(mocks.transferCapacity).not.toHaveBeenCalled();
				else
					expect(log).toHaveBeenCalledWith(
						"Embedded sponsored-capacity transfer failed",
						expect.objectContaining({ installationId: INSTALLATION }),
					);
			} finally {
				log.mockRestore();
			}
		},
	);

	it.each([
		[0, 100],
		[-1, 100],
		[100, 0],
		[100, -1],
	])(
		"denies unavailable capacity even with zero refill thresholds (%s tokens, %s spend)",
		async (tokens, spend) => {
			mocks.resolve.mockResolvedValueOnce({
				...(await mocks.resolve.getMockImplementation()?.()),
				provenance: {
					sponsoredCapacity: {
						enabled: true,
						budgetRevision: 1,
						maxTransfersPerBudgetDay: 1,
						lowWatermarkTokens: 0,
						lowWatermarkSpendMicros: 0,
						transferTokens: 1_000_000,
						transferSpendMicros: 5_000_000,
					},
				},
			});
			mocks.capacityOverview.mockResolvedValue({
				budgetDay: "2026-08-31",
				allocatedTokens: 100,
				usedTokens: 100 - tokens,
				allocatedSpendMicros: 100,
				usedSpendMicros: 100 - spend,
				earliestExpiryAt: null,
			});
			mocks.countTransfers.mockResolvedValue(1);
			const client = createRouterClient(router, { context: context() });
			await expect(
				client.createEmbeddedProviderSession(input()),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			expect(mocks.issue).not.toHaveBeenCalled();
			expect(mocks.transferCapacity).not.toHaveBeenCalled();
		},
	);

	it("uses capacity replenished by a concurrent session at the transfer limit", async () => {
		mocks.resolve.mockResolvedValueOnce({
			...(await mocks.resolve.getMockImplementation()?.()),
			provenance: {
				sponsoredCapacity: {
					enabled: true,
					budgetRevision: 5,
					maxTransfersPerBudgetDay: 1,
					lowWatermarkTokens: 10_000,
					lowWatermarkSpendMicros: 50_000,
					transferTokens: 100_000,
					transferSpendMicros: 500_000,
				},
			},
		});
		mocks.countTransfers.mockResolvedValueOnce(1);
		mocks.capacityOverview
			.mockResolvedValueOnce({
				budgetDay: "2026-08-31",
				usedTokens: 0,
				usedSpendMicros: 0,
				allocatedTokens: 0,
				allocatedSpendMicros: 0,
				earliestExpiryAt: null,
			})
			.mockResolvedValueOnce({
				budgetDay: "2026-08-31",
				usedTokens: 0,
				usedSpendMicros: 0,
				allocatedTokens: 100_000,
				allocatedSpendMicros: 500_000,
				earliestExpiryAt: "2026-09-01T00:00:00.000Z",
			});
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.createEmbeddedProviderSession(input()),
		).resolves.toEqual(
			expect.objectContaining({ sessionKey: "embed:session" }),
		);
		expect(mocks.capacityOverview).toHaveBeenCalledTimes(2);
		expect(mocks.transferCapacity).not.toHaveBeenCalled();
		expect(mocks.issue).toHaveBeenCalledOnce();
	});
});

describe("automatic installation admission", () => {
	const request = {
		providerOrganizationId: PROVIDER_ORG,
		providerAppId: "88888888-8888-4888-8888-888888888888",
		providerApiKeyId: "66666666-6666-4666-8666-666666666666",
		externalTenantId: "8042",
		allowedOrigin: "https://staging.acme.example",
		hostTenantArgument: "companyId",
		hostTenantNamespace: "acme_staging",
		customer: {
			name: "Garage",
			billingPlanKey: "business" as const,
			sponsoredCapacity: {
				enabled: true,
				budgetRevision: 1,
				maxTransfersPerBudgetDay: 1,
				lowWatermarkTokens: 250000,
				lowWatermarkSpendMicros: 1000000,
				transferTokens: 1000000,
				transferSpendMicros: 5000000,
			},
		},
	};
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.providerApp.mockResolvedValue({ id: request.providerAppId });
		mocks.providerKey.mockResolvedValue({
			organizationId: PROVIDER_ORG,
			status: "active",
			environment: "live",
			scopes: ["embedded:session"],
		});
	});
	it("does not let the host session key create customer organizations", async () => {
		const client = createRouterClient(router, { context: context() });
		await expect(
			client.provisionProviderInstallation(request),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.ensureCustomer).not.toHaveBeenCalled();
	});
	it.each(["paused", "active"])(
		"repairs an existing %s installation without replacing its specification",
		async (status) => {
			const existing = {
				id: INSTALLATION,
				providerOrganizationId: PROVIDER_ORG,
				providerAppId: request.providerAppId,
				providerApiKeyId: request.providerApiKeyId,
				externalTenantId: "8042",
				customerOrganizationId: CUSTOMER_ORG,
				primaryWorkspaceId: WORKSPACE,
				primaryTediId: TEDI,
				allowedOrigin: request.allowedOrigin,
				hostTenantArgument: "companyId",
				hostTenantNamespace: "acme_staging",
				status,
				provisionedBy: "test",
				provenance: null,
				createdAt: "2026-09-01T00:00:00Z",
				updatedAt: "2026-09-01T00:00:00Z",
				pausedAt: "2026-09-01T00:00:00Z",
			};
			mocks.findInstallation.mockResolvedValue(existing);
			const client = createRouterClient(router, {
				context: context(["platform:admin"]),
			});
			expect(await client.provisionProviderInstallation(request)).toEqual(
				existing,
			);
			// The provider console uses the same early-return path, never overwriting audience or pause.
			const providerContext = {
				...context(),
				authType: "user" as const,
				apiKey: undefined,
				user: { sub: "provider-admin" },
			} as BaseContext;
			expect(
				await provisionInstallation(
					providerContext,
					{
						...request,
						provenance: { widgetAccess: { attempted: "replacement" } },
					},
					true,
				),
			).toEqual(existing);
			expect(mocks.ensureCustomer).not.toHaveBeenCalled();
			expect(mocks.createInstallation).not.toHaveBeenCalled();
			expect(mocks.ensureGateway).toHaveBeenCalledWith(
				expect.anything(),
				existing,
			);
		},
	);
	it("rejects mixed automatic and existing resource inputs", async () => {
		const client = createRouterClient(router, {
			context: context(["platform:admin"]),
		});
		await expect(
			client.provisionProviderInstallation({
				...request,
				customerOrganizationId: CUSTOMER_ORG,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.ensureCustomer).not.toHaveBeenCalled();
	});
});
