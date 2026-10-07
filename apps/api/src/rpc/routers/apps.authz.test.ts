import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { appsContractRouter } from "./apps";

const gatewayMocks = vi.hoisted(() => ({
	appById: vi.fn(),
	records: vi.fn(),
	gateways: vi.fn(),
	bundleSummary: vi.fn(),
	write: vi.fn(),
}));
vi.mock("@tedix/db/queries/apps", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getAppsByOrganization: gatewayMocks.records,
}));
vi.mock("@tedix/db/queries/organization-members", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getOrganizationAggregatorGateways: gatewayMocks.gateways,
}));
vi.mock("@tedix/db/queries/tenant-bundles", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getTenantBundleSummary: gatewayMocks.bundleSummary,
}));
vi.mock("@tedix/db/queries/app-records", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getAppById: gatewayMocks.appById,
	setAppGatewayMembership: gatewayMocks.write,
}));

const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

function userContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/apps"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: "org-1",
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/apps"),
	} as BaseContext;
}

describe("apps authorization-plane composition", () => {
	it("rejects a user without apps:read from a public read", async () => {
		const client = createRouterClient(appsContractRouter, {
			context: userContext([]),
		});

		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects an API key without apps:read from a public read", async () => {
		const client = createRouterClient(appsContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects read-only users and API keys from config-version writes", async () => {
		const input = { appId: APP_ID, config: {} };
		const userClient = createRouterClient(appsContractRouter, {
			context: userContext(["apps:read"]),
		});
		const apiKeyClient = createRouterClient(appsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(userClient.createConfigVersion(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(apiKeyClient.createConfigVersion(input)).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
	});
});

describe("gateway membership authorization", () => {
	it("requires write authority on both user and API-key planes", async () => {
		for (const context of [
			userContext(["apps:read"]),
			apiKeyContext(["apps:read"]),
		]) {
			const client = createRouterClient(appsContractRouter, { context });
			await expect(
				client.setGatewayMembership({ appId: APP_ID, enabled: true }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
});

describe("tenant gateway membership", () => {
	const gatewayId = "841351cc-cbec-413c-bdc3-c313c118f39d";
	const gateway = {
		id: gatewayId,
		name: "Gateway",
		slug: "org-unified",
		metadata: { mcpConfig: {} },
	};
	const installed = {
		id: APP_ID,
		slug: "initech-org",
		catalogAppId: "catalog",
		sourceAppId: "base",
		visibility: "private",
	};
	beforeEach(() => {
		gatewayMocks.records.mockReset().mockResolvedValue([gateway, installed]);
		gatewayMocks.gateways
			.mockReset()
			.mockResolvedValue(new Map([["org-1", { slug: "org-unified" }]]));
		gatewayMocks.write.mockReset().mockResolvedValue([{ id: gatewayId }]);
	});
	const client = () =>
		createRouterClient(appsContractRouter, {
			context: userContext(["apps:read", "apps:update"]),
		});
	it("resolves only the caller's canonical gateway and installed app", async () => {
		await expect(
			client().getGatewayMembership({ appId: APP_ID }),
		).resolves.toEqual({
			gateway: { id: gatewayId, name: "Gateway", slug: "org-unified" },
			enabled: false,
			unavailableReason: null,
		});
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: true }),
		).resolves.toEqual({ success: true });
		expect(gatewayMocks.records).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
		);
		expect(gatewayMocks.write).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			gatewayId,
			{ appId: APP_ID, slug: "initech-org" },
			true,
		);
	});
	it("lists every installed app membership in one tenant-scoped read", async () => {
		gatewayMocks.records.mockResolvedValue([
			{
				...gateway,
				metadata: {
					mcpConfig: { aggregateApps: [{ slug: installed.slug }] },
				},
			},
			installed,
		]);
		await expect(client().listGatewayMemberships({})).resolves.toEqual({
			gateway: { id: gatewayId, name: "Gateway", slug: "org-unified" },
			memberships: [
				{ appId: gatewayId, enabled: false },
				{ appId: APP_ID, enabled: true },
			],
		});
		expect(gatewayMocks.records).toHaveBeenCalledTimes(1);
		expect(gatewayMocks.gateways).toHaveBeenCalledTimes(1);
	});
	it("rejects a foreign or missing app and self-inclusion", async () => {
		gatewayMocks.records.mockResolvedValue([gateway]);
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client().setGatewayMembership({ appId: gatewayId, enabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(gatewayMocks.write).not.toHaveBeenCalled();
	});
	it("reports missing gateway without claiming the app is included", async () => {
		gatewayMocks.gateways.mockResolvedValue(new Map());
		const state = await client().getGatewayMembership({ appId: APP_ID });
		expect(state.gateway).toBeNull();
		expect(state.enabled).toBe(false);
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("rejects a catalog proxy that already references the tenant gateway", async () => {
		gatewayMocks.records.mockResolvedValue([
			gateway,
			{
				...installed,
				metadata: { mcpConfig: { aggregateApps: [{ slug: gateway.slug }] } },
			},
		]);
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(gatewayMocks.write).not.toHaveBeenCalled();
	});
	it("allows removal of a disabled app but rejects enabling it", async () => {
		gatewayMocks.records.mockResolvedValue([
			gateway,
			{ ...installed, visibility: "disabled" },
		]);
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client().setGatewayMembership({ appId: APP_ID, enabled: false }),
		).resolves.toEqual({ success: true });
	});
});
