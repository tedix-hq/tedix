import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_SERVER_INFO_META_KEY,
} from "@tedix/mcp-shared/protocol";
import {
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	validateModernProtocolHeaders,
} from "@tedix/mcp-shared/transport";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { ResolvedApp } from "./resolution";

/**
 * JSON-RPC envelope reading and response shaping for the Worker's modern
 * fast paths, which answer some MCP requests before building a server.
 */

export interface JsonRpcEnvelope {
	body: Record<string, unknown>;
	isSingleItemBatch: boolean;
}

type JsonRpcEnvelopeRead = JsonRpcEnvelope | { tooLarge: true } | null;

export function jsonRpcEnvelopeResponse(
	envelope: JsonRpcEnvelope,
	result: Record<string, unknown>,
	init?: ResponseInit,
): Response {
	const payload = {
		jsonrpc: "2.0",
		id: envelope.body.id ?? null,
		result,
	};
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/json");
	return new Response(
		JSON.stringify(envelope.isSingleItemBatch ? [payload] : payload),
		{
			...init,
			headers,
		},
	);
}

export function resolvedMcpServerInfo(resolvedApp: ResolvedApp) {
	return {
		name:
			(resolvedApp.metadata?.mcpConfig?.serverName as string | undefined) ??
			`${resolvedApp.app.name} MCP`,
		version:
			(resolvedApp.metadata?.mcpConfig?.serverVersion as string | undefined) ??
			"1.0.0",
	};
}

export function decorateModernFastPathResult(
	envelope: JsonRpcEnvelope,
	resolvedApp: ResolvedApp,
	result: Record<string, unknown>,
): Record<string, unknown> {
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	const meta = isRecord(params._meta) ? params._meta : {};
	if (meta[MCP_PROTOCOL_VERSION_META_KEY] !== MCP_MODERN_PROTOCOL_VERSION) {
		return result;
	}
	const resultMeta = isRecord(result._meta) ? result._meta : {};
	return {
		...result,
		_meta: {
			...resultMeta,
			[MCP_SERVER_INFO_META_KEY]: resolvedMcpServerInfo(resolvedApp),
		},
	};
}

export async function readJsonRpcEnvelope(
	request: Request,
): Promise<JsonRpcEnvelopeRead> {
	try {
		const maxBytes = 4 * 1024 * 1024;
		const clone = request.clone();
		if (Number(clone.headers.get("content-length")) > maxBytes) {
			return { tooLarge: true };
		}
		if (!clone.body) return null;
		const reader = clone.body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel();
					return { tooLarge: true };
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const body = JSON.parse(new TextDecoder().decode(bytes));
		if (isRecord(body)) {
			return { body, isSingleItemBatch: false };
		}
		if (Array.isArray(body) && body.length === 1 && isRecord(body[0])) {
			return { body: body[0], isSingleItemBatch: true };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Fast-path JSON-RPC error envelope. Every emission site here runs only for
 * modern (2026-07-28) callers — the ladder codes (`-32600`/`-32020`/`-32021`)
 * and `-32022` answer 400, while method-not-found (`-32601`, e.g.
 * `subscriptions/listen` without the `MCP_SUBSCRIPTIONS` binding) answers 404
 * per the modern spec's method-not-found → HTTP 404 mapping.
 */
export function jsonRpcEnvelopeErrorResponse(
	envelope: JsonRpcEnvelope,
	code: number,
	message: string,
	data?: Record<string, unknown>,
): Response {
	const payload = {
		jsonrpc: "2.0",
		id: envelope.body.id ?? null,
		error: { code, message, ...(data ? { data } : {}) },
	};
	return new Response(
		JSON.stringify(envelope.isSingleItemBatch ? [payload] : payload),
		{
			status: code === -32_601 ? 404 : 400,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/** Early version gate used before auth/routing; preserve an echoable JSON-RPC id. */
export async function unsupportedProtocolVersionResponse(
	request: Request,
): Promise<Response> {
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	const requestId = envelope?.body.id;
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id:
				typeof requestId === "string" || typeof requestId === "number"
					? requestId
					: null,
			error: {
				code: -32_022,
				message: "Unsupported MCP protocol version",
				data: { supported: MCP_SUPPORTED_PROTOCOL_VERSIONS },
			},
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

export async function readJsonRpcBody(
	request: Request,
): Promise<Record<string, unknown> | null> {
	const envelope = await readJsonRpcEnvelope(request);
	return envelope && "body" in envelope ? envelope.body : null;
}

export function requestBodyTooLargeResponse(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32_000,
				message:
					"Payload Too Large: Request body must not exceed 4194304 bytes",
			},
		}),
		{ status: 413, headers: { "Content-Type": "application/json" } },
	);
}

export function validateModernFastPathRequest(
	request: Request,
	envelope: JsonRpcEnvelope,
): Response | null {
	const method =
		typeof envelope.body.method === "string" ? envelope.body.method : "";
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	const violation = validateModernProtocolHeaders({
		headers: request.headers,
		method,
		params,
	});
	if (!violation) return null;
	return jsonRpcEnvelopeErrorResponse(
		envelope,
		violation.code,
		violation.message,
		violation.data,
	);
}
