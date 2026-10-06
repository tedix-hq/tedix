/**
 * `tools/call` telemetry — wraps a tool's callback at registration time.
 *
 * Single source of truth for `tool_call` MCP events. Wraps every `tools/call`
 * dispatch, regardless of whether the underlying tool is D1-driven (the
 * common case via ToolHandler), bootstrap (get_info), aggregated proxy, or
 * Code Mode's `code` tool wrapper.
 *
 * Replaces the per-call-site `trackMcpEvent` / `emitMcpAuditEvent` invocations
 * that previously lived inside executeTool() and tool-registration.ts. Those
 * call sites have been removed — `wrapToolCallTelemetry` is now the only
 * emitter of `tool_call` events.
 *
 * Code Mode's `code_exec` events stay in `codemode.ts` (different semantics —
 * one outer code execution, N inner per-tool RPCs). Resource-read and
 * prompt-get telemetry remain in their existing call sites for now (different
 * event types; future migrations will fold them in once the pattern is
 * proven for tools/call).
 */

import type { ServerContext as McpCtx } from "@modelcontextprotocol/server";
import { tracing } from "cloudflare:workers";
import type { ServerContext } from "../server-context";
import { toolRiskAuditMetadata } from "../tool-risk-policy";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	getJsonSize,
	type McpEvent,
	normalizeMcpErrorCode,
	trackMcpEvent,
	truncateErrorMessage,
} from "../utils/analytics";
import {
	capturePayloadRecord,
	redactAndTruncate,
} from "../utils/payload-capture";

/**
 * Extract a numeric `tokensUsed` off an unknown tool result. AI-powered tool
 * handlers attach it (see apps/mcp handler usage path); other tools omit it.
 * Populates AE double5 for `tool_call` events so per-app token/cost stops being
 * structurally blank.
 */
function readTokensUsed(result: unknown): number | undefined {
	const t = (result as { tokensUsed?: unknown } | null | undefined)?.tokensUsed;
	return typeof t === "number" && Number.isFinite(t) ? t : undefined;
}

/** The tool callback shape registered via `server.registerTool()` in this codebase. */
export type ToolCallback = (
	args: Record<string, unknown>,
	ctx: McpCtx,
) => Promise<unknown>;

/**
 * Wrap a tool's callback with `tool_call` telemetry.
 *
 * Returns a new callback that records timing/success/payload telemetry
 * around the original `cb`, then delegates to it. Call at tool-registration
 * time in place of the raw callback.
 */
export function wrapToolCallTelemetry(
	toolName: string,
	serverCtx: ServerContext,
	cb: ToolCallback,
	tool?: Pick<import("../server-context").AppTool, "meta">,
): ToolCallback {
	return async (args, extra) => {
		const startTime = Date.now();
		const callerFields = buildCallerTelemetryFields(serverCtx.callerIdentity);
		const riskMetadata = tool ? toolRiskAuditMetadata(tool) : undefined;
		const baseEvent: Partial<McpEvent> = {
			timestamp: new Date().toISOString(),
			eventType: "tool_call",
			appId: serverCtx.appId,
			appSlug: serverCtx.appSlug,
			organizationId: serverCtx.app?.organizationId,
			toolName,
			toolInputSize: getJsonSize(args),
			...callerFields,
			traceId: serverCtx.traceId,
			metadata:
				callerFields.metadata || riskMetadata
					? { ...callerFields.metadata, ...riskMetadata }
					: undefined,
		};

		const waitUntil = serverCtx.ctx.waitUntil.bind(serverCtx.ctx);
		const capturePayloads = (
			serverCtx.appMetadata?.mcpConfig as
				| { capturePayloads?: boolean }
				| null
				| undefined
		)?.capturePayloads;

		try {
			const result = await tracing.enterSpan(
				"tedix.mcp.tool_call",
				async (span) => {
					span.setAttribute("tedix.trace_id", serverCtx.traceId);
					span.setAttribute("tedix.app_id", serverCtx.appId);
					span.setAttribute("tedix.event_type", "tool_call");
					try {
						const value = await cb(args, extra);
						const callResult = value as { isError?: boolean } | null;
						span.setAttribute(
							"tedix.outcome",
							callResult?.isError ? "error" : "success",
						);
						return value;
					} catch (error) {
						span.setAttribute("tedix.outcome", "error");
						throw error;
					}
				},
			);
			// MCP convention: handler errors surface as { isError: true, content }
			// rather than a thrown exception (the SDK protocol layer catches
			// thrown errors before we see them). Treat isError results as failed
			// calls and lift the error message from content[0].text into the
			// telemetry event so dashboards / alerts can filter on it.
			const callToolResult = result as
				| {
						isError?: boolean;
						content?: Array<{ type?: string; text?: string }>;
						_meta?: Record<string, unknown>;
				  }
				| null
				| undefined;
			const success = !callToolResult?.isError;
			const errorMessage = success
				? undefined
				: truncateErrorMessage(
						callToolResult?.content?.find((c) => c?.type === "text")?.text ??
							"Tool returned isError without text content",
					);
			const tokensUsed = readTokensUsed(result);
			const securityMeta = callToolResult?._meta?.["com.tedix/security"];
			const security =
				typeof securityMeta === "object" && securityMeta !== null
					? (securityMeta as Record<string, unknown>)
					: null;
			const event: McpEvent = {
				...baseEvent,
				success,
				durationMs: Date.now() - startTime,
				toolOutputSize: getJsonSize(result),
				...(tokensUsed != null ? { tokensUsed } : {}),
				...(!success
					? {
							errorCode:
								typeof security?.denialReason === "string"
									? security.denialReason
									: "TOOL_RESULT_ERROR",
						}
					: {}),
				...(errorMessage ? { errorMessage } : {}),
				...(security
					? { metadata: { ...baseEvent.metadata, ...security } }
					: {}),
			} as McpEvent;
			trackMcpEvent(serverCtx.env, event);
			emitMcpAuditEvent(serverCtx.env, event, waitUntil);
			const inputCap = redactAndTruncate(args);
			const outputCap = redactAndTruncate(result);
			capturePayloadRecord(
				serverCtx.env,
				serverCtx.ctx,
				{
					traceId: serverCtx.traceId ?? "",
					executionId: "",
					appId: serverCtx.appId ?? "",
					appSlug: serverCtx.appSlug ?? "",
					organizationId: serverCtx.app?.organizationId ?? "",
					toolName,
					eventType: "tool_call",
					success: success ? 1 : 0,
					errorCode: "",
					durationMs: event.durationMs ?? 0,
					timestamp: event.timestamp,
					userId: event.userId ?? "",
					tediId: event.tediId ?? "",
					authType: event.authType ?? "",
					inputArgs: inputCap.json,
					inputBytes: inputCap.bytes,
					outputBody: outputCap.json,
					outputBytes: outputCap.bytes,
					truncated: inputCap.truncated || outputCap.truncated ? 1 : 0,
				},
				capturePayloads,
			);
			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			const errorCode = normalizeMcpErrorCode(error);
			const event: McpEvent = {
				...baseEvent,
				success: false,
				durationMs: Date.now() - startTime,
				errorCode,
				errorMessage: truncateErrorMessage(errorMessage),
			} as McpEvent;
			trackMcpEvent(serverCtx.env, event);
			emitMcpAuditEvent(serverCtx.env, event, waitUntil);
			const inputCap = redactAndTruncate(args);
			capturePayloadRecord(
				serverCtx.env,
				serverCtx.ctx,
				{
					traceId: serverCtx.traceId ?? "",
					executionId: "",
					appId: serverCtx.appId ?? "",
					appSlug: serverCtx.appSlug ?? "",
					organizationId: serverCtx.app?.organizationId ?? "",
					toolName,
					eventType: "tool_call",
					success: 0,
					errorCode,
					durationMs: event.durationMs ?? 0,
					timestamp: event.timestamp,
					userId: event.userId ?? "",
					tediId: event.tediId ?? "",
					authType: event.authType ?? "",
					inputArgs: inputCap.json,
					inputBytes: inputCap.bytes,
					outputBody: "",
					outputBytes: 0,
					truncated: inputCap.truncated ? 1 : 0,
				},
				capturePayloads,
			);
			throw error;
		}
	};
}
