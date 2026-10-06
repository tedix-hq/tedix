/**
 * @tedix/auth - Scope Sync for Descope Policies
 *
 * Generates scope definitions that align with Descope's policy engine.
 * When an app's tools change, this produces a manifest of scopes
 * that should be registered in the Descope Console for policy evaluation.
 *
 * Descope evaluates policies at token issuance time, filtering requested
 * scopes based on user roles, tenant membership, and custom conditions.
 * This utility ensures the scope definitions stay in sync with tool changes.
 */

import {
	hasScope,
	PLATFORM_SCOPES,
	toolToScope,
} from "@tedix/mcp-shared/auth/scopes";
import {
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
	type ToolAuthShape,
} from "@tedix/mcp-shared/auth/tool-scopes";

// =============================================================================
// TYPES
// =============================================================================

export interface ScopeDefinition {
	/** MCP scope string (e.g., "mcp:invoice.create") */
	scope: string;
	/** Human-readable description */
	description: string;
	/** Tool name this scope maps to */
	toolName: string;
	/** Whether this scope requires user consent */
	requiresConsent: boolean;
}

export interface RegisteredScopeDefinition {
	/** Registered or advertised scope string */
	name: string;
	/** Human-readable description */
	description: string;
}

export interface ScopeConfigLike {
	enforcePolicies?: boolean;
	toolScopes?: Record<string, string[]>;
	scopeDescriptions?: Record<string, string>;
}

export interface ScopeManifest {
	/** MCP Server URL */
	serverUrl: string;
	/** Descope Resource ID (MCP Server ID) */
	descopeResourceId: string;
	/**
	 * One entry per (tool, ENFORCED scope) pair. A tool that the edge lets
	 * through with no scope at all contributes no entry; a tool whose configured
	 * `toolScopes` names several scopes contributes one entry per scope.
	 */
	toolScopes: ScopeDefinition[];
	/** False when the edge rejects configured tools with no capability mapping. */
	complete: boolean;
	/** Tool ids the edge cannot classify; no scope may be inferred for them. */
	unclassifiedTools: string[];
	/** Platform scopes (connections.execute, profile, email) */
	platformScopes: string[];
	/** Generated timestamp */
	generatedAt: string;
}

// =============================================================================
// SCOPE COLLECTION
// =============================================================================

function getScopeDescription(
	scope: string,
	scopeDescriptions?: Record<string, string>,
): string {
	return scopeDescriptions?.[scope] ?? scope;
}

/**
 * Collect deduplicated configured scopes from MCP config.
 */
export function collectConfiguredScopes(
	mcpConfig: ScopeConfigLike | null | undefined,
): RegisteredScopeDefinition[] {
	if (!mcpConfig) return [];

	const seen = new Set<string>();
	const scopes: RegisteredScopeDefinition[] = [];
	const scopeDescriptions = mcpConfig.scopeDescriptions;

	const addScope = (scope: string) => {
		if (!scope || seen.has(scope)) return;
		seen.add(scope);
		scopes.push({
			name: scope,
			description: getScopeDescription(scope, scopeDescriptions),
		});
	};

	for (const scopeList of Object.values(mcpConfig.toolScopes ?? {})) {
		for (const scope of scopeList ?? []) addScope(scope);
	}
	// `scopeDescriptions` is also the Resource's declared capability catalog.
	// It can intentionally include granular scopes that no current tool pins
	// directly yet, but which policy profiles and newly hydrated tools request.
	for (const scope of Object.keys(scopeDescriptions ?? {})) addScope(scope);

	return scopes;
}

/**
 * Collect the scopes an MCP server should advertise/register.
 *
 * - Policy mode: per-tool `mcp:<tool>` scopes derived from live tools
 * - D1 config mode: capability scopes from `mcpConfig.toolScopes`
 */
export function collectAdvertisedScopes(params: {
	mcpConfig: ScopeConfigLike | null | undefined;
	tools?: Array<{ name: string; description?: string }>;
}): RegisteredScopeDefinition[] {
	const { mcpConfig, tools = [] } = params;
	if (mcpConfig?.enforcePolicies) {
		return tools.map((tool) => {
			const scope = toolToScope(tool.name);
			return {
				name: scope,
				description:
					mcpConfig.scopeDescriptions?.[scope] ??
					tool.description ??
					`Access to ${tool.name}`,
			};
		});
	}

	return collectConfiguredScopes(mcpConfig);
}

/**
 * Collect the complete scope catalog registered on a Descope MCP Resource.
 *
 * Tool discovery and edge authorization are only one half of that catalog.
 * Managed tedi clients also request the platform scopes used for connected
 * provider token retrieval and bounded writes. If scope reconciliation omits
 * those scopes, Descope rejects the client before it can reach the MCP edge
 * (`Invalid scope name for MCP server client`). Keep the Resource catalog and
 * the client profile derived from `PLATFORM_SCOPES` on the same source of
 * truth.
 */
export function collectDescopeResourceScopes(params: {
	mcpConfig: ScopeConfigLike | null | undefined;
	tools?: Array<{ name: string; description?: string }>;
}): RegisteredScopeDefinition[] {
	const scopes = collectAdvertisedScopes(params);
	const seen = new Set(scopes.map((scope) => scope.name));
	for (const scope of PLATFORM_SCOPES) {
		if (seen.has(scope)) continue;
		scopes.push({
			name: scope,
			description: params.mcpConfig?.scopeDescriptions?.[scope] ?? scope,
		});
		seen.add(scope);
	}
	return scopes;
}

// =============================================================================
// MANIFEST GENERATION
// =============================================================================

/** A tool row as the manifest sees it: identity, prose, and auth shape. */
export type ScopeManifestTool = Omit<ToolAuthShape, "toolId"> & {
	/** The tool's MCP name (`app_tools.tool_id`, aggregate prefix included). */
	name: string;
	description?: string;
};

/**
 * Generate a scope manifest from app tools and config.
 * This manifest documents all scopes that should be configured
 * in the Descope Console for policy evaluation.
 *
 * The scopes come from `resolveMcpToolRequiredScopes` — the SAME resolver the
 * MCP edge gates `tools/call` with — not from `toolToScope`, which is only that
 * resolver's `enforcePolicies: true` branch. Deriving `mcp:<tool>` for every
 * tool made the manifest describe a policy model the edge does not run: it
 * ignored per-app `toolScopes` overrides, dangerous-tool promotion to
 * `platform:admin`, and the namespace fallbacks, so an operator configuring Descope
 * from it provisioned scopes no request ever asks for while the scopes the edge
 * DOES demand went unregistered.
 *
 * `mcpConfig` must therefore be passed: without it every app looks like a
 * no-config app, which is the same lie in a different shape.
 * Persisted endpoint metadata is also part of the tool input so namespace
 * resolution stays byte-for-byte aligned with Code Mode and native dispatch.
 */
export function generateScopeManifest(params: {
	serverUrl: string;
	descopeResourceId: string;
	tools: ScopeManifestTool[];
	/** The serving app's mcpConfig, read the way the edge reads it. */
	mcpConfig?: Record<string, unknown> | null;
	scopeDescriptions?: Record<string, string>;
	platformScopes?: string[];
}): ScopeManifest {
	const mcpConfig = params.mcpConfig ?? undefined;
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	// One entry per (tool, scope): the resolver returns 0..n scopes per tool,
	// where the old one-scope-per-tool derivation always returned exactly one.
	const toolScopes: ScopeDefinition[] = [];
	const unclassifiedTools: string[] = [];
	for (const tool of params.tools) {
		let scopes: string[];
		try {
			scopes = resolveMcpToolRequiredScopes(
				{ ...tool, toolId: tool.name },
				resolveMcpToolNamespace(
					{ ...tool, toolId: tool.name },
					namespaceOverrides,
				),
				mcpConfig,
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("Missing MCP capability mapping for tool:")
			) {
				unclassifiedTools.push(tool.name);
				continue;
			}
			throw error;
		}
		for (const scope of scopes) {
			toolScopes.push({
				scope,
				description:
					params.scopeDescriptions?.[scope] ??
					tool.description ??
					`Access to ${tool.name}`,
				toolName: tool.name,
				requiresConsent: true,
			});
		}
	}

	return {
		serverUrl: params.serverUrl,
		descopeResourceId: params.descopeResourceId,
		toolScopes,
		complete: unclassifiedTools.length === 0,
		unclassifiedTools,
		platformScopes: params.platformScopes ?? [...PLATFORM_SCOPES],
		generatedAt: new Date().toISOString(),
	};
}

// =============================================================================
// POLICY SCOPE VALIDATION
// =============================================================================

/**
 * Validate that JWT scopes satisfy a tool's required scope.
 * Descope policies filter scopes at token issuance — this runtime check
 * verifies the JWT contains the required scope.
 *
 * @param jwtScopes - Space-separated or array of scopes from the JWT
 * @param requiredScope - The scope required for the tool
 * @returns Whether the JWT has the required scope
 */
export function validatePolicyScope(
	jwtScopes: string | string[],
	requiredScope: string,
): boolean {
	const scopes = Array.isArray(jwtScopes)
		? jwtScopes
		: jwtScopes.split(" ").filter(Boolean);
	return hasScope(scopes, requiredScope);
}
