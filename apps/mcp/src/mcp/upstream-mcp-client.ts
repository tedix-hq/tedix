/**
 * One proxied `tools/call` against an upstream MCP server, through the
 * official SDK v2 client.
 *
 * `versionNegotiation: 'auto'` probes `server/discover` and falls back to the
 * 2025 `initialize` handshake; the verdict is remembered per upstream endpoint
 * and fed back as `connect({ prior })`, so a warm call to a 2026-07-28
 * upstream is the single `tools/call` request. First-party modern-only
 * bindings (the tedi runtime, Docs) are seeded with a fixed modern verdict and
 * never probe: a transient or auth-negative discovery must surface on the
 * actual call, never trigger an invalid legacy handshake.
 *
 * `tools/call` is never re-sent by the SDK: input_required auto-fulfilment is
 * off and the explicit tool definition disables its `-32020` list-and-resend.
 * The two retries this proxy owns stay explicit here, because in both the
 * upstream did NOT execute the rejected call: one `HeaderMismatch` retry with
 * the upstream's current schema, and bounded agent-in-the-loop
 * `input_required` rounds resolved by the deterministic elicitation filler.
 */

import {
	Client,
	type DiscoverResult,
	type PriorDiscovery,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
	type Tool,
	UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/client";
import { resolveInputRequestsDeterministic } from "@tedix/mcp-shared/elicitation-fill";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
	readInputRequiredResult,
} from "@tedix/mcp-shared/protocol";
import { setBoundedCacheEntry } from "../lib/bounded-cache";

export type UpstreamProtocolEra = "modern_2026" | "legacy_streamable_2025";

export interface UpstreamToolCall {
	url: string;
	fetcher: typeof globalThis.fetch;
	/** Auth, tracing, attribution, and config-declared headers for every hop. */
	headers: Record<string, string>;
	toolName: string;
	args: Record<string, unknown>;
	/** D1 input schema; its `x-mcp-header` bindings drive `Mcp-Param-*`. */
	toolInputSchema?: Record<string, unknown>;
	/** Request `_meta` on a 2026-07-28 connection (protocol keys are added). */
	modernMeta?: Record<string, unknown>;
	/** Request `_meta` on a 2025-era session. */
	legacyMeta?: Record<string, unknown>;
	/** First-party binding that always serves the modern revision. */
	modernOnly: boolean;
	signal: AbortSignal;
	timeoutMs: number;
}

export type UpstreamToolOutcome =
	| {
			ok: true;
			era: UpstreamProtocolEra;
			/** CallToolResult, or an input_required result the edge could not fulfil. */
			result: Record<string, unknown>;
	  }
	| { ok: false; status: number; error: string };

const CLIENT_INFO = { name: "tedix-mcp-proxy", version: "1.0.0" };
const MAX_INPUT_ROUNDS = 8;
const MAX_TOOL_LIST_PAGES = 20;
const HEADER_MISMATCH = -32_020;

// Tedix resolves elicitation agent-in-the-loop, so a conformant upstream may
// elicit through the proxy (MRTR: a server must not send an inputRequests
// entry the client did not declare). Declared per request on the modern era
// only: a 2025-era session has no input_required vocabulary to answer with.
const MODERN_CLIENT_CAPABILITIES = { elicitation: { form: {} } };

const FIRST_PARTY_MODERN: PriorDiscovery = {
	kind: "modern",
	discover: {
		supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
		capabilities: { tools: {} },
	} as DiscoverResult,
};

// The era of an upstream is a property of its deployment, so the verdict is
// remembered per endpoint (origin + path) for a bounded TTL: an upgrade is
// picked up within one TTL, and any failed call evicts the entry so the next
// call re-probes. Only verdicts from a successful connect are stored.
const ERA_TTL_MS = 10 * 60 * 1000;
const MAX_ERA_ENTRIES = 100;
const upstreamEras = new Map<
	string,
	{ prior: PriorDiscovery; expiresAt: number }
>();

function eraKey(url: string): string {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return url;
	}
}

function rememberedEra(key: string): PriorDiscovery | undefined {
	const entry = upstreamEras.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt > Date.now()) return entry.prior;
	upstreamEras.delete(key);
	return undefined;
}

function rememberEra(key: string, client: Client): void {
	const era = client.getProtocolEra();
	const discover = client.getDiscoverResult();
	const prior: PriorDiscovery | undefined =
		era === "legacy"
			? { kind: "legacy" }
			: era === "modern" && discover
				? { kind: "modern", discover }
				: undefined;
	if (!prior) return;
	setBoundedCacheEntry(
		upstreamEras,
		key,
		{ prior, expiresAt: Date.now() + ERA_TTL_MS },
		MAX_ERA_ENTRIES,
	);
}

/** Test-only: forget every remembered upstream protocol era. */
/** @internal */
export function resetUpstreamEraCache(): void {
	upstreamEras.clear();
}

// Protocol-owned headers are the transport's; a config-declared value must
// never smuggle a session or a modern header onto the other era.
function callerHeaders(headers: Record<string, string>): Headers {
	const out = new Headers();
	// Headers iteration yields lower-cased names.
	for (const [name, value] of new Headers(headers)) {
		if (
			name !== "mcp-protocol-version" &&
			name !== "mcp-method" &&
			name !== "mcp-name" &&
			name !== "mcp-session-id" &&
			!name.startsWith("mcp-param-")
		) {
			out.append(name, value);
		}
	}
	return out;
}

function responseCookies(headers: Headers): string | undefined {
	const values =
		(headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
		(headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
	const cookies = values
		.map((value) => value.split(";", 1)[0]?.trim())
		.filter((value): value is string => Boolean(value));
	return cookies.length > 0 ? cookies.join("; ") : undefined;
}

function newClient(): Client {
	return new Client(CLIENT_INFO, {
		versionNegotiation: { mode: "auto" },
		inputRequired: { autoFulfill: false },
		listMaxPages: MAX_TOOL_LIST_PAGES,
	});
}

function upstreamTransport(
	call: UpstreamToolCall,
): StreamableHTTPClientTransport {
	// A 2025-era upstream may pin its session to a backend with a cookie.
	let cookie: string | undefined;
	// Call the fetcher unbound: invoked as `call.fetcher(...)`, workerd's
	// native fetch sees `call` as `this` and throws "Illegal invocation".
	const { fetcher } = call;
	return new StreamableHTTPClientTransport(new URL(call.url), {
		requestInit: { headers: callerHeaders(call.headers) },
		fetch: async (input, init) => {
			// One call never listens for server-initiated messages; answer the
			// standalone SSE GET the 2025 handshake opens locally.
			if (init?.method === "GET") return new Response(null, { status: 405 });
			const headers = new Headers(init?.headers);
			if (cookie && !headers.has("cookie")) headers.set("Cookie", cookie);
			const response = await fetcher(String(input), {
				...init,
				headers,
				signal: init?.signal
					? AbortSignal.any([init.signal, call.signal])
					: call.signal,
			});
			cookie = responseCookies(response.headers) ?? cookie;
			return response;
		},
	});
}

/**
 * The `auto` probe failed with a 5xx or a network error (connection reset or
 * closed). The SDK reports both as `EraNegotiationFailed`; a 401/403 probe
 * answer carries an HTTP auth code instead and a timeout `RequestTimeout`.
 */
function isProbeOutage(error: unknown): boolean {
	return (
		error instanceof SdkError &&
		error.code === SdkErrorCode.EraNegotiationFailed
	);
}

export async function callUpstreamMcpTool(
	call: UpstreamToolCall,
): Promise<UpstreamToolOutcome> {
	const key = eraKey(call.url);
	const requestOptions = { signal: call.signal, timeout: call.timeoutMs };
	const prior = call.modernOnly ? FIRST_PARTY_MODERN : rememberedEra(key);
	let client = newClient();
	let stage: "connect" | "call" = "connect";
	try {
		try {
			await client.connect(upstreamTransport(call), {
				...requestOptions,
				...(prior ? { prior } : {}),
			});
		} catch (error) {
			// Many 2025-era servers answer the unknown `server/discover` probe
			// with a 5xx or drop the connection. Treat that probe outage as a
			// legacy signal and run the plain initialize handshake once on a
			// fresh connection; its verdict is cached only if it succeeds.
			// 401/403 on the probe stay auth failures.
			if (prior || call.signal.aborted || !isProbeOutage(error)) throw error;
			await client.close().catch(() => {});
			client = newClient();
			await client.connect(upstreamTransport(call), {
				...requestOptions,
				prior: { kind: "legacy" },
			});
		}
		if (!call.modernOnly) rememberEra(key, client);
		stage = "call";
		const modern = client.getProtocolEra() === "modern";
		const era: UpstreamProtocolEra = modern
			? "modern_2026"
			: "legacy_streamable_2025";
		const meta = modern
			? {
					...call.modernMeta,
					[MCP_CLIENT_CAPABILITIES_META_KEY]: MODERN_CLIENT_CAPABILITIES,
				}
			: call.legacyMeta;
		let toolDefinition: Tool = {
			name: call.toolName,
			inputSchema: (call.toolInputSchema ?? {
				type: "object",
			}) as Tool["inputSchema"],
		};
		const send = (extra?: Record<string, unknown>) =>
			client.callTool(
				{
					name: call.toolName,
					arguments: call.args,
					...extra,
					...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
				},
				{ ...requestOptions, toolDefinition, allowInputRequired: true },
			) as Promise<Record<string, unknown>>;

		let result: Record<string, unknown>;
		try {
			result = await send();
		} catch (error) {
			// HeaderMismatch: the upstream rejected the call before executing it.
			// Rebuild Mcp-Param-* from its current schema and retry exactly once.
			if (
				!modern ||
				!(error instanceof ProtocolError) ||
				error.code !== HEADER_MISMATCH
			) {
				throw error;
			}
			const listed = await client
				.listTools(undefined, requestOptions)
				.catch(() => undefined);
			const current = listed?.tools.find((tool) => tool.name === call.toolName);
			if (!current?.inputSchema) throw error;
			toolDefinition = {
				name: call.toolName,
				inputSchema: current.inputSchema,
			};
			result = await send();
		}

		// input_required: the upstream halted for caller input and executed
		// nothing. Resolve deterministically and retry echoing inputResponses
		// and the opaque requestState; when the filler declines or a round
		// fails, the caller surfaces the last input_required result.
		let inputRequired = modern ? readInputRequiredResult(result) : null;
		for (
			let round = 0;
			round < MAX_INPUT_ROUNDS && inputRequired?.inputRequests;
			round++
		) {
			const inputResponses = resolveInputRequestsDeterministic(
				inputRequired.inputRequests,
			);
			if (!inputResponses) break;
			try {
				result = await send({
					inputResponses,
					...(inputRequired.requestState !== undefined
						? { requestState: inputRequired.requestState }
						: {}),
				});
			} catch (error) {
				if (error instanceof ProtocolError) throw error;
				break;
			}
			inputRequired = readInputRequiredResult(result);
		}
		return { ok: true, era, result };
	} catch (error) {
		// A JSON-RPC error answering tools/call says nothing about the era.
		if (stage === "connect" || !(error instanceof ProtocolError)) {
			upstreamEras.delete(key);
		}
		return upstreamFailure(stage, error, call);
	} finally {
		await client.close().catch(() => {});
	}
}

function upstreamFailure(
	stage: "connect" | "call",
	error: unknown,
	call: UpstreamToolCall,
): UpstreamToolOutcome & { ok: false } {
	if (
		call.signal.aborted ||
		(error instanceof Error && error.name === "AbortError") ||
		(error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
	) {
		return {
			ok: false,
			status: 408,
			error: `Upstream MCP server timed out after ${call.timeoutMs}ms`,
		};
	}
	if (error instanceof UnsupportedProtocolVersionError) {
		return {
			ok: false,
			status: 502,
			error: `Upstream MCP server offers no supported protocol revision: ${error.message}`,
		};
	}
	if (error instanceof SdkHttpError) {
		const text = error.data?.text;
		const detail = typeof text === "string" ? text.slice(0, 500) : "";
		return {
			ok: false,
			status: error.status,
			error:
				stage === "connect"
					? `Upstream MCP handshake returned ${error.status}: ${detail || error.message}`
					: `Upstream MCP server returned ${error.status}: ${detail}`,
		};
	}
	if (error instanceof ProtocolError) {
		return {
			ok: false,
			// An unresolved HeaderMismatch is the upstream's 400, not a relay fault.
			status: error.code === HEADER_MISMATCH ? 400 : 502,
			error:
				stage === "connect"
					? `Upstream MCP handshake failed: ${error.message}`
					: error.message || "Upstream MCP server returned an error",
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return { ok: false, status: 502, error: `MCP proxy failed: ${message}` };
}
