import type { CallerIdentity } from "./caller-identity";

/**
 * A platform-scoped caller may deliberately address a tenant other than the
 * app's own organization. The downstream API independently verifies that
 * platform authority before accepting the target.
 */
export function hasPlatformMcpScope(
	caller: Pick<CallerIdentity, "scopes"> | undefined,
): boolean {
	const scopes = caller?.scopes ?? [];
	return scopes.includes("platform:admin") || scopes.includes("*");
}

/**
 * Resolves the organization sent on the trusted MCP → API hop. Ordinary
 * callers are always pinned to the served app/caller organization. A verified
 * platform operator may deliberately address an explicit organizationId, which
 * the API then checks against its live D1 membership and platform authority.
 */
export function resolveRpcOrganizationId(
	caller: Pick<CallerIdentity, "scopes" | "organizationId"> | undefined,
	appOrganizationId: string | undefined,
	params: Record<string, unknown>,
): string | undefined {
	const requestedOrganizationId =
		typeof params.organizationId === "string" &&
		params.organizationId.length > 0
			? params.organizationId
			: undefined;
	if (requestedOrganizationId && hasPlatformMcpScope(caller)) {
		return requestedOrganizationId;
	}
	return caller?.organizationId ?? appOrganizationId;
}
