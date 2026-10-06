/**
 * `prompts/get` telemetry — wraps a prompt's callback at registration time.
 *
 * Single source of truth for `prompt_get` MCP events. Mirrors the
 * `tools/call` telemetry wrapper: wraps every prompts/get dispatch, emits a
 * normalized McpEvent regardless of where the prompt is sourced (D1 /
 * external proxy / bootstrap).
 *
 * Replaces the per-handler `trackMcpEvent` calls that previously lived in
 * `external-prompts.ts` and the bootstrap prompt path in
 * `tool-registration.ts`. Those call sites have been removed —
 * `wrapPromptGetTelemetry` is now the only emitter of `prompt_get` events.
 */

import type { ServerContext as McpCtx } from "@modelcontextprotocol/server";
import type { ServerContext } from "../server-context";
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

/** The prompt callback shape registered via `server.registerPrompt()` in this codebase. */
export type PromptCallback = (
	args: Record<string, unknown>,
	ctx: McpCtx,
) => unknown;

/**
 * Wrap a prompt's callback with `prompt_get` telemetry.
 *
 * Returns a new callback that records timing/success/payload telemetry
 * around the original `cb`, then delegates to it. Call at prompt-registration
 * time in place of the raw callback.
 */
export function wrapPromptGetTelemetry(
	promptName: string,
	serverCtx: ServerContext,
	cb: PromptCallback,
): PromptCallback {
	return async (args, extra) => {
		const startTime = Date.now();
		const baseEvent: Partial<McpEvent> = {
			timestamp: new Date().toISOString(),
			eventType: "prompt_get",
			appId: serverCtx.appId,
			appSlug: serverCtx.appSlug,
			organizationId: serverCtx.app?.organizationId,
			toolName: promptName,
			toolInputSize: getJsonSize(args),
			...buildCallerTelemetryFields(serverCtx.callerIdentity),
			traceId: serverCtx.traceId,
		};

		const waitUntil = serverCtx.ctx.waitUntil.bind(serverCtx.ctx);
		const capturePayloads = (
			serverCtx.appMetadata?.mcpConfig as
				| { capturePayloads?: boolean }
				| null
				| undefined
		)?.capturePayloads;

		try {
			const result = await cb(args, extra);
			const event: McpEvent = {
				...baseEvent,
				success: true,
				durationMs: Date.now() - startTime,
				toolOutputSize: getJsonSize(result),
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
					toolName: promptName,
					eventType: "prompt_get",
					success: 1,
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
					toolName: promptName,
					eventType: "prompt_get",
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
