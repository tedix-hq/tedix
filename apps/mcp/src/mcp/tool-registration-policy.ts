import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	resolveToolAnnotations,
	type ToolAnnotations,
	ToolAnnotationsSchema,
} from "@tedix/api-contract/schemas/tools";
import {
	enforceMcpToolScopeAuthorization,
	evaluateMcpToolScopeAuthorization,
} from "./codemode-auth";

import type { AppTool, ServerContext } from "./server-context";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";

/**
 * Derive securitySchemes for a tool based on app's authMode and toolScopes.
 * ChatGPT uses this to decide whether to show OAuth UI before calling a tool.
 *
 * - Tools with scope requirements: [{ type: "oauth2", scopes: [...] }]
 * - Tools without scopes on hybrid/public apps: [{ type: "noauth" }]
 * - Both (optional auth): [{ type: "noauth" }, { type: "oauth2", scopes: [...] }]
 */
export function deriveSecuritySchemes(
	toolId: string,
	mcpConfig: Record<string, unknown> | undefined,
): Array<{ type: string; scopes?: string[] }> | undefined {
	if (!mcpConfig) return undefined;
	const authMode = mcpConfig.authMode as string | undefined;
	const toolScopes = mcpConfig.toolScopes as
		| Record<string, string[]>
		| undefined;
	const scopes = toolScopes?.[toolId];

	if (authMode === "hybrid") {
		if (scopes && scopes.length > 0) {
			// This tool requires auth — but still callable anonymously with limited results
			return [{ type: "oauth2", scopes }];
		}
		// Public tool on hybrid app
		return [{ type: "noauth" }];
	}

	if (authMode === "authenticated") {
		if (scopes && scopes.length > 0) {
			return [{ type: "oauth2", scopes }];
		}
		// Authenticated but no specific scopes
		return [{ type: "oauth2" }];
	}

	// Public app — no auth needed
	return [{ type: "noauth" }];
}

function parseToolAnnotations(
	value: unknown,
	toolId: string,
): ToolAnnotations | undefined {
	if (value == null) return undefined;
	const parsed = ToolAnnotationsSchema.safeParse(value);
	if (!parsed.success) {
		console.warn(
			`[registerDynamicTool] Tool ${toolId} annotations are invalid`,
		);
		return undefined;
	}
	return parsed.data;
}

/**
 * Annotations as they go on the wire, with the declared write capability folded
 * in.
 *
 * `app_tools.write_capability` is a D1 column, but every gate that classifies a
 * tool — the Kernel write planner's `isWriteCapable`, `requireDestructiveToolApproval`
 * in governance.ts, Code Mode's side-effect serializer — reads MCP `annotations`
 * off the wire. Without this projection a declared tool whose upstream server
 * sends no annotations would still arrive unclassified at all three.
 *
 * Provider hints win where present; the declaration only fills in what is
 * absent. A row with neither stays `undefined`, which is exactly what keeps
 * undeclared distinguishable from "declared read-only" downstream.
 */
export function resolveWireAnnotations(
	tool: AppTool,
): ToolAnnotations | undefined {
	return resolveToolAnnotations({
		annotations: parseToolAnnotations(tool.annotations, tool.toolId) ?? null,
		writeCapability: tool.writeCapability ?? null,
		meta: tool.meta as Record<string, unknown> | null,
	});
}

/**
 * Native `tools/call` scope gate for code-built home-surface (`home__*`) tools.
 *
 * The `home__*` tools are merged into the per-request tool set after
 * `enforceMcpAccess()` has already evaluated `resolvedApp.tools`
 * (apps/mcp/src/index.ts): the request-level scope gate (`extractRequiredScopes`)
 * never sees them, so on the native dispatch they would otherwise resolve to no
 * required scope and run unguarded. The Code Mode path already gates them via
 * `assertCodeModeInnerToolAuthorized`; this mirrors that exact check on the
 * native path (same `resolveMcpToolRequiredScopes` resolver with
 * `fallbackOnAuthenticatedAuthMode:true`, the same exact-scope semantics via
 * `hasScope`, and the same trusted `authType:"service"` bypass) so a `home__*`
 * write can't bypass its scope. This harmonizes `ask`,
 * `home__cancel_home_run`, `home__retry_delegation`, and the Work Item write
 * tools with the Code Mode + aggregate `cto__*` resolution.
 *
 * Covers the two tool families that are invisible to the request-level edge
 * gate (`enforceMcpAccess`), because both are appended to `cachedData.tools`
 * only after that gate has already resolved scopes against `resolvedApp.tools`:
 *
 *   1. `home__*` surface tools (`meta.source === "homeSurface"`).
 *   2. Aggregate tools (`config._aggregateNamespace`) — aggregated app, tedi
 *      and home surfaces. Gate 1's unknown-name fallback is an exact lookup in
 *      `toolScopes[toolName]`, and a prefixed name like `cto__delete_app` is
 *      never a key there, so `requiredScopes` came back `undefined` and the
 *      scope block was skipped entirely. Reachable on native dispatch two ways:
 *      an `aih-m2m` bearer caller naming an aggregated tool directly (see
 *      `shouldBypassCodeModeForCaller`), and any app with `codeMode !== true`,
 *      which registers every merged aggregate tool natively. For `external`/
 *      `mcp`-transport tools — which inject tenant credentials from the Descope
 *      Token Vault and call a third party — this edge is the only scope
 *      boundary, so the gap was not covered downstream.
 *
 * Still deliberately not applied to plain D1 provider tools: those are enforced
 * at the request level exactly as before, and running this fallback resolver
 * over them would over-gate hybrid/public tools with anonymous callers.
 *
 * Over-gating is bounded for the families it does cover: an empty required-scope
 * set is authorized (`evaluateMcpToolScopeAuthorization`), so a tool that
 * declares no capability stays open, and a trusted service caller bypasses.
 *
 * Returns an `insufficient_scope` CallToolResult to DENY, or null to proceed.
 */
export function enforceNativeToolScopeGate(
	agent: Pick<ServerContext, "appMetadata" | "callerIdentity">,
	tool: AppTool,
): CallToolResult | null {
	const source = (tool.meta as { source?: unknown } | null)?.source;
	const config = tool.config as Record<string, unknown> | null | undefined;
	const isAggregate = typeof config?._aggregateNamespace === "string";
	if (source !== "homeSurface" && !isAggregate) return null;

	// Resolve the namespace the same way Code Mode does, so a tool reachable
	// through both surfaces can never get two different verdicts.
	const namespace =
		source === "homeSurface"
			? "home"
			: resolveMcpToolNamespace(
					tool,
					agent.appMetadata?.mcpConfig?.codeModeNamespaces as
						| Record<string, string>
						| undefined,
				);
	let decision: ReturnType<typeof evaluateMcpToolScopeAuthorization>;
	try {
		decision = evaluateMcpToolScopeAuthorization(agent, tool, namespace);
	} catch (error) {
		// `resolveMcpToolRequiredScopes` throws for a tool with no capability
		// mapping. Mirror the Code Mode handling exactly (`codemode.ts`): an
		// unclassified tool is a configuration defect, not a reason to 500 the
		// dispatch — but it fails closed, and Code Mode already denies these same
		// tools, so native dispatch was simply the more permissive of the two.
		if (
			!(error instanceof Error) ||
			!error.message.startsWith("Missing MCP capability mapping for tool:")
		) {
			throw error;
		}
		return {
			content: [
				{
					type: "text",
					text: `scope_mapping_missing: "${tool.toolId}" has no declared capability.`,
				},
			],
			isError: true,
			structuredContent: {
				error: "scope_mapping_missing",
				toolId: tool.toolId,
			},
		};
	}
	if (decision.authorized) return null;
	return enforceMcpToolScopeAuthorization(
		agent,
		tool,
		namespace,
		decision.requiredScopes,
	);
}
