import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as providers from "@tedix/db/queries/connection-providers";
import * as auth from "@tedix/auth/connections";
import * as policy from "./policy-resolution";
import * as discovery from "./provider-discovery";
import * as management from "../../../lib/descope-management";
import { apiKeyContext, userContext } from "../../test-context";
import {
	createProviderFromMcp,
	createTediProvider,
	deleteProvider,
	updateProviderMetadata,
} from "./provider-management";
import { createProvider } from "./credentials-tedi";

const router = {
	deleteProvider,
	updateProviderMetadata,
	createProvider,
	createProviderFromMcp,
	createTediProvider,
};
afterEach(() => vi.restoreAllMocks());

describe("organization-owned providers", () => {
	it.each(["deleteProvider", "updateProviderMetadata"] as const)(
		"allows only the owning admin to %s",
		async (method) => {
			const lookup = vi
				.spyOn(providers, "getConnectionProviderOwnershipForOrganization")
				.mockResolvedValue({
					appId: "owned",
					organizationId: "org-1",
					createdAt: "now",
				});
			vi.spyOn(
				providers,
				"deleteConnectionProviderOwnership",
			).mockResolvedValue();
			vi.spyOn(management, "getDescopeManagement").mockReturnValue({} as never);
			const remove = vi
				.spyOn(auth, "deleteConnectionProvider")
				.mockResolvedValue();
			const update = vi
				.spyOn(auth, "updateConnectionProviderMetadataWithId")
				.mockResolvedValue({ id: "owned" });
			const client = createRouterClient(router, {
				context: userContext({
					userRole: "admin",
					permissions: ["integrations:manage"],
				}),
			});
			await client[method]({ appId: "owned", name: "New name" });
			expect(lookup).toHaveBeenCalledWith(expect.anything(), "owned", "org-1");
			expect(
				method === "deleteProvider" ? remove : update,
			).toHaveBeenCalledOnce();
		},
	);
	it.each(["deleteProvider", "updateProviderMetadata"] as const)(
		"rejects foreign and unowned providers before %s",
		async (method) => {
			vi.spyOn(
				providers,
				"getConnectionProviderOwnershipForOrganization",
			).mockResolvedValue(undefined);
			const remove = vi.spyOn(auth, "deleteConnectionProvider");
			const update = vi.spyOn(auth, "updateConnectionProviderMetadataWithId");
			const client = createRouterClient(router, {
				context: userContext({
					userRole: "admin",
					permissions: ["integrations:manage"],
				}),
			});
			for (const appId of ["foreign", "legacy"])
				await expect(
					client[method]({ appId, name: "Hijack" }),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(remove).not.toHaveBeenCalled();
			expect(update).not.toHaveBeenCalled();
		},
	);
	it.each(["deleteProvider", "updateProviderMetadata"] as const)(
		"keeps platform access to unowned providers for %s",
		async (method) => {
			const lookup = vi.spyOn(
				providers,
				"getConnectionProviderOwnershipForOrganization",
			);
			vi.spyOn(
				providers,
				"deleteConnectionProviderOwnership",
			).mockResolvedValue();
			vi.spyOn(management, "getDescopeManagement").mockReturnValue({} as never);
			vi.spyOn(auth, "deleteConnectionProvider").mockResolvedValue();
			vi.spyOn(
				auth,
				"updateConnectionProviderMetadataWithId",
			).mockResolvedValue({ id: "legacy" });
			const client = createRouterClient(router, {
				context: apiKeyContext({ scopes: ["platform:admin", "apps:write"] }),
			});
			await client[method]({ appId: "legacy", name: "Updated" });
			expect(lookup).not.toHaveBeenCalled();
		},
	);
	it("does not let a non-admin with integration permissions manage an owned provider", async () => {
		const client = createRouterClient(router, {
			context: userContext({
				userRole: "member",
				permissions: ["integrations:manage"],
			}),
		});
		await expect(
			client.deleteProvider({ appId: "owned" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("records the creating organization for generated provider ids", async () => {
		vi.spyOn(auth, "createConnectionProvider").mockResolvedValue({
			id: "new-provider",
		});
		const record = vi
			.spyOn(providers, "createConnectionProviderOwnership")
			.mockResolvedValue();
		const client = createRouterClient(router, {
			context: userContext({
				userRole: "admin",
				permissions: ["integrations:manage"],
			}),
		});
		await client.createProvider({ name: "New", type: "api_key" });
		expect(record).toHaveBeenCalledWith(expect.anything(), {
			appId: "new-provider",
			organizationId: "org-1",
		});
	});
});

describe("MCP provider ownership", () => {
	it("refuses a foreign or unowned explicit id before provisioning", async () => {
		vi.spyOn(
			providers,
			"getConnectionProviderOwnershipForOrganization",
		).mockResolvedValue(undefined);
		const upsert = vi.spyOn(auth, "upsertConnectionProviderWithId");
		const client = createRouterClient(router, {
			context: userContext({
				userRole: "admin",
				permissions: ["integrations:manage"],
			}),
		});
		await expect(
			client.createProviderFromMcp({
				id: "foreign",
				mcpEndpointUrl: "https://mcp.example.com",
				connectionType: "api_key",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(upsert).not.toHaveBeenCalled();
	});
	it("gives new tenant MCP providers unique ids and records ownership", async () => {
		vi.spyOn(discovery, "resolveConnectionProviderTemplate").mockResolvedValue(
			undefined,
		);
		const upsert = vi
			.spyOn(auth, "upsertConnectionProviderWithId")
			.mockImplementation(async (id) => ({ id, status: "created" }));
		const record = vi
			.spyOn(providers, "createConnectionProviderOwnership")
			.mockResolvedValue();
		const client = createRouterClient(router, {
			context: userContext({
				userRole: "admin",
				permissions: ["integrations:manage"],
			}),
		});
		const result = await client.createProviderFromMcp({
			mcpEndpointUrl: "https://mcp.example.com",
			connectionType: "api_key",
		});
		expect(upsert).toHaveBeenCalledWith(
			result.appId,
			expect.anything(),
			expect.anything(),
		);
		expect(result.appId).not.toBe("mcp-example-com");
		expect(record).toHaveBeenCalledWith(expect.anything(), {
			appId: result.appId,
			organizationId: "org-1",
		});
	});
	it("does not claim legacy providers updated by platform provisioning", async () => {
		vi.spyOn(discovery, "resolveConnectionProviderTemplate").mockResolvedValue(
			undefined,
		);
		vi.spyOn(auth, "upsertConnectionProviderWithId").mockResolvedValue({
			id: "legacy",
			status: "updated",
		});
		const record = vi.spyOn(providers, "createConnectionProviderOwnership");
		const client = createRouterClient(router, {
			context: apiKeyContext({ scopes: ["platform:admin", "apps:write"] }),
		});
		await client.createProviderFromMcp({
			id: "legacy",
			mcpEndpointUrl: "https://mcp.example.com",
			connectionType: "api_key",
		});
		expect(record).not.toHaveBeenCalled();
	});
	it("does not provision or claim a dry-run provider", async () => {
		vi.spyOn(discovery, "resolveConnectionProviderTemplate").mockResolvedValue(
			undefined,
		);
		const upsert = vi.spyOn(auth, "upsertConnectionProviderWithId");
		const record = vi.spyOn(providers, "createConnectionProviderOwnership");
		const client = createRouterClient(router, {
			context: userContext({
				userRole: "admin",
				permissions: ["integrations:manage"],
			}),
		});
		await client.createProviderFromMcp({
			dryRun: true,
			mcpEndpointUrl: "https://mcp.example.com",
			connectionType: "api_key",
		});
		expect(upsert).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
	});
	it("records tedi-created providers against the resolved organization", async () => {
		vi.spyOn(policy, "resolveTediTenantId").mockResolvedValue({
			organizationId: "org-1",
			descopeTenantId: "tenant-1",
		});
		vi.spyOn(auth, "createConnectionProvider").mockResolvedValue({
			id: "tedi-provider",
		});
		const record = vi
			.spyOn(providers, "createConnectionProviderOwnership")
			.mockResolvedValue();
		const client = createRouterClient(router, {
			context: {
				...apiKeyContext({ headers: { "X-Service-Binding": "true" } }),
				tediScopes: ["apps:write"],
			},
		});
		await client.createTediProvider({
			tediId: "00000000-0000-4000-8000-000000000001",
			name: "Tedi",
			type: "api_key",
		});
		expect(record).toHaveBeenCalledWith(expect.anything(), {
			appId: "tedi-provider",
			organizationId: "org-1",
		});
	});
});
