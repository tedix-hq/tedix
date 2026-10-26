import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { userContext } from "../rpc/test-context";

const mocks = vi.hoisted(() => ({
	surface: vi.fn(),
	account: vi.fn(),
	ownAccounts: vi.fn(),
	member: vi.fn(),
	organization: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	consume: vi.fn(),
	pending: vi.fn(),
	anchor: vi.fn(),
	gateway: vi.fn(),
}));
vi.mock("@tedix/db/queries/app-records", async (load) => ({
	...(await load<object>()),
	getAppByIdWithToolsForOrganization: mocks.surface,
}));
vi.mock("@tedix/db/queries/connection-instances", async (load) => ({
	...(await load<object>()),
	getConnectionInstance: mocks.account,
	listConnectionInstances: mocks.ownAccounts,
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	createApprovalRequestWithAudit: mocks.create,
	getApprovalRequestById: mocks.get,
	consumeOwnerToolApproval: mocks.consume,
	findPendingOwnerToolApproval: mocks.pending,
	getApprovalAnchor: mocks.anchor,
}));
vi.mock("../lib/first-party-mcp", () => ({
	requestFirstPartyMcp: mocks.gateway,
}));
import { callWorkspaceAppConnection } from "./os-app-connection";

const resource = {
	id: "resource-1",
	organizationId: "org-1",
	workspaceId: "workspace-1",
	slot: "calendar",
	providerId: "fictional-calendar",
	connectionScope: "user",
	personalOwnerUserId: "user-1",
	connectionInstanceId: "account-1",
	resourceType: "calendar",
	providerResourceId: "calendar-1",
	requiredScopes: '["calendar.read"]',
	status: "active",
	updatedAt: "2026-01-01",
} as OsWorkspaceResourceRow;
const session = {
	organizationId: "org-1",
	workspaceId: "workspace-1",
	gadgetId: "gadget-1",
	revisionId: "revision-1",
	role: "build",
	actorUserId: "user-1",
	principal: { kind: "user", id: "user-1" },
} as WorkspaceAppSession;
const input = {
	appId: "app-1",
	toolId: "list_events",
	arguments: { calendarId: "calendar-1" },
};
function context(sub = "user-1") {
	return userContext({
		sub,
		env: {
			ENVIRONMENT: "test",
			MCP_URL: "https://mcp.example.test",
			MCP_SERVICE: { fetch: vi.fn() },
		} as unknown as CloudflareEnv,
	});
}
function surface() {
	return {
		app: {
			slug: "calendar-reader",
			metadata: {
				mcpConfig: {
					connectionProviderId: resource.providerId,
					connectionInstanceId: "account-1",
					connectionScope: "user",
				},
			},
		},
		tools: [
			{
				enabled: true,
				toolId: input.toolId,
				annotations: { readOnlyHint: true },
				config: {
					transport: "mcp",
					mcpToolName: "list_events",
					connectionReadOnly: true,
					auth: {
						type: "connection",
						connectionId: resource.providerId,
						scopes: ["calendar.read"],
					},
					personalResourceBinding: {
						operation: "read",
						resourceType: "calendar",
						paths: [["calendarId"]],
					},
				},
			},
		],
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.surface.mockResolvedValue(surface());
	mocks.account.mockResolvedValue({
		id: "account-1",
		tokenIds: ["grant-1"],
		tokenSub: "subject-1",
	});
	mocks.ownAccounts.mockResolvedValue([]);
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.organization.mockResolvedValue({ slug: "fictional" });
	mocks.anchor.mockResolvedValue({ id: "anchor-1" });
	mocks.create.mockImplementation(async (_db, row) => row);
	mocks.consume.mockResolvedValue(true);
	mocks.gateway.mockResolvedValue({
		content: [{ type: "text", text: "events" }],
	});
});
async function retry(
	status = "approved",
	actor: {
		context: ReturnType<typeof context>;
		session: WorkspaceAppSession;
	} = {
		context: context(),
		session,
	},
) {
	const first = (await callWorkspaceAppConnection(
		actor.context,
		actor.session,
		resource,
		input,
	)) as { approval: { approvalRequestId: string } };
	const row = mocks.create.mock.calls[0]![1];
	mocks.get.mockResolvedValue({
		...row,
		status,
		resolvedBy: actor.context.user!.sub,
	});
	return { ...input, approvalRequestId: first.approval.approvalRequestId };
}
/** A build collaborator who is not the slot's personal owner. */
const collaborator = {
	context: context("user-2"),
	session: {
		...session,
		actorUserId: "user-2",
		principal: { kind: "user", id: "user-2" },
	} as WorkspaceAppSession,
};
describe("runtime connection OS approval adapter", () => {
	it("parks before gateway or credentials and binds the exact slot, account, config and arguments", async () => {
		const result = await callWorkspaceAppConnection(
			context(),
			session,
			resource,
			input,
		);
		expect(result).toMatchObject({
			approval: { approved: false, status: "pending" },
		});
		expect(mocks.gateway).not.toHaveBeenCalled();
		expect(mocks.create.mock.calls[0]![1].payload).toMatchObject({
			target: {
				workspaceId: resource.workspaceId,
				gadgetId: session.gadgetId,
				revisionId: session.revisionId,
				slot: "calendar",
			},
			args: input.arguments,
		});
	});
	it("releases one approved exact retry through canonical MCP with no provider token", async () => {
		const approved = await retry();
		expect(
			await callWorkspaceAppConnection(context(), session, resource, approved),
		).toEqual({ content: [{ type: "text", text: "events" }] });
		expect(mocks.gateway).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Tedix-Acting-User": "user-1",
					"X-Tedix-Kernel": "true",
					"X-Tedix-Tedi-Scopes": "connections.read",
				}),
			}),
			"tools/call",
			expect.objectContaining({
				name: "list_events",
				arguments: input.arguments,
				_meta: expect.objectContaining({
					"tedix/expectedConnection": {
						providerId: resource.providerId,
						connectionInstanceId: "account-1",
						scope: "user",
						scopes: ["calendar.read"],
					},
				}),
			}),
		);
		mocks.consume.mockResolvedValue(false);
		await callWorkspaceAppConnection(context(), session, resource, approved);
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
	});
	it("runs a collaborator's call on their own account, never the owner's personal account", async () => {
		mocks.ownAccounts.mockResolvedValue([
			{
				id: "account-other-provider",
				providerId: "other-provider",
				tokenIds: ["grant-x"],
				tokenSub: "subject-x",
			},
			{
				id: "account-2",
				providerId: resource.providerId,
				tokenIds: ["grant-2"],
				tokenSub: "subject-2",
			},
		]);
		const approved = await retry("approved", collaborator);
		expect(mocks.ownAccounts).toHaveBeenCalledWith(expect.anything(), {
			userId: "user-2",
		});
		expect(mocks.account).not.toHaveBeenCalled();
		expect(mocks.create.mock.calls[0]![1].payload).toMatchObject({
			initiatedByUserId: "user-2",
		});
		expect(
			await callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				resource,
				approved,
			),
		).toEqual({ content: [{ type: "text", text: "events" }] });
		expect(mocks.gateway).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({ "X-Tedix-Acting-User": "user-2" }),
			}),
			"tools/call",
			expect.objectContaining({
				_meta: expect.objectContaining({
					"tedix/expectedConnection": expect.objectContaining({
						connectionInstanceId: "account-2",
						scope: "user",
					}),
				}),
			}),
		);
		expect(mocks.account).not.toHaveBeenCalled();
	});
	it("refuses a collaborator without their own account before any approval", async () => {
		await expect(
			callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				resource,
				input,
			),
		).rejects.toThrow(/Connect your own fictional-calendar account/);
		expect(mocks.account).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("keeps an organization slot on the organization account for a collaborator", async () => {
		const shared = {
			...resource,
			connectionScope: "tenant",
			personalOwnerUserId: null,
		} as OsWorkspaceResourceRow;
		const changed = surface();
		changed.app.metadata.mcpConfig.connectionScope = "tenant";
		mocks.surface.mockResolvedValue(changed);
		await callWorkspaceAppConnection(
			collaborator.context,
			collaborator.session,
			shared,
			input,
		);
		expect(mocks.account).toHaveBeenCalledWith(
			expect.anything(),
			{ organizationId: "org-1" },
			"account-1",
			resource.providerId,
		);
		expect(mocks.ownAccounts).not.toHaveBeenCalled();
	});
	it.each(["pending", "rejected", "cancelled", "expired"])(
		"refuses %s approvals before dispatch",
		async (status) => {
			const result = await callWorkspaceAppConnection(
				context(),
				session,
				resource,
				await retry(status),
			);
			expect(result).toMatchObject({ approval: { approved: false, status } });
			expect(mocks.gateway).not.toHaveBeenCalled();
			expect(mocks.consume).not.toHaveBeenCalled();
		},
	);
	it("refuses an expired approved grant at the canonical consumption CAS", async () => {
		const approved = await retry();
		mocks.consume.mockResolvedValue(false);
		expect(
			await callWorkspaceAppConnection(context(), session, resource, approved),
		).toMatchObject({ approval: { approved: false } });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ slot: "other-slot" },
		{ providerResourceId: "other-calendar" },
		{ connectionInstanceId: "other-account" },
		{ status: "removed" },
		{ personalOwnerUserId: "other-owner" },
		{ organizationId: "org-2" },
		{ workspaceId: "other-workspace" },
		{ requiredScopes: "[]" },
	])("refuses revoked or changed resource %j", async (patch) => {
		const approved = await retry();
		await expect(
			callWorkspaceAppConnection(
				context(),
				session,
				{ ...resource, ...patch } as OsWorkspaceResourceRow,
				approved,
			),
		).rejects.toThrow();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("refuses a disconnected account and a removed tool on retry", async () => {
		const approved = await retry();
		mocks.account.mockResolvedValue(undefined);
		await expect(
			callWorkspaceAppConnection(context(), session, resource, approved),
		).rejects.toThrow();
		mocks.surface.mockResolvedValue(null);
		await expect(
			callWorkspaceAppConnection(context(), session, resource, approved),
		).rejects.toThrow();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("keeps effects and account-wide tools refused before approval creation", async () => {
		const changed = surface();
		changed.tools[0]!.annotations.readOnlyHint = false;
		mocks.surface.mockResolvedValue(changed);
		await expect(
			callWorkspaceAppConnection(context(), session, resource, input),
		).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each(["use", "external_agent"])(
		"refuses an elevated app facade for %s",
		async (kind) => {
			const changed =
				kind === "use"
					? { ...session, role: "use" }
					: { ...session, principal: { kind, id: "user-1" } };
			await expect(
				callWorkspaceAppConnection(
					context(),
					changed as WorkspaceAppSession,
					resource,
					input,
				),
			).rejects.toThrow();
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);
	it("refuses build access without existing owner/admin approval authority", async () => {
		mocks.member.mockResolvedValue({ status: "active", role: "member" });
		await expect(
			callWorkspaceAppConnection(context(), session, resource, input),
		).rejects.toThrow(/owner or admin/);
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("binds approval to the account's current grant and app revision", async () => {
		const approved = await retry();
		mocks.account.mockResolvedValue({
			id: "account-1",
			tokenIds: ["replacement-grant"],
			tokenSub: "subject-1",
		});
		await expect(
			callWorkspaceAppConnection(context(), session, resource, approved),
		).rejects.toThrow();
		mocks.account.mockResolvedValue({
			id: "account-1",
			tokenIds: ["grant-1"],
			tokenSub: "subject-1",
		});
		await expect(
			callWorkspaceAppConnection(
				context(),
				{ ...session, revisionId: "revision-2" },
				resource,
				approved,
			),
		).rejects.toThrow();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("rejects an unmapped account-wide tool", async () => {
		const changed = surface();
		Object.assign(changed.tools[0]!.config, {
			personalResourceBinding: {
				operation: "read",
				resourceType: "calendar",
				target: "account",
			},
		});
		mocks.surface.mockResolvedValue(changed);
		await expect(
			callWorkspaceAppConnection(context(), session, resource, input),
		).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("preserves human-required results without satisfying them", async () => {
		const approved = await retry();
		mocks.gateway.mockResolvedValue({
			input_required: { message: "User presence required" },
		});
		expect(
			await callWorkspaceAppConnection(context(), session, resource, approved),
		).toEqual({ input_required: { message: "User presence required" } });
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
	});
});
