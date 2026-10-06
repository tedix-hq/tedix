/**
 * @tedix/mcp — MCP Scope Utilities
 *
 * Scope convention helpers for MCP tool-level authorization.
 * Descope Agentic Identity Hub uses `mcp:<tool>` scope convention.
 *
 * Extracted from @tedix/api-contract/schemas/mcp-scopes and extended
 * with tedi-specific scopes for the tedi runtime MCP server.
 *
 * @see https://docs.descope.com/agentic-identity-hub
 */

import { MCP_GRANULAR_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";

// =============================================================================
// SCOPE CONVERSION
// =============================================================================

/**
 * Convert a tool ID to an MCP scope string.
 * Replaces underscores with dots per Descope convention.
 *
 * @example toolToScope("invoice_create") // "mcp:invoice.create"
 * @example toolToScope("search_listings") // "mcp:search.listings"
 */
export function toolToScope(toolId: string): string {
	return `mcp:${toolId.replace(/_/g, ".")}`;
}

// =============================================================================
// PLATFORM SCOPES
// =============================================================================

/**
 * Standard platform scopes (non-tool).
 * Always included in scopes_supported regardless of tool configuration.
 *
 * - `connections.read`: Invoke reviewed read-only connected-provider tools.
 * - `connections.execute`: Invoke an authorized connected provider. Credential
 *   retrieval remains an internal implementation detail.
 * - `profile`: User profile read access (OpenID Connect standard)
 * - `email`: User email access (OpenID Connect standard)
 */
export const PLATFORM_SCOPES = [
	"connections.read",
	"connections.execute",
	"connections.admin",
	"profile",
	"email",
] as const;

export type PlatformScope = (typeof PLATFORM_SCOPES)[number];
export const PLATFORM_OPERATOR_SCOPE = "platform:admin" as const;
export type PlatformOperatorScope = typeof PLATFORM_OPERATOR_SCOPE;

// =============================================================================
// CAPABILITY SCOPES
// =============================================================================

/**
 * Granular capability scopes for tool-level authorization.
 * Each domain maps tools to explicit read/write/admin grants — see
 * `packages/api-contract/src/schemas/mcp-capability-scopes.ts` (`PREFIX_RULES`,
 * `toolToCapabilityScope()`).
 *
 * `mcp:tedis.read` through `mcp:settings.admin` are exact capability grants.
 * `platform:admin` is defined separately and implies none of these capabilities.
 */
export const CAPABILITY_SCOPES = Object.keys(
	MCP_GRANULAR_CAPABILITY_SCOPES,
) as Array<keyof typeof MCP_GRANULAR_CAPABILITY_SCOPES>;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

// =============================================================================
// CAPABILITY SCOPE CATALOG
// =============================================================================

/**
 * Human-readable descriptions of each capability scope.
 *
 * Lives beside the scopes it describes rather than being mirrored into
 * `@tedix/api-contract`, for the same reason the RBAC catalog does: this is
 * static build-time data, so a second copy on the wire would buy nothing and
 * add one more surface that can disagree with what the MCP edge enforces. This
 * catalog derives from the API contract capability scopes and product surfaces
 * consume it directly.
 *
 * This catalog drives the product-facing explanation of each exact grant.
 */
export interface CapabilityScopeMetadata {
	/** Short label, sentence case. */
	label: string;
	/** One sentence on what holding this scope permits. */
	description: string;
	/**
	 * True when the scope is meant for people administering a tenant rather than
	 * for a tedi identity. Mirrors `NON_TEDI_CAPABILITY_SCOPES` below, which is
	 * what actually withholds them from a worker's default profile.
	 */
	humanOnly: boolean;
}

export const CAPABILITY_SCOPE_METADATA: Record<
	CapabilityScope,
	CapabilityScopeMetadata
> = Object.fromEntries(
	Object.entries(MCP_GRANULAR_CAPABILITY_SCOPES).map(([scope, description]) => [
		scope,
		{
			label: scope.replace("mcp:", "").replace(".", " "),
			description,
			humanOnly: scope.startsWith("mcp:settings."),
		},
	]),
) as Record<CapabilityScope, CapabilityScopeMetadata>;

/**
 * Capability scopes a tedi identity must never receive by default.
 * `mcp:settings.*` is human-admin governance (org
 * members, connections, org settings) and is granted to people, not workers.
 */
const NON_TEDI_CAPABILITY_SCOPES: readonly CapabilityScope[] = [
	...CAPABILITY_SCOPES.filter((scope) => scope.endsWith(".admin")),
	"mcp:settings.read",
	"mcp:settings.write",
];

/**
 * MCP capability profiles -- config-driven scope assignment for tedi identities.
 * Source of truth for profile values is D1 `tedis.mcp_capability_profile`.
 */
export const CAPABILITY_PROFILES = {
	/** Standard tedi -- read/write worker capabilities, no admin/settings scopes. */
	standard: CAPABILITY_SCOPES.filter(
		(s) => !NON_TEDI_CAPABILITY_SCOPES.includes(s),
	),
	/**
	 * Content-admin tedi -- a standard worker that also owns the org's CMS and
	 * docs sites: `mcp:content.admin` (unpublish, theme source commit and deploy,
	 * site configuration). Granted to the tedi that runs marketing, without the
	 * settings, member, tedi, or app administration an `org_admin` holds.
	 */
	content_admin: [
		...CAPABILITY_SCOPES.filter((s) => !NON_TEDI_CAPABILITY_SCOPES.includes(s)),
		"mcp:content.admin",
	],
	/**
	 * Org-admin tedi -- the tenant's designated OPERATOR. Everything a standard
	 * tedi has PLUS granular `.admin` and `mcp:settings.*` scopes (install/manage the org's
	 * own MCP apps, manage its connections and settings) — but NOT `platform:admin`.
	 *
	 * The point: let a tenant's primary tedi run its own org end-to-end so the
	 * human never has to open the dashboard, WITHOUT any cross-org/platform reach.
	 * Because it lacks `platform:admin`, `isPlatformPrincipal` is false for it, so every
	 * apps/api handler still confines it to its own org (own-org enforcement lives
	 * in the handlers, not the scope) and platform-wide surfaces (`waitlist.*`,
	 * `tenantMembership.*`, cross-org `apps.provision`) stay out of reach.
	 */
	org_admin: [...CAPABILITY_SCOPES],
	/** Platform operator -- tenant capabilities plus explicit cross-org authority. */
	platform_admin: [...CAPABILITY_SCOPES],
} as const satisfies Record<string, readonly CapabilityScope[]>;

export type McpCapabilityProfile = keyof typeof CAPABILITY_PROFILES;

/**
 * Resolve scopes for a tedi based on its capability profile.
 * Falls back to "standard" for unknown profiles.
 */
export function resolveTediScopes(
	profile: string | null | undefined,
): readonly (CapabilityScope | PlatformScope | PlatformOperatorScope)[] {
	if (profile && profile in CAPABILITY_PROFILES) {
		return [
			...CAPABILITY_PROFILES[profile as McpCapabilityProfile],
			"connections.execute",
			...(profile === "org_admin" || profile === "platform_admin"
				? (["connections.admin"] as const)
				: []),
			...(profile === "platform_admin"
				? ([PLATFORM_OPERATOR_SCOPE] as const)
				: []),
		];
	}
	return [...CAPABILITY_PROFILES.standard, "connections.execute"];
}

/**
 * Default scopes assigned to authenticated tedi identities (standard profile).
 * Worker read/write capabilities and connections.execute; no admin/settings scopes.
 */
export const DEFAULT_TEDI_SCOPES = resolveTediScopes("standard");

// =============================================================================
// TEDI-SPECIFIC SCOPES (for apps/tedi runtime MCP server)
// =============================================================================

/**
 * Tedi runtime scopes -- used by the tedi Worker MCP server for
 * channel, event, permission, brain, cognitive, skill, and config operations.
 */
export const TEDI_MCP_SCOPES = [
	"tedi:channel.read",
	"tedi:channel.write",
	"tedi:events.read",
	"tedi:permissions.read",
	"tedi:permissions.write",
	"tedi:brain.read",
	"tedi:brain.write",
	"tedi:cognitive.read",
	"tedi:cognitive.write",
	"tedi:email.read",
	"tedi:email.write",
	"tedi:skills.read",
	"tedi:skills.write",
	"tedi:browser.read",
	"tedi:browser.write",
	"tedi:config.read",
	"tedi:config.write",
	"tedi:admin",
] as const;

export type TediMcpScope = (typeof TEDI_MCP_SCOPES)[number];

const TEDI_MCP_READ_SCOPE_BY_PREFIX: ReadonlyArray<
	readonly [string, TediMcpScope]
> = [
	["conversation", "tedi:channel.read"],
	["conversations_", "tedi:channel.read"],
	["messages_read", "tedi:channel.read"],
	["audit_memory", "tedi:brain.read"],
	["mcp_read_resource", "tedi:skills.read"],
	["mcp_directory_read", "tedi:skills.read"],
	["read_execution", "tedi:permissions.read"],
];

const TEDI_MCP_READ_ONLY_PREFIXES = [
	"audit_",
	"artifact_list",
	"artifact_read",
	"conversation",
	"conversations_",
	"describe_",
	"diff_",
	"get_",
	"list_",
	"mcp_",
	"messages_read",
	"read_",
	"repo_commit_status",
	"repo_load",
	"validate_",
] as const;

export function isTediMcpToolReadOnly(toolName: string): boolean {
	return (
		["read", "ls", "find", "grep"].includes(toolName) ||
		TEDI_MCP_READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix))
	);
}

export function requiredTediMcpToolScope(
	toolName: string,
	readOnly = isTediMcpToolReadOnly(toolName),
): TediMcpScope {
	for (const [prefix, scope] of TEDI_MCP_READ_SCOPE_BY_PREFIX)
		if (toolName.startsWith(prefix)) return scope;
	if (toolName === "run_tedi_turn" || toolName === "send_tedi_message")
		return "tedi:channel.write";
	if (
		[
			"open_computer",
			"close_computer",
			"exec",
			"read_execution",
			"cancel_execution",
		].includes(toolName)
	)
		return readOnly ? "tedi:permissions.read" : "tedi:permissions.write";
	return readOnly ? "tedi:config.read" : "tedi:config.write";
}

// =============================================================================
// SCOPE BUILDERS
// =============================================================================

/**
 * Build the full scopes_supported array from app tool IDs.
 * Includes platform scopes + tool-level scopes with mcp: prefix.
 *
 * @example
 * buildScopesSupported(["search_listings", "get_item"])
 * // ["email", "mcp:get.item", "mcp:search.listings", "connections.execute", "profile"]
 */
export function buildScopesSupported(toolIds: string[]): string[] {
	const scopes = new Set<string>([
		...PLATFORM_SCOPES,
		...toolIds.map(toolToScope),
	]);
	return [...scopes].sort();
}

/**
 * Check if a set of granted scopes satisfies a required scope.
 * Supports wildcard scope "*" which grants everything.
 */
export function hasScope(
	grantedScopes: string[],
	requiredScope: string,
): boolean {
	if (grantedScopes.includes("*")) return true;
	// Execute is the existing provider read/write authority. Read is its
	// narrower independently grantable subset, never a write/admin substitute.
	if (
		requiredScope === "connections.read" &&
		grantedScopes.includes("connections.execute")
	)
		return true;
	if (grantedScopes.includes("mcp:*") && requiredScope.startsWith("mcp:")) {
		return true;
	}
	if (grantedScopes.includes("tedi:*") && requiredScope.startsWith("tedi:")) {
		return true;
	}
	if (
		grantedScopes.includes("tedi:admin") &&
		requiredScope.startsWith("tedi:")
	) {
		return true;
	}
	const tediParentScope = requiredScope.match(
		/^(tedi:[a-z0-9-]+)\.(read|write|admin)$/,
	)?.[1];
	if (tediParentScope && grantedScopes.includes(tediParentScope)) return true;
	return grantedScopes.includes(requiredScope);
}

/**
 * Exact-correspondence translations from granular MCP grants to apps/api's
 * machine vocabulary (for example, mcp:tedis.read -> tedis:read).
 * Neither platform:admin nor wildcard grants expand into machine scopes.
 * Callers forward original grants alongside these translations so API guards
 * requiring MCP vocabulary, such as mcp:memory.read, can match them exactly.
 * Extend this mapping with the AUTHZ guards in apps/api/src/rpc/orpc.ts.
 */
const GRANULAR_MACHINE_TRANSLATIONS: Record<string, readonly string[]> = {
	"mcp:tedis.read": ["tedis:read"],
	"mcp:tedis.write": ["tedis:write"],
	"mcp:tedis.admin": ["tedis:read", "tedis:write"],
	"mcp:apps.read": ["apps:read", "tools:read"],
	"mcp:apps.write": ["apps:write", "tools:write"],
	"mcp:apps.admin": [
		"apps:read",
		"apps:write",
		"tools:read",
		"tools:write",
		"adapters:write",
		"catalog:manage",
	],
	"mcp:observe.read": ["analytics:read"],
	"mcp:observe.write": ["analytics:read"],
	"mcp:observe.admin": ["analytics:read"],
	"mcp:settings.read": ["billing:read"],
	"mcp:settings.write": ["billing:read", "billing:write"],
	"mcp:settings.admin": [
		"billing:read",
		"billing:write",
		"earned-delegation:govern",
	],
	"mcp:catalog.write": ["catalog:manage"],
	"mcp:catalog.admin": ["catalog:manage"],
	"mcp:work.read": ["work:read"],
	"mcp:work.write": ["work:read", "work:write"],
	"mcp:work.admin": [
		"work:read",
		"work:write",
		"work:accept",
		"work:cancel",
		"work:review",
		"work:complete",
	],
};

export function delegatedMachineScopes(grantedScopes: string[]): string[] {
	const machine = new Set<string>();
	for (const scope of grantedScopes) {
		for (const translated of GRANULAR_MACHINE_TRANSLATIONS[scope] ?? []) {
			machine.add(translated);
		}
	}
	return [...machine].sort();
}

/**
 * Check if a set of granted scopes satisfies all required scopes.
 */
export function hasAllScopes(
	grantedScopes: string[],
	requiredScopes: string[],
): boolean {
	return requiredScopes.every((scope) => hasScope(grantedScopes, scope));
}

/**
 * Enforce that granted scopes satisfy required scopes.
 * Returns an error message if enforcement fails, null if OK.
 */
export function enforceScopes(
	grantedScopes: string[],
	requiredScopes: string[],
): string | null {
	if (requiredScopes.length === 0) return null;

	const missing = requiredScopes.filter(
		(scope) => !hasScope(grantedScopes, scope),
	);
	if (missing.length === 0) return null;

	return `Missing required scopes: ${missing.join(", ")}`;
}
