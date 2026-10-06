import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * W3C Trace Context ↔ Tedix traceId bridging (SEP-414 / OTel MCP semconv).
 *
 * Tedix uses a per-request UUID `traceId`. The W3C `traceparent` trace-id is 32
 * lowercase hex — which is exactly a UUID with the dashes removed. So the two are
 * losslessly convertible, and we can both ACCEPT an upstream W3C trace context and
 * PROPAGATE ours to downstream MCP servers.
 *
 * SEP-414 (status: Final) carries `traceparent` / `tracestate` in the MCP request
 * `params._meta` using bare W3C keys (an explicit exception to MCP's DNS-prefix
 * convention). For HTTP transport we additionally honor the standard `traceparent`
 * HTTP header. Injecting into outbound `_meta` is the load-bearing interop piece:
 * it lets a downstream MCP server continue the same trace. Inbound requests may
 * carry the same fields in the JSON-RPC body at `params._meta`.
 *
 * @module trace-context
 */

/** W3C traceparent: `version-traceid-spanid-flags`, version 00. */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const HEX32_RE = /^[0-9a-f]{32}$/;

export interface TraceContext {
	traceId?: string | null;
	tracestate?: string | null;
	metadata?: Record<string, unknown> | null;
}

/** Format a 32-hex W3C trace-id as a canonical UUID (Tedix `traceId` shape). */
function hex32ToUuid(hex: string): string {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Strip dashes + lowercase a UUID/traceId into a 32-hex W3C trace-id, or null. */
function traceIdToHex32(traceId: string): string | null {
	const hex = traceId.replace(/-/g, "").toLowerCase();
	return HEX32_RE.test(hex) ? hex : null;
}

/**
 * Extract the trace-id from a W3C `traceparent` value and return it as a Tedix
 * UUID-shaped `traceId`. Returns null when the header is absent/malformed (the
 * all-zero trace-id is rejected per spec).
 */
export function parseTraceparentTraceId(
	traceparent: string | null | undefined,
): string | null {
	if (!traceparent) return null;
	const m = TRACEPARENT_RE.exec(traceparent.trim().toLowerCase());
	if (!m) return null;
	const traceId = m[1]!;
	if (traceId === "0".repeat(32)) return null;
	return hex32ToUuid(traceId);
}

function nonBlankHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name)?.trim();
	return value ? value : undefined;
}

/**
 * Resolve an existing trace id from HTTP headers without creating a new one.
 * This is for downstream API handlers that should join an already-rooted
 * episode but omit trace metadata when no upstream context exists.
 */
export function inboundTraceIdFromHeaders(
	headers: Headers,
): string | undefined {
	return (
		parseTraceparentTraceId(headers.get("traceparent")) ??
		nonBlankHeader(headers, "x-trace-id") ??
		nonBlankHeader(headers, "x-tedix-trace-id")
	);
}

/** Extract the MCP SEP-414 trace metadata object from one JSON-RPC request. */
export function extractMcpTraceMeta(
	jsonRpcBody: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(jsonRpcBody)) return undefined;
	const params = jsonRpcBody.params;
	if (!isRecord(params)) return undefined;
	const meta = params._meta;
	return isRecord(meta) ? meta : undefined;
}

/** 16-hex span id from CSPRNG (never all-zero). */
export function randomSpanId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	// Guard against the (astronomically unlikely) all-zero span id.
	if (bytes.every((b) => b === 0)) bytes[0] = 1;
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Format a Tedix `traceId` (UUID or 32-hex) as a W3C `traceparent`. A fresh span
 * id is generated for the outbound hop; `sampled` defaults true (flags `01`).
 * Returns null when `traceId` can't be normalized to a 32-hex trace-id.
 */
export function formatTraceparent(
	traceId: string,
	opts?: { spanId?: string; sampled?: boolean },
): string | null {
	const hex = traceIdToHex32(traceId);
	if (!hex) return null;
	const spanId = opts?.spanId ?? randomSpanId();
	const flags = opts?.sampled === false ? "00" : "01";
	return `00-${hex}-${spanId}-${flags}`;
}

/**
 * Resolve the inbound traceId, preferring (in order): the W3C `traceparent`
 * header, the MCP SEP-414 `params._meta.traceparent`, the legacy `X-Trace-Id`
 * header, then a freshly generated UUID. Keeps `X-Trace-Id` as a
 * backwards-compatible source.
 */
export function resolveInboundTraceId(
	headers: Headers,
	mcpMeta?: Record<string, unknown>,
): string {
	const fromW3c = parseTraceparentTraceId(headers.get("traceparent"));
	if (fromW3c) return fromW3c;
	const metaTraceparent =
		typeof mcpMeta?.traceparent === "string" ? mcpMeta.traceparent : undefined;
	const fromMcpMeta = parseTraceparentTraceId(metaTraceparent);
	if (fromMcpMeta) return fromMcpMeta;
	const xTrace = nonBlankHeader(headers, "x-trace-id");
	if (xTrace) return xTrace;
	return crypto.randomUUID();
}

/**
 * Resolve inbound W3C tracestate, preferring the HTTP header over MCP
 * `params._meta.tracestate`. Tedix does not parse vendor entries; it preserves
 * the upstream chain for the next outbound hop.
 */
export function resolveInboundTracestate(
	headers: Headers,
	mcpMeta?: Record<string, unknown>,
): string | undefined {
	const headerValue = headers.get("tracestate")?.trim();
	if (headerValue) return headerValue;
	const metaValue = mcpMeta?.tracestate;
	return typeof metaValue === "string" && metaValue.trim()
		? metaValue.trim()
		: undefined;
}

/**
 * Build the outbound `_meta` trace-context fields (SEP-414 bare keys) for a
 * given Tedix traceId, optionally merging an inbound `tracestate` to preserve the
 * upstream vendor chain. Returns `{}` when the traceId can't be formatted, so the
 * caller can spread it unconditionally.
 */
export function outboundTraceMeta(
	traceId: string | undefined,
	tracestate?: string | null,
): Record<string, string> {
	if (!traceId) return {};
	const traceparent = formatTraceparent(traceId);
	if (!traceparent) return {};
	const meta: Record<string, string> = { traceparent };
	if (tracestate) meta.tracestate = tracestate;
	return meta;
}
