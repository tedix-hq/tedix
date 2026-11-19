import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
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
	provider: vi.fn(),
	ownToken: vi.fn(),
	receipt: vi.fn(),
	settle: vi.fn(),
	workspace: vi.fn(),
	resource: vi.fn(),
	outputQuery: vi.fn(),
	resolveApproval: vi.fn(),
	audit: vi.fn(),
	role: vi.fn(),
	runtimeRole: vi.fn(),
	membership: vi.fn(),
	findTool: vi.fn(),
	approvalTool: vi.fn(),
	tediProfile: vi.fn(),
}));
vi.mock("./workspace-document-owner", () => ({
	workspaceDocumentRuntime: () => ({ outputQuery: mocks.outputQuery }),
}));
vi.mock("@tedix/db/queries/audit", async (load) => ({
	...(await load<object>()),
	insertAuditEvent: mocks.audit,
}));
vi.mock("@tedix/db/queries/tedis", async (load) => ({
	...(await load<object>()),
	getTediByIdForOrganization: mocks.tediProfile,
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", async (load) => ({
	...(await load<object>()),
	getOsWorkspace: mocks.workspace,
}));
vi.mock("@tedix/db/queries/os-workspaces/resources", async (load) => ({
	...(await load<object>()),
	getOsWorkspaceResource: mocks.resource,
}));
vi.mock("@tedix/db/queries/os-workspace-access", async (load) => ({
	...(await load<object>()),
	readWorkspaceSessionRole: mocks.role,
	readWorkspaceRuntimeRole: mocks.runtimeRole,
}));
vi.mock("@tedix/db/queries/tools", async (load) => ({
	...(await load<object>()),
	findWorkspaceConnectionTool: mocks.findTool,
	getToolByIdForOrganization: mocks.approvalTool,
}));
vi.mock("@tedix/db/queries/connection-providers", async (load) => ({
	...(await load<object>()),
	getConnectionProviderByDescopeAppId: mocks.provider,
}));
vi.mock("@tedix/db/queries/os-workspaces/executions", async (load) => ({
	...(await load<object>()),
	createOsGadgetExecution: mocks.receipt,
	settleOsAppCallExecution: mocks.settle,
}));
vi.mock("../rpc/routers/connections/policy-resolution", () => ({
	fetchNamedConnection: mocks.ownToken,
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
	getMemberAccessByUserId: mocks.membership,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	createApprovalRequestWithAudit: mocks.create,
	getApprovalRequestById: mocks.get,
	resolveApprovalRequest: mocks.resolveApproval,
	consumeOwnerToolApproval: mocks.consume,
	findPendingOwnerToolApproval: mocks.pending,
	getApprovalAnchor: mocks.anchor,
}));
vi.mock("../lib/first-party-mcp", () => ({
	requestFirstPartyMcp: mocks.gateway,
}));
// Load the real governance router during test collection so the first case
// measures the adapter call without Vite's cold transform of the router graph.
import "../rpc/routers/mcp-governance";
import { callWorkspaceAppConnection } from "./os-app-connection";
import {
	decideLinkedWorkspaceAccountApproval,
	readLinkedWorkspaceAccount,
} from "./workspace-connection-read";

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
	mocks.receipt.mockImplementation(async (_db, row) => row);
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
	it("refuses a read-only Drive write before approval or provider dispatch", async () => {
		const changed = surface();
		changed.tools[0]!.annotations.readOnlyHint = false;
		mocks.surface.mockResolvedValue(changed);
		await expect(
			callWorkspaceAppConnection(
				context(),
				session,
				{
					...resource,
					providerId: "google-drive",
					providerAccess: { canRead: true, canWrite: false },
				},
				input,
			),
		).rejects.toThrow("read-only");
		expect(mocks.create).not.toHaveBeenCalled();
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

/** An organization Notion page slot read by a member who is not an admin of Notion. */
const NOTION_PAGE = "0c5a8f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
const notionPage = {
	...resource,
	slot: "roadmap",
	providerId: "notion",
	connectionScope: "tenant",
	personalOwnerUserId: null,
	connectionInstanceId: "org-notion",
	resourceType: "page",
	providerResourceId: NOTION_PAGE,
	requiredScopes: "[]",
} as OsWorkspaceResourceRow;
const notionInput = {
	appId: "app-1",
	toolId: "get_page",
	arguments: { page_id: NOTION_PAGE },
};
function notionSurface(providerId = "notion") {
	return {
		app: {
			slug: "roadmap-reader",
			metadata: {
				mcpConfig: {
					connectionProviderId: providerId,
					connectionInstanceId: "org-notion",
					connectionScope: "tenant",
				},
			},
		},
		tools: [
			{
				enabled: true,
				toolId: notionInput.toolId,
				annotations: { readOnlyHint: true },
				config: {
					transport: "mcp",
					mcpToolName: "get_page",
					connectionReadOnly: true,
					auth: { type: "connection", connectionId: providerId, scopes: [] },
					personalResourceBinding: {
						operation: "read",
						resourceType: "page",
						paths: [["page_id"]],
					},
				},
			},
		],
	};
}
const AUDIT_WEEK = new Date("2026-10-27T09:00:00.000Z");
const ENFORCED = new Date("2026-11-03T09:00:00.000Z");
function observation(call = 0) {
	const row = mocks.receipt.mock.calls[call]![1];
	return {
		row,
		input: JSON.parse(row.input),
		policy: JSON.parse(row.policyDecision),
	};
}
describe("app connection read observations and own-access checks", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		mocks.surface.mockResolvedValue(notionSurface());
		mocks.account.mockResolvedValue({
			id: "org-notion",
			tokenIds: ["org-grant"],
			tokenSub: "org-subject",
		});
		// Notion is a document store by its access probe, whatever its stored category.
		mocks.provider.mockResolvedValue(undefined);
		mocks.ownToken.mockResolvedValue({ accessToken: "member-token" });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	/** Approves the parked read so the retry reaches the gateway. */
	async function approvedRead(
		actor = collaborator,
		slot: OsWorkspaceResourceRow = notionPage,
	) {
		const first = (await callWorkspaceAppConnection(
			actor.context,
			actor.session,
			slot,
			notionInput,
		)) as { approval: { approvalRequestId: string } };
		const row = mocks.create.mock.calls.at(-1)![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: actor.context.user!.sub,
		});
		return {
			...notionInput,
			approvalRequestId: first.approval.approvalRequestId,
		};
	}
	/** Back to the personal calendar slot of the outer suite. */
	function usePersonalCalendar() {
		mocks.surface.mockResolvedValue(surface());
		mocks.account.mockResolvedValue({
			id: "account-1",
			tokenIds: ["grant-1"],
			tokenSub: "subject-1",
		});
	}
	function linkOwnNotion() {
		mocks.ownAccounts.mockResolvedValue([
			{
				id: "member-notion",
				providerId: "notion",
				tokenIds: ["member-grant"],
				tokenSub: "member-subject",
			},
		]);
	}

	it("records a receipt for each read, without provider data", async () => {
		vi.setSystemTime(AUDIT_WEEK);
		usePersonalCalendar();
		const approved = await retry();
		await callWorkspaceAppConnection(context(), session, resource, approved);
		expect(mocks.receipt).toHaveBeenCalledTimes(1);
		const { row, input: seen, policy } = observation();
		expect(row).toMatchObject({
			gadgetId: "gadget-1",
			revisionId: "revision-1",
			status: "running",
			createdByKind: "user",
			createdById: "user-1",
		});
		expect(seen).toMatchObject({
			kind: "connection_observation",
			toolId: "list_events",
			slot: "calendar",
			account: "personal",
			ownAccess: "own_account",
			containsRestrictedData: false,
		});
		expect(row.output).toBeUndefined();
		expect(policy).toEqual({
			allowed: true,
			reasons: ["connection_observation", "own_access:own_account"],
		});
		expect(mocks.settle).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			executionId: row.id,
			status: "completed",
		});
	});

	it("refuses a member whose own Notion account cannot open the page", async () => {
		vi.setSystemTime(ENFORCED);
		linkOwnNotion();
		fetchMock.mockResolvedValue(
			new Response('{"code":"object_not_found"}', { status: 404 }),
		);
		await expect(
			callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				notionPage,
				notionInput,
			),
		).rejects.toThrow(/Your own notion account cannot open this resource/);
		expect(fetchMock).toHaveBeenCalledWith(
			`https://api.notion.com/v1/blocks/${NOTION_PAGE.replaceAll("-", "")}`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer member-token",
				}),
			}),
		);
		expect(mocks.ownToken).toHaveBeenCalledWith(
			expect.anything(),
			{ userId: "user-2" },
			"notion",
			"member-notion",
		);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
		const { row, input: seen, policy } = observation();
		expect(row.status).toBe("denied");
		expect(seen).toMatchObject({
			account: "organization",
			ownAccess: "no_access",
			mode: "enforce",
			wouldDeny: true,
			containsRestrictedData: true,
			checkEachPersonsAccess: {
				checkEachPersonsAccess: true,
				source: "default",
			},
		});
		expect(policy.allowed).toBe(false);
		expect(policy.reasons).toContain("own_access:denied");
	});

	it("fails closed before HTTP when the Notion profile rejects the page id", async () => {
		vi.setSystemTime(ENFORCED);
		linkOwnNotion();
		const partialUuid = NOTION_PAGE.replace("-", "");
		await expect(
			callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				{ ...notionPage, providerResourceId: partialUuid },
				{ ...notionInput, arguments: { page_id: partialUuid } },
			),
		).rejects.toThrow(/could not be confirmed/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(observation().input.ownAccess).toBe("check_failed");
	});

	it("fails closed when the member has no linked Notion account", async () => {
		vi.setSystemTime(ENFORCED);
		await expect(
			callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				notionPage,
				notionInput,
			),
		).rejects.toThrow(/Link your own notion account/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(observation().input.ownAccess).toBe("no_linked_account");
		expect(mocks.gateway).not.toHaveBeenCalled();
	});

	it("fails closed when the Notion check itself fails", async () => {
		vi.setSystemTime(ENFORCED);
		linkOwnNotion();
		fetchMock.mockResolvedValue(new Response("", { status: 502 }));
		await expect(
			callWorkspaceAppConnection(
				collaborator.context,
				collaborator.session,
				notionPage,
				notionInput,
			),
		).rejects.toThrow(/could not be confirmed/);
		expect(observation().input.ownAccess).toBe("check_failed");
	});

	it("serves the read in the audit week and records the would-deny", async () => {
		vi.setSystemTime(AUDIT_WEEK);
		const approved = await approvedRead();
		await callWorkspaceAppConnection(
			collaborator.context,
			collaborator.session,
			notionPage,
			approved,
		);
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
		const { row, input: seen, policy } = observation();
		expect(row.status).toBe("running");
		expect(seen).toMatchObject({
			ownAccess: "no_linked_account",
			mode: "audit",
			wouldDeny: true,
			containsRestrictedData: true,
		});
		expect(policy).toEqual({
			allowed: true,
			reasons: [
				"connection_observation",
				"own_access:no_linked_account",
				"own_access:would_deny",
			],
		});
	});

	it("marks a read the member can open themselves as unrestricted", async () => {
		vi.setSystemTime(ENFORCED);
		linkOwnNotion();
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const approved = await approvedRead();
		await callWorkspaceAppConnection(
			collaborator.context,
			collaborator.session,
			notionPage,
			approved,
		);
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
		expect(observation().input).toMatchObject({
			ownAccess: "verified",
			wouldDeny: false,
			containsRestrictedData: false,
		});
	});

	it("leaves a service-account connection unaffected", async () => {
		vi.setSystemTime(ENFORCED);
		const billing = { ...notionPage, providerId: "fictional-billing" };
		mocks.surface.mockResolvedValue(notionSurface("fictional-billing"));
		mocks.provider.mockResolvedValue({
			id: "fictional-billing",
			category: "commerce",
		});
		const approved = await approvedRead(collaborator, billing);
		await callWorkspaceAppConnection(
			collaborator.context,
			collaborator.session,
			billing,
			approved,
		);
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
		expect(mocks.ownAccounts).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(observation().input).toMatchObject({
			ownAccess: "not_checked",
			checkEachPersonsAccess: {
				checkEachPersonsAccess: false,
				source: "default",
			},
			containsRestrictedData: true,
		});
	});

	it("honours an org admin who turned the check off for a document store", async () => {
		vi.setSystemTime(ENFORCED);
		mocks.organization.mockResolvedValue({
			slug: "fictional",
			metadata: {
				connectionAccessChecks: [
					{ connectionInstanceId: "org-notion", checkEachPersonsAccess: false },
				],
			},
		});
		const approved = await approvedRead();
		await callWorkspaceAppConnection(
			collaborator.context,
			collaborator.session,
			notionPage,
			approved,
		);
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
		expect(observation().input).toMatchObject({
			ownAccess: "not_checked",
			checkEachPersonsAccess: {
				checkEachPersonsAccess: false,
				source: "admin",
			},
		});
	});

	it("settles the receipt as failed when the gateway read fails", async () => {
		vi.setSystemTime(AUDIT_WEEK);
		usePersonalCalendar();
		const approved = await retry();
		mocks.gateway.mockRejectedValue(new Error("gateway down"));
		await expect(
			callWorkspaceAppConnection(context(), session, resource, approved),
		).rejects.toThrow("gateway down");
		expect(mocks.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: "failed" }),
		);
	});
});

describe("workspace agent linked account reads", () => {
	const tedi = { kind: "tedi", tediId: "tedi-1" } as const;
	const schedule = { kind: "schedule" } as const;
	const request = {
		organizationId: "org-1",
		workspaceId: "workspace-1",
		resourceId: "resource-1",
		toolName: "list_events",
		args: input.arguments,
		conversationId: "conversation-1",
		actor: { kind: "user" as const, id: "user-2" },
	};
	const env = () =>
		({
			...context().env,
			DB: {
				withSession: () => ({
					prepare: vi.fn(),
					batch: vi.fn(),
					getBookmark: () => null,
				}),
			},
		}) as unknown as CloudflareEnv;
	const ownAccount = {
		id: "account-2",
		providerId: resource.providerId,
		tokenIds: ["grant-2"],
		tokenSub: "subject-2",
	};
	beforeEach(() => {
		mocks.workspace.mockResolvedValue({
			id: "workspace-1",
			organizationId: "org-1",
			status: "active",
		});
		mocks.outputQuery.mockResolvedValue({ ...resource });
		mocks.membership.mockResolvedValue({ status: "active", role: "member" });
		mocks.member.mockResolvedValue({ status: "active", role: "member" });
		mocks.role.mockResolvedValue("build");
		mocks.runtimeRole.mockResolvedValue("build");
		mocks.findTool.mockResolvedValue({ appId: "app-1", toolId: "list_events" });
		mocks.surface.mockResolvedValue({
			...surface(),
			tools: [{ ...surface().tools[0], id: "tool-row-1" }],
		});
		mocks.approvalTool.mockResolvedValue({
			...surface().tools[0],
			id: "tool-row-1",
		});
		mocks.ownAccounts.mockResolvedValue([ownAccount]);
	});
	async function read(overrides: Record<string, unknown> = {}) {
		return readLinkedWorkspaceAccount(env(), { ...request, ...overrides });
	}
	function tenant() {
		mocks.outputQuery.mockResolvedValue({
			...resource,
			connectionScope: "tenant",
			personalOwnerUserId: null,
		});
		const app = surface();
		app.app.metadata.mcpConfig.connectionScope = "tenant";
		mocks.surface.mockResolvedValue({
			...app,
			tools: [{ ...app.tools[0], id: "tool-row-1" }],
		});
	}
	it("re-reads membership and role for every personal read and uses the acting person's own account", async () => {
		expect(await read()).toMatchObject({ status: "ok" });
		expect(mocks.membership).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"user-2",
		);
		expect(mocks.role).toHaveBeenCalledWith(
			expect.anything(),
			"workspace-1",
			"user-2",
		);
		expect(mocks.outputQuery).toHaveBeenCalledWith(
			{ organizationId: "org-1", workspaceId: "workspace-1" },
			{
				op: "resources",
				query: {
					operation: "get",
					params: {
						organizationId: "org-1",
						workspaceId: "workspace-1",
						resourceId: "resource-1",
					},
				},
			},
		);
		expect(mocks.account).not.toHaveBeenCalled();
		expect(mocks.gateway).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({ "X-Tedix-Acting-User": "user-2" }),
			}),
			"tools/call",
			expect.objectContaining({
				_meta: expect.objectContaining({
					"tedix/expectedToolConfig": expect.any(String),
					"tedix/expectedConnection": expect.objectContaining({
						connectionInstanceId: "account-2",
						scope: "user",
					}),
				}),
			}),
		);
		expect(mocks.receipt.mock.calls[0]![1]).toMatchObject({
			gadgetId: "conversation:conversation-1",
			createdByKind: "user",
			createdById: "user-2",
		});
		expect(JSON.parse(mocks.receipt.mock.calls[0]![1].input)).toMatchObject({
			conversationId: "conversation-1",
			actor: request.actor,
		});
		mocks.membership.mockResolvedValue({ status: "suspended" });
		expect(await read()).toMatchObject({
			status: "refused",
			message: expect.stringContaining("membership"),
		});
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
	});
	it.each([
		{
			actor: schedule,
			createdByKind: "service",
			createdById: "workspace-agent:conversation-1",
		},
		{ actor: tedi, createdByKind: "tedi", createdById: tedi.tediId },
	])(
		"allows a $actor.kind to read the organization account",
		async ({ actor, createdByKind, createdById }) => {
			tenant();
			expect(await read({ actor })).toMatchObject({ status: "ok" });
			expect(mocks.account).toHaveBeenCalledWith(
				expect.anything(),
				{ organizationId: "org-1" },
				"account-1",
				resource.providerId,
			);
			expect(mocks.membership).not.toHaveBeenCalled();
			expect(mocks.role).not.toHaveBeenCalled();
			const headers = mocks.gateway.mock.calls[0]![0].headers;
			expect(headers).not.toHaveProperty("X-Tedix-Acting-User");
			expect(headers).toMatchObject({
				"X-Tedix-Kernel": "true",
				"X-Tedix-Tedi-Scopes": "connections.read",
			});
			if (actor.kind === "tedi") {
				expect(mocks.runtimeRole).toHaveBeenCalledWith(
					expect.anything(),
					{ organizationId: "org-1", workspaceId: "workspace-1" },
					{ actorKind: "tedi", actorId: actor.tediId },
				);
				expect(headers["X-Tedix-Tedi-Id"]).toBe(actor.tediId);
			} else {
				expect(mocks.runtimeRole).not.toHaveBeenCalled();
				expect(headers).not.toHaveProperty("X-Tedix-Tedi-Id");
			}
			const receipt = mocks.receipt.mock.calls[0]![1];
			expect(receipt).toMatchObject({ createdByKind, createdById });
			expect(JSON.parse(receipt.input)).toMatchObject({ actor });
		},
	);
	it.each([null, "use"])(
		"refuses a tedi with workspace role %s before reaching the account",
		async (role) => {
			tenant();
			mocks.runtimeRole.mockResolvedValue(role);
			expect(await read({ actor: tedi })).toMatchObject({
				status: "refused",
				message: expect.stringContaining("needs build access"),
			});
			expect(mocks.outputQuery).not.toHaveBeenCalled();
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it.each([schedule, tedi])(
		"refuses personal reads for a $kind",
		async (actor) => {
			expect(await read({ actor })).toEqual({
				status: "refused",
				message: "Only a signed-in person can read a personal account.",
			});
			expect(mocks.account).not.toHaveBeenCalled();
			expect(mocks.ownAccounts).not.toHaveBeenCalled();
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it("returns the personal connect link without using the owner's account", async () => {
		mocks.ownAccounts.mockResolvedValue([]);
		expect(await read()).toEqual({
			status: "not_connected",
			providerId: resource.providerId,
			scope: "user",
			connectPath: `/account/connections?connect=${resource.providerId}`,
		});
		expect(mocks.account).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("returns the organization connect path for a missing grant", async () => {
		tenant();
		mocks.account.mockResolvedValue({
			id: "account-1",
			tokenIds: [],
			tokenSub: "subject",
		});
		expect(await read({ actor: schedule })).toEqual({
			status: "not_connected",
			providerId: resource.providerId,
			scope: "tenant",
			connectPath: "/admin/connections",
		});
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("refuses a resource that survives only in the core index", async () => {
		mocks.resource.mockResolvedValue(resource);
		mocks.outputQuery.mockResolvedValue(undefined);
		expect(await read()).toEqual({
			status: "refused",
			message: "The linked resource was not found in this workspace.",
		});
		expect(mocks.resource).not.toHaveBeenCalled();
		expect(mocks.findTool).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});

	async function pendingRead() {
		mocks.approvalTool.mockResolvedValue({
			...surface().tools[0],
			config: { ...surface().tools[0]!.config, approvalPolicy: "always" },
		});
		const result = await read();
		expect(result).toMatchObject({
			status: "approval_required",
			approvalId: expect.any(String),
		});
		expect(mocks.gateway).not.toHaveBeenCalled();
		const row = { ...mocks.create.mock.calls[0]![1], status: "pending" };
		mocks.get.mockResolvedValue(row);
		mocks.resolveApproval.mockImplementation(async (_db, id, data) => {
			expect(id).toBe(row.id);
			Object.assign(row, data);
			return row;
		});
		return {
			replay: { approvalRequestId: row.id as string },
			tray: {
				organizationId: request.organizationId,
				workspaceId: request.workspaceId,
				conversationId: request.conversationId,
				approvalRequestId: row.id as string,
				by: "admin-1",
			},
		};
	}

	function allowTrayApprover() {
		const member = { status: "active", role: "admin" };
		mocks.membership.mockResolvedValue(member);
		mocks.member.mockImplementation(async (_db, _org, id) =>
			id === "admin-1" ? member : { status: "active", role: "member" },
		);
	}

	it("returns a bound owner approval when the tool has an approval rule", async () => {
		await pendingRead();
		const target = mocks.create.mock.calls[0]![1].payload.target;
		expect(target).toMatchObject({
			workspaceId: "workspace-1",
			conversationId: "conversation-1",
			actor: request.actor,
			resourceHash: expect.any(String),
			accountHash: expect.any(String),
			configHash: expect.any(String),
		});
		expect(target).not.toHaveProperty("gadgetId");
		expect(target).not.toHaveProperty("revisionId");
		expect(target).not.toHaveProperty("slot");
	});
	it("records an authorized tray approval and replays as the original actor", async () => {
		const { tray, replay } = await pendingRead();
		allowTrayApprover();
		expect(await read(replay)).toEqual({
			status: "approval_required",
			approvalId: replay.approvalRequestId,
		});
		await expect(
			decideLinkedWorkspaceAccountApproval(env(), {
				...tray,
				decision: "approve",
			}),
		).resolves.toEqual({ status: "approved" });
		expect(mocks.resolveApproval).toHaveBeenCalledWith(
			expect.anything(),
			tray.approvalRequestId,
			{ status: "approved", resolvedBy: "user:admin-1" },
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actorId: "user:admin-1",
				action: "approval.approved",
			}),
		);
		expect(mocks.gateway).not.toHaveBeenCalled();
		expect(await read(replay)).toMatchObject({ status: "ok" });
		expect(mocks.gateway.mock.calls[0]![0].headers).toMatchObject({
			"X-Tedix-Acting-User": "user-2",
		});
		expect(mocks.consume).toHaveBeenCalledTimes(1);
	});

	it("records a denial and refuses replay even if the rule is later removed", async () => {
		const { tray, replay } = await pendingRead();
		allowTrayApprover();
		await expect(
			decideLinkedWorkspaceAccountApproval(env(), {
				...tray,
				decision: "deny",
			}),
		).resolves.toEqual({ status: "denied" });
		mocks.approvalTool.mockResolvedValue(surface().tools[0]);
		expect(await read(replay)).toEqual({
			status: "refused",
			message: "The connection read was denied.",
		});
		expect(mocks.consume).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});

	it("refuses a tray decision without current authority or the original conversation", async () => {
		const { tray } = await pendingRead();
		const decide = (overrides = {}) =>
			decideLinkedWorkspaceAccountApproval(env(), {
				...tray,
				decision: "approve",
				...overrides,
			});
		expect(await decide()).toMatchObject({ status: "refused" });
		allowTrayApprover();
		mocks.role.mockResolvedValue("use");
		expect(await decide()).toMatchObject({ status: "refused" });
		mocks.role.mockResolvedValue("build");
		expect(await decide({ conversationId: "other-chat" })).toMatchObject({
			status: "refused",
		});
		expect(mocks.resolveApproval).not.toHaveBeenCalled();
	});

	it.each([
		["actor", { actor: { kind: "user", id: "user-3" } }],
		["arguments", { args: { ...request.args, limit: 10 } }],
		["conversation", { conversationId: "other-chat" }],
		["workspace", { workspaceId: "other-workspace" }],
		["resource", { resourceId: "other-resource" }],
		["account", {}],
	])("refuses replay with a changed %s", async (binding, overrides) => {
		const { tray, replay } = await pendingRead();
		allowTrayApprover();
		expect(
			await decideLinkedWorkspaceAccountApproval(env(), {
				...tray,
				decision: "approve",
			}),
		).toEqual({ status: "approved" });
		if (binding === "workspace")
			mocks.outputQuery.mockResolvedValue({
				...resource,
				workspaceId: "other-workspace",
			});
		if (binding === "resource")
			mocks.outputQuery.mockResolvedValue({
				...resource,
				id: "other-resource",
			});
		if (binding === "account")
			mocks.ownAccounts.mockResolvedValue([
				{ ...ownAccount, id: "replacement-account" },
			]);
		expect(await read({ ...replay, ...overrides })).toMatchObject({
			status: "refused",
			message: expect.stringContaining("different call"),
		});
		expect(mocks.consume).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});

	it.each([
		{
			actor: schedule,
			actorType: "service",
			actorId: "workspace-agent:conversation-1",
		},
		{ actor: tedi, actorType: "tedi", actorId: tedi.tediId },
	])(
		"records the $actor.kind identity in the approval",
		async ({ actor, actorType, actorId }) => {
			tenant();
			mocks.tediProfile.mockResolvedValue({ name: "Ops Tedi" });
			mocks.approvalTool.mockResolvedValue({
				...surface().tools[0],
				config: { ...surface().tools[0]!.config, approvalPolicy: "once" },
			});
			expect(await read({ actor })).toMatchObject({
				status: "approval_required",
			});
			const [, approval, audit] = mocks.create.mock.calls[0]!;
			// The request people read names the tedi, never its id.
			if (actor.kind === "tedi") {
				expect(JSON.stringify(approval)).toContain("Ops Tedi");
				expect(approval.summary ?? approval.description ?? "").not.toContain(
					actor.tediId,
				);
			}
			expect(approval.payload).toMatchObject({
				workspaceReadActor: actor,
				target: { actor },
			});
			expect(approval.payload).not.toHaveProperty("initiatedByUserId");
			expect(audit).toMatchObject({ actorType, actorId });
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ enabled: false },
		{ annotations: { readOnlyHint: false } },
		{ config: { ...surface().tools[0]!.config, auth: { type: "none" } } },
	])(
		"refuses a tool that fails the approval router recheck: %j",
		async (change) => {
			tenant();
			mocks.approvalTool.mockResolvedValue({
				...surface().tools[0],
				...change,
			});
			expect(await read({ actor: tedi })).toMatchObject({
				status: "refused",
				message:
					"Only a checked workspace connection read may use this approval path",
			});
			expect(mocks.create).not.toHaveBeenCalled();
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it.each([null, "use", "view"])(
		"refuses a person whose current workspace role is %s",
		async (role) => {
			mocks.role.mockResolvedValue(role);
			expect(await read()).toMatchObject({
				status: "refused",
				message: expect.stringContaining("build or owner"),
			});
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it("accepts an owner role and refuses once the role is revoked", async () => {
		mocks.role.mockResolvedValue("owner");
		expect(await read()).toMatchObject({ status: "ok" });
		mocks.role.mockResolvedValue(null);
		expect(await read()).toMatchObject({ status: "refused" });
		expect(mocks.gateway).toHaveBeenCalledTimes(1);
	});
	it.each([undefined, { status: "suspended" }, { status: "invited" }])(
		"requires active organization membership: %j",
		async (member) => {
			mocks.membership.mockResolvedValue(member);
			expect(await read()).toMatchObject({ status: "refused" });
			expect(mocks.role).not.toHaveBeenCalled();
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, { status: "archived" }])(
		"refuses unavailable workspaces: %j",
		async (workspace) => {
			mocks.workspace.mockResolvedValue(workspace);
			expect(await read()).toMatchObject({ status: "refused" });
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it("refuses missing resources and ambiguous tool names", async () => {
		mocks.outputQuery.mockResolvedValueOnce(undefined);
		expect(await read()).toMatchObject({ status: "refused" });
		mocks.findTool.mockResolvedValue(undefined);
		expect(await read()).toMatchObject({ status: "refused" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ organizationId: "other-org" },
		{ workspaceId: "other-workspace" },
		{ status: "archived" },
		{ providerId: "tedix" },
		{ connectionInstanceId: null },
		{ connectionScope: "invalid" },
		{ requiredScopes: '["extra.scope"]' },
		{ requiredScopes: "invalid" },
		{ providerAccess: { canRead: false } },
		{ resourceType: "other" },
		{ providerResourceId: "other" },
	])("shares the resource refusal checks: %j", async (change) => {
		mocks.outputQuery.mockResolvedValue({ ...resource, ...change });
		expect(await read()).toMatchObject({ status: "refused" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ toolId: "different_tool" },
		{ config: undefined },
		{
			config: {
				...surface().tools[0]!.config,
				personalResourceBinding: {
					...surface().tools[0]!.config.personalResourceBinding,
					operation: "write",
				},
			},
		},
		{ enabled: false },
		{ config: { ...surface().tools[0]!.config, transport: "rpc" } },
		{ config: { ...surface().tools[0]!.config, connectionReadOnly: false } },
		{ annotations: { readOnlyHint: false } },
		{ annotations: { readOnlyHint: true, destructiveHint: true } },
		{ config: { ...surface().tools[0]!.config, auth: { type: "none" } } },
		{
			config: {
				...surface().tools[0]!.config,
				auth: {
					type: "connection",
					connectionId: "other",
					scopes: ["calendar.read"],
				},
			},
		},
		{
			config: {
				...surface().tools[0]!.config,
				personalResourceBinding: undefined,
			},
		},
	])("shares the tool refusal checks: %j", async (change) => {
		mocks.surface.mockResolvedValue({
			...surface(),
			tools: [{ ...surface().tools[0], ...change }],
		});
		expect(await read()).toMatchObject({ status: "refused" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ connectionProviderId: "other" },
		{ connectionInstanceId: "other" },
		{ connectionScope: "tenant" },
	])("refuses a changed connection route: %j", async (route) => {
		const app = surface();
		Object.assign(app.app.metadata.mcpConfig, route);
		mocks.surface.mockResolvedValue(app);
		expect(await read()).toMatchObject({ status: "refused" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ calendarId: "other" },
		{},
		{ calendarId: ["calendar-1", "other"] },
	])("refuses unbound arguments: %j", async (args) => {
		expect(await read({ args })).toMatchObject({ status: "refused" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("keeps own-access enforcement for scheduled organization reads", async () => {
		tenant();
		mocks.organization.mockResolvedValue({
			slug: "fictional",
			metadata: {
				connectionAccessChecks: [
					{ connectionInstanceId: "account-1", checkEachPersonsAccess: true },
				],
			},
		});
		expect(await read({ actor: schedule })).toMatchObject({
			status: "refused",
			message: expect.stringContaining("checks each person's"),
		});
		expect(mocks.receipt.mock.calls[0]![1]).toMatchObject({ status: "denied" });
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it("settles failed reads without exposing internal errors", async () => {
		mocks.gateway.mockRejectedValue(new Error("private error details"));
		expect(await read()).toMatchObject({
			status: "refused",
			message: expect.not.stringContaining("private error"),
		});
		expect(mocks.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: "failed" }),
		);
	});
	it.each([
		{ actor: { kind: "user", id: "user-2", role: "owner" } },
		{ actor: { kind: "tedi" } },
		{ actor: { kind: "schedule", tediId: tedi.tediId } },
		{ resource },
		{ args: undefined },
		{ conversationId: "" },
	])(
		"rejects caller-supplied authority and malformed requests: %j",
		async (change) => {
			expect(await read(change)).toMatchObject({ status: "refused" });
			expect(mocks.workspace).not.toHaveBeenCalled();
		},
	);
});

describe("shared workspace connection refusal boundaries", () => {
	it.each([
		"machine",
		"missing user",
		"non-user principal",
		"different principal",
		"different actor",
		"use role",
		"preview",
	])("refuses an app session with %s", async (change) => {
		const ctx = context();
		let actor = { ...session };
		if (change === "machine") ctx.authType = "service-binding";
		if (change === "missing user") delete ctx.user;
		if (change === "non-user principal")
			actor = {
				...actor,
				principal: { kind: "service", id: "service-1" },
			} as WorkspaceAppSession;
		if (change === "different principal")
			actor.principal = { kind: "user", id: "user-2" };
		if (change === "different actor") actor.actorUserId = "user-2";
		if (change === "use role") actor.role = "use";
		if (change === "preview") actor.previewId = "preview-1";
		await expect(
			callWorkspaceAppConnection(ctx, actor, resource, input),
		).rejects.toThrow();
		expect(mocks.surface).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		undefined,
		{ tokenIds: [], tokenSub: "subject" },
		{ tokenIds: ["grant"], tokenSub: null },
	])("refuses a missing account grant: %j", async (account) => {
		mocks.account.mockResolvedValue(account);
		await expect(
			callWorkspaceAppConnection(context(), session, resource, input),
		).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each([
		{ paths: [["calendarId"]], args: {} },
		{ paths: [["calendarId"]], args: { calendarId: "other" } },
		{ paths: [["items", "*", "id"]], args: { items: [] } },
		{ paths: [["items", "*", "id"]], args: { items: "calendar-1" } },
		{
			paths: [["items", "*", "id"]],
			args: { items: Array.from({ length: 51 }, () => ({ id: "calendar-1" })) },
		},
		{
			paths: [["items", "*", "id"]],
			args: { items: [{ id: "calendar-1" }, { id: "other" }] },
		},
		{ paths: [["nested", "id"]], args: { nested: ["calendar-1"] } },
		{ paths: [["nested", "id"]], args: { nested: null } },
		{
			paths: [["constructor", "id"]],
			args: { constructor: { id: "calendar-1" } },
		},
		{
			paths: [["calendarId"], ["secondId"]],
			args: { calendarId: "calendar-1", secondId: "other" },
		},
	])(
		"refuses every mismatched resource argument: %j",
		async ({ paths, args }) => {
			const app = surface();
			app.tools[0]!.config.personalResourceBinding.paths = paths;
			mocks.surface.mockResolvedValue(app);
			await expect(
				callWorkspaceAppConnection(context(), session, resource, {
					...input,
					arguments: args,
				}),
			).rejects.toThrow();
			expect(mocks.create).not.toHaveBeenCalled();
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it("accepts a bounded wildcard only when every element points to the linked resource", async () => {
		const app = surface();
		app.tools[0]!.config.personalResourceBinding.paths = [["items", "*", "id"]];
		mocks.surface.mockResolvedValue(app);
		expect(
			await callWorkspaceAppConnection(context(), session, resource, {
				...input,
				arguments: { items: [{ id: "calendar-1" }, { id: "calendar-1" }] },
			}),
		).toMatchObject({ approval: { approved: false } });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.gateway).not.toHaveBeenCalled();
	});
	it.each(["MCP_SERVICE", "MCP_URL"] as const)(
		"refuses when %s is unavailable",
		async (key) => {
			const ctx = context();
			delete ctx.env[key];
			await expect(
				callWorkspaceAppConnection(ctx, session, resource, input),
			).rejects.toThrow("MCP service unavailable");
			expect(mocks.gateway).not.toHaveBeenCalled();
		},
	);
	it("settles a provider error as a failed receipt and preserves the tool result", async () => {
		const approved = await retry();
		const result = {
			isError: true,
			content: [{ type: "text", text: "Read unavailable" }],
		};
		mocks.gateway.mockResolvedValue(result);
		expect(
			await callWorkspaceAppConnection(context(), session, resource, approved),
		).toEqual(result);
		expect(mocks.settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				status: "failed",
				error: "Provider reported an error",
			}),
		);
	});
});
