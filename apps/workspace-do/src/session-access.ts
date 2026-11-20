import { operationAllowed } from "@tedix/api-contract/schemas/os-collaborators";
import {
	isWorkspaceGuestTediAllowed,
	readWorkspaceRuntimeRole,
} from "@tedix/db/queries/os-workspace-access";
import { hasActiveOsWorkspaceInspection } from "@tedix/db/queries/os-workspace-inspections";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	delegatedMachineScopes,
	hasScope,
} from "@tedix/mcp-shared/auth/scopes";
import type { WorkspaceScope } from "./env";
import { workspaceLog } from "./log";

export interface WorkspaceSession {
	scope: WorkspaceScope;
	actorId: string;
	actorKind: string;
	/** Null only for the OS worker's authenticated human socket. */
	scopes: string[] | null;
}

/**
 * Frames and outbound events consult the current graph on every call. The
 * role reader reuses a role only while the database's authorization fence is
 * unchanged, so a revoke is seen by the next check.
 */
export async function workspaceSessionAllowed(
	database: D1Database,
	session: WorkspaceSession | null | undefined,
	write = false,
): Promise<boolean> {
	if (!session?.scope || !session.actorId) return false;
	if (session.scopes !== null && !Array.isArray(session.scopes)) return false;
	if (session.scopes !== null) {
		const scopes = [
			...session.scopes,
			...delegatedMachineScopes(session.scopes),
		];
		if (!hasScope(scopes, write ? "apps:write" : "apps:read")) return false;
	}
	try {
		const db = createDbQueryClient(database);
		const role = await readWorkspaceRuntimeRole(db, session.scope, session);
		if (operationAllowed(role, "app.chat")) return true;
		// An organization admin's recorded inspection reads the chat through the
		// OS worker's socket and nothing else: no send, approval, cancel, rename,
		// archive or delete, and never on the MCP lane.
		return (
			!write &&
			session.scopes === null &&
			session.actorKind === "user" &&
			(await hasActiveOsWorkspaceInspection(db, session.scope, session.actorId))
		);
	} catch (error) {
		// Fails closed; the line tells a refused person from a failed read.
		workspaceLog.warn("Workspace access check failed", {
			event: "workspace.access_check_failed",
			workspaceId: session.scope.workspaceId,
			error,
		});
		return false;
	}
}

export async function assertWorkspaceGuestTedi(
	database: D1Database,
	session: WorkspaceSession,
	tediId?: string,
) {
	if (!tediId) return;
	if (
		!(await isWorkspaceGuestTediAllowed(
			createDbQueryClient(database),
			session.scope.organizationId,
			session,
			tediId,
		))
	)
		throw new Error(
			"Your message was not sent: you cannot pick that tedi here. Pick an organization tedi or one of your own.",
		);
}
