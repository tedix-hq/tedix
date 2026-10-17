import type {
	McpServerApprovedScopes,
	McpServerScope,
} from "@tedix/auth/aih-client";
import { MCP_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	CONNECTION_SCOPE_DESCRIPTIONS,
	MCP_SCOPE_POLICY,
} from "@tedix/api-contract/utils/mcp-scope-catalog";
const AIH_CONNECTION_PLATFORM_SCOPES = Object.keys(
	MCP_SCOPE_POLICY.connectionScopes,
);
const WORK_CAPABILITY_SCOPES = [
	"mcp:work.read",
	"mcp:work.write",
	"mcp:work.admin",
] as const;
const TEDIX_DOMAIN_SCOPE_RE =
	/^mcp:(tedis|apps|memory|skills|content|catalog|observe|messaging|settings)\.(read|write|admin)$/;
const DESCOPE_AUTO_GRANTED_IDENTITY_SCOPES = new Set(
	Object.entries(MCP_SCOPE_POLICY.protocolScopes)
		.filter(([, definition]) => definition.advertise)
		.map(([name]) => name),
);
const TENANT_FORBIDDEN_SCOPES = new Set(["platform:admin"]);
const NON_EXACT_CAPABILITY_SCOPES = new Set(Object.keys(MCP_CAPABILITY_SCOPES));

/** Only first-party operator resources offer optional platform administration. */
export function isPlatformOperatorMcpResource(slug: string): boolean {
	return slug === "connect" || slug === "tedix" || slug === "tedix-unified";
}

function scopeName(scope: McpServerScope | string): string | null {
	if (typeof scope === "string") return scope.trim() || null;
	return typeof scope.name === "string" && scope.name.trim()
		? scope.name.trim()
		: null;
}

export function extractMcpApprovedScopeNames(
	approvedScopes: McpServerApprovedScopes | null | undefined,
): string[] {
	const names = new Set<string>();
	for (const value of Object.values(approvedScopes ?? {})) {
		if (!Array.isArray(value)) continue;
		for (const entry of value as Array<McpServerScope | string>) {
			const name = scopeName(entry);
			if (name) names.add(name);
		}
	}
	return [...names].sort();
}

export function extractMcpDefaultGrantedScopeNames(
	approvedScopes: McpServerApprovedScopes | null | undefined,
): string[] {
	const names = new Set<string>();
	for (const value of Object.values(approvedScopes ?? {})) {
		if (!Array.isArray(value)) continue;
		for (const entry of value as Array<McpServerScope | string>) {
			const name = scopeName(entry);
			if (name && (typeof entry === "string" || entry.optional !== true)) {
				names.add(name);
			}
		}
	}
	return [...names].sort();
}

/**
 * Descope rejects an MCP client whose requested scope is not registered on the
 * target server. Keep the platform scopes advertised by the MCP edge present
 * on every D1-owned Descope server and delete retired broad grants.
 */
export function reconcileMcpPlatformScopes(
	approvedScopes: McpServerApprovedScopes | null | undefined,
	options: { allowPlatformAdmin?: boolean } = {},
): McpServerApprovedScopes {
	const keptNames = new Set<string>();
	const current: McpServerApprovedScopes = {};
	for (const [category, value] of Object.entries(approvedScopes ?? {})) {
		if (!Array.isArray(value)) {
			(current as Record<string, unknown>)[category] = value;
			continue;
		}
		(current as Record<string, unknown>)[category] = value.flatMap(
			(entry: McpServerScope | string) => {
				const name = scopeName(entry);
				if (
					!name ||
					keptNames.has(name) ||
					DESCOPE_AUTO_GRANTED_IDENTITY_SCOPES.has(name) ||
					TENANT_FORBIDDEN_SCOPES.has(name) ||
					NON_EXACT_CAPABILITY_SCOPES.has(name)
				) {
					return [];
				}
				keptNames.add(name);
				return [
					typeof entry === "string"
						? {
								name,
								description: name,
								optional: MCP_SCOPE_POLICY.optionalScopes,
							}
						: { ...entry, name, optional: MCP_SCOPE_POLICY.optionalScopes },
				];
			},
		);
	}
	const names = new Set(extractMcpApprovedScopeNames(current));
	const connectionsScopes = [...(current.connectionsScopes ?? [])];
	if ([...names].some((name) => TEDIX_DOMAIN_SCOPE_RE.test(name))) {
		for (const name of WORK_CAPABILITY_SCOPES) {
			if (names.has(name)) continue;
			connectionsScopes.push({
				name,
				description: name.replace("mcp:work.", "Work Items: "),
				optional: MCP_SCOPE_POLICY.optionalScopes,
			});
			names.add(name);
		}
	}

	for (const name of AIH_CONNECTION_PLATFORM_SCOPES) {
		if (names.has(name)) continue;
		connectionsScopes.push({
			name,
			description: CONNECTION_SCOPE_DESCRIPTIONS[name] ?? name,
			optional: MCP_SCOPE_POLICY.optionalScopes,
		});
		names.add(name);
	}
	if (options.allowPlatformAdmin === true && !names.has("platform:admin")) {
		connectionsScopes.push({
			name: "platform:admin",
			description: CONNECTION_SCOPE_DESCRIPTIONS["platform:admin"],
			optional: MCP_SCOPE_POLICY.optionalScopes,
		});
	}

	return { ...current, connectionsScopes };
}
