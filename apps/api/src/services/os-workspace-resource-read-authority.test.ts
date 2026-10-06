import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { authorizeWorkspaceResourceRead } from "./os-workspace-resource-read-authority";

const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	resource: vi.fn(),
	tedi: vi.fn(),
	apps: vi.fn(),
	roles: vi.fn(),
	management: vi.fn(),
}));
vi.mock("@tedix/db/query-client", () => ({
	createDbQueryClient: () => ({}),
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: mocks.workspace,
}));
vi.mock("@tedix/db/queries/os-workspaces/resources", () => ({
	getOsWorkspaceResource: mocks.resource,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	listAppReferenceMetadataByOrganization: mocks.apps,
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: mocks.management,
}));
vi.mock("@tedix/auth/fga", () => ({
	getAssignedAppRoles: mocks.roles,
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const input = {
	workspaceId,
	resourceId,
	expectedProviderId: "google-drive",
	expectedResourceType: "file",
};
const resource = {
	id: resourceId,
	organizationId: "org-1",
	workspaceId,
	providerId: "google-drive",
	resourceType: "file",
	providerResourceId: "drive-file-123",
	connectionScope: "tenant",
	requiredScopes: '["https://www.googleapis.com/auth/drive.readonly"]',
	status: "active",
};
const humanContext = {
	authType: "user",
	organizationId: "org-1",
	user: { sub: "user-1" },
	env: { DB: {} },
	db: {},
} as unknown as BaseContext;
const tediContext = {
	...humanContext,
	authType: "service-binding",
	user: undefined,
	tediId: "tedi-1",
	tediScopes: ["connections.execute"],
	headers: new Headers({
		"X-Tedix-Mcp-Tool-Id": "osWorkspaces.resources.readFile",
	}),
	// An owner's identity forwarded for provenance cannot authorize personal reads.
	descopeUserId: "owner-1",
} as BaseContext;

describe("Workspace resource read authority", () => {
	beforeEach(() => {
		mocks.workspace.mockReset().mockResolvedValue({
			id: workspaceId,
			organizationId: "org-1",
			status: "active",
		});
		mocks.resource.mockReset().mockResolvedValue(resource);
		mocks.tedi.mockReset().mockResolvedValue({
			id: "tedi-1",
			organizationId: "org-1",
			descopeUserId: "descope-tedi-1",
			retiredAt: null,
		});
		mocks.apps.mockReset().mockResolvedValue([
			{
				id: "drive-app-1",
				organizationId: "org-1",
				slug: "google-drive-58976b6c",
				metadata: {
					mcpConfig: {
						connectionProviderId: "google-drive",
						connectionScope: "user",
					},
				},
			},
			{
				id: "unrelated-app",
				organizationId: "org-1",
				slug: "other-drive",
				metadata: { mcpConfig: { connectionProviderId: "other" } },
			},
		]);
		mocks.roles.mockReset().mockResolvedValue({
			"drive-app-1": "observer",
		});
		mocks.management.mockReset().mockReturnValue({});
	});

	it("requires the exact active tenant Workspace file and returns its live scopes", async () => {
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).resolves.toEqual({
			resource,
			requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
		});
		expect(mocks.workspace).toHaveBeenCalledWith(
			{},
			{
				organizationId: "org-1",
				workspaceId,
			},
		);
		expect(mocks.resource).toHaveBeenCalledWith(
			{},
			{
				organizationId: "org-1",
				workspaceId,
				resourceId,
			},
		);
		expect(mocks.roles).toHaveBeenCalledWith({}, "descope-tedi-1", [
			"drive-app-1",
		]);
		expect(mocks.apps).toHaveBeenCalledWith({}, "org-1");
	});

	it.each([
		["missing reference", null],
		["removed reference", { ...resource, status: "removed" }],
		["wrong provider", { ...resource, providerId: "other-provider" }],
		["wrong object type", { ...resource, resourceType: "folder" }],
	])(
		"denies %s before checking the provider assignment",
		async (_label, row) => {
			mocks.resource.mockResolvedValue(row);
			await expect(
				authorizeWorkspaceResourceRead(tediContext, input),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.roles).not.toHaveBeenCalled();
		},
	);

	it("denies archived or cross-organization Workspaces", async () => {
		mocks.workspace.mockResolvedValue({ status: "archived" });
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.workspace.mockResolvedValue(null);
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.resource).not.toHaveBeenCalled();
	});

	it.each(["not-json", "null", '["valid",1]', '[""]'])(
		"denies malformed persisted scopes: %s",
		async (requiredScopes) => {
			mocks.resource.mockResolvedValue({ ...resource, requiredScopes });
			await expect(
				authorizeWorkspaceResourceRead(tediContext, input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.roles).not.toHaveBeenCalled();
		},
	);

	it("requires a current same-org Tedi app read assignment", async () => {
		mocks.roles.mockResolvedValue({});
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.tedi.mockResolvedValue({
			descopeUserId: "descope-tedi-1",
			retiredAt: "2026-09-25T00:00:00Z",
		});
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("does not infer provider authority from an app slug or unrelated assignment", async () => {
		mocks.apps.mockResolvedValue([
			{
				id: "slug-only-app",
				organizationId: "org-1",
				slug: "google-drive",
				metadata: { mcpConfig: { connectionProviderId: "other" } },
			},
		]);
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.roles).not.toHaveBeenCalled();
	});

	it("accepts a role on any org app explicitly bound to the provider", async () => {
		mocks.apps.mockResolvedValue([
			{
				id: "drive-app-1",
				metadata: { mcpConfig: { connectionProviderId: "google-drive" } },
			},
			{
				id: "drive-app-2",
				metadata: { mcpConfig: { connectionProviderId: "google-drive" } },
			},
		]);
		mocks.roles.mockResolvedValue({ "drive-app-2": "observer" });
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).resolves.toMatchObject({ resource });
		expect(mocks.roles).toHaveBeenCalledWith({}, "descope-tedi-1", [
			"drive-app-1",
			"drive-app-2",
		]);
	});

	it("rejects a Tedi without verified connected-tool authority", async () => {
		await expect(
			authorizeWorkspaceResourceRead({ ...tediContext, tediScopes: [] }, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			authorizeWorkspaceResourceRead(
				{ ...tediContext, headers: new Headers() },
				input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.roles).not.toHaveBeenCalled();
	});

	it("never lets a background Tedi inherit a personal connection", async () => {
		mocks.resource.mockResolvedValue({
			...resource,
			connectionScope: "user",
		});
		await expect(
			authorizeWorkspaceResourceRead(tediContext, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.roles).not.toHaveBeenCalled();
	});

	it("allows the interactive user's exact resource but rejects a bare service binding", async () => {
		await expect(
			authorizeWorkspaceResourceRead(humanContext, input),
		).resolves.toEqual({
			resource,
			requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
		});
		await expect(
			authorizeWorkspaceResourceRead(
				{ ...humanContext, authType: "service-binding", user: undefined },
				input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
