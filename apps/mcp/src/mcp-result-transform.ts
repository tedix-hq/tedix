import { type ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { isDelegatedWorkTool } from "@tedix/auth/delegated-mcp-token";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { type McpResultTransform } from "@tedix/mcp-shared/transport";
import { codeModeSecurityMeta } from "./mcp/codemode-security";
import {
	isCodeModeNativeOptIn,
	SESSION_NATIVE_HOME_TOOL_IDS,
} from "./mcp/code-mode-native-tools";
import { ACCOUNT_PROFILE_SECURITY } from "./mcp/registration/account-profile";
import type { AppTool as InternalAppTool } from "./mcp/server-context";
import { sortToolsDeterministically } from "./mcp/tools-list-order";
import { paginateSortedToolsList } from "./mcp/tools-list-pagination";

export function parseMcpCallerFromHeaders(headers: Headers): {
	authType?: string | null;
	scopes: string[];
} {
	return {
		authType: headers.get("x-tedix-auth-type"),
		scopes: (headers.get("x-tedix-auth-scopes") ?? "")
			.split(" ")
			.filter(Boolean),
	};
}

export function mcpToolsListResultTransform(
	tools: Array<{
		annotations?: InternalAppTool["annotations"];
		authRequired?: boolean;
		config?: Record<string, unknown> | null;
		outputSchema?: ToolJsonSchema | null;
		toolId: string;
		toolTypeId?: string | null;
		visibility?: string | null;
	}>,
	mcpConfig: Record<string, unknown> | undefined,
	requestHeaders: Headers,
): McpResultTransform {
	const outputSchemasByName = new Map(
		tools.flatMap((tool) =>
			tool.outputSchema ? [[tool.toolId, tool.outputSchema] as const] : [],
		),
	);
	const toolsByName = new Map(tools.map((tool) => [tool.toolId, tool]));
	const caller = parseMcpCallerFromHeaders(requestHeaders);
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const visibleToolNames = new Set(
		tools
			.filter(
				(tool) =>
					(requestHeaders.get("x-tedix-auth-credential-mode") !==
						"delegated-mcp" ||
						!isDelegatedWorkTool(
							tool.toolId,
							resolveMcpToolNamespace(tool, namespaceOverrides),
							tool.config,
							tool.toolTypeId,
						)) &&
					isMcpToolVisibleToCaller(
						tool,
						resolveMcpToolNamespace(tool, namespaceOverrides),
						mcpConfig,
						caller,
					),
			)
			.map((tool) => tool.toolId),
	);

	return ({ request, response }) => {
		// `tools/call` result rewrites (transport.ts intentionally untouched):
		//  - `tedix/inputRequired` (sync-MRTR agent approval, governance.ts) →
		//    protocol-native `resultType: "input_required"` + inputRequests +
		//    requestState, so the calling agent resolves it and retries.
		//  - `tedix/genericTask` (async task, tool-execution.ts) →
		//    `resultType: "task"` envelope.
		if (request.method === "tools/call") {
			return rewriteGenericTaskResult(rewriteInputRequiredResult(response));
		}

		if (request.method !== "tools/list") return response;
		if (!("result" in response) || !response.result) return response;
		const result = response.result as { tools?: unknown };
		if (!Array.isArray(result.tools)) return response;

		const transformed = result.tools.flatMap((tool) => {
			if (
				typeof tool !== "object" ||
				tool === null ||
				Array.isArray(tool) ||
				typeof (tool as { name?: unknown }).name !== "string"
			) {
				return [tool];
			}
			const name = (tool as { name: string }).name;
			if (toolsByName.has(name) && !visibleToolNames.has(name)) {
				return [];
			}
			// Code Mode lists `code` only; registered helpers and widget tools
			// stay callable but need an explicit opt-in to be listed.
			if (
				mcpConfig?.codeMode === true &&
				name !== "code" &&
				!(SESSION_NATIVE_HOME_TOOL_IDS as readonly string[]).includes(name) &&
				toolsByName.get(name)?.config?.transport !== "catalog" &&
				!isCodeModeNativeOptIn(mcpConfig, name)
			) {
				return [];
			}
			if (
				name === "code" &&
				mcpConfig?.codeMode === true &&
				visibleToolNames.size === 0
			) {
				return [];
			}

			const outputSchema = outputSchemasByName.get(name);
			return [
				{
					...tool,
					...(outputSchema ? { outputSchema } : {}),
					// The SDK preserves extension metadata but does not serialize the
					// OpenAI top-level auth declaration. Add it at the wire boundary.
					...(name === "code" && mcpConfig?.codeMode === true
						? codeModeSecurityMeta(mcpConfig)
						: {}),
					...(name === "get_profile"
						? { securitySchemes: ACCOUNT_PROFILE_SECURITY }
						: {}),
				},
			];
		});

		// Deterministic ordering for prompt-cache hits: stable sort by tool name.
		// D1 load order and aggregate merging are not stable across requests, so
		// without this clients see cache-busting tool-list permutations.
		sortToolsDeterministically(transformed);

		// Server-side cursor pagination: the stable sort makes a tool
		// name a stable position anchor, so page after filter+sort. Surfaces at
		// or under the page size return one cursorless page (no behavior change
		// for plain apps); the ~700-tool aggregate pages instead of shipping one
		// giant cold payload. This transform owns `nextCursor` for tools/list —
		// the inner server never mints one.
		const page = paginateSortedToolsList(
			transformed,
			isRecord(request.params) ? request.params.cursor : undefined,
		);
		if (!page.ok) {
			// Spec (2026-07-28 pagination): invalid cursors should result
			// in -32602 Invalid params.
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32_602,
					message: "Invalid params: unrecognized tools/list cursor",
				},
			};
		}
		const { nextCursor: _innerNextCursor, ...restResult } = result as {
			tools?: unknown;
			nextCursor?: unknown;
		};
		return {
			...response,
			result: {
				...restResult,
				tools: page.tools,
				...(page.nextCursor !== undefined
					? { nextCursor: page.nextCursor }
					: {}),
			},
		};
	};
}

/**
 * Rewrite a `tools/call` result that carries the `tedix/genericTask` _meta
 * marker into a protocol-native MCP Tasks `resultType: "task"` envelope
 * (McpCreateTaskResultSchema). Non-task results pass through unchanged.
 */
type McpJsonRpcMessage = Parameters<McpResultTransform>[0]["response"];

/**
 * Rewrite a `tools/call` result carrying the `tedix/inputRequired` _meta marker
 * (sync-MRTR agent approval, governance.ts) into a protocol-native
 * `resultType: "input_required"` result. The calling agent resolves the
 * `inputRequests` and retries the same call echoing `inputResponses` +
 * `requestState` (under `_meta`). Non-marker results pass through unchanged.
 */
function rewriteInputRequiredResult(
	response: McpJsonRpcMessage,
): McpJsonRpcMessage {
	if (!("result" in response) || !response.result) return response;
	const result = response.result as {
		_meta?: Record<string, unknown> | null;
		content?: unknown;
	};
	const marker = result._meta?.["tedix/inputRequired"];
	if (typeof marker !== "object" || marker === null) return response;
	const inputRequired = marker as Record<string, unknown>;
	if (typeof inputRequired.requestState !== "string") return response;

	return {
		...response,
		result: {
			resultType: "input_required",
			requestState: inputRequired.requestState,
			inputRequests: inputRequired.inputRequests ?? {},
			// Preserve the human-readable content block so non-MRTR clients still
			// see what is being asked.
			...(Array.isArray(result.content) ? { content: result.content } : {}),
		},
	} as McpJsonRpcMessage;
}

function rewriteGenericTaskResult(
	response: McpJsonRpcMessage,
): McpJsonRpcMessage {
	if (!("result" in response) || !response.result) return response;
	const result = response.result as {
		_meta?: Record<string, unknown> | null;
	};
	const marker = result._meta?.["tedix/genericTask"];
	if (typeof marker !== "object" || marker === null) return response;
	const task = marker as Record<string, unknown>;
	if (typeof task.taskId !== "string") return response;

	return buildTaskResult(response, {
		taskId: task.taskId,
		status: typeof task.status === "string" ? task.status : "working",
		createdAt: typeof task.createdAt === "string" ? task.createdAt : undefined,
		lastUpdatedAt:
			typeof task.lastUpdatedAt === "string" ? task.lastUpdatedAt : undefined,
		ttlMs: typeof task.ttlMs === "number" ? task.ttlMs : null,
		pollIntervalMs:
			typeof task.pollIntervalMs === "number" ? task.pollIntervalMs : undefined,
	});
}

function buildTaskResult(
	response: McpJsonRpcMessage,
	task: {
		createdAt?: string;
		lastUpdatedAt?: string;
		pollIntervalMs?: number;
		status: string;
		taskId: string;
		ttlMs: number | null;
	},
): McpJsonRpcMessage {
	return {
		...response,
		result: {
			resultType: "task",
			taskId: task.taskId,
			status: task.status,
			createdAt: task.createdAt,
			lastUpdatedAt: task.lastUpdatedAt,
			ttlMs: task.ttlMs,
			...(typeof task.pollIntervalMs === "number"
				? { pollIntervalMs: task.pollIntervalMs }
				: {}),
		},
	} as McpJsonRpcMessage;
}
