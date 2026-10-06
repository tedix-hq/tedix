import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * SEP-2243 `Mcp-Param-*` request-binding headers (MCP 2026-07-28), outbound.
 *
 * A modern tool inputSchema may bind statically reachable primitive object
 * properties to HTTP request headers via the `x-mcp-header` schema keyword.
 * When calling such a tool, the caller mirrors each bound argument value into
 * an `Mcp-Param-{headerName}` header so HTTP infrastructure can route or
 * authorize on it without parsing the JSON-RPC body. Values that are not
 * plain-safe HTTP field values are carried as `=?base64?{data}?=`.
 *
 * This is the client-side counterpart to the inbound SEP-2243 request-binding
 * validation ladder in `./transport.ts` (`validateModernProtocolHeaders`,
 * `Mcp-Method`/`Mcp-Name`). Consumers: `@tedix/mcp-client-core`'s stateless
 * client manager and `apps/mcp`'s upstream MCP proxy (2026-07-28-negotiated
 * upstreams only — legacy upstreams get no `Mcp-Param-*` headers).
 *
 * @module @tedix/mcp-shared/mcp-param-headers
 */

export const MCP_PARAM_HEADER_PREFIX = "Mcp-Param-";

const MCP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MCP_BASE64_SENTINEL_RE = /^=\?base64\?.*\?=$/;
const MCP_BASE64_SENTINEL_PREFIX = "=?base64?";
const MCP_BASE64_SENTINEL_SUFFIX = "?=";
// RFC 4648 §4 with required canonical padding, mirroring the SDK's decoder.
const MCP_BASE64_CANONICAL_RE =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type McpHeaderBinding = {
	headerName: string;
	path: string[];
	/** Declared JSON Schema primitive type of the bound property. */
	type: "string" | "integer" | "boolean";
};

function isPrimitiveHeaderSchema(node: Record<string, unknown>): boolean {
	return (
		node.type === "string" || node.type === "integer" || node.type === "boolean"
	);
}

/**
 * Scan a tool input JSON Schema for `x-mcp-header` bindings. Fails (rather
 * than partially binding) when an annotation is malformed: non-reachable
 * placement (inside `items`/combinators/root), invalid HTTP field-name token,
 * non-primitive property type, or case-insensitively duplicated header names.
 */
export function collectMcpHeaderBindings(
	schema: Record<string, unknown>,
): { ok: true; bindings: McpHeaderBinding[] } | { ok: false; reason: string } {
	const bindings: McpHeaderBinding[] = [];
	const seenHeaders = new Set<string>();
	let failure: string | undefined;

	function visit(node: unknown, path: string[], reachable: boolean): void {
		if (failure || !isRecord(node)) return;
		const header = node["x-mcp-header"];
		if (header !== undefined) {
			if (!reachable || path.length === 0) {
				failure =
					"x-mcp-header must be on a statically reachable object property";
				return;
			}
			if (
				typeof header !== "string" ||
				!header ||
				!MCP_HEADER_NAME_RE.test(header)
			) {
				failure =
					"x-mcp-header must be a valid non-empty HTTP field-name token";
				return;
			}
			if (!isPrimitiveHeaderSchema(node)) {
				failure =
					"x-mcp-header is only supported on string, integer, or boolean properties";
				return;
			}
			const key = header.toLowerCase();
			if (seenHeaders.has(key)) {
				failure = `duplicate x-mcp-header value: ${header}`;
				return;
			}
			seenHeaders.add(key);
			bindings.push({
				headerName: header,
				path,
				type: node.type as McpHeaderBinding["type"],
			});
		}

		const properties = isRecord(node.properties) ? node.properties : undefined;
		if (properties && reachable) {
			for (const [name, child] of Object.entries(properties)) {
				visit(child, [...path, name], true);
			}
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === "properties") continue;
			if (Array.isArray(child)) {
				for (const item of child) visit(item, path, false);
			} else if (isRecord(child)) {
				visit(child, path, false);
			}
		}
	}

	visit(schema, [], true);
	return failure ? { ok: false, reason: failure } : { ok: true, bindings };
}

function valueAtPath(value: Record<string, unknown>, path: string[]): unknown {
	let current: unknown = value;
	for (const part of path) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Encode one bound argument as an HTTP header value. Plain-safe visible-ASCII
 * strings pass through; everything else representable (booleans, safe
 * integers, non-ASCII/padded strings, strings that collide with the base64
 * sentinel) is wrapped as `=?base64?{data}?=`. Non-representable values
 * (null/undefined, floats, objects) yield `undefined` — the header is omitted.
 */
export function encodeMcpHeaderValue(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	let text: string;
	if (typeof value === "string") text = value;
	else if (typeof value === "boolean") text = value ? "true" : "false";
	else if (typeof value === "number" && Number.isSafeInteger(value))
		text = String(value);
	else return undefined;

	const plainSafe =
		text.trim() === text &&
		!MCP_BASE64_SENTINEL_RE.test(text) &&
		/^[\t\x20-\x7e]*$/.test(text);
	return plainSafe ? text : `=?base64?${base64Utf8(text)}?=`;
}

/**
 * Decode one inbound `Mcp-Name` / `Mcp-Param-*` header value. The spec
 * requires servers to decode the `=?base64?{data}?=` sentinel form before
 * comparing a header to the corresponding request body value; a non-sentinel
 * value passes through unchanged. Returns `undefined` when the sentinel
 * payload is not canonical Base64 or not valid UTF-8 — callers treat that as
 * a mismatch.
 */
export function decodeMcpHeaderValue(value: string): string | undefined {
	if (!MCP_BASE64_SENTINEL_RE.test(value)) return value;
	const payload = value.slice(
		MCP_BASE64_SENTINEL_PREFIX.length,
		value.length - MCP_BASE64_SENTINEL_SUFFIX.length,
	);
	if (!MCP_BASE64_CANONICAL_RE.test(payload)) return undefined;
	try {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		return undefined;
	}
}

/**
 * SEP-2243 inbound: primitive → decimal/lowercase-boolean string, mirroring
 * the SDK's `mcpParamPrimitiveToString`. `undefined` means "not comparable —
 * skip this declaration" (non-finite numbers, unsafe integers, non-primitives).
 */
function mcpParamPrimitiveToString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		if (Number.isInteger(value) && !Number.isSafeInteger(value))
			return undefined;
		return String(value);
	}
	return undefined;
}

const MCP_CANONICAL_DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** `-32020` HeaderMismatch violation for an inbound `Mcp-Param-*` disagreement. */
export type McpParamHeaderViolation = {
	code: -32020;
	message: string;
	data: { mismatch: { header: string; body: string } };
};

function paramHeaderViolation(
	header: string,
	detail: string,
): McpParamHeaderViolation {
	return {
		code: -32020,
		message: `Bad Request: the request headers and body disagree: ${detail}`,
		data: { mismatch: { header, body: detail } },
	};
}

/**
 * SEP-2243 inbound `Mcp-Param-*` ↔ body validation, the server-side
 * counterpart to {@link buildMcpParamHeaders}. For each `x-mcp-header`
 * declaration on the called tool: when the body `arguments` carries a
 * non-null value, the matching `Mcp-Param-{Name}` header MUST be present and
 * decode ({@link decodeMcpHeaderValue}) to an equal value; a body-absent
 * declaration ignores any present header. An invalid Base64 sentinel payload
 * is a rejection. Integer-typed declarations compare numerically (`42.0` ==
 * `42`); everything else compares as decoded strings. Mirrors the SDK v2
 * serving entry's `validateMcpParamHeaders` (`-32020` + HTTP 400).
 *
 * Fail-safe like the outbound side: an absent schema, no bindings, or a
 * malformed annotation validates nothing (`undefined`).
 */
export function validateInboundMcpParamHeaders(
	inputSchema: Record<string, unknown> | undefined,
	args: Record<string, unknown> | undefined,
	headers: Headers,
): McpParamHeaderViolation | undefined {
	if (!inputSchema) return undefined;
	const collected = collectMcpHeaderBindings(inputSchema);
	if (!collected.ok || collected.bindings.length === 0) return undefined;

	for (const binding of collected.bindings) {
		const headerKey = `${MCP_PARAM_HEADER_PREFIX}${binding.headerName}`;
		const headerValue = headers.get(headerKey);
		const bodyRaw = args ? valueAtPath(args, binding.path) : undefined;
		if (bodyRaw === undefined || bodyRaw === null) continue;
		const bodyString = mcpParamPrimitiveToString(bodyRaw);
		if (bodyString === undefined) continue;

		if (headerValue === null) {
			return paramHeaderViolation(
				headerKey,
				`the body carries ${binding.path.join(".")}=${JSON.stringify(bodyRaw)} but the ${headerKey} header is absent`,
			);
		}
		const decoded = decodeMcpHeaderValue(headerValue);
		if (decoded === undefined) {
			return paramHeaderViolation(
				headerKey,
				`the ${headerKey} header carries an invalid Base64 sentinel value`,
			);
		}
		const matches =
			binding.type === "integer" &&
			MCP_CANONICAL_DECIMAL_RE.test(decoded) &&
			typeof bodyRaw === "number"
				? Number(decoded) === bodyRaw
				: decoded === bodyString;
		if (!matches) {
			return paramHeaderViolation(
				headerKey,
				`the ${headerKey} header decodes to ${JSON.stringify(decoded)} but the body carries ${binding.path.join(".")}=${JSON.stringify(bodyRaw)}`,
			);
		}
	}
	return undefined;
}

/**
 * Build the `Mcp-Param-*` header map for one tool call: scan `inputSchema`
 * for bindings and encode the bound values found in `args` (the FINAL
 * arguments object as sent to the server). Returns `{}` when the schema is
 * absent, has no bindings, or has malformed bindings (fail-safe: a bad
 * annotation never blocks the call, it just binds nothing).
 */
export function buildMcpParamHeaders(
	inputSchema: Record<string, unknown> | undefined,
	args: Record<string, unknown>,
): Record<string, string> {
	if (!inputSchema) return {};
	const collected = collectMcpHeaderBindings(inputSchema);
	if (!collected.ok) return {};
	const headers: Record<string, string> = {};
	for (const binding of collected.bindings) {
		const encoded = encodeMcpHeaderValue(valueAtPath(args, binding.path));
		if (encoded !== undefined)
			headers[`${MCP_PARAM_HEADER_PREFIX}${binding.headerName}`] = encoded;
	}
	return headers;
}
