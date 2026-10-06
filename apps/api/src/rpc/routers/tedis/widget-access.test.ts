import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_EMBEDDED_WIDGET_ACCESS } from "@tedix/api-contract/schemas/embedded-widget-access";
import type { BaseContext } from "../../orpc";
import { tedisOs } from "./helpers";
import {
	listWidgetAccessConfigurations,
	updateWidgetAccessConfiguration,
	previewWidgetAccess,
	authorizeEmbeddedWidgetAccess,
} from "./widget-access";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	tedis: vi.fn(),
	tedi: vi.fn(),
	gateway: vi.fn(),
	organization: vi.fn(),
	update: vi.fn(),
	get: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTedisByOrganization: mocks.tedis,
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("../../../services/provider-installation-gateway", () => ({
	ensureProviderInstallationGateway: mocks.gateway,
}));
vi.mock("@tedix/db/queries/provider-installations", () => ({
	listProviderWidgetInstallations: mocks.list,
	updateProviderWidgetAccess: mocks.update,
	getProviderInstallationById: mocks.get,
	resolveActiveProviderInstallationForOutcome: mocks.resolve,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
}));
const router = tedisOs.router({
	listWidgetAccessConfigurations,
	updateWidgetAccessConfiguration,
	previewWidgetAccess,
	authorizeEmbeddedWidgetAccess,
});
const id = "33333333-3333-4333-8333-333333333333";
const appId = "88888888-8888-4888-8888-888888888888";
const row = {
	id,
	primaryTediId: "44444444-4444-4444-8444-444444444444",
	customerOrganizationId: "customer-8042",
	externalTenantId: "8042",
	allowedOrigin: "https://staging.acme.example",
	status: "active",
	provenance: null,
};
const policy = { ...DEFAULT_EMBEDDED_WIDGET_ACCESS, enabled: false };
function context(authType: "user" | "apikey", grants: string[]): BaseContext {
	return {
		authType,
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		organizationId: "provider-1",
		url: new URL("https://api.test/rpc"),
		...(authType === "user"
			? {
					user: {
						sub: "admin",
						permissions: grants,
						roles: [],
						aud: "test",
						dct: "tenant",
						exp: 2,
						iat: 1,
						iss: "test",
					},
				}
			: {
					apiKey: {
						id: "key",
						name: "test",
						organizationId: "provider-1",
						scopes: grants,
					},
				}),
	} as BaseContext;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.tedis.mockResolvedValue([
		{
			id: row.primaryTediId,
			name: "Operator",
			status: "active",
			retiredAt: null,
		},
	]);
	mocks.tedi.mockResolvedValue({
		id: row.primaryTediId,
		status: "active",
		retiredAt: null,
	});
	mocks.get.mockResolvedValue(row);
	mocks.update.mockResolvedValue(row);
	mocks.resolve.mockResolvedValue(row);
});
describe("provider widget access", () => {
	it("resolves business names only from provider-owned installations", async () => {
		mocks.list.mockResolvedValue([
			{ ...row, customerOrganizationId: "customer-8042" },
		]);
		mocks.organization.mockResolvedValue({ name: "Acme" });
		const client = createRouterClient(router, {
			context: context("user", ["apps:read"]),
		});
		const result = await client.listWidgetAccessConfigurations({});
		expect(mocks.list).toHaveBeenCalledWith({}, "provider-1");
		expect(mocks.organization).toHaveBeenCalledWith({}, "customer-8042");
		expect(result.data[0]?.businessName).toBe("Acme");
	});
	it("requires settings authority for people and write scope for API keys", async () => {
		for (const ctx of [
			context("user", ["apps:read"]),
			context("apikey", ["apps:read"]),
		]) {
			const client = createRouterClient(router, { context: ctx });
			await expect(
				client.updateWidgetAccessConfiguration({
					installationId: id,
					expectedRevision: 0,
					policy,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("derives ownership from the authenticated provider", async () => {
		const client = createRouterClient(router, {
			context: context("user", ["settings:manage", "apps:read"]),
		});
		await client.updateWidgetAccessConfiguration({
			installationId: id,
			expectedRevision: 0,
			policy,
		});
		expect(mocks.update).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				organizationId: "provider-1",
				updatedBy: "admin",
			}),
		);
		mocks.get.mockResolvedValue(undefined);
		await expect(
			client.previewWidgetAccess({ installationId: id, hostUserId: "6190" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("rejects a selection outside the customer roster before provisioning or saving", async () => {
		const client = createRouterClient(router, {
			context: context("user", ["settings:manage", "apps:read"]),
		});
		const foreign = "55555555-5555-4555-8555-555555555555";
		await expect(
			client.updateWidgetAccessConfiguration({
				installationId: id,
				expectedRevision: 0,
				policy: {
					...policy,
					tediSelection: { defaultTediId: foreign, allowedTediIds: [foreign] },
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.gateway).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("does not publish a choice when gateway preparation fails", async () => {
		const client = createRouterClient(router, {
			context: context("user", ["settings:manage", "apps:read"]),
		});
		mocks.gateway.mockRejectedValueOnce(new Error("gateway unavailable"));
		await expect(
			client.updateWidgetAccessConfiguration({
				installationId: id,
				expectedRevision: 0,
				policy: {
					...policy,
					tediSelection: {
						defaultTediId: row.primaryTediId,
						allowedTediIds: [row.primaryTediId],
					},
				},
			}),
		).rejects.toThrow("gateway unavailable");
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("rechecks current policy for an existing identity and forbids direct callers", async () => {
		const input = {
			installationId: id,
			providerAppId: appId,
			externalTenantId: "8042",
			allowedOrigin: row.allowedOrigin,
			hostUserId: "6190",
		};
		await expect(
			createRouterClient(router, {
				context: context("user", ["settings:manage"]),
			}).authorizeEmbeddedWidgetAccess(input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		const ctx = {
			...context("user", []),
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": "customer-8042",
				"X-Tedix-Tedi-Id": "demo-worker",
			}),
		};
		const client = createRouterClient(router, { context: ctx });
		expect((await client.authorizeEmbeddedWidgetAccess(input)).allowed).toBe(
			true,
		);
		mocks.resolve.mockResolvedValue({
			...row,
			provenance: {
				widgetAccess: {
					revision: 1,
					policy,
					updatedBy: "admin",
					updatedAt: "2026-09-11",
				},
			},
		});
		expect(await client.authorizeEmbeddedWidgetAccess(input)).toMatchObject({
			allowed: false,
			reason: "access_disabled",
			revision: 1,
		});
		expect(mocks.resolve).toHaveBeenLastCalledWith(
			{},
			expect.objectContaining({
				customerOrganizationId: "customer-8042",
				primaryTediId: "demo-worker",
				installationId: id,
				externalTenantId: "8042",
				allowedOrigin: row.allowedOrigin,
			}),
		);
	});
});
