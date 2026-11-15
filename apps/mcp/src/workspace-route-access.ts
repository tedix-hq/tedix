import {
	delegatedMachineScopes,
	hasScope,
} from "@tedix/mcp-shared/auth/scopes";
import { callApiRpc } from "./lib/rpc";

/** The caller the gateway authenticated for a `/mcp/workspaces/{id}` request. */
export interface WorkspaceRouteCaller {
	organizationId: string;
	workspaceId: string;
	authType: string | null;
	tediId: string | null;
	userId: string | null;
	bearerToken: string | null;
	scopes: string[];
}

/** Ask the API for the workspace under these caller headers; returns the HTTP status. */
export type WorkspaceLookup = (
	headers: Record<string, string>,
) => Promise<number>;

export type WorkspaceRouteAccess = "allow" | "deny" | "unavailable";

/**
 * Whether this caller may reach the workspace, by the API's own visibility
 * rule (`assertOsWorkspaceVisible`): everyone in the organization sees a
 * shared workspace; a private one is seen by its owner, a build collaborator,
 * or the owner's personal tedi. The gateway never decides this itself.
 */
export async function resolveWorkspaceRouteAccess(
	lookup: WorkspaceLookup,
	caller: WorkspaceRouteCaller,
): Promise<WorkspaceRouteAccess> {
	const scopes = [...caller.scopes, ...delegatedMachineScopes(caller.scopes)];
	if (!hasScope(scopes, "apps:read")) return "deny";
	let headers: Record<string, string>;
	if (caller.authType === "tedi" && caller.tediId) {
		headers = {
			"X-Tedix-Org-Id": caller.organizationId,
			"X-Tedix-Tedi-Scopes": "apps:read",
			"X-Tedix-Tedi-Id": caller.tediId,
		};
	} else if (
		(caller.authType === "oauth" || caller.authType === "user") &&
		caller.bearerToken &&
		caller.userId
	) {
		headers = {
			"X-Tedix-Org-Id": caller.organizationId,
			"X-Forwarded-Authorization": `Bearer ${caller.bearerToken}`,
			"X-Tedix-Caller-Type": "mcp-edge-user",
			...(caller.scopes.length
				? { "X-Tedix-Mcp-Caller-Scopes": caller.scopes.join(" ") }
				: {}),
		};
	} else return "deny";
	try {
		const status = await lookup(headers);
		if (status === 200) return "allow";
		return status >= 500 || status === 429 ? "unavailable" : "deny";
	} catch {
		return "unavailable";
	}
}

export function apiWorkspaceLookup(
	env: Parameters<typeof callApiRpc>[0],
	workspaceId: string,
): WorkspaceLookup {
	return async (headers) =>
		(
			await callApiRpc(
				env,
				"osWorkspaces/workspaces/get",
				{ workspaceId },
				{ headers, timeoutMs: 10_000 },
			)
		).status;
}
