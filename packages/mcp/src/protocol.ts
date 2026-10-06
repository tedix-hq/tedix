import { encodeMcpHeaderValue } from "./mcp-param-headers";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const MCP_METHOD_HEADER = "Mcp-Method";
export const MCP_NAME_HEADER = "Mcp-Name";

export const MCP_PROTOCOL_VERSION_META_KEY =
	"io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * OAuth Client Credentials extension (SEP-1046 / ext-auth). Advertised in
 * `server/discover` capabilities when the app is backed by an OAuth
 * authorization server that supports the client-credentials / JWT-bearer M2M
 * flow (Descope AIH, keyed by `mcpConfig.descopeResourceId`). Discovery-only:
 * token validation + scope enforcement already run at the edge; this label lets
 * non-interactive clients (background services, CI, tedi-to-tedi) discover that
 * they may skip the interactive authorization-code flow.
 */
export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION =
	"io.modelcontextprotocol/oauth-client-credentials";

export const MCP_TASK_METHODS = [
	"tasks/get",
	"tasks/update",
	"tasks/cancel",
] as const;

export const MCP_TASK_METHOD_SET: ReadonlySet<string> = new Set(
	MCP_TASK_METHODS,
);

export const MCP_NAME_REQUIRED_METHODS: ReadonlySet<string> = new Set([
	"tools/call",
	"resources/read",
	"resources/directory/read",
	"prompts/get",
	"skills/get",
	...MCP_TASK_METHODS,
]);

/**
 * Subset of {@link MCP_NAME_REQUIRED_METHODS} where inbound validation is
 * validate-only-if-present: header present → must match the body target;
 * header absent → pass. SEP-2663-Final mandates the client-side `Mcp-Name`
 * header for `tasks/*`, but the current SDK v2 core transport only ever sends
 * `Mcp-Name` for `tools/call`, `resources/read`, and `prompts/get` — hard
 * enforcement here would reject every SDK client. Tedix keeps SENDING the
 * header for all name-bound methods (strict outbound, see
 * `apps/mcp/src/subscriptions.ts` and `@tedix/mcp-client-core`) and stays
 * lenient inbound for the methods the SDK never binds.
 */
export const MCP_NAME_IF_PRESENT_METHODS: ReadonlySet<string> = new Set([
	"resources/directory/read",
	...MCP_TASK_METHODS,
]);

export function mcpRequestTargetName(
	method: string,
	params: Record<string, unknown> | undefined,
): string | undefined {
	if (!MCP_NAME_REQUIRED_METHODS.has(method)) return undefined;
	const target =
		method === "resources/read" ||
		method === "resources/directory/read" ||
		method === "skills/get"
			? params?.uri
			: MCP_TASK_METHOD_SET.has(method)
				? params?.taskId
				: params?.name;
	return typeof target === "string" ? target : undefined;
}

/**
 * Bind one stateless JSON-RPC request to the MCP 2026-07-28 request contract
 * for a caller that relays raw envelopes and cannot go through the SDK
 * `Client` (it must pass `resultType: "task"` results and Tasks methods
 * through untouched). Protocol-owned `_meta` keys win over caller input, and
 * the target header is encoded through the same guard the server transport
 * uses. `clientInfo` is optional in the contract; Tedix sends it for
 * attribution.
 */
export function bindModernMcpRequest(
	method: string,
	params: Record<string, unknown>,
	options: {
		clientName: string;
		clientCapabilities?: Record<string, unknown>;
	},
): { params: Record<string, unknown>; headers: Record<string, string> } {
	const existingMeta =
		params._meta &&
		typeof params._meta === "object" &&
		!Array.isArray(params._meta)
			? (params._meta as Record<string, unknown>)
			: {};
	const boundParams = {
		...params,
		_meta: {
			...existingMeta,
			[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
			[MCP_CLIENT_INFO_META_KEY]: {
				name: options.clientName,
				version: "1.0.0",
			},
			[MCP_CLIENT_CAPABILITIES_META_KEY]: options.clientCapabilities ?? {},
		},
	};
	const headers: Record<string, string> = {
		[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
		[MCP_METHOD_HEADER]: method,
	};
	const target = encodeMcpHeaderValue(
		mcpRequestTargetName(method, boundParams),
	);
	if (target !== undefined) headers[MCP_NAME_HEADER] = target;
	return { params: boundParams, headers };
}

export const MCP_RESULT_TYPE_INPUT_REQUIRED = "input_required";

/**
 * A 2026-07-28 result that halted for additional caller input (SEP-2322 multi
 * round-trip) instead of executing — Tedix's own governance gate emits these
 * for destructive tools. Every hand-rolled `tools/call` parser must branch on
 * it: treating it as a plain result silently converts "blocked, needs
 * approval" into a success.
 */
export interface McpInputRequiredResult {
	resultType: typeof MCP_RESULT_TYPE_INPUT_REQUIRED;
	inputRequests?: Record<string, unknown>;
	requestState?: string;
}

export function readInputRequiredResult(
	result: unknown,
): McpInputRequiredResult | null {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		return null;
	}
	const record = result as Record<string, unknown>;
	if (record.resultType !== MCP_RESULT_TYPE_INPUT_REQUIRED) return null;
	return {
		resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
		...(typeof record.inputRequests === "object" &&
		record.inputRequests !== null &&
		!Array.isArray(record.inputRequests)
			? { inputRequests: record.inputRequests as Record<string, unknown> }
			: {}),
		...(typeof record.requestState === "string"
			? { requestState: record.requestState }
			: {}),
	};
}
