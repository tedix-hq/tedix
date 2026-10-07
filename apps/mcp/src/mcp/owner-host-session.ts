/**
 * Per-call owner-host Agent-Session attribution for plugin-only MCP hosts.
 *
 * Hosts such as Claude desktop or ChatGPT reach Tedix with their human owner's
 * OAuth grant, and this server is stateless, so the host's Agent-Session must
 * travel with each Code Mode call (`agentSessionId`). Only a human OAuth caller
 * may name one, and only a session apps/api resolves as that same user's
 * active `owner_user` session. Machine callers already carry their own
 * verified identity, so the argument is ignored for them.
 */

import { getInternalApiClient } from "@tedix/api-client/internal";
import { OWNER_HOST_SESSION_HEADER } from "@tedix/api-contract/contracts/external-agent-identity";
import type { CallerIdentity } from "./caller-identity";

export class OwnerHostSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerHostSessionError";
	}
}

/** True only for an interactive human OAuth caller (never AIH M2M, tedi, or external agent). */
export function isOwnerHostEligibleCaller(
	caller: CallerIdentity | undefined,
	bearerToken: string | undefined,
): boolean {
	return Boolean(
		caller &&
		(caller.authType === "oauth" || caller.authType === "user") &&
		caller.credentialMode !== "aih-m2m" &&
		!caller.tediId &&
		!caller.externalAgentPrincipalId &&
		!caller.skillRunId &&
		!caller.kernel &&
		bearerToken,
	);
}

const MAX_CANDIDATE_ORGANIZATIONS = 10;

function candidateOrganizations(
	caller: CallerIdentity,
	appOrganizationId: string | undefined,
): string[] {
	const verified = caller.verifiedMultiOrgOrganizations?.map(
		(org) => org.organizationId,
	);
	const candidates = verified?.length
		? verified
		: [caller.organizationId ?? appOrganizationId];
	return [
		...new Set(candidates.filter((id): id is string => Boolean(id))),
	].slice(0, MAX_CANDIDATE_ORGANIZATIONS);
}

/**
 * Preflight the named session against apps/api as the forwarded human. The
 * API re-validates it on every forwarded call; this check makes an invalid id
 * fail the whole Code Mode call before any inner tool runs.
 */
export async function verifyOwnerHostSession(input: {
	env: Pick<CloudflareEnv, "API_SERVICE">;
	caller: CallerIdentity;
	bearerToken: string;
	appOrganizationId: string | undefined;
	sessionId: string;
}): Promise<{ sessionId: string; organizationId: string }> {
	if (!input.env.API_SERVICE) {
		throw new OwnerHostSessionError(
			"agentSessionId cannot be verified: the API service binding is unavailable",
		);
	}
	const organizations = candidateOrganizations(
		input.caller,
		input.appOrganizationId,
	);
	for (const organizationId of organizations) {
		const client = getInternalApiClient(input.env, {
			organizationId,
			headers: {
				"X-Forwarded-Authorization": `Bearer ${input.bearerToken}`,
				"X-Tedix-Caller-Type": "mcp-edge-user",
				[OWNER_HOST_SESSION_HEADER]: input.sessionId,
				...(input.caller.scopes?.length
					? { "X-Tedix-Mcp-Caller-Scopes": input.caller.scopes.join(" ") }
					: {}),
			},
		});
		try {
			const resolved =
				await client.externalAgentIdentity.resolveOwnerHostSession({
					sessionId: input.sessionId,
				});
			if (
				resolved.session.id === input.sessionId &&
				resolved.session.organizationId === organizationId &&
				resolved.session.status === "active"
			) {
				return { sessionId: resolved.session.id, organizationId };
			}
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (
				code !== "UNAUTHORIZED" &&
				code !== "FORBIDDEN" &&
				code !== "NOT_FOUND"
			) {
				throw new OwnerHostSessionError(
					"agentSessionId could not be verified right now; retry shortly",
				);
			}
			// Not this organization's session; a uniform refusal follows.
		}
	}
	throw new OwnerHostSessionError(
		"agentSessionId is not an active owner-host Agent-Session of the authenticated user. Start one with start_external_agent_session_for_host and pass its session id.",
	);
}

/**
 * Decide the owner-host Agent-Session for one Code Mode execution. Absent, or
 * named by a non-human caller: undefined (behaviour unchanged). Named by a
 * human: the verified id, or OwnerHostSessionError — never a silent fallback
 * to the owner's own identity.
 */
export async function resolveCodeModeOwnerHostSession(input: {
	agentSessionId: string | undefined;
	caller: CallerIdentity | undefined;
	bearerToken: string | undefined;
	env: Pick<CloudflareEnv, "API_SERVICE">;
	appOrganizationId: string | undefined;
}): Promise<string | undefined> {
	if (
		!input.agentSessionId ||
		!input.caller ||
		!input.bearerToken ||
		!isOwnerHostEligibleCaller(input.caller, input.bearerToken)
	) {
		return undefined;
	}
	const verified = await verifyOwnerHostSession({
		env: input.env,
		caller: input.caller,
		bearerToken: input.bearerToken,
		appOrganizationId: input.appOrganizationId,
		sessionId: input.agentSessionId,
	});
	return verified.sessionId;
}
