import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import { isDelegatedWorkTool } from "@tedix/auth/delegated-mcp-token";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	resolveMcpToolRequiredScopes,
	type ToolAuthShape,
} from "@tedix/mcp-shared/auth/tool-scopes";
import type { ServerContext } from "./server-context";

export class CodeModeAuthorizationError extends Error {
	readonly requiredScopes: string[];
	readonly missingScopes: string[];

	constructor(params: {
		toolId: string;
		requiredScopes: string[];
		missingScopes: string[];
		authenticated: boolean;
	}) {
		const scopeList = params.requiredScopes.join(", ");
		const message = params.authenticated
			? `Insufficient scope for Code Mode inner tool "${params.toolId}". Required scopes: ${scopeList}. Missing scopes: ${params.missingScopes.join(", ")}.`
			: `Authentication required for Code Mode inner tool "${params.toolId}". Required scopes: ${scopeList}.`;
		super(message);
		this.name = "CodeModeAuthorizationError";
		this.requiredScopes = params.requiredScopes;
		this.missingScopes = params.missingScopes;
	}
}

export function resolveCodeModeInnerToolScopes(
	tool: ToolAuthShape,
	namespace: string,
	mcpConfig: Record<string, unknown> | undefined,
	toolCall?: { arguments: unknown },
): string[] {
	return resolveMcpToolRequiredScopes(tool, namespace, mcpConfig, {
		fallbackOnAuthenticatedAuthMode: true,
		toolCall,
	});
}

function missingCodeModeScopes(
	grantedScopes: string[],
	requiredScopes: string[],
): string[] {
	if (requiredScopes.length === 0) return [];
	return requiredScopes.filter((scope) => !hasScope(grantedScopes, scope));
}

export type McpToolScopeDecision =
	| { authorized: true }
	| {
			authorized: false;
			requiredScopes: string[];
			missingScopes: string[];
			authenticated: boolean;
	  };

/**
 * Resolve whether the caller may invoke `tool` (in `namespace`) under the MCP
 * scope model. This is the single seam reused by both the Code Mode inner-tool
 * gate (`assertCodeModeInnerToolAuthorized`) and the native `tools/call`
 * dispatch gate for code-built home-surface tools (tool-registration.ts), so
 * the two paths can never drift. A trusted service-binding caller bypasses; an
 * empty required-scope set is open. Platform authority never substitutes for a
 * resource capability.
 */
export function evaluateMcpToolScopeAuthorization(
	serverCtx: Pick<ServerContext, "appMetadata" | "callerIdentity">,
	tool: ToolAuthShape,
	namespace: string,
	options: {
		requiredScopes?: readonly string[];
		toolCall?: { arguments: unknown };
	} = {},
): McpToolScopeDecision {
	if (
		serverCtx.callerIdentity?.credentialMode === "delegated-mcp" &&
		isDelegatedWorkTool(tool.toolId, namespace, tool.config, tool.toolTypeId)
	) {
		return {
			authorized: false,
			requiredScopes: ["mcp:work.write"],
			missingScopes: ["mcp:work.write"],
			authenticated: true,
		};
	}
	const mcpConfig = serverCtx.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const requiredScopes = options.requiredScopes
		? [...new Set(options.requiredScopes)]
		: resolveCodeModeInnerToolScopes(
				tool,
				namespace,
				mcpConfig,
				options.toolCall,
			);
	if (requiredScopes.length === 0) return { authorized: true };

	const callerIdentity = serverCtx.callerIdentity;
	if (callerIdentity?.authType === "service") return { authorized: true };

	const grantedScopes = callerIdentity?.scopes ?? [];
	const missingScopes = missingCodeModeScopes(grantedScopes, requiredScopes);
	if (missingScopes.length === 0) return { authorized: true };

	return {
		authorized: false,
		requiredScopes,
		missingScopes,
		authenticated: !!callerIdentity,
	};
}

/**
 * Dispatch-time guard for code-built MCP tools that are not present in the D1
 * tool inventory seen by the request-level edge gate. Callers must declare the
 * capability explicitly. Omitting it is a server configuration error; an empty
 * array is not an escape hatch and never pressures an operator to grant a
 * platform credential.
 */
export function enforceMcpToolScopeAuthorization(
	serverCtx: Pick<ServerContext, "appMetadata" | "callerIdentity">,
	tool: ToolAuthShape,
	namespace: string,
	requiredScopes?: readonly string[],
): CallToolResult | null {
	if (!requiredScopes || requiredScopes.length === 0) {
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
	const declaredScopes = requiredScopes;
	const decision = evaluateMcpToolScopeAuthorization(
		serverCtx,
		tool,
		namespace,
		{ requiredScopes: declaredScopes },
	);
	if (decision.authorized) return null;

	return {
		content: [
			{
				type: "text",
				text: `insufficient_scope: "${tool.toolId}" requires ${decision.requiredScopes.join(
					", ",
				)}; caller is missing ${decision.missingScopes.join(", ")}.`,
			},
		],
		isError: true,
		structuredContent: {
			error: "insufficient_scope",
			required_scopes: decision.requiredScopes,
			missing_scopes: decision.missingScopes,
		},
		_meta: {
			"com.tedix/error": "insufficient_scope",
			// SEP-2350: a Code Mode / aggregate scope denial was previously
			// machine-unreadable — only the vendor `com.tedix/error` marker and prose
			// text. Emit the standard challenge so a client can parse the RFC 6750
			// `scope` parameter and drive scope-union step-up, exactly as it can from
			// the HTTP 401/403 paths in `index.ts`.
			//
			// `resource_metadata` is deliberately omitted: it needs the request
			// hostname, which this pure authorization helper does not receive, and a
			// client that needs it discovers it from the transport-level 401.
			"mcp/www_authenticate": [
				`Bearer error="insufficient_scope", scope="${decision.requiredScopes.join(" ")}"`,
			],
		},
	};
}

export function assertCodeModeInnerToolAuthorized(
	serverCtx: Pick<ServerContext, "appMetadata" | "callerIdentity">,
	tool: ToolAuthShape,
	namespace: string,
	callArguments?: unknown,
): void {
	const decision = evaluateMcpToolScopeAuthorization(
		serverCtx,
		tool,
		namespace,
		{ toolCall: { arguments: callArguments } },
	);
	if (decision.authorized) return;

	throw new CodeModeAuthorizationError({
		toolId: tool.toolId,
		requiredScopes: decision.requiredScopes,
		missingScopes: decision.missingScopes,
		authenticated: decision.authenticated,
	});
}
