import { extractTokenFromCookie } from "@tedix/auth/utils";
import { DESCOPE_SESSION_COOKIE } from "@tedix/auth/web";
import { buildSurfaceUrl } from "@tedix/tenant-directory";
import {
	bindModernMcpRequest,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import {
	createLogger,
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

/**
 * Governed widget proxy for the MCP Apps host bridge.
 *
 * Widget iframes never receive raw bearer tokens (docs/engineering/mcp/apps.md, "Host
 * Bridge and Token Handling"). The SPA calls these same-origin endpoints on
 * the OS worker; the worker forwards the caller's OWN credentials to
 * Tedix-managed MCP hosts over public HTTPS, restricted to
 * `https://{appSlug}.mcp.tedix.dev/mcp` targets and a fixed allowlist of
 * guest operations. Browser sessions arrive as the canonical `DS` cookie;
 * because the MCP transport accepts bearer/API-key auth rather than browser
 * cookies, the proxy promotes that exact session JWT to `Authorization` for
 * the upstream request. It never mints or substitutes another identity.
 */

/** Only Tedix-managed tenant app slugs are valid proxy targets. */
const APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const MCP_CLIENT_NAME = "tedix-os-widget-proxy";

/** Guest operations a widget may relay (docs/engineering/mcp/apps.md). Nothing else. */
const ALLOWED_WIDGET_METHODS: ReadonlySet<string> = new Set([
	"tools/call",
	"resources/list",
	"resources/templates/list",
	"resources/read",
	"prompts/list",
	"tasks/get",
	"tasks/update",
	"tasks/cancel",
]);

/** Widget MCP relay bodies are small JSON-RPC params; refuse anything larger. */
const MAX_MCP_BODY_BYTES = 256 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const MCP_REQUEST_DEADLINE_MS = 15_000;

type ContentFreeException = {
	name: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
};

const safeExceptionNames = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"DOMException",
	"NullThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
	"stringThrown",
	"numberThrown",
	"booleanThrown",
	"undefinedThrown",
]);

/** Upstream exceptions can contain request URIs, arguments, or bearer values. */
export function contentFreeProxyException(
	error: unknown,
): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: safeExceptionNames.has(exception.type) ? exception.type : "Error",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(redact) }),
	});
	return redact(serializeException(error));
}

const widgetProxyLogger = createLogger<{ failure: ContentFreeException }>({
	component: "os.widget.proxy",
});

/**
 * Same-zone trap: a public fetch from this worker to *.mcp.tedix.dev routes
 * to the zone's DNS origin (a dummy AAAA), not the MCP worker — 522. Deployed
 * callers must pass a service-binding fetch; the global default exists for
 * tests and the local lane.
 */
export type WidgetProxyFetch = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

/** Verified caller identity forwarded only across the MCP service binding. */
export interface WidgetServiceIdentity {
	sessionToken: string;
	tenantId: string;
	/** Explicit tenant-scoped capabilities resolved by apps/api for WebMCP. */
	browserMcpScopes?: readonly string[];
}

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** Typed upstream failure carrying the HTTP status and any JSON-RPC error. */
export class McpProxyError extends Error {
	readonly status: number;
	readonly rpcError?: JsonRpcError;

	constructor(message: string, status: number, rpcError?: JsonRpcError) {
		super(message);
		this.name = "McpProxyError";
		this.status = status;
		this.rpcError = rpcError;
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "private, no-store",
		},
	});
}

function errorResponse(status: number, message: string): Response {
	return jsonResponse({ error: { message } }, status);
}

/** The caller's own credentials, and nothing else. */
export function credentialHeadersFrom(
	request: Request,
	serviceIdentity?: WidgetServiceIdentity,
): Record<string, string> {
	if (serviceIdentity) {
		return {
			Authorization: `Bearer ${serviceIdentity.sessionToken}`,
			"X-Service-Binding": "true",
			"X-Tedix-Browser-Bridge": "true",
			"X-Tedix-Tenant-Id": serviceIdentity.tenantId,
			...(serviceIdentity.browserMcpScopes?.length
				? {
						"X-Tedix-Browser-Scopes":
							serviceIdentity.browserMcpScopes.join(" "),
					}
				: {}),
		};
	}
	const headers: Record<string, string> = {};
	const authorization = request.headers.get("Authorization");
	const cookie = request.headers.get("Cookie");
	const browserSession = extractTokenFromCookie(cookie, DESCOPE_SESSION_COOKIE);
	if (authorization) headers.Authorization = authorization;
	else if (browserSession) headers.Authorization = `Bearer ${browserSession}`;
	if (cookie) headers.Cookie = cookie;
	return headers;
}

/**
 * Parse a Streamable HTTP response body: plain JSON, or SSE-framed
 * (`data: {json}` lines) when the server answers with `text/event-stream`.
 * Returns the JSON-RPC response envelope for the request id.
 */
function parseStreamableBody(
	contentType: string,
	text: string,
): Record<string, unknown> {
	if (contentType.includes("text/event-stream")) {
		// Each SSE event carries one JSON-RPC message in its data line(s).
		// The response to our request is the message bearing a `result` or
		// `error` member (notifications/progress frames carry neither).
		for (const rawLine of text.split(/\r?\n/)) {
			if (!rawLine.startsWith("data:")) continue;
			const payload = rawLine.slice(5).trim();
			if (!payload) continue;
			let message: unknown;
			try {
				message = JSON.parse(payload);
			} catch {
				continue;
			}
			if (
				message &&
				typeof message === "object" &&
				("result" in message || "error" in message)
			) {
				return message as Record<string, unknown>;
			}
		}
		throw new McpProxyError(
			"Upstream event stream carried no JSON-RPC response.",
			502,
		);
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to the typed error below.
	}
	throw new McpProxyError("Upstream returned an unparseable body.", 502);
}

async function postJsonRpc(
	endpoint: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	fetchImpl: WidgetProxyFetch,
): Promise<{ response: Response; text: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MCP_REQUEST_DEADLINE_MS);
	try {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const declaredLength = Number(
			response.headers.get("Content-Length") ?? "0",
		);
		if (declaredLength > MAX_MCP_RESPONSE_BYTES) {
			throw new McpProxyError("Upstream MCP response is too large.", 502);
		}
		const text = await readResponseTextBounded(response);
		if (!response.ok) {
			let rpcError: JsonRpcError | undefined;
			try {
				const parsed = JSON.parse(text) as { error?: JsonRpcError };
				rpcError = parsed?.error;
			} catch {
				// Non-JSON upstream error body; the status alone is the signal.
			}
			throw new McpProxyError(
				rpcError?.message ?? `Upstream MCP host answered ${response.status}.`,
				response.status,
				rpcError,
			);
		}
		return { response, text };
	} catch (error) {
		if (controller.signal.aborted) {
			throw new McpProxyError("Upstream MCP request timed out.", 504);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function rpcResultOrThrow(envelope: Record<string, unknown>): unknown {
	const error = envelope.error as JsonRpcError | undefined;
	if (error) {
		// A JSON-RPC-level error rode a 2xx transport; surface it as a bad
		// upstream answer rather than inventing a client status.
		throw new McpProxyError(error.message ?? "MCP error", 502, error);
	}
	return envelope.result;
}

async function readResponseTextBounded(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_MCP_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {});
			throw new McpProxyError("Upstream MCP response is too large.", 502);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * One stateless MCP 2026 request cycle against a Tedix-managed host:
 * discover the current protocol, then issue the actual method with the caller's
 * own credential headers riding both requests. No legacy initialize or session
 * negotiation is accepted. Returns the JSON-RPC result or throws
 * {@link McpProxyError} with the upstream HTTP status and JSON-RPC error.
 *
 * This is a raw relay, not an SDK `Client`: the widget bridge declares MCP
 * Tasks and must receive `resultType: "task"` results and `tasks/*` answers
 * verbatim, which the SDK client rejects or rewrites.
 */
export async function mcpCall(
	appSlug: string,
	method: string,
	params: Record<string, unknown>,
	credentialHeaders: Record<string, string>,
	fetchImpl: WidgetProxyFetch = fetch,
): Promise<unknown> {
	const endpoint = buildSurfaceUrl("mcp", appSlug, { path: "endpoint" })!;
	const baseHeaders: Record<string, string> = {
		...credentialHeaders,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const clientCapabilities = {
		extensions: { [MCP_TASKS_EXTENSION]: {} },
	};
	const discoveryRequest = bindModernMcpRequest(
		"server/discover",
		{},
		{
			clientName: MCP_CLIENT_NAME,
			clientCapabilities,
		},
	);
	const discovery = await postJsonRpc(
		endpoint,
		{ ...baseHeaders, ...discoveryRequest.headers },
		{
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: discoveryRequest.params,
		},
		fetchImpl,
	);
	const discoveryResult = rpcResultOrThrow(
		parseStreamableBody(
			discovery.response.headers.get("Content-Type") ?? "",
			discovery.text,
		),
	) as { supportedVersions?: unknown } | undefined;
	if (
		!Array.isArray(discoveryResult?.supportedVersions) ||
		!discoveryResult.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)
	) {
		throw new McpProxyError(
			`Tedix-managed MCP host does not advertise required protocol ${MCP_MODERN_PROTOCOL_VERSION}.`,
			502,
		);
	}

	const modernRequest = bindModernMcpRequest(method, params, {
		clientName: MCP_CLIENT_NAME,
		clientCapabilities,
	});
	const call = await postJsonRpc(
		endpoint,
		{
			...baseHeaders,
			...modernRequest.headers,
		},
		{ jsonrpc: "2.0", id: 2, method, params: modernRequest.params },
		fetchImpl,
	);
	return rpcResultOrThrow(
		parseStreamableBody(
			call.response.headers.get("Content-Type") ?? "",
			call.text,
		),
	);
}

function upstreamFailureResponse(error: unknown): Response {
	if (error instanceof McpProxyError) {
		// Auth outcomes belong to the caller; everything else is a bad gateway.
		const status =
			error.status === 401 || error.status === 403 || error.status === 504
				? error.status
				: 502;
		return jsonResponse(
			{ error: { message: error.message, rpc: error.rpcError } },
			status,
		);
	}
	widgetProxyLogger.error("Widget proxy upstream failed", {
		event: "widget.proxy.upstream_failed",
		failure: contentFreeProxyException(error),
	});
	return errorResponse(502, "Upstream MCP host is unreachable.");
}

/**
 * GET /widgets/resource?app={appSlug}&uri={ui://...}
 *
 * Fetches a widget's `ui://` resource from the app's MCP host with the
 * caller's own session and returns the `resources/read` content JSON
 * `{ contents: [{ uri, mimeType, text, _meta }] }` — `_meta` preserved,
 * because the MCP Apps CSP rides in `_meta.ui.csp` (docs/engineering/mcp/apps.md).
 */
export async function handleWidgetResource(
	request: Request,
	url: URL,
	fetchImpl: WidgetProxyFetch = fetch,
	serviceIdentity?: WidgetServiceIdentity,
): Promise<Response> {
	if (request.method !== "GET") {
		return errorResponse(405, "Widget resources are fetched with GET.");
	}
	const appSlug = url.searchParams.get("app") ?? "";
	const uri = url.searchParams.get("uri") ?? "";
	if (!APP_SLUG_PATTERN.test(appSlug)) {
		return errorResponse(400, "Invalid app slug.");
	}
	if (!uri.startsWith("ui://")) {
		return errorResponse(400, "Widget resources use ui:// URIs.");
	}
	try {
		const result = await mcpCall(
			appSlug,
			"resources/read",
			{ uri },
			credentialHeadersFrom(request, serviceIdentity),
			fetchImpl,
		);
		return jsonResponse(result);
	} catch (error) {
		return upstreamFailureResponse(error);
	}
}

/**
 * POST /widgets/mcp with `{ app, method, params }`.
 *
 * Relays a widget-originated MCP call through the caller's own session:
 * same-origin only, Tedix-managed targets only, and only the allowlisted
 * guest operations (docs/engineering/mcp/apps.md).
 */
export async function handleWidgetMcp(
	request: Request,
	url: URL,
	fetchImpl: WidgetProxyFetch = fetch,
	serviceIdentity?: WidgetServiceIdentity,
): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "Widget MCP relay accepts POST only.");
	}
	// Same-origin: a cross-site page must not ride the session cookie into
	// the relay. Absent Origin (same-origin GET-less fetches, non-browser
	// callers) is acceptable; a present mismatch is not.
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return errorResponse(403, "Cross-origin widget MCP calls are refused.");
	}
	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (declaredLength > MAX_MCP_BODY_BYTES) {
		return errorResponse(413, "Widget MCP request body is too large.");
	}
	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await request.arrayBuffer();
	} catch {
		return errorResponse(400, "Unreadable request body.");
	}
	if (bodyBytes.byteLength > MAX_MCP_BODY_BYTES) {
		return errorResponse(413, "Widget MCP request body is too large.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
	} catch {
		return errorResponse(400, "Request body must be JSON.");
	}
	const body = parsed as {
		app?: unknown;
		method?: unknown;
		params?: unknown;
	} | null;
	const appSlug = typeof body?.app === "string" ? body.app : "";
	if (!APP_SLUG_PATTERN.test(appSlug)) {
		return errorResponse(400, "Invalid app slug.");
	}
	const method = typeof body?.method === "string" ? body.method : "";
	if (!ALLOWED_WIDGET_METHODS.has(method)) {
		return errorResponse(
			403,
			"Method is not allowed through the widget bridge.",
		);
	}
	const params =
		body?.params &&
		typeof body.params === "object" &&
		!Array.isArray(body.params)
			? (body.params as Record<string, unknown>)
			: {};
	try {
		const result = await mcpCall(
			appSlug,
			method,
			params,
			credentialHeadersFrom(request, serviceIdentity),
			fetchImpl,
		);
		return jsonResponse(result);
	} catch (error) {
		return upstreamFailureResponse(error);
	}
}
