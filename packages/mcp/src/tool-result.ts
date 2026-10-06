/**
 * Shared `tools/call` result unwrapping — THE single normalization pipeline
 * for every Tedix surface that hand-parses MCP tool results (skill-runtime's
 * env.MCP bridge and tedi-codemode-core's generated connector fns). The two
 * surfaces previously carried divergent copies, which produced the
 * codemode-vs-skill-runtime shape-mismatch class: the same tool returned a
 * DIFFERENT value depending on which surface called it.
 *
 * Layering (outermost first):
 *   1. `unwrapJsonRpcToolResult(text, toolName)` — raw JSON-RPC response body
 *      → protocol-error throw → CallToolResult unwrap (2).
 *   2. `unwrapCallToolResult(result, toolName)` — parsed CallToolResult →
 *      `toolResult` passthrough → input_required throw → isError throw →
 *      structuredContent preference → all-text content join + JSON parse.
 *   3. `stripCodeModeExecutionEnvelope(value)` — the aggregate `code` tool's
 *      `{ executionId, result }` wrapper → inner result. Applied ONLY by
 *      Code Mode call paths: a native tool may legitimately return a value
 *      with those keys, so this is never part of the generic pipeline.
 */

import { readInputRequiredResult } from "./protocol";

export const CONNECTION_RECOVERY_META_KEY = "tedix/connectionRecovery";

/** A canonical credential miss before any provider operation was attempted. */
export interface ConnectionRecovery {
	providerId: string;
	connectionInstanceId: string;
	scope: "tenant" | "user";
	scopes: string[];
}

export function readConnectionRecovery(
	value: unknown,
): ConnectionRecovery | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	if (
		typeof row.providerId !== "string" ||
		!row.providerId ||
		row.providerId.length > 200 ||
		typeof row.connectionInstanceId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			row.connectionInstanceId,
		) ||
		(row.scope !== "tenant" && row.scope !== "user") ||
		!Array.isArray(row.scopes) ||
		row.scopes.length > 50 ||
		!row.scopes.every(
			(scope) =>
				typeof scope === "string" && scope.length > 0 && scope.length <= 300,
		)
	)
		return null;
	return {
		providerId: row.providerId,
		connectionInstanceId: row.connectionInstanceId,
		scope: row.scope,
		scopes: [...row.scopes] as string[],
	};
}

export class McpConnectionRequiredError extends Error {
	readonly code = "MCP_CONNECTION_REQUIRED";
	constructor(readonly recovery: ConnectionRecovery) {
		super(
			"MCP_CONNECTION_REQUIRED: reconnect the selected account before this operation can execute",
		);
		this.name = "McpConnectionRequiredError";
	}
}

/**
 * A `resultType: "input_required"` tools/call outcome (SEP-2322 MRTR): the
 * gateway halted the call for an approval and did NOT execute it. Surfaces
 * with no approval round-trip channel must treat this as a hard rejection —
 * otherwise the approval prose is returned as the resolved tool value and the
 * caller believes the blocked destructive call succeeded.
 */
export class McpInputRequiredError extends Error {
	readonly code = "MCP_INPUT_REQUIRED";
	constructor(toolName: string) {
		super(
			`MCP_INPUT_REQUIRED: ${toolName} requires an approval (resultType "input_required") and was NOT executed. This surface cannot resolve the approval round-trip; run this action through a surface that can approve it.`,
		);
	}
}

export class McpToolError extends Error {
	readonly code: string | undefined;
	readonly details: unknown;
	constructor(message: string, metadata: unknown) {
		super(`MCP tool error: ${message}`);
		this.name = "McpToolError";
		const meta =
			metadata && typeof metadata === "object"
				? (metadata as Record<string, unknown>)
				: undefined;
		this.code = typeof meta?.code === "string" ? meta.code : undefined;
		this.details = meta?.details;
	}
}

function joinedTextContent(
	content: Array<{ type?: unknown; text?: unknown }>,
): string | null {
	const parts = content.filter(
		(c) =>
			c &&
			typeof c === "object" &&
			c.type === "text" &&
			typeof c.text === "string",
	);
	if (parts.length === 0) return null;
	return parts.map((c) => c.text as string).join("\n");
}

/**
 * Parsed CallToolResult → plain value. Union of the two prior copies'
 * behaviors, converging on the stricter/upstream-mirroring semantics:
 *   - `toolResult` key passes through verbatim (upstream codemode mirror);
 *   - `input_required` ALWAYS throws (previously missing from the codemode
 *     copy — a halted approval flowed through as prose);
 *   - `isError` ALWAYS throws with all text parts joined (previously the
 *     skill-runtime copy threw only when the FIRST part was text);
 *   - `structuredContent` wins when non-null;
 *   - all-text content joins with "\n" and JSON-parses when possible
 *     (previously the skill-runtime copy read only content[0]);
 *   - non-text content arrays return as-is (media parts stay structured).
 */
export function unwrapCallToolResult(
	result: unknown,
	toolName: string,
): unknown {
	if (!result || typeof result !== "object") return result;
	const record = result as Record<string, unknown>;
	if ("toolResult" in record) return record.toolResult;
	if (readInputRequiredResult(record)) {
		throw new McpInputRequiredError(toolName);
	}
	const content = Array.isArray(record.content)
		? (record.content as Array<{ type?: unknown; text?: unknown }>)
		: null;
	if (record.isError === true) {
		const metadata =
			record._meta && typeof record._meta === "object"
				? (record._meta as Record<string, unknown>)
				: null;
		const recovery = readConnectionRecovery(
			metadata?.[CONNECTION_RECOVERY_META_KEY],
		);
		if (recovery) throw new McpConnectionRequiredError(recovery);
		const message = content ? joinedTextContent(content) : null;
		throw new McpToolError(message ?? "Tool call failed", record._meta);
	}
	if (record.structuredContent != null) return record.structuredContent;
	if (content && content.length > 0) {
		const text = joinedTextContent(content);
		if (text !== null && content.every((c) => c?.type === "text")) {
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		}
		return content;
	}
	return result;
}

/**
 * Raw JSON-RPC `tools/call` response body → plain value. Fail-soft on
 * unparseable bodies (returns the raw text) but ALWAYS propagates protocol
 * errors, input_required, and tool errors.
 */
export function unwrapJsonRpcToolResult(
	text: string,
	toolName: string,
): unknown {
	try {
		const parsed = JSON.parse(text) as {
			result?: unknown;
			error?: { code?: number; message?: string };
		};
		if (parsed.error) {
			throw new Error(
				`MCP tool error ${parsed.error.code ?? "unknown"}: ${
					parsed.error.message ?? "unknown"
				}`,
			);
		}
		const result = parsed.result !== undefined ? parsed.result : parsed;
		return unwrapCallToolResult(result, toolName);
	} catch (err) {
		if (
			err instanceof McpInputRequiredError ||
			err instanceof McpConnectionRequiredError
		)
			throw err;
		if (err instanceof Error && err.message.startsWith("MCP tool error")) {
			throw err;
		}
		return text;
	}
}

/**
 * The aggregate `code` tool returns `{ executionId, result }`. Unwrap to the
 * inner `result` so a Code Mode call looks identical to a native tool call.
 * Apply ONLY on Code Mode call paths — a native tool result may legitimately
 * carry these keys.
 */
export function stripCodeModeExecutionEnvelope(value: unknown): unknown {
	if (
		value &&
		typeof value === "object" &&
		"result" in (value as Record<string, unknown>) &&
		"executionId" in (value as Record<string, unknown>)
	) {
		return (value as { result: unknown }).result;
	}
	return value;
}
