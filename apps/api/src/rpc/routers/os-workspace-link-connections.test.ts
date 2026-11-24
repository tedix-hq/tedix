import { createDbClient } from "@tedix/db/client";
import { connectionInstances } from "@tedix/db/schema/connection-instances";
import { expect, it, vi } from "vite-plus/test";
import { clients, userContext } from "./__tests__/os-workspaces-env";
import { createRouterClient } from "@orpc/server";
import { osWorkspacesContractRouter } from "./os-workspaces";

const adopt = vi.hoisted(() =>
	vi.fn(async () => ({ tokenId: "grant", tokenSub: "subject" })),
);
vi.mock("./connections/policy-resolution", async (original) => ({
	...(await original<typeof import("./connections/policy-resolution")>()),
	adoptDefaultPersonalConnection: adopt,
}));
const choices = vi.hoisted(() => [
	{
		id: "default-choice",
		providerId: "github",
		service: "GitHub",
		label: "Default GitHub",
		connectionScope: "personal",
		hybrid: true,
		connectedForYou: true,
		access: [],
	},
	{
		id: "org-named",
		providerId: "example-crm",
		service: "CRM",
		label: "Named CRM",
		connectionScope: "organization",
		connectionInstanceId: "00000000-0000-4000-8000-000000000005",
		hybrid: false,
		connectedForYou: true,
		access: [],
	},
	{
		id: "drive-choice",
		providerId: "google-drive",
		service: "Drive",
		label: "Personal Drive",
		connectionScope: "personal",
		connectionInstanceId: "00000000-0000-4000-8000-000000000003",
		hybrid: true,
		connectedForYou: true,
		access: [],
	},
	{
		id: "github-choice",
		providerId: "github",
		service: "GitHub",
		label: "Personal GitHub",
		connectionScope: "personal",
		connectionInstanceId: "00000000-0000-4000-8000-000000000004",
		hybrid: true,
		connectedForYou: true,
		access: [],
	},
	{
		id: "crm-choice",
		providerId: "example-crm",
		service: "CRM",
		label: "Shared CRM",
		connectionScope: "organization",
		hybrid: false,
		connectedForYou: true,
		access: [],
	},
]);
vi.mock("../../services/workspace-available-connections", async (original) => ({
	...(await original<
		typeof import("../../services/workspace-available-connections")
	>()),
	discoverWorkspaceConnections: async () => choices,
}));
vi.mock("../../services/os-workspace-resource-availability", () => ({
	resolveWorkspaceResourceAvailability: async () => ({
		status: "available",
		reason: null,
		checkedAt: "2026-01-01T00:00:00Z",
	}),
}));

it("adds only the selected accounts through the source path and refuses machines and workspace readers", async () => {
	const c = clients();
	const { workspace } = await c.org1.workspaces.create({
		name: "Connection test",
	});
	expect(
		(await c.org1.resources.list({ workspaceId: workspace.id })).items,
	).toEqual([]);
	const result = await c.org1.resources.linkConnections({
		workspaceId: workspace.id,
		connections: ["drive-choice", "crm-choice"],
	});
	expect(result.failed).toEqual([]);
	expect(result.added.map((item) => item.id)).toEqual([
		"drive-choice",
		"crm-choice",
	]);
	const sources = (await c.org1.resources.list({ workspaceId: workspace.id }))
		.items;
	expect(sources.map((source) => source.providerId).sort()).toEqual([
		"example-crm",
		"google-drive",
	]);
	expect(
		sources.find((source) => source.providerId === "google-drive"),
	).toMatchObject({
		personalOwnerUserId: "user-1",
		connectionInstanceId: "00000000-0000-4000-8000-000000000003",
	});
	await expect(
		c.machine.resources.linkConnections({
			workspaceId: workspace.id,
			connections: ["github-choice"],
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const stranger = createRouterClient(osWorkspacesContractRouter, {
		context: userContext({
			env: c.env,
			organizationId: "org-1",
			sub: "stranger",
		}),
	});
	await expect(
		stranger.resources.linkConnections({
			workspaceId: workspace.id,
			connections: ["github-choice"],
		}),
	).rejects.toThrow("workspace build or owner access");
	const retry = await c.org1.resources.linkConnections({
		workspaceId: workspace.id,
		connections: ["drive-choice"],
	});
	expect(retry.failed).toEqual([]);
	expect(
		(await c.org1.resources.list({ workspaceId: workspace.id })).items.length,
	).toBe(2);
});

it("pins a default personal login only on add and preserves a named organization account", async () => {
	adopt.mockClear();
	const c = clients();
	const { workspace } = await c.org1.workspaces.create({
		name: "Default account",
	});
	await createDbClient(c.env.DB)
		.insert(connectionInstances)
		.values({
			id: "00000000-0000-4000-8000-000000000005",
			organizationId: "org-1",
			ownerUserId: "admin",
			providerId: "example-crm",
			label: "Named CRM",
			tokenIds: ["org-grant"],
			tokenSub: "org-sub",
			createdAt: "2026-01-01",
			updatedAt: "2026-01-01",
		});
	await c.org1.resources.availableConnections({ workspaceId: workspace.id });
	expect(adopt).not.toHaveBeenCalled();
	expect(
		(await c.org1.resources.list({ workspaceId: workspace.id })).items,
	).toEqual([]);
	const result = await c.org1.resources.linkConnections({
		workspaceId: workspace.id,
		connections: ["default-choice", "org-named"],
	});
	expect(result.failed).toEqual([]);
	expect(adopt).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
		userId: "user-1",
		providerId: "github",
	});
	const sources = (await c.org1.resources.list({ workspaceId: workspace.id }))
		.items;
	expect(
		sources.find((source) => source.providerId === "github"),
	).toMatchObject({
		connectionInstanceId: "00000000-0000-4000-8000-000000000004",
		personalOwnerUserId: "user-1",
	});
	expect(
		sources.find((source) => source.providerId === "example-crm"),
	).toMatchObject({
		connectionInstanceId: "00000000-0000-4000-8000-000000000005",
		connectionScope: "tenant",
	});
});
