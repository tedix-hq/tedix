import { inboundTraceIdFromHeaders } from "@tedix/mcp-shared/trace-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TRACE = /^[0-9a-f]{32}$/i;

/** Header values are untrusted: retain only identifier shapes, never arbitrary text. */
export function requestCorrelation(
	headers: Headers | undefined,
): Record<string, string> {
	if (!headers) return {};
	const result: Record<string, string> = {};
	const traceId = inboundTraceIdFromHeaders(headers);
	if (traceId && (UUID.test(traceId) || HEX_TRACE.test(traceId))) {
		result.traceId = traceId;
	}
	for (const [field, header] of [
		["mcpExecutionId", "X-Tedix-Mcp-Execution-Id"],
		["kernelRunId", "X-Tedix-Kernel-Run-Id"],
		["workItemId", "X-Tedix-Work-Item-Id"],
		["traceBundleId", "X-Tedix-Trace-Bundle-Id"],
	] as const) {
		const value = headers.get(header);
		if (value && UUID.test(value)) result[field] = value;
	}
	return result;
}
