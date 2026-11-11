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
	const attempts: Record<string, string>[] = [
		{
			"X-Tedix-Org-Id": caller.organizationId,
			// Read authority for this one lookup; identity decides visibility.
			"X-Tedix-Tedi-Scopes": "apps:read",
			...(caller.tediId ? { "X-Tedix-Tedi-Id": caller.tediId } : {}),
			// A person bound to a tedi is still that person, not the tedi's owner.
			...(caller.tediId && caller.authType !== "tedi" && caller.userId
				? { "X-Tedix-Acting-User": caller.userId }
				: {}),
		},
	];
	if (
		(caller.authType === "oauth" || caller.authType === "user") &&
		caller.bearerToken
	)
		attempts.push({
			"X-Tedix-Org-Id": caller.organizationId,
			"X-Forwarded-Authorization": `Bearer ${caller.bearerToken}`,
			"X-Tedix-Caller-Type": "mcp-edge-user",
			...(caller.scopes.length
				? { "X-Tedix-Mcp-Caller-Scopes": caller.scopes.join(" ") }
				: {}),
		});

	let unavailable = false;
	for (const headers of attempts) {
		let status: number;
		try {
			status = await lookup(headers);
		} catch {
			status = 503;
		}
		if (status === 200) return "allow";
		if (status >= 500 || status === 429) unavailable = true;
	}
	return unavailable ? "unavailable" : "deny";
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
