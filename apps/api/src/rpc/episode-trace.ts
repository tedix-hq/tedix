import { inboundTraceIdFromHeaders } from "@tedix/mcp-shared/trace-context";

/**
 * Episode trace correlation.
 *
 * The "episode" is one logical unit of tedi work — an MCP request and everything
 * it triggers (run, tool calls, decisions, skills, memory). We anchor it on the
 * inbound trace context (`traceparent`, `X-Trace-Id`, or `X-Tedix-Trace-Id`).
 * Stamping this id onto every cognitive runtime event lets Tedix OS Activity
 * replay a full episode across lanes — decisions, skills, and memory grouped
 * with the AE/audit rows of the same request — WITHOUT a new schema column.
 *
 * Returns undefined when no upstream trace context is present so callers can
 * omit the field rather than invent an orphan id.
 */
export function episodeTraceId(headers: Headers): string | undefined {
	return inboundTraceIdFromHeaders(headers);
}
