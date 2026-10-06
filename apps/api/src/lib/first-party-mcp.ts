/**
 * Stateless requests to a first-party (Tedix-hosted) MCP endpoint through the
 * SDK v2 `Client`.
 *
 * Tedix's own MCP surfaces (apps/mcp over `MCP_SERVICE`, Docs over `DOCS`)
 * speak only `2026-07-28`, so the client is pinned to that revision. By
 * default it adopts the known modern verdict (`connect({ prior })`, zero round
 * trips), so one request is one HTTP call — the same wire cost as the
 * hand-bound requests this replaces. `probe: true` runs the pinned
 * `server/discover` first and fails unless the host advertises the revision.
 *
 * The SDK owns the request contract: the per-request `_meta` envelope, the
 * `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, JSON and SSE
 * response parsing, and result validation. `input_required` results are
 * returned as-is (never auto-fulfilled); the caller decides what they mean.
 */

import type {
	Client,
	DiscoverResult,
	PriorDiscovery,
	StandardSchemaV1,
} from "@modelcontextprotocol/client";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";

type McpSdk = typeof import("./mcp-client-sdk");

let mcpSdk: Promise<McpSdk> | undefined;

/** Loaded on first use; see `./mcp-client-sdk` for why it is a named subset. */
function loadMcpSdk(): Promise<McpSdk> {
	mcpSdk ??= import("./mcp-client-sdk");
	return mcpSdk;
}

/**
 * A fetch that is safe to call as a plain function. Pass
 * `binding.fetch.bind(binding)` or a closure — never an unbound method, which
 * workerd rejects with "Illegal invocation".
 */
export type FirstPartyMcpFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export interface FirstPartyMcpConnection {
	/** Full MCP endpoint URL (`https://…/mcp`). */
	url: string;
	fetch: FirstPartyMcpFetch;
	/** Routing, identity, and audit headers sent on every request. */
	headers: Record<string, string>;
	clientName: string;
	clientCapabilities?: Record<string, unknown>;
	/** Run the pinned `server/discover` probe instead of adopting the verdict. */
	probe?: boolean;
	/** Per-request timeout. Default 5 minutes (callers previously set none). */
	timeoutMs?: number;
}

/** Why a first-party MCP request failed, without exposing SDK classes. */
export class FirstPartyMcpError extends Error {
	constructor(
		message: string,
		readonly kind:
			| "http"
			| "protocol"
			| "unsupported_protocol"
			| "timeout"
			| "invalid_response",
		/** HTTP status for `kind: "http"`. */
		readonly status?: number,
		/** JSON-RPC error for `kind: "protocol"`. */
		readonly rpcError?: { code: number; message: string; data?: unknown },
		/** Response body excerpt for `kind: "http"`. */
		readonly body?: string,
	) {
		super(message);
		this.name = "FirstPartyMcpError";
	}
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const FIRST_PARTY_MODERN: PriorDiscovery = {
	kind: "modern",
	discover: {
		supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
		capabilities: {},
	} as DiscoverResult,
};

/** A result schema that accepts any JSON-RPC result object as sent. */
const RESULT_OBJECT: StandardSchemaV1<unknown, Record<string, unknown>> = {
	"~standard": {
		version: 1,
		vendor: "tedix",
		validate: (value) =>
			value && typeof value === "object" && !Array.isArray(value)
				? { value: value as Record<string, unknown> }
				: { issues: [{ message: "Expected a JSON-RPC result object" }] },
	},
};

/** SDK failures become {@link FirstPartyMcpError}; anything else is returned as-is. */
function classify(sdk: McpSdk, error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof sdk.SdkHttpError) {
		const text = (error.data as { text?: unknown } | undefined)?.text;
		return new FirstPartyMcpError(
			`MCP host answered HTTP ${error.status}`,
			"http",
			error.status,
			undefined,
			typeof text === "string" ? text.slice(0, 800) : undefined,
		);
	}
	// A ProtocolError subclass: check it first.
	if (error instanceof sdk.UnsupportedProtocolVersionError) {
		return new FirstPartyMcpError(message, "unsupported_protocol");
	}
	if (error instanceof sdk.ProtocolError) {
		return new FirstPartyMcpError(message, "protocol", undefined, {
			code: error.code,
			message: error.message,
			...(error.data !== undefined ? { data: error.data } : {}),
		});
	}
	if (
		(error instanceof sdk.SdkError &&
			error.code === sdk.SdkErrorCode.RequestTimeout) ||
		(error instanceof Error && error.name === "AbortError")
	) {
		return new FirstPartyMcpError(message, "timeout");
	}
	if (
		error instanceof sdk.SdkError &&
		error.code === sdk.SdkErrorCode.EraNegotiationFailed
	) {
		return new FirstPartyMcpError(message, "unsupported_protocol");
	}
	if (error instanceof sdk.SdkError) {
		return new FirstPartyMcpError(message, "invalid_response");
	}
	return error;
}

/**
 * Open one pinned connection, run `operation`, and close it. SDK failures
 * surface as {@link FirstPartyMcpError}; an exception thrown by `fetch` itself
 * (a dropped binding, a network error) propagates unchanged, as it did when
 * callers fetched directly.
 */
export async function withFirstPartyMcp<T>(
	connection: FirstPartyMcpConnection,
	operation: (
		request: (
			method: string,
			params?: Record<string, unknown>,
		) => Promise<Record<string, unknown>>,
		client: Client,
	) => Promise<T>,
): Promise<T> {
	const sdk = await loadMcpSdk();
	const timeout = connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const client = new sdk.Client(
		{ name: connection.clientName, version: "1.0.0" },
		{
			capabilities: connection.clientCapabilities ?? {},
			versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
			inputRequired: { autoFulfill: false },
		},
	);
	// Destructure so the fetch is never invoked as a method of `connection`.
	const { fetch: fetchFn, headers: callerHeaders } = connection;
	const transport = new sdk.StreamableHTTPClientTransport(
		new URL(connection.url),
		{
			fetch: async (input, init) => {
				// A stateless call never opens the standalone SSE listen stream;
				// 405 is the spec's "no stream offered" answer.
				if (init?.method === "GET") return new Response(null, { status: 405 });
				const headers = new Headers(init?.headers);
				for (const [name, value] of Object.entries(callerHeaders))
					headers.set(name, value);
				return fetchFn(String(input), { ...init, headers });
			},
		},
	);
	try {
		await client.connect(transport, {
			timeout,
			...(connection.probe ? {} : { prior: FIRST_PARTY_MODERN }),
		});
		const request = (method: string, params: Record<string, unknown> = {}) =>
			client
				.request({ method, params }, RESULT_OBJECT, {
					timeout,
					allowInputRequired: true,
				})
				.catch((error: unknown) => {
					throw classify(sdk, error);
				});
		return await operation(request, client);
	} catch (error) {
		throw classify(sdk, error);
	} finally {
		await client.close().catch(() => {});
	}
}

/** One JSON-RPC request on its own pinned connection. */
export function requestFirstPartyMcp(
	connection: FirstPartyMcpConnection,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	return withFirstPartyMcp(connection, (request) => request(method, params));
}
