import type {
	McpServerApprovedScopes,
	McpServerScope,
} from "@tedix/auth/aih-client";
import { MCP_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";
const PLATFORM_SCOPE_DESCRIPTIONS: Record<string, string> = {
	"connections.read":
		"Read data through reviewed organization connection tools",
	"connections.execute":
		"Invoke an approved action through an organization connection",
	"connections.admin":
		"Perform a destructive action through an organization connection",
	"platform:admin": "Operate the cross-organization Tedix control plane",
};

const AIH_CONNECTION_PLATFORM_SCOPES = [
	"connections.read",
	"connections.execute",
	"connections.admin",
] as const;
const WORK_CAPABILITY_SCOPES = [
	"mcp:work.read",
	"mcp:work.write",
	"mcp:work.admin",
] as const;
const TEDIX_DOMAIN_SCOPE_RE =
	/^mcp:(tedis|apps|memory|skills|content|catalog|observe|messaging|settings)\.(read|write|admin)$/;
const DESCOPE_AUTO_GRANTED_IDENTITY_SCOPES = new Set(["profile", "email"]);
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
						? { name, description: name, optional: true }
						: { ...entry, name, optional: true },
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
				optional: true,
			});
			names.add(name);
		}
	}

	for (const name of AIH_CONNECTION_PLATFORM_SCOPES) {
		if (names.has(name)) continue;
		connectionsScopes.push({
			name,
			description: PLATFORM_SCOPE_DESCRIPTIONS[name] ?? name,
			optional: true,
		});
		names.add(name);
	}
	if (options.allowPlatformAdmin === true && !names.has("platform:admin")) {
		connectionsScopes.push({
			name: "platform:admin",
			description: PLATFORM_SCOPE_DESCRIPTIONS["platform:admin"],
			optional: true,
		});
	}

	return { ...current, connectionsScopes };
}
