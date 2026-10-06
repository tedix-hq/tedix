import { MCP_SKILLS_EXTENSION } from "@tedix/mcp-shared/skills";
import { createLogger } from "@tedix/worker-kit/logger";
import {
	contentFreeProxyException,
	credentialHeadersFrom,
	mcpCall,
	McpProxyError,
	type WidgetProxyFetch,
	type WidgetServiceIdentity,
} from "../widgets/proxy";

/**
 * Same-origin MCP endpoint for WebMCP browser agents.
 *
 * Cloudflare's WebMCP developer preview injects a bridge script whose Site
 * MCP Server pack speaks plain streamable-HTTP JSON-RPC (`tools/list`,
 * `tools/call`) at a same-origin `data-mcp-url`, defaulting to `/mcp`, with
 * the visitor's own cookies (`credentials: "same-origin"`). Tedix MCP hosts
 * live on another origin (`*.mcp.tedix.dev`) and speak the modern stateless
 * `server/discover` protocol, so this endpoint adapts: it accepts one legacy
 * JSON-RPC request per POST, answers the client-lifecycle methods locally,
 * and relays the tool, skill, and resource methods through the caller's OWN
 * session over the MCP service binding — the exact trust path the widget bridge uses. The
 * hostname's tenant selects the default gateway app (`{slug}-unified`);
 * `?app={slug}` targets a specific per-app surface instead.
 *
 * The endpoint holds no authority: the MCP edge revalidates the forwarded
 * session and applies app/tool authorization per call.
 */

/** Only Tedix-managed tenant app slugs are valid relay targets. */
const APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Methods relayed upstream; everything else is refused or answered locally. */
const RELAYED_METHODS: ReadonlySet<string> = new Set([
	"tools/list",
	"tools/call",
	"skills/list",
	"skills/get",
	"resources/read",
	"resources/directory/read",
]);

const MAX_BODY_BYTES = 256 * 1024;
const LEGACY_INITIALIZE_PROTOCOL_VERSION = "2025-06-18";

/** Stable log-line prefix so an observability query can select on it. */
export const WEBMCP_RELAY_LOG_EVENT = "webmcp.relay";
/** Caller-controlled string; bound it before it reaches a log line. */
const RELAY_LOG_TOOL_NAME_MAX_CHARS = 128;
const PORTABLE_CALLABLE = /^([a-z][a-z0-9_]{1,127})\.([a-z][a-z0-9_]{1,127})$/;

const relayLogger = createLogger<{
	failure: ReturnType<typeof contentFreeProxyException>;
}>({ component: "os.webmcp.relay" });

export interface OsPortableAuthorizationRequest {
	token: string;
	routeId: string;
	callable: string;
	args: Record<string, unknown>;
	origin: string;
	refererPathname: string;
}

/** Dedicated portable relay: exact callable only, with an API-verified signed route. */
export async function handleOsPortableCall(
	request: Request,
	url: URL,
	tenantSlug: string,
	serviceIdentity: WidgetServiceIdentity,
	authorize: (input: OsPortableAuthorizationRequest) => Promise<boolean>,
	fetchImpl: WidgetProxyFetch = fetch,
): Promise<Response> {
	const fail = (status: number, error: string) =>
		Response.json(
			{ error },
			{ status, headers: { "Cache-Control": "private, no-store" } },
		);
	if (request.method !== "POST" || request.headers.get("Origin") !== url.origin)
		return fail(403, "Same-origin POST required");
	if (
		request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
		"application/json"
	)
		return fail(415, "JSON request required");
	const referer = request.headers.get("Referer");
	if (!referer) return fail(403, "Current page route required");
	let refererPathname: string;
	try {
		const page = new URL(referer);
		if (page.origin !== url.origin) return fail(403, "Page origin mismatch");
		refererPathname = page.pathname;
	} catch {
		return fail(403, "Invalid page route");
	}
	const body = await request.text();
	if (body.length > 32_000) return fail(413, "Portable call is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return fail(400, "Invalid portable call");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return fail(400, "Invalid portable call");
	const input = parsed as Record<string, unknown>;
	if (
		typeof input.token !== "string" ||
		input.token.length < 1 ||
		input.token.length > 24_000 ||
		typeof input.routeId !== "string" ||
		!/^[a-z][a-z0-9_-]{0,79}$/.test(input.routeId) ||
		typeof input.callable !== "string" ||
		!PORTABLE_CALLABLE.test(input.callable) ||
		!input.args ||
		typeof input.args !== "object" ||
		Array.isArray(input.args) ||
		Object.keys(input).some(
			(key) => !["token", "routeId", "callable", "args"].includes(key),
		)
	)
		return fail(400, "Invalid portable call");
	const args = input.args as Record<string, unknown>;
	const authorized = await authorize({
		token: input.token,
		routeId: input.routeId,
		callable: input.callable,
		args,
		origin: url.origin,
		refererPathname,
	}).catch(() => false);
	if (!authorized) return fail(403, "Portable route unauthorized");
	const [, namespace, tool] = PORTABLE_CALLABLE.exec(input.callable)!;
	const code = `async () => await ${namespace}.${tool}(${JSON.stringify(args)})`;
	try {
		const result = await mcpCall(
			`${tenantSlug}-unified`,
			"tools/call",
			{ name: "code", arguments: { code } },
			credentialHeadersFrom(request, serviceIdentity),
			fetchImpl,
		);
		return Response.json(
			{ result },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		if (error instanceof McpProxyError)
			return fail(
				error.status === 401 || error.status === 403 ? error.status : 502,
				error.message,
			);
		relayLogger.error("Portable WebMCP relay failed", {
			event: "webmcp.portable_relay.failed",
			failure: contentFreeProxyException(error),
		});
		return fail(502, "Portable tool unavailable");
	}
}

type WebMcpRelayOutcome =
	| "ok"
	| "rpc_error"
	| "unauthorized"
	| "upstream_error";

interface JsonRpcRequest {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

function rpcResponse(
	id: unknown,
	body: { result?: unknown; error?: { code: number; message: string } },
	status = 200,
): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...body }),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		},
	);
}

function rpcError(
	id: unknown,
	code: number,
	message: string,
	status = 200,
): Response {
	return rpcResponse(id, { error: { code, message } }, status);
}

/**
 * POST /mcp with one JSON-RPC request per body.
 *
 * `initialize`, `notifications/*`, and `ping` are answered locally for the
 * supported legacy adapter version; the {@link RELAYED_METHODS} tool, skill,
 * and resource methods relay to the resolved Tedix MCP app with the caller's
 * own credentials. The caller is
 * authenticated by the worker before this handler runs — an unauthenticated
 * request never reaches it.
 */
export async function handleWebMcpEndpoint(
	request: Request,
	url: URL,
	tenantSlug: string,
	fetchImpl: WidgetProxyFetch = fetch,
	serviceIdentity?: WidgetServiceIdentity,
): Promise<Response> {
	if (request.method !== "POST") {
		return rpcError(null, -32600, "The MCP endpoint accepts POST only.", 405);
	}
	const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
	if (contentType.split(";", 1)[0]?.trim() !== "application/json") {
		return rpcError(
			null,
			-32600,
			"Content-Type must be application/json.",
			415,
		);
	}
	// Same-origin: a cross-site page must not ride the session cookie into the
	// relay. Absent Origin is acceptable (non-browser callers); a mismatch not.
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return rpcError(null, -32600, "Cross-origin MCP calls are refused.", 403);
	}
	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (declaredLength > MAX_BODY_BYTES) {
		return rpcError(null, -32600, "Request body is too large.", 413);
	}
	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await request.arrayBuffer();
	} catch {
		return rpcError(null, -32700, "Unreadable request body.", 400);
	}
	if (bodyBytes.byteLength > MAX_BODY_BYTES) {
		return rpcError(null, -32600, "Request body is too large.", 413);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
	} catch {
		return rpcError(null, -32700, "Request body must be JSON.", 400);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return rpcError(
			null,
			-32600,
			Array.isArray(parsed)
				? "Batch requests are not supported."
				: "A JSON-RPC request object is required.",
			400,
		);
	}
	const rpc = parsed as JsonRpcRequest;
	const id = rpc.id;
	if (rpc.jsonrpc !== "2.0") {
		return rpcError(id, -32600, 'jsonrpc must be exactly "2.0".', 400);
	}
	if (
		id !== undefined &&
		id !== null &&
		typeof id !== "string" &&
		typeof id !== "number"
	) {
		return rpcError(
			null,
			-32600,
			"JSON-RPC id must be a string or number.",
			400,
		);
	}
	const method = typeof rpc.method === "string" ? rpc.method : "";
	if (!method) {
		return rpcError(id, -32600, "A JSON-RPC method is required.", 400);
	}
	if (
		rpc.params !== undefined &&
		(rpc.params === null ||
			typeof rpc.params !== "object" ||
			Array.isArray(rpc.params))
	) {
		return rpcError(id, -32602, "MCP params must be an object.", 400);
	}

	// Client lifecycle, answered locally: the Tedix modern edge rejects
	// `initialize`, and the bridge needs no upstream state to boot.
	if (method === "initialize") {
		return rpcResponse(id, {
			result: {
				protocolVersion: LEGACY_INITIALIZE_PROTOCOL_VERSION,
				capabilities: {
					tools: {},
					resources: {},
					extensions: { [MCP_SKILLS_EXTENSION]: {} },
				},
				serverInfo: { name: "tedix-os-webmcp", version: "1.0.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) {
		return new Response(null, {
			status: 202,
			headers: { "Cache-Control": "private, no-store" },
		});
	}
	if (method === "ping") {
		return rpcResponse(id, { result: {} });
	}
	if (!RELAYED_METHODS.has(method)) {
		return rpcError(id, -32601, "Method is not available on this endpoint.");
	}

	const appSlug = url.searchParams.get("app") ?? `${tenantSlug}-unified`;
	if (!APP_SLUG_PATTERN.test(appSlug)) {
		return rpcError(id, -32602, "Invalid app slug.", 400);
	}
	const params =
		rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
			? (rpc.params as Record<string, unknown>)
			: {};
	// Bounded invocation telemetry: one structured line per relayed request —
	// method, tool name, app, outcome class, wall time, HTTP status. NEVER
	// params, results, or user content. Workers observability ingests the
	// line (`invocation_logs`, head sampling 1), so `webmcp.relay` is
	// directly queryable.
	const startedAt = Date.now();
	const toolName =
		method === "tools/call" && typeof params.name === "string"
			? params.name.slice(0, RELAY_LOG_TOOL_NAME_MAX_CHARS)
			: undefined;
	const logRelay = (outcome: WebMcpRelayOutcome, status: number): void => {
		console.log(WEBMCP_RELAY_LOG_EVENT, {
			method,
			...(toolName !== undefined && { tool: toolName }),
			app: appSlug,
			outcome,
			durationMs: Date.now() - startedAt,
			status,
		});
	};
	try {
		const result = await mcpCall(
			appSlug,
			method,
			params,
			credentialHeadersFrom(request, serviceIdentity),
			fetchImpl,
		);
		logRelay("ok", 200);
		return rpcResponse(id, { result });
	} catch (error) {
		if (error instanceof McpProxyError) {
			const status =
				error.status === 401 || error.status === 403 ? error.status : 502;
			logRelay(
				status === 401 || status === 403
					? "unauthorized"
					: error.rpcError
						? "rpc_error"
						: "upstream_error",
				status,
			);
			return rpcError(
				id,
				error.rpcError?.code ?? -32000,
				error.message,
				status,
			);
		}
		relayLogger.error("WebMCP endpoint upstream failed", {
			event: "webmcp.endpoint.upstream_failed",
			failure: contentFreeProxyException(error),
		});
		logRelay("upstream_error", 502);
		return rpcError(id, -32000, "Upstream MCP host is unreachable.", 502);
	}
}
