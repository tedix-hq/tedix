/**
 * A skipped Descope AIH client sync must not read as a clean success.
 *
 * `create` / `updateRole` do two independent things: grant the FGA relation,
 * then sync the tedi's Descope AIH client. The second legitimately no-ops when
 * the app carries no `mcpConfig.descopeResourceId` — `ensureTediAihClientForApp`
 * returns `status: "skipped"` and NO client is ever created. Before this guard
 * the handlers returned a fully-formed assignment either way and recorded the
 * outcome only in a `console.log`, so a caller could not tell "assigned and
 * MCP-credentialed" from "assigned, with no MCP credentials at all".
 *
 * These tests assert the outcome is in the RETURNED payload (which oRPC
 * validates against the contract output schema), and that a successful sync is
 * distinguishable from a skipped one by more than a boolean.
 */

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	ensureTediAihClientForApp: vi.fn(),
	getManagementClient: vi.fn(() => ({}) as never),
	getAssignedAppRoles: vi.fn(),
	getAppRoleStateForMutation: vi.fn(),
	grantAppOperator: vi.fn(async () => undefined),
	grantAppObserver: vi.fn(async () => undefined),
	deleteAppRelation: vi.fn(async () => undefined),
	revokeAppAccess: vi.fn(async () => undefined),
	emitAuditEvent: vi.fn(async () => undefined),
	getAppById: vi.fn(),
	getTediById: vi.fn(),
	getAppsByOrganization: vi.fn(),
}));

vi.mock("@tedix/db/queries/apps", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getAppsByOrganization: mocks.getAppsByOrganization,
	};
});

vi.mock("../../lib/tedi-aih-client-sync", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		ensureTediAihClientForApp: mocks.ensureTediAihClientForApp,
	};
});

vi.mock("@tedix/auth/client", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getManagementClient: mocks.getManagementClient };
});

vi.mock("@tedix/auth/fga", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getAssignedAppRoles: mocks.getAssignedAppRoles,
		getAppRoleStateForMutation: mocks.getAppRoleStateForMutation,
		grantAppOperator: mocks.grantAppOperator,
		grantAppObserver: mocks.grantAppObserver,
		deleteAppRelation: mocks.deleteAppRelation,
		revokeAppAccess: mocks.revokeAppAccess,
	};
});

vi.mock("../audit-helpers", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, emitAuditEvent: mocks.emitAuditEvent };
});

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getAppById: mocks.getAppById };
});

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getTediById: mocks.getTediById };
});

import { tediAppAssignmentsContractRouter } from "./tedi-app-assignments";

const ORG_ID = "3f4d1c7a-8b2e-4f61-9a0d-5c6e7f8a9b01";
const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const TEDI_ID = "9c1de3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ASSIGNMENT_ID = `fga:${TEDI_ID}:${APP_ID}`;

function context(): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["platform:admin", "tedis:write"],
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "P-test",
			DESCOPE_MANAGEMENT_KEY: "K-test",
			SECRETS_MASTER_KEY: "M-test",
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/tedi-app-assignments"),
	} as BaseContext;
}

/** An app with NO `mcpConfig.descopeResourceId` — the skip trigger. */
const SKIPPED_SYNC = {
	status: "skipped" as const,
	appId: APP_ID,
	appSlug: "no-mcp-app",
	tediId: TEDI_ID,
	scopes: ["mcp:catalog", "mcp:observe"],
	reason: "App has no mcpConfig.descopeResourceId",
};

const CREATED_SYNC = {
	status: "created" as const,
	appId: APP_ID,
	appSlug: "mcp-app",
	tediId: TEDI_ID,
	mcpServerId: "MS-app",
	clientId: "client-abc",
	scopes: ["mcp:catalog", "mcp:observe"],
	secretNames: {
		clientIdName: "MCP_APP_CLIENT_ID",
		clientSecretName: "MCP_APP_CLIENT_SECRET",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getManagementClient.mockReturnValue({} as never);
	mocks.getAppById.mockResolvedValue({
		id: APP_ID,
		name: "Test App",
		slug: "test-app",
		organizationId: ORG_ID,
		metadata: {},
	});
	mocks.getTediById.mockResolvedValue({
		id: TEDI_ID,
		name: "Test Tedi",
		slug: "test-tedi",
		organizationId: ORG_ID,
		descopeUserId: "descope-user-1",
		mcpCapabilityProfile: "standard",
	});
	mocks.getAssignedAppRoles.mockResolvedValue({});
	mocks.getAppRoleStateForMutation.mockResolvedValue({
		operator: true,
		observer: false,
	});
	mocks.getAppsByOrganization.mockResolvedValue([]);
});

describe("create surfaces the AIH client sync outcome", () => {
	it("reports a skipped sync in the returned payload, not only in a log", async () => {
		mocks.ensureTediAihClientForApp.mockResolvedValue(SKIPPED_SYNC);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		const result = await client.create({
			appId: APP_ID,
			tediId: TEDI_ID,
			role: "operator",
		});

		// The FGA grant genuinely happened — this is a success response, and the
		// skip must not be signalled by throwing.
		expect(mocks.grantAppOperator).toHaveBeenCalledTimes(1);
		expect(mocks.emitAuditEvent).toHaveBeenCalledTimes(2);
		expect(mocks.emitAuditEvent.mock.calls[0]?.[1].action).toBe(
			"tedi_app_assignment.grant_requested",
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
			context().db,
			expect.objectContaining({
				organizationId: ORG_ID,
				actorId: "key-1",
				actorType: "api_key",
				action: "tedi_app_assignment.granted",
				resourceType: "tedi_app_assignment",
				resourceId: ASSIGNMENT_ID,
				metadata: expect.objectContaining({
					appId: APP_ID,
					tediId: TEDI_ID,
					role: "operator",
				}),
			}),
		);
		expect(mocks.emitAuditEvent.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.grantAppOperator.mock.invocationCallOrder[0]!,
		);
		expect(mocks.grantAppOperator.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.emitAuditEvent.mock.invocationCallOrder[1]!,
		);
		expect(mocks.emitAuditEvent.mock.invocationCallOrder[1]).toBeLessThan(
			mocks.ensureTediAihClientForApp.mock.invocationCallOrder[0]!,
		);
		expect(result.id).toBe(ASSIGNMENT_ID);
		expect(result.role).toBe("operator");

		// ...but the caller can see the AIH client was never created, and why.
		expect(result.aihClientSync.status).toBe("skipped");
		expect(result.aihClientSync.reason).toBe(
			"App has no mcpConfig.descopeResourceId",
		);
		expect(result.aihClientSync.clientId).toBeUndefined();
		expect(result.aihClientSync.mcpServerId).toBeUndefined();
	});

	it("is distinguishable from a successful sync by status, not by presence", async () => {
		mocks.ensureTediAihClientForApp.mockResolvedValue(CREATED_SYNC);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		const result = await client.create({
			appId: APP_ID,
			tediId: TEDI_ID,
			role: "operator",
		});

		expect(result.aihClientSync.status).toBe("created");
		expect(result.aihClientSync.clientId).toBe("client-abc");
		expect(result.aihClientSync.mcpServerId).toBe("MS-app");
		expect(result.aihClientSync.reason).toBeUndefined();
		// The discriminator is a closed union, so "created" vs "updated" vs
		// "skipped" survives; a boolean would have erased it.
		expect(result.aihClientSync.status).not.toBe(SKIPPED_SYNC.status);
	});

	it("does not claim a grant in the audit trail when Descope rejects it", async () => {
		mocks.grantAppOperator.mockRejectedValueOnce(
			new Error("Descope unavailable"),
		);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.create({ appId: APP_ID, tediId: TEDI_ID, role: "operator" }),
		).rejects.toThrow();
		expect(mocks.emitAuditEvent).toHaveBeenCalledTimes(1);
		expect(mocks.emitAuditEvent.mock.calls[0]?.[1].action).toBe(
			"tedi_app_assignment.grant_requested",
		);
		expect(mocks.ensureTediAihClientForApp).not.toHaveBeenCalled();
	});

	it("does not call Descope when the requested audit event cannot be stored", async () => {
		mocks.emitAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.create({ appId: APP_ID, tediId: TEDI_ID, role: "operator" }),
		).rejects.toThrow();
		expect(mocks.grantAppOperator).not.toHaveBeenCalled();
	});
});

describe("updateRole surfaces the AIH client sync outcome", () => {
	it("reports a skipped re-scope in the returned payload", async () => {
		mocks.ensureTediAihClientForApp.mockResolvedValue(SKIPPED_SYNC);
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: false, observer: true });
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		const result = await client.updateRole({
			assignmentId: ASSIGNMENT_ID,
			role: "observer",
		});

		expect(mocks.grantAppObserver).toHaveBeenCalledTimes(1);
		expect(mocks.emitAuditEvent).toHaveBeenCalledTimes(2);
		expect(mocks.emitAuditEvent.mock.calls[0]?.[1].action).toBe(
			"tedi_app_assignment.role_change_requested",
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
			context().db,
			expect.objectContaining({
				action: "tedi_app_assignment.role_changed",
				resourceId: ASSIGNMENT_ID,
				metadata: expect.objectContaining({
					previousRole: "operator",
					role: "observer",
				}),
			}),
		);
		expect(mocks.emitAuditEvent.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.grantAppObserver.mock.invocationCallOrder[0]!,
		);
		expect(mocks.grantAppObserver.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteAppRelation.mock.invocationCallOrder[0]!,
		);
		expect(mocks.deleteAppRelation).toHaveBeenCalledWith(
			{},
			"descope-user-1",
			APP_ID,
			"operator",
		);
		expect(mocks.deleteAppRelation.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.emitAuditEvent.mock.invocationCallOrder[1]!,
		);
		expect(mocks.revokeAppAccess).not.toHaveBeenCalled();
		expect(result.role).toBe("observer");
		expect(result.aihClientSync.status).toBe("skipped");
		expect(result.aihClientSync.reason).toBe(
			"App has no mcpConfig.descopeResourceId",
		);
	});

	it("reports an applied re-scope distinctly", async () => {
		mocks.ensureTediAihClientForApp.mockResolvedValue({
			...CREATED_SYNC,
			status: "updated" as const,
		});
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: false, observer: true });
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		const result = await client.updateRole({
			assignmentId: ASSIGNMENT_ID,
			role: "observer",
		});

		expect(result.aihClientSync.status).toBe("updated");
		expect(result.aihClientSync.clientId).toBe("client-abc");
	});

	it("preserves the old relation when the replacement grant fails", async () => {
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: true, observer: false });
		mocks.grantAppObserver.mockRejectedValueOnce(
			new Error("Descope unavailable"),
		);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.revokeAppAccess).not.toHaveBeenCalled();
		expect(mocks.deleteAppRelation).toHaveBeenCalledWith(
			{},
			"descope-user-1",
			APP_ID,
			"observer",
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledTimes(2);
		expect(mocks.emitAuditEvent.mock.calls[0]?.[1].action).toBe(
			"tedi_app_assignment.role_change_requested",
		);
		expect(mocks.emitAuditEvent.mock.calls[1]?.[1].action).toBe(
			"tedi_app_assignment.role_change_rolled_back",
		);
	});

	it("records an unresolved recovery when old-relation removal fails", async () => {
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: false, observer: true });
		mocks.deleteAppRelation
			.mockRejectedValueOnce(new Error("Descope unavailable"))
			.mockRejectedValueOnce(new Error("Descope unavailable"));
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.grantAppOperator).toHaveBeenCalledTimes(1);
		expect(mocks.emitAuditEvent.mock.calls[1]?.[1].action).toBe(
			"tedi_app_assignment.role_change_recovery_failed",
		);
		expect(mocks.ensureTediAihClientForApp).not.toHaveBeenCalled();
	});

	it("verifies restoration when old-relation removal rejects", async () => {
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: true, observer: false });
		mocks.deleteAppRelation.mockRejectedValueOnce(
			new Error("Descope unavailable"),
		);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.grantAppOperator).toHaveBeenCalledTimes(1);
		expect(mocks.deleteAppRelation).toHaveBeenCalledWith(
			{},
			"descope-user-1",
			APP_ID,
			"observer",
		);
		expect(mocks.emitAuditEvent.mock.calls[1]?.[1].action).toBe(
			"tedi_app_assignment.role_change_rolled_back",
		);
	});

	it("rejects an unconfirmed target state and restores the original relation", async () => {
		mocks.getAppRoleStateForMutation
			.mockResolvedValueOnce({ operator: true, observer: false })
			.mockResolvedValueOnce({ operator: true, observer: true })
			.mockResolvedValueOnce({ operator: true, observer: false });
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.grantAppOperator).toHaveBeenCalledTimes(1);
		expect(mocks.deleteAppRelation).toHaveBeenCalledTimes(2);
		expect(mocks.emitAuditEvent.mock.calls[1]?.[1].action).toBe(
			"tedi_app_assignment.role_change_rolled_back",
		);
	});

	it("refuses an unverified current relation before any mutation", async () => {
		mocks.getAppRoleStateForMutation.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.grantAppObserver).not.toHaveBeenCalled();
		expect(mocks.deleteAppRelation).not.toHaveBeenCalled();
		expect(mocks.emitAuditEvent).not.toHaveBeenCalled();
	});

	it("refuses a role change when no current assignment exists", async () => {
		mocks.getAppRoleStateForMutation.mockResolvedValueOnce({
			operator: false,
			observer: false,
		});
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await expect(
			client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" }),
		).rejects.toThrow();
		expect(mocks.grantAppObserver).not.toHaveBeenCalled();
		expect(mocks.deleteAppRelation).not.toHaveBeenCalled();
		expect(mocks.emitAuditEvent).not.toHaveBeenCalled();
	});

	it("does not rewrite an already-correct relation", async () => {
		mocks.getAppRoleStateForMutation.mockResolvedValueOnce({
			operator: false,
			observer: true,
		});
		mocks.ensureTediAihClientForApp.mockResolvedValue(SKIPPED_SYNC);
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		await client.updateRole({ assignmentId: ASSIGNMENT_ID, role: "observer" });
		expect(mocks.grantAppObserver).not.toHaveBeenCalled();
		expect(mocks.deleteAppRelation).not.toHaveBeenCalled();
		expect(mocks.emitAuditEvent).not.toHaveBeenCalled();
	});
});

describe("delete audits the completed FGA revocation", () => {
	it("records the principal and exact relation after Descope revokes it", async () => {
		mocks.getAssignedAppRoles.mockResolvedValue({ [APP_ID]: "observer" });
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});
		await client.delete({ assignmentId: ASSIGNMENT_ID });

		expect(mocks.revokeAppAccess).toHaveBeenCalledTimes(1);
		expect(mocks.emitAuditEvent).toHaveBeenCalledTimes(2);
		expect(mocks.emitAuditEvent.mock.calls[0]?.[1].action).toBe(
			"tedi_app_assignment.revoke_requested",
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
			context().db,
			expect.objectContaining({
				organizationId: ORG_ID,
				actorId: "key-1",
				actorType: "api_key",
				action: "tedi_app_assignment.revoked",
				resourceId: ASSIGNMENT_ID,
				metadata: expect.objectContaining({
					appId: APP_ID,
					tediId: TEDI_ID,
					previousRole: "observer",
				}),
			}),
		);
		expect(mocks.emitAuditEvent.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.revokeAppAccess.mock.invocationCallOrder[0]!,
		);
		expect(mocks.revokeAppAccess.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.emitAuditEvent.mock.invocationCallOrder[1]!,
		);
	});
});

describe("reconcileManagedByTedi surfaces every AIH client sync it attempted", () => {
	it("returns an empty sync list on a dry run rather than implying syncs ran", async () => {
		const client = createRouterClient(tediAppAssignmentsContractRouter, {
			context: context(),
		});

		const result = await client.reconcileManagedByTedi({
			tediId: TEDI_ID,
			dryRun: true,
			pruneExtra: false,
		});

		expect(result.dryRun).toBe(true);
		expect(result.aihClientSyncs).toEqual([]);
		expect(mocks.ensureTediAihClientForApp).not.toHaveBeenCalled();
	});
});
