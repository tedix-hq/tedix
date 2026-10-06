/**
 * @tedix/mcp — Web-native stateless MCP transport
 *
 * `mountMcp()` dispatches between TWO engines on the SHAPE of the mount
 * options (a structural decision fixed at each call site, not a flag):
 *
 * - **Simple mounts** — callers that configure none of Tedix's non-spec
 *   extensions (see {@link requiresLegacyMcpTransport}) — are served by the
 *   official SDK's `createMcpHandler` engine (`legacy: 'stateless'`,
 *   `responseMode: 'auto'`). The SDK owns era classification, the SEP-2243
 *   header ladder, inbound `Mcp-Param-*` validation, MRTR, and SSE promotion
 *   on mid-call notifications.
 * - **Extension mounts** — anything configuring `taskHandlers`,
 *   `completionHandler`, `directoryReadHandler`, `resultTransform`,
 *   `cacheHints`, `requiredClientExtensions`, or an explicit
 *   `toolSchemaLookup` — use the hand-rolled {@link StatelessMcpTransport}
 *   below (the SDK Transport-interface shim Tedix owns). Related mid-call
 *   notifications promote only their originating POST to request-scoped SSE.
 *
 * The hand-rolled engine is STATELESS. It does not implement:
 * - Session IDs / `mcp-session-id` header / session validation
 * - Event store / SSE replay / `Last-Event-ID` resumption
 * - Server-initiated notifications on a standalone SSE stream
 * - Persistent state (storage)
 *
 * If any of those are needed in the future, expand the transport — do NOT
 * reach for `agents/mcp::WorkerTransport` again. Keep the primitive ours.
 *
 * Wire protocol parity is asserted in `apps/mcp/src/mcp/transport.test.ts`.
 */
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import type {
	JSONRPCMessage,
	JSONRPCRequest,
	MessageExtraInfo,
	McpServer as SdkMcpServer,
	Transport,
	TransportSendOptions,
} from "@modelcontextprotocol/server";
import {
	createMcpHandler,
	isInitializeRequest,
	isJSONRPCErrorResponse,
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	isJsonContentType,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import {
	decodeMcpHeaderValue,
	validateInboundMcpParamHeaders,
} from "./mcp-param-headers";
import { toPaymentRequiredErrorMessage } from "./payment";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_NAME_IF_PRESENT_METHODS,
	MCP_NAME_REQUIRED_METHODS,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_SERVER_INFO_META_KEY,
	MCP_TASK_METHOD_SET,
	MCP_TASKS_EXTENSION,
	MCP_MODERN_PROTOCOL_VERSION as MODERN_PROTOCOL_VERSION,
	mcpRequestTargetName,
} from "./protocol";
import {
	clientSupportsTasks,
	McpTaskError,
	type McpTaskHandlers,
} from "./tasks";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** 2026-07-28 autocomplete method (`completions` capability). */
const COMPLETION_METHOD = "completion/complete";
const DIRECTORY_READ_METHOD = "resources/directory/read";
/** Max suggestions a `completion/complete` result may carry (spec cap). */
const COMPLETION_MAX_VALUES = 100;
/**
 * 2026-07-28 long-lived subscription stream (replaces HTTP GET +
 * `resources/subscribe`). Our transport is deliberately stateless, so this is
 * rejected rather than served — see {@link StatelessMcpTransport.handleSubscriptionsListen}.
 */
const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const TEDIX_INPUT_RESPONSES_META_KEY = "tedix/inputResponses";

/**
 * Spec error codes from the finalized 2026-07-28 schema + Streamable HTTP transport.
 * These live in the MCP-reserved server-error range; do not reuse legacy draft
 * values (-32001/-32003/-32004) for modern transport rejections.
 */
const ERR_HEADER_MISMATCH = -32_020;
const ERR_MISSING_REQUIRED_CLIENT_CAPABILITY = -32_021;
const ERR_UNSUPPORTED_PROTOCOL_VERSION = -32_022;
/** Match the official TypeScript SDK HTTP-entry default (2.2.0). */
const MAX_MCP_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Bounded read for the hand-rolled transport path. Simple mounts delegate body
 * parsing to the official SDK; extension-shaped mounts must enforce the same
 * 4 MiB ceiling before JSON parsing or dispatch.
 */
async function readBoundedRequestBody(
	request: Pick<Request, "headers" | "body">,
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
	if (
		Number(request.headers.get("content-length")) > MAX_MCP_REQUEST_BODY_BYTES
	) {
		return { tooLarge: true };
	}
	if (!request.body) return { tooLarge: false, text: "" };
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > MAX_MCP_REQUEST_BODY_BYTES) return { tooLarge: true };
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return { tooLarge: false, text: text + decoder.decode() };
}

/** Fail-closed current-spec gate for Tedix-owned MCP POST surfaces. External
 * upstream adapters remain dual-era and deliberately do not call this helper. */
export function enforceModernMcpProtocol(request: Request): Response | null {
	if (request.method !== "POST") return null;
	if (
		request.headers.get(MCP_PROTOCOL_VERSION_HEADER)?.trim() ===
		MODERN_PROTOCOL_VERSION
	)
		return null;
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: ERR_UNSUPPORTED_PROTOCOL_VERSION,
				message: `Unsupported MCP protocol version: Tedix requires ${MODERN_PROTOCOL_VERSION}`,
			},
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Response-inactivity backstop for a dispatched request. Slow handlers can
 * outlive it; expiry does not cancel execution or establish its outcome.
 * Request-related notifications renew this timer. Overridable for tests.
 */
const UNANSWERED_REQUEST_TIMEOUT_MS = 45_000;

const CACHEABLE_MCP_METHODS = new Set([
	"server/discover",
	"tools/list",
	"prompts/list",
	"resources/list",
	"resources/templates/list",
	"resources/read",
	DIRECTORY_READ_METHOD,
	// SEP-2640: both discovery methods carry CacheableResult attributes.
	"skills/list",
	"skills/get",
]);

function firstInputResponseContent(
	inputResponses: Record<string, unknown>,
): Record<string, unknown> | undefined {
	for (const response of Object.values(inputResponses)) {
		if (!isRecord(response)) continue;
		if (isRecord(response.content)) return response.content;
		return response;
	}
	return undefined;
}

// =============================================================================
// CORS
// =============================================================================

export interface CorsOptions {
	origin?: string;
	headers?: string;
	methods?: string;
	exposeHeaders?: string;
	maxAge?: number;
}

// Wildcard default with X-API-Key in the header list: intentionally broader
// than @tedix/worker-kit/cors (origin allowlist, MCP_CORS_HEADERS).
const DEFAULT_CORS: Required<CorsOptions> = {
	origin: "*",
	headers:
		"Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-API-Key",
	methods: "GET, POST, DELETE, OPTIONS",
	exposeHeaders: "",
	maxAge: 86_400,
};

function corsHeaders(
	opts: CorsOptions | undefined,
	forPreflight: boolean,
): Record<string, string> {
	const c = { ...DEFAULT_CORS, ...opts };
	if (forPreflight) {
		return {
			"Access-Control-Allow-Origin": c.origin,
			"Access-Control-Allow-Headers": c.headers,
			"Access-Control-Allow-Methods": c.methods,
			"Access-Control-Max-Age": String(c.maxAge),
		};
	}
	return {
		"Access-Control-Allow-Origin": c.origin,
		"Access-Control-Expose-Headers": c.exposeHeaders,
	};
}

// =============================================================================
// JSON-RPC ERROR ENVELOPES
// =============================================================================

const JSONRPC_ERROR_HEADERS = (cors: CorsOptions | undefined): HeadersInit => ({
	"Content-Type": "application/json",
	...corsHeaders(cors, false),
});

function rpcError(
	status: number,
	code: number,
	message: string,
	cors: CorsOptions | undefined,
	data?: Record<string, unknown>,
	id: string | number | null = null,
): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code, message, ...(data ? { data } : {}) },
			id,
		}),
		{ status, headers: JSONRPC_ERROR_HEADERS(cors) },
	);
}

function requestBodyTooLargeResponse(cors: CorsOptions | undefined): Response {
	return rpcError(
		413,
		-32_000,
		`Payload Too Large: Request body must not exceed ${MAX_MCP_REQUEST_BODY_BYTES} bytes`,
		cors,
	);
}

// =============================================================================
// MODERN (2026-07-28) REQUEST-BINDING HEADER LADDER (SEP-2243)
// =============================================================================

export interface ModernProtocolHeaderViolation {
	code: number;
	message: string;
	data?: Record<string, unknown>;
}

export interface ModernProtocolHeaderCheckInput {
	headers: Pick<Headers, "get">;
	method: string;
	params?: Record<string, unknown>;
	/**
	 * Client extensions (`_meta.clientCapabilities.extensions`) a modern
	 * request MUST declare, e.g. `mountMcp()`'s `requiredClientExtensions`.
	 */
	requiredClientExtensions?: string[];
}

/**
 * Canonical SEP-2243 header-validation ladder for MCP `2026-07-28` request
 * binding. Framework-agnostic and Response-agnostic on purpose: it is shared
 * by {@link StatelessMcpTransport.validateModernRequest} (which validates a
 * parsed SDK `JSONRPCRequest` bound for `mountMcp()`'s McpServer dispatch)
 * and by any fast-path caller that validates a modern request BEFORE
 * `mountMcp()` ever runs — e.g. `apps/mcp/src/index.ts`'s
 * `subscriptions/listen` handling, which is a stateful Durable Object surface
 * outside this stateless transport (see {@link StatelessMcpTransport.handleSubscriptionsListen}).
 * Each caller builds its own JSON-RPC error `Response` from the returned
 * violation, since callers differ in envelope shape (this transport's bare
 * JSON-RPC error vs. a fast path that may need to preserve a single-item
 * batch wrapper).
 *
 * Enforcement is a no-op unless the caller declares the modern revision via
 * `MCP-Protocol-Version`; legacy and unscoped requests pass through
 * untouched. Every modern request, including `server/discover`, binds
 * `Mcp-Method`; `Mcp-Name` remains limited to methods with a named target.
 */
export function validateModernProtocolHeaders(
	input: ModernProtocolHeaderCheckInput,
): ModernProtocolHeaderViolation | null {
	const { headers, method, params = {}, requiredClientExtensions = [] } = input;

	if (
		headers.get(MCP_PROTOCOL_VERSION_HEADER)?.trim() !== MODERN_PROTOCOL_VERSION
	) {
		return null;
	}

	// Removed-method parity (conformance `server-stateless`): `initialize` is
	// gone in 2026-07-28 and must answer method-not-found (`-32601`, HTTP 404)
	// exactly like every other removed 2025 method (ping, logging/setLevel,
	// resources/subscribe, ...), not Invalid Request.
	if (method === "initialize") {
		return {
			code: -32_601,
			message:
				"Method not found: the initialize handshake is removed in MCP 2026-07-28; use server/discover",
		};
	}

	const isDiscover = method === "server/discover";
	const methodHeader = headers.get(MCP_METHOD_HEADER)?.trim() ?? null;
	if (methodHeader !== method) {
		return {
			code: ERR_HEADER_MISMATCH,
			message: "Header mismatch: Mcp-Method must equal the request method",
			data: {
				header: MCP_METHOD_HEADER,
				expected: method,
				received: methodHeader,
			},
		};
	}

	if (!isDiscover && MCP_NAME_REQUIRED_METHODS.has(method)) {
		const rawNameHeader = headers.get(MCP_NAME_HEADER);
		const nameHeader = rawNameHeader?.trim() ?? null;
		// SEP-2663-Final vs current SDK v2 core transport: it never sends
		// Mcp-Name for tasks/* or resources/directory/read, so those methods are
		// validate-only-if-present (see MCP_NAME_IF_PRESENT_METHODS). Tedix keeps
		// sending the header outbound for all name-bound methods.
		if (nameHeader !== null || !MCP_NAME_IF_PRESENT_METHODS.has(method)) {
			const target = mcpRequestTargetName(method, params);
			// The spec requires decoding the `=?base64?…?=` sentinel form before
			// the header ↔ body comparison.
			const decoded =
				nameHeader === null ? null : decodeMcpHeaderValue(nameHeader);
			if (typeof target !== "string" || decoded !== target) {
				return {
					code: ERR_HEADER_MISMATCH,
					message: "Header mismatch: Mcp-Name must equal the request target",
					data: {
						header: MCP_NAME_HEADER,
						expected: typeof target === "string" ? target : null,
						received: rawNameHeader,
					},
				};
			}
		}
	}

	// Missing `_meta` envelope fields are Invalid Params (`-32602`, HTTP 400)
	// per the conformance checks and SDK v2's `createMcpHandler`; a
	// present-but-different `_meta` protocol version is a header ↔ body
	// disagreement and stays HeaderMismatch (`-32020`).
	const meta = isRecord(params._meta) ? params._meta : null;
	const metaVersion = meta?.[MCP_PROTOCOL_VERSION_META_KEY];
	if (metaVersion !== MODERN_PROTOCOL_VERSION) {
		if (typeof metaVersion === "string") {
			return {
				code: ERR_HEADER_MISMATCH,
				message:
					"Header mismatch: MCP-Protocol-Version must equal the request _meta protocol version",
				data: {
					header: MCP_PROTOCOL_VERSION_HEADER,
					expected: MODERN_PROTOCOL_VERSION,
					received: metaVersion,
				},
			};
		}
		return {
			code: -32_602,
			message:
				"Invalid params: request _meta must carry io.modelcontextprotocol/protocolVersion=2026-07-28",
			data: { field: "_meta.io.modelcontextprotocol/protocolVersion" },
		};
	}
	// The 2026-07-28 wire makes clientInfo optional. clientCapabilities remains required on
	// every modern request, including server/discover. (`meta` is non-null here
	// — a null `meta` already failed the protocol-version gate above — but TS
	// cannot narrow through the string comparison.)
	const clientCapabilities = meta?.[MCP_CLIENT_CAPABILITIES_META_KEY];
	if (!isRecord(clientCapabilities)) {
		return {
			code: -32_602,
			message:
				"Invalid params: request _meta must carry io.modelcontextprotocol/clientCapabilities",
			data: { field: "_meta.io.modelcontextprotocol/clientCapabilities" },
		};
	}

	// 2026-07-28 `-32021`: if the caller declares required client extensions,
	// every modern request must advertise them under
	// `clientCapabilities.extensions`. `server/discover` must carry the client
	// capabilities object but is exempt from server-required extensions because
	// discovery is how the client learns which extensions are required.
	if (!isDiscover && requiredClientExtensions.length > 0) {
		const extensions = isRecord(clientCapabilities.extensions)
			? clientCapabilities.extensions
			: {};
		const missing = requiredClientExtensions.filter(
			(ext) => !(ext in extensions),
		);
		if (missing.length > 0) {
			// `data.requiredCapabilities` is a ClientCapabilities OBJECT per the
			// spec schema — the current SDK v2 error parser rejects an array shape.
			return {
				code: ERR_MISSING_REQUIRED_CLIENT_CAPABILITY,
				message: "Missing required client capability",
				data: {
					requiredCapabilities: {
						extensions: Object.fromEntries(missing.map((ext) => [ext, {}])),
					},
				},
			};
		}
	}
	return null;
}

// =============================================================================
// TRANSPORT
// =============================================================================

export interface McpResultCacheHint {
	ttlMs: number;
	cacheScope: "private" | "public";
}

export const DEFAULT_MCP_CACHE_HINT: McpResultCacheHint = {
	ttlMs: 60_000,
	cacheScope: "private",
};

/**
 * SEP-2549 result-level hint marker. A handler that wants a per-RESULT
 * `ttlMs`/`cacheScope` different from the per-method default attaches a
 * (partial) {@link McpResultCacheHint} under `_meta["tedix/cacheHint"]`.
 * `decorateResponse` consumes (strips) the marker and emits its valid fields
 * in place of the method hint's, per field.
 *
 * The marker rides `_meta` rather than top-level result fields because the
 * SDK's 2026-07-28 encode seam zero-fills `ttlMs`/`cacheScope` on cacheable
 * results before this transport sees them — a top-level field cannot
 * distinguish a handler-authored value from that fill.
 */
export const MCP_RESULT_CACHE_HINT_META_KEY = "tedix/cacheHint";

/** Parsed, validated fields of a `tedix/cacheHint` marker (invalid fields dropped). */
function parseResultCacheHintMarker(
	raw: unknown,
): Partial<McpResultCacheHint> | undefined {
	if (!isRecord(raw)) return undefined;
	const hint: Partial<McpResultCacheHint> = {};
	if (
		typeof raw.ttlMs === "number" &&
		Number.isInteger(raw.ttlMs) &&
		raw.ttlMs >= 0
	) {
		hint.ttlMs = raw.ttlMs;
	}
	if (raw.cacheScope === "public" || raw.cacheScope === "private") {
		hint.cacheScope = raw.cacheScope;
	}
	return hint.ttlMs !== undefined || hint.cacheScope !== undefined
		? hint
		: undefined;
}

export interface McpDiscoverOptions {
	serverInfo?: { name: string; version: string };
	capabilities?: Record<string, unknown>;
	instructions?: string;
	supportedVersions?: string[];
}

export type McpResultTransform = (input: {
	request: JSONRPCRequest;
	response: JSONRPCMessage;
}) => JSONRPCMessage;

/**
 * 2026-07-28 `completion/complete` (autocomplete). The server resolves
 * suggestions for a prompt-argument or resource-URI-template variable.
 */
export type McpCompletionRef =
	| {
			type: "ref/prompt";
			name: string;
	  }
	| {
			type: "ref/resource";
			uri: string;
	  };

export interface McpCompletionRequest {
	ref: McpCompletionRef;
	argument: { name: string; value: string };
	/** Prior argument values already resolved in the same completion session. */
	context?: { arguments?: Record<string, string> };
}

export interface McpCompletionResult {
	values: string[];
	total?: number;
	hasMore?: boolean;
}

export type McpCompletionHandler = (
	input: McpCompletionRequest,
) => Promise<McpCompletionResult> | McpCompletionResult;

export interface McpDirectoryReadRequest {
	uri: string;
	cursor?: string;
}

export interface McpDirectoryReadResult {
	resources: Array<Record<string, unknown>>;
	nextCursor?: string;
}

export type McpDirectoryReadHandler = (
	input: McpDirectoryReadRequest,
) => Promise<McpDirectoryReadResult> | McpDirectoryReadResult;

interface TransportOptions {
	cors?: CorsOptions;
	/**
	 * Backstop for a dispatched request the server never answers. Tests inject a
	 * short value; production uses {@link UNANSWERED_REQUEST_TIMEOUT_MS}.
	 */
	unansweredTimeoutMs?: number;
	/** Trusted execution budget for this exact tool; never shortens the default backstop. */
	toolResponseTimeoutMs?: (toolName: string) => number | undefined;
	cacheHints?: Record<string, McpResultCacheHint>;
	discover?: McpDiscoverOptions;
	resultTransform?: McpResultTransform;
	taskHandlers?: McpTaskHandlers;
	/**
	 * 2026-07-28 autocomplete. When mounted, the transport answers
	 * `completion/complete` and advertises the `completions` capability in
	 * `server/discover`.
	 */
	completionHandler?: McpCompletionHandler;
	directoryReadHandler?: McpDirectoryReadHandler;
	/**
	 * 2026-07-28 `-32021`. Client extensions a modern request MUST declare under
	 * `_meta.io.modelcontextprotocol/clientCapabilities.extensions`. A modern
	 * request missing any of these is rejected with
	 * `MissingRequiredClientCapability` (HTTP 400).
	 */
	requiredClientExtensions?: string[];
	/**
	 * SEP-2243 inbound `Mcp-Param-*` validation. Resolves a tool's JSON-Schema
	 * `inputSchema` (`McpServer.toolInputSchemaJson`) so the transport can
	 * cross-check `x-mcp-header`-bound header values against the request body
	 * before dispatch. `mountMcp()` wires this to the connected server; when
	 * absent (no schema source), inbound `Mcp-Param-*` validation is skipped.
	 */
	toolSchemaLookup?: (toolName: string) => Record<string, unknown> | undefined;
}

type PendingExchangeFirstEvent = "notification" | "response";

interface PendingExchange {
	request: JSONRPCRequest;
	resolveFirst: (event: PendingExchangeFirstEvent) => void;
	firstSettled: boolean;
	notifications: JSONRPCMessage[];
	response?: JSONRPCMessage;
	controller?: ReadableStreamDefaultController<Uint8Array>;
	unanswered?: ReturnType<typeof setTimeout>;
}

const SSE_ENCODER = new TextEncoder();

function encodeSseMessage(message: JSONRPCMessage): Uint8Array {
	return SSE_ENCODER.encode(
		`event: message\ndata: ${JSON.stringify(message)}\n\n`,
	);
}

/**
 * Stateless Web-native MCP Streamable HTTP transport.
 *
 * Implements the SDK `Transport` interface in auto-response mode. Ordinary
 * requests resolve as JSON; a request-related notification promotes that POST
 * to SSE and the stream closes after the final JSON-RPC response.
 */
/**
 * Exported for transport-level tests that must construct the transport
 * without an SDK server attached (the never-answered-request guards).
 */
export class StatelessMcpTransport implements Transport {
	// SDK Transport surface
	onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;
	sessionId?: string; // always undefined in stateless mode

	private started = false;
	private readonly cors: CorsOptions | undefined;
	private readonly cacheHints: Record<string, McpResultCacheHint>;
	private readonly unansweredTimeoutMs: number;
	private readonly toolResponseTimeoutMs: TransportOptions["toolResponseTimeoutMs"];
	private readonly discover: McpDiscoverOptions | undefined;
	private readonly resultTransform: McpResultTransform | undefined;
	private readonly taskHandlers: McpTaskHandlers | undefined;
	private readonly completionHandler: McpCompletionHandler | undefined;
	private readonly directoryReadHandler: McpDirectoryReadHandler | undefined;
	private readonly requiredClientExtensions: string[];
	private readonly toolSchemaLookup:
		| ((toolName: string) => Record<string, unknown> | undefined)
		| undefined;
	/** Request id → one live, request-scoped POST exchange. */
	private readonly pending = new Map<string | number, PendingExchange>();

	constructor(options: TransportOptions = {}) {
		this.cors = options.cors;
		this.cacheHints = {
			...Object.fromEntries(
				[...CACHEABLE_MCP_METHODS].map((method) => [
					method,
					DEFAULT_MCP_CACHE_HINT,
				]),
			),
			...options.cacheHints,
		};
		this.discover = options.discover;
		this.unansweredTimeoutMs =
			options.unansweredTimeoutMs ?? UNANSWERED_REQUEST_TIMEOUT_MS;
		this.toolResponseTimeoutMs = options.toolResponseTimeoutMs;
		this.resultTransform = options.resultTransform;
		this.taskHandlers = options.taskHandlers;
		this.completionHandler = options.completionHandler;
		this.directoryReadHandler = options.directoryReadHandler;
		this.requiredClientExtensions = options.requiredClientExtensions ?? [];
		this.toolSchemaLookup = options.toolSchemaLookup;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("Transport already started");
		this.started = true;
	}

	async close(): Promise<void> {
		for (const exchange of this.pending.values()) {
			if (exchange.unanswered) clearTimeout(exchange.unanswered);
			try {
				exchange.controller?.close();
			} catch {
				// The client may already have cancelled the response stream.
			}
		}
		this.pending.clear();
		this.onclose?.();
	}

	/**
	 * Called by the SDK Server when it produces a response/error or a
	 * request-related notification. A related notification promotes that POST
	 * to an SSE response; the stream closes with the final JSON-RPC response.
	 * Notifications without `relatedRequestId` remain standalone and are
	 * dropped because this stateless transport has no independent push channel.
	 */
	async send(
		message: JSONRPCMessage,
		options?: TransportSendOptions,
	): Promise<void> {
		message = toPaymentRequiredErrorMessage(message);
		const id =
			isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)
				? (message as { id: string | number }).id
				: options?.relatedRequestId;
		if (id === undefined) return; // standalone notification, drop
		const exchange = this.pending.get(id);
		if (!exchange) return; // unknown id, drop

		if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
			exchange.response = this.decorateResponse(exchange.request, message);
			if (exchange.unanswered) clearTimeout(exchange.unanswered);
			if (exchange.controller) {
				exchange.controller.enqueue(encodeSseMessage(exchange.response));
				exchange.controller.close();
				this.pending.delete(id);
			}
			this.settleFirst(exchange, "response");
			return;
		}

		// Request-scoped SSE carries notifications, not a bidirectional protocol
		// session. Server-to-client JSON-RPC requests (elicitation/sampling/etc.)
		// remain unsupported here and must use MRTR on modern mounts.
		if (isJSONRPCRequest(message)) return;

		exchange.notifications.push(message);
		this.armUnansweredTimeout(id, exchange);
		this.flushPendingNotifications(exchange);
		this.settleFirst(exchange, "notification");
	}

	private settleFirst(
		exchange: PendingExchange,
		event: PendingExchangeFirstEvent,
	): void {
		if (exchange.firstSettled) return;
		exchange.firstSettled = true;
		exchange.resolveFirst(event);
	}

	private flushPendingNotifications(exchange: PendingExchange): void {
		if (!exchange.controller) return;
		for (const notification of exchange.notifications.splice(0)) {
			exchange.controller.enqueue(encodeSseMessage(notification));
		}
	}

	private armUnansweredTimeout(
		id: string | number,
		exchange: PendingExchange,
	): void {
		if (exchange.unanswered) clearTimeout(exchange.unanswered);
		const params = exchange.request.params;
		const configured =
			exchange.request.method === "tools/call" &&
			isRecord(params) &&
			typeof params.name === "string"
				? this.toolResponseTimeoutMs?.(params.name)
				: undefined;
		const timeoutMs =
			typeof configured === "number" &&
			Number.isFinite(configured) &&
			configured > 0
				? Math.max(this.unansweredTimeoutMs, configured)
				: this.unansweredTimeoutMs;
		exchange.unanswered = setTimeout(() => {
			if (this.pending.get(id) !== exchange) return;
			exchange.response = this.decorateResponse(exchange.request, {
				jsonrpc: "2.0",
				id: exchange.request.id,
				error: {
					code: -32_603,
					message: `Response timed out for ${exchange.request.method}; execution outcome is unknown. Read back state before retrying.`,
					data: {
						reason: "response_timeout",
						timeoutMs,
						executionOutcome: "unknown",
					},
				},
			} as JSONRPCMessage);
			if (exchange.controller) {
				exchange.controller.enqueue(encodeSseMessage(exchange.response));
				exchange.controller.close();
				this.pending.delete(id);
			}
			this.settleFirst(exchange, "response");
		}, timeoutMs);
	}

	// =========================================================================
	// HTTP ENTRYPOINT
	// =========================================================================

	async handleRequest(request: Request): Promise<Response> {
		switch (request.method) {
			case "OPTIONS":
				return new Response(null, {
					status: 200,
					headers: corsHeaders(this.cors, true),
				});
			case "POST":
				return this.handlePost(request);
			case "GET":
				return rpcError(
					405,
					-32_601,
					"Method not found: GET is not supported by Tedix stateless MCP transport",
					this.cors,
				);
			case "DELETE":
				// MCP 2026-07-28 (`basic/transports`): "HTTP GET or DELETE to the MCP
				// endpoint: respond with 405 Method Not Allowed." There is no session
				// to terminate under stateless transport, so DELETE has no meaning —
				// answering 200 told a client a teardown succeeded that never existed.
				return rpcError(
					405,
					-32_601,
					"Method not found: DELETE is not supported by Tedix stateless MCP transport",
					this.cors,
				);
			default:
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32_000, message: "Method not allowed." },
						id: null,
					}),
					{
						status: 405,
						headers: {
							Allow: "GET, POST, DELETE, OPTIONS",
							"Content-Type": "application/json",
						},
					},
				);
		}
	}

	private async handlePost(request: Request): Promise<Response> {
		// Content negotiation
		const accept = request.headers.get("Accept") ?? "";
		if (
			!accept.includes("application/json") ||
			!accept.includes("text/event-stream")
		) {
			return rpcError(
				406,
				-32_000,
				"Not Acceptable: Client must accept both application/json and text/event-stream",
				this.cors,
			);
		}
		if (!isJsonContentType(request.headers.get("Content-Type"))) {
			return rpcError(
				415,
				-32_000,
				"Unsupported Media Type: Content-Type must be application/json",
				this.cors,
			);
		}

		// Parse body only after the bounded read; the SDK applies this same 4 MiB
		// limit on SDK-owned paths, but this extension transport owns its parser.
		let raw: unknown;
		try {
			const body = await readBoundedRequestBody(request);
			if (body.tooLarge) {
				return requestBodyTooLargeResponse(this.cors);
			}
			raw = JSON.parse(body.text);
		} catch {
			return rpcError(400, -32_700, "Parse error: Invalid JSON", this.cors);
		}

		if (Array.isArray(raw)) {
			return rpcError(
				400,
				-32_600,
				"Invalid Request: JSON-RPC batches are not supported",
				this.cors,
			);
		}

		let messages: JSONRPCMessage[];
		try {
			messages = [JSONRPCMessageSchema.parse(raw)];
		} catch {
			return rpcError(
				400,
				-32_700,
				"Parse error: Invalid JSON-RPC message",
				this.cors,
			);
		}

		// Initialize request rules
		const initRequests = messages.filter(isInitializeRequest);
		if (initRequests.length > 1) {
			return rpcError(
				400,
				-32_600,
				"Invalid Request: Only one initialization request is allowed",
				this.cors,
			);
		}

		// Modern (2026-07-28) request binding. Batches are already rejected, so
		// there is at most one request-bearing message per POST to validate.
		const requests = messages.filter(isJSONRPCRequest);
		const onlyRequest = requests.length === 1 ? requests[0] : undefined;

		// Protocol version — checked AFTER body parse so the JSON-RPC error can
		// echo the request id (SEP-2575 `http-server-error-jsonrpc-id`) instead
		// of `id: null`.
		const versionError = this.validateProtocolVersion(request, onlyRequest?.id);
		if (versionError) return versionError;

		if (onlyRequest) {
			const modernError = this.validateModernRequest(request, onlyRequest);
			if (modernError) return modernError;
			const versionMismatch = this.validateRequestProtocolVersion(
				request,
				onlyRequest,
			);
			if (versionMismatch) return versionMismatch;
			const paramError = this.validateInboundParamHeaders(request, onlyRequest);
			if (paramError) return paramError;
		}

		// No requests (only notification/response) → 202 No Content
		if (requests.length === 0) {
			for (const m of messages) this.onmessage?.(m, { request });
			return new Response(null, {
				status: 202,
				headers: corsHeaders(this.cors, false),
			});
		}

		// Register resolvers, emit messages, await all responses
		const responses = await Promise.all(
			requests.map((req) => {
				if (req.method === "server/discover" && this.discover) {
					return Promise.resolve(
						this.decorateResponse(req, {
							jsonrpc: "2.0",
							id: req.id,
							result: {
								resultType: "complete",
								supportedVersions: this.supportedVersions(),
								capabilities: this.discoveryCapabilities(),
								...(this.discover.instructions
									? { instructions: this.discover.instructions }
									: {}),
							},
						}),
					);
				}
				if (MCP_TASK_METHOD_SET.has(req.method)) {
					return Promise.resolve(this.handleTaskRequest(req));
				}
				if (req.method === COMPLETION_METHOD) {
					return this.handleCompletionRequest(req);
				}
				if (req.method === DIRECTORY_READ_METHOD) {
					return this.handleDirectoryReadRequest(req).then((message) =>
						this.decorateResponse(req, message),
					);
				}
				if (req.method === SUBSCRIPTIONS_LISTEN_METHOD) {
					return Promise.resolve(this.handleSubscriptionsListen(req));
				}
				const reqId = (req as { id: string | number }).id;

				// Without a connected server, no method can be dispatched. Once
				// dispatched, only the server can establish MethodNotFound; a
				// response deadline cannot distinguish a slow handler from a lost reply.
				if (!this.onmessage) {
					this.pending.delete(reqId);
					return Promise.resolve(
						this.decorateResponse(req, {
							jsonrpc: "2.0",
							id: req.id,
							error: {
								code: -32_601,
								message: `Method not found: ${req.method}`,
							},
						} as JSONRPCMessage),
					);
				}

				let resolveFirst: (event: PendingExchangeFirstEvent) => void = () => {};
				const firstEvent = new Promise<PendingExchangeFirstEvent>((resolve) => {
					resolveFirst = resolve;
				});
				const exchange: PendingExchange = {
					request: req,
					resolveFirst,
					firstSettled: false,
					notifications: [],
				};
				this.pending.set(reqId, exchange);
				// Bound response inactivity, not execution. A slow handler may still
				// finish after this timeout; never classify that as a missing method.
				this.armUnansweredTimeout(reqId, exchange);

				this.onmessage(this.normalizeCanonicalMrtrRetry(req), {
					request,
				});
				return firstEvent.then((event) => {
					if (event === "response") {
						this.pending.delete(reqId);
						if (!exchange.response) {
							throw new Error("MCP exchange settled without a response");
						}
						return exchange.response;
					}

					const stream = new ReadableStream<Uint8Array>({
						start: (controller) => {
							exchange.controller = controller;
							this.flushPendingNotifications(exchange);
							if (exchange.response) {
								controller.enqueue(encodeSseMessage(exchange.response));
								controller.close();
								this.pending.delete(reqId);
							}
						},
						cancel: () => {
							if (exchange.unanswered) clearTimeout(exchange.unanswered);
							this.pending.delete(reqId);
						},
					});
					return new Response(stream, {
						status: 200,
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "private, no-store, no-transform",
							"X-Accel-Buffering": "no",
							...corsHeaders(this.cors, false),
						},
					});
				});
			}),
		);

		// Also dispatch any non-request messages (notifications)
		for (const m of messages) {
			if (!isJSONRPCRequest(m)) this.onmessage?.(m, { request });
		}

		const streamed = responses.find(
			(response): response is Response => response instanceof Response,
		);
		if (streamed) return streamed;

		const responseMessages = responses as JSONRPCMessage[];
		const body =
			responseMessages.length === 1 ? responseMessages[0] : responseMessages;
		// In-band JSON-RPC errors ride HTTP 200 — with two exceptions:
		// MissingRequiredClientCapability (-32021), whose 400 the spec mandates
		// per-error with no origin condition (SDK v2 parity): even the
		// post-dispatch tasks-extension poll gate answers 400 while the response
		// is uncommitted (request-scoped SSE starts only after a notification); and
		// method-not-found (-32601) for MODERN-classified callers, which the
		// spec maps to HTTP 404 (body unchanged). Legacy callers keep 200.
		const single =
			responseMessages.length === 1 ? responseMessages[0] : undefined;
		let status = 200;
		if (single && isJSONRPCErrorResponse(single)) {
			if (single.error.code === ERR_MISSING_REQUIRED_CLIENT_CAPABILITY) {
				status = 400;
			} else if (
				single.error.code === -32_601 &&
				request.headers.get(MCP_PROTOCOL_VERSION_HEADER) ===
					MODERN_PROTOCOL_VERSION
			) {
				status = 404;
			}
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: {
				"Content-Type": "application/json",
				// Explicit, not just absent: every JSON-RPC result (tools/list,
				// resources/list, etc.) is per-caller-scope. Never let Workers
				// Cache's edge tier (apps/mcp wrangler.jsonc `cache.enabled`) store
				// this across callers/orgs — only the `.well-known/*` discovery
				// routes, which are provably scope-invariant, opt in.
				"Cache-Control": "private, no-store",
				...corsHeaders(this.cors, false),
			},
		});
	}

	private decorateResponse(
		request: JSONRPCRequest,
		response: JSONRPCMessage,
	): JSONRPCMessage {
		const next = this.resultTransform
			? this.resultTransform({ request, response })
			: response;
		if (isJSONRPCErrorResponse(next)) {
			const sdkPrefix = `MCP error ${next.error.code}: `;
			if (next.error.message.startsWith(sdkPrefix)) {
				return {
					...next,
					error: {
						...next.error,
						message: next.error.message.slice(sdkPrefix.length),
					},
				};
			}
			return next;
		}
		if (!isJSONRPCResultResponse(next)) return next;
		if (!isRecord(next.result)) return next;

		let result: Record<string, unknown> = next.result;

		// Consume (always strip) the result-level SEP-2549 hint marker, whether
		// or not the method is cacheable — it is transport plumbing, never wire
		// payload.
		let resultHint: Partial<McpResultCacheHint> | undefined;
		const meta = isRecord(result._meta) ? result._meta : undefined;
		if (meta && MCP_RESULT_CACHE_HINT_META_KEY in meta) {
			resultHint = parseResultCacheHintMarker(
				meta[MCP_RESULT_CACHE_HINT_META_KEY],
			);
			const { [MCP_RESULT_CACHE_HINT_META_KEY]: _marker, ...restMeta } = meta;
			if (Object.keys(restMeta).length > 0) {
				result = { ...result, _meta: restMeta };
			} else {
				const { _meta: _dropped, ...rest } = result;
				result = rest;
			}
		}

		if (typeof result.resultType !== "string") {
			result = { resultType: "complete", ...result };
		}

		const cacheHint = this.cacheHints[request.method];
		if (cacheHint) {
			// Per-field precedence: a valid handler-supplied marker field wins over
			// the per-method hint (`ttlMs: 0` is a legitimate "immediately stale").
			result = {
				...result,
				ttlMs: resultHint?.ttlMs ?? cacheHint.ttlMs,
				cacheScope: resultHint?.cacheScope ?? cacheHint.cacheScope,
			};
		}

		const requestMeta = isRecord(request.params)
			? request.params._meta
			: undefined;
		const isModernRequest =
			isRecord(requestMeta) &&
			requestMeta[MCP_PROTOCOL_VERSION_META_KEY] === MODERN_PROTOCOL_VERSION;
		if (isModernRequest && this.discover?.serverInfo) {
			const responseMeta = isRecord(result._meta) ? result._meta : {};
			result = {
				...result,
				_meta: {
					...responseMeta,
					// Transport identity wins after the application result transform so a
					// handler cannot spoof the server that produced this result.
					[MCP_SERVER_INFO_META_KEY]: this.discover.serverInfo,
				},
			};
		}

		return { ...next, result };
	}

	private validateProtocolVersion(
		request: Request,
		requestId?: string | number,
	): Response | undefined {
		const v = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
		const supported = this.supportedVersions();
		if (v !== null && !supported.includes(v)) {
			return rpcError(
				400,
				ERR_UNSUPPORTED_PROTOCOL_VERSION,
				"Unsupported protocol version",
				this.cors,
				{ supported, requested: v },
				requestId,
			);
		}
		return undefined;
	}

	/**
	 * Modern (`2026-07-28`) request binding. Delegates to the exported
	 * {@link validateModernProtocolHeaders} ladder (shared with any fast-path
	 * caller that validates a modern request outside `mountMcp()`'s McpServer
	 * dispatch) and turns a violation into this transport's JSON-RPC error
	 * `Response`. Only enforced when the caller declares the modern revision
	 * via `MCP-Protocol-Version`; legacy and unscoped requests are untouched,
	 * so external hosts keep working.
	 */
	private validateModernRequest(
		request: Request,
		rpcRequest: JSONRPCRequest,
	): Response | undefined {
		const params = isRecord(rpcRequest.params) ? rpcRequest.params : {};
		const violation = validateModernProtocolHeaders({
			headers: request.headers,
			method: rpcRequest.method,
			params,
			requiredClientExtensions: this.requiredClientExtensions,
		});
		if (!violation) return undefined;
		return rpcError(
			// Modern method-not-found (removed `initialize`) maps to HTTP 404,
			// mirroring the post-dispatch -32601 mapping in handlePost and the
			// fast-path jsonRpcEnvelopeErrorResponse.
			violation.code === -32_601 ? 404 : 400,
			violation.code,
			violation.message,
			this.cors,
			violation.data,
			rpcRequest.id,
		);
	}

	/**
	 * `MCP-Protocol-Version` header ↔ `_meta` protocol-version cross-check.
	 * The header-present-but-unsupported case is already rejected by
	 * {@link validateProtocolVersion} (`-32022`, HTTP 400), so the only failure
	 * left here is a disagreement between the header and the request's own
	 * `_meta` claim — a `HeaderMismatch` (`-32020`, HTTP 400), not an
	 * unsupported version.
	 */
	private validateRequestProtocolVersion(
		request: Request,
		rpcRequest: JSONRPCRequest,
	): Response | undefined {
		const params = isRecord(rpcRequest.params) ? rpcRequest.params : null;
		const meta = isRecord(params?._meta) ? params._meta : null;
		const requested =
			typeof meta?.[MCP_PROTOCOL_VERSION_META_KEY] === "string"
				? meta[MCP_PROTOCOL_VERSION_META_KEY]
				: undefined;
		if (!requested) return undefined;

		const header = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
		if (header !== requested) {
			return rpcError(
				400,
				ERR_HEADER_MISMATCH,
				"Header mismatch: MCP-Protocol-Version must equal the request _meta protocol version",
				this.cors,
				{
					header: MCP_PROTOCOL_VERSION_HEADER,
					expected: requested,
					received: header,
				},
				rpcRequest.id,
			);
		}
		return undefined;
	}

	/**
	 * SEP-2243 inbound `Mcp-Param-*` validation for `tools/call`. Only modern
	 * (2026-07-28) callers bind custom headers, so this is a no-op unless the
	 * caller declared the modern revision AND a `toolSchemaLookup` is wired.
	 * Resolves the called tool's `inputSchema`, and rejects a header ↔ body
	 * disagreement on any `x-mcp-header`-bound property with `-32020` + HTTP 400
	 * — matching the SDK v2 serving entry's `validateMcpParamHeaders`. This
	 * closes the inbound side of SEP-2243 (Tedix already sends these headers
	 * outbound via {@link buildMcpParamHeaders}).
	 */
	private validateInboundParamHeaders(
		request: Request,
		rpcRequest: JSONRPCRequest,
	): Response | undefined {
		if (rpcRequest.method !== "tools/call" || !this.toolSchemaLookup) {
			return undefined;
		}
		if (
			request.headers.get(MCP_PROTOCOL_VERSION_HEADER)?.trim() !==
			MODERN_PROTOCOL_VERSION
		) {
			return undefined;
		}
		const params = isRecord(rpcRequest.params) ? rpcRequest.params : undefined;
		const toolName = typeof params?.name === "string" ? params.name : undefined;
		if (!toolName) return undefined;

		let inputSchema: Record<string, unknown> | undefined;
		try {
			inputSchema = this.toolSchemaLookup(toolName);
		} catch {
			// A schema lookup failure must never block dispatch (fail-safe, like
			// the outbound side); skip inbound param validation for this call.
			return undefined;
		}
		const args = isRecord(params?.arguments) ? params.arguments : undefined;
		const violation = validateInboundMcpParamHeaders(
			inputSchema,
			args,
			request.headers,
		);
		if (!violation) return undefined;
		return rpcError(
			400,
			violation.code,
			violation.message,
			this.cors,
			violation.data.mismatch,
			rpcRequest.id,
		);
	}

	private normalizeCanonicalMrtrRetry(request: JSONRPCRequest): JSONRPCRequest {
		if (request.method !== "tools/call") return request;
		const params = isRecord(request.params) ? request.params : null;
		if (!params) return request;
		const inputResponses = isRecord(params.inputResponses)
			? params.inputResponses
			: undefined;
		if (!inputResponses && params.requestState === undefined) return request;

		const meta = isRecord(params._meta) ? { ...params._meta } : {};
		if (!isRecord(meta[TEDIX_INPUT_RESPONSES_META_KEY])) {
			meta[TEDIX_INPUT_RESPONSES_META_KEY] = {
				requestState: params.requestState,
				inputResponses,
				...(inputResponses
					? { content: firstInputResponseContent(inputResponses) }
					: {}),
			};
		}
		return { ...request, params: { ...params, _meta: meta } };
	}

	/**
	 * Versions advertised via `server/discover` and accepted on the
	 * `MCP-Protocol-Version` header. The modern revision is prepended (preferred)
	 * additively in front of the SDK's legacy versions so modern callers can
	 * negotiate `2026-07-28` while legacy hosts keep their negotiated version.
	 */
	private supportedVersions(): string[] {
		const base =
			this.discover?.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
		return base.includes(MODERN_PROTOCOL_VERSION)
			? base
			: [MODERN_PROTOCOL_VERSION, ...base];
	}

	private discoveryCapabilities(): Record<string, unknown> {
		const capabilities = { ...this.discover?.capabilities };

		// 2026-07-28 autocomplete: advertise `completions` only when a handler is
		// mounted, mirroring the SDK's capability-gating for prompts/resources.
		if (this.completionHandler && !("completions" in capabilities)) {
			capabilities.completions = {};
		}

		if (!this.taskHandlers) return capabilities;

		const extensions = isRecord(capabilities.extensions)
			? { ...capabilities.extensions }
			: {};
		extensions[MCP_TASKS_EXTENSION] = {};
		capabilities.extensions = extensions;
		return capabilities;
	}

	/**
	 * SEP-2663 (Tasks, Final): `tasks/get|update|cancel` polling is gated on the
	 * caller having declared the tasks extension, mirroring the gate already
	 * enforced at task-CREATION time ({@link clientSupportsTasks}, used by
	 * `apps/mcp/src/mcp/tool-execution.ts` before deferring `_asyncTask` work
	 * and by `apps/mcp/src/index.ts::rewriteCompatibilityTaskResult` before
	 * emitting a protocol-native task envelope). Reusing that same helper here
	 * — rather than re-deriving the check — also reuses its exemption: legacy/
	 * internal callers that never declare `_meta.clientCapabilities` at all
	 * (e.g. Home/tedi compatibility-linkage polling, which predates the tasks
	 * extension and still reads the `task.id` field embedded in tool results)
	 * are treated as supporting tasks and are NOT rejected here. Only a caller
	 * that declared capabilities WITHOUT the tasks extension — a deliberate
	 * modern opt-out — is rejected.
	 */
	private async handleTaskRequest(
		request: JSONRPCRequest,
	): Promise<JSONRPCMessage> {
		if (!this.taskHandlers) {
			return this.taskError(
				request,
				-32_601,
				`Method not found: ${request.method}`,
			);
		}

		const params = isRecord(request.params) ? request.params : {};
		if (!clientSupportsTasks(params._meta)) {
			return this.taskError(
				request,
				ERR_MISSING_REQUIRED_CLIENT_CAPABILITY,
				`Missing required client capability: ${MCP_TASKS_EXTENSION}`,
				{
					requiredCapabilities: {
						extensions: { [MCP_TASKS_EXTENSION]: {} },
					},
				},
			);
		}

		try {
			if (request.method === "tasks/get") {
				const taskId = this.requiredTaskId(request);
				const task = await this.taskHandlers.get({ taskId });
				return this.taskResult(request, { resultType: "complete", ...task });
			}

			if (request.method === "tasks/update") {
				const taskId = this.requiredTaskId(request);
				const params = isRecord(request.params) ? request.params : {};
				const inputResponses = isRecord(params.inputResponses)
					? params.inputResponses
					: undefined;
				if (!inputResponses) {
					throw new McpTaskError(
						-32_602,
						"Invalid params: inputResponses is required",
					);
				}
				await this.taskHandlers.update({
					taskId,
					inputResponses,
				});
				return this.taskResult(request, { resultType: "complete" });
			}

			if (request.method === "tasks/cancel") {
				const taskId = this.requiredTaskId(request);
				await this.taskHandlers.cancel({ taskId });
				return this.taskResult(request, { resultType: "complete" });
			}

			return this.taskError(
				request,
				-32_601,
				`Method not found: ${request.method}`,
			);
		} catch (error) {
			if (error instanceof McpTaskError) {
				return this.taskError(request, error.code, error.message, error.data);
			}
			const message = error instanceof Error ? error.message : String(error);
			return this.taskError(request, -32_603, message);
		}
	}

	private requiredTaskId(request: JSONRPCRequest): string {
		const params = isRecord(request.params) ? request.params : {};
		if (typeof params.taskId !== "string" || params.taskId.length === 0) {
			throw new McpTaskError(-32_602, "Invalid params: taskId is required");
		}
		return params.taskId;
	}

	private taskResult(
		request: JSONRPCRequest,
		result: Record<string, unknown>,
	): JSONRPCMessage {
		return { jsonrpc: "2.0", id: request.id, result };
	}

	private taskError(
		request: JSONRPCRequest,
		code: number,
		message: string,
		data?: Record<string, unknown>,
	): JSONRPCMessage {
		return {
			jsonrpc: "2.0",
			id: request.id,
			error: { code, message, ...(data ? { data } : {}) },
		};
	}

	/**
	 * 2026-07-28 `completion/complete` (autocomplete). Validates the request
	 * shape, runs the mounted handler, and caps the result at 100 values per the
	 * spec. Without a mounted handler this is method-not-found.
	 */
	private async handleCompletionRequest(
		request: JSONRPCRequest,
	): Promise<JSONRPCMessage> {
		if (!this.completionHandler) {
			return this.taskError(
				request,
				-32_601,
				`Method not found: ${request.method}`,
			);
		}

		const params = isRecord(request.params) ? request.params : {};
		const ref = isRecord(params.ref) ? params.ref : {};
		const argument = isRecord(params.argument) ? params.argument : {};
		const refType = ref.type;
		if (refType !== "ref/prompt" && refType !== "ref/resource") {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: ref.type must be ref/prompt or ref/resource",
			);
		}
		if (refType === "ref/prompt" && typeof ref.name !== "string") {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: ref.name is required for ref/prompt",
			);
		}
		if (refType === "ref/resource" && typeof ref.uri !== "string") {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: ref.uri is required for ref/resource",
			);
		}
		if (
			typeof argument.name !== "string" ||
			typeof argument.value !== "string"
		) {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: argument.name and argument.value are required",
			);
		}

		const completionRequest: McpCompletionRequest = {
			ref:
				refType === "ref/prompt"
					? { type: refType, name: ref.name as string }
					: { type: refType, uri: ref.uri as string },
			argument: { name: argument.name, value: argument.value },
			...(isRecord(params.context) && isRecord(params.context.arguments)
				? {
						context: {
							arguments: params.context.arguments as Record<string, string>,
						},
					}
				: {}),
		};

		try {
			const result = await this.completionHandler(completionRequest);
			const values = (result.values ?? []).slice(0, COMPLETION_MAX_VALUES);
			const completion: Record<string, unknown> = { values };
			if (typeof result.total === "number") completion.total = result.total;
			if (typeof result.hasMore === "boolean")
				completion.hasMore = result.hasMore;
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: { resultType: "complete", completion },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this.taskError(request, -32_603, message);
		}
	}

	private async handleDirectoryReadRequest(
		request: JSONRPCRequest,
	): Promise<JSONRPCMessage> {
		if (!this.directoryReadHandler) {
			return this.taskError(
				request,
				-32_601,
				`Method not found: ${request.method}`,
			);
		}

		const params = isRecord(request.params) ? request.params : {};
		if (typeof params.uri !== "string" || params.uri.length === 0) {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: uri is required",
			);
		}
		if (params.cursor != null && typeof params.cursor !== "string") {
			return this.taskError(
				request,
				-32_602,
				"Invalid params: cursor must be a string",
			);
		}

		try {
			const result = await this.directoryReadHandler({
				uri: params.uri,
				...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
			});
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					resultType: "complete",
					resources: Array.isArray(result.resources) ? result.resources : [],
					...(typeof result.nextCursor === "string"
						? { nextCursor: result.nextCursor }
						: {}),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this.taskError(request, -32_602, message);
		}
	}

	/**
	 * 2026-07-28 `subscriptions/listen` decision (DESCOPED HERE, by design).
	 *
	 * The spec replaces the legacy HTTP GET SSE channel + `resources/subscribe`
	 * with a single long-lived POST request that streams subscription
	 * notifications for as long as the connection is held open. That model is
	 * fundamentally incompatible with THIS transport: we are STATELESS and
	 * per-request (see the file header) — every POST resolves to exactly one JSON
	 * response and the Worker has no durable connection, no subscription
	 * registry, and nowhere to push server-initiated frames (the SDK `send()`
	 * path already drops standalone notifications). The existing GET→405 contract
	 * is the matching stance for the same reason.
	 *
	 * Rather than crash or hang, we return a spec-shaped JSON-RPC error
	 * (`-32601` method-not-found) explaining the stateless stance, so a modern
	 * client gets a clear, non-fatal signal and falls back to polling
	 * (`resources/read`, `tasks/get`).
	 *
	 * A durable subscription surface already exists and is the established,
	 * adopted pattern for this need: `apps/mcp/src/subscriptions.ts`
	 * (`McpSubscriptionDurableObject`, mounted as the `MCP_SUBSCRIPTIONS`
	 * binding) + `apps/mcp/src/subscription-publisher.ts` (server-side fan-out
	 * into that DO). That surface is reached directly by `apps/mcp/src/index.ts`
	 * BEFORE it ever calls `mountMcp()` — it is a stateful Worker (Durable
	 * Object), deliberately kept off this stateless primitive. Do not bolt a
	 * long-lived stream onto `StatelessMcpTransport`; extend the DO surface
	 * instead.
	 */
	private handleSubscriptionsListen(request: JSONRPCRequest): JSONRPCMessage {
		return this.taskError(
			request,
			-32_601,
			"Method not found: subscriptions/listen is not supported by the Tedix stateless MCP transport (no long-lived connection); poll resources/read or tasks/get instead",
			{ reason: "stateless-transport", transport: "stateless" },
		);
	}
}

// =============================================================================
// PUBLIC API
// =============================================================================

export interface MountMcpOptions {
	/** Trusted per-tool budget for the custom transport backstop; SDK mounts have no such timer. */
	toolResponseTimeoutMs?: (toolName: string) => number | undefined;
	/**
	 * Path the handler answers on. Defaults to "/mcp". Pass `null` to skip
	 * the path check (caller already routed).
	 */
	route?: string | null;
	cors?: CorsOptions;
	cacheHints?: Record<string, McpResultCacheHint>;
	discover?: McpDiscoverOptions;
	resultTransform?: McpResultTransform;
	taskHandlers?: McpTaskHandlers;
	completionHandler?: McpCompletionHandler;
	directoryReadHandler?: McpDirectoryReadHandler;
	requiredClientExtensions?: string[];
	/**
	 * SEP-2243 inbound `Mcp-Param-*` validation source. Defaults to the mounted
	 * server's `toolInputSchemaJson`; pass `null` to disable inbound validation
	 * (e.g. a proxy that forwards `tools/call` to an upstream whose schemas this
	 * server does not hold).
	 */
	toolSchemaLookup?:
		| ((toolName: string) => Record<string, unknown> | undefined)
		| null;
}

/**
 * Engine-dispatch predicate for {@link mountMcp}: does this mount configure
 * any of Tedix's NON-SPEC extensions, forcing the hand-rolled
 * {@link StatelessMcpTransport}?
 *
 * A mount that configures none of these (only `route`/`cors`/`discover`) is a
 * "simple mount" and is served permanently through the official SDK's
 * `createMcpHandler` engine. This is dispatch on the SHAPE of the options —
 * fixed structurally at each call site — not a runtime flag.
 *
 * `toolSchemaLookup` counts as extension-shaped only when the caller supplies
 * it explicitly (a custom source, or `null` to disable inbound validation):
 * the SDK engine already performs SEP-2243 inbound `Mcp-Param-*` validation
 * against the mounted server's own `toolInputSchemaJson`, which is exactly
 * this transport's default.
 */
export function requiresLegacyMcpTransport(options: MountMcpOptions): boolean {
	return (
		options.taskHandlers !== undefined ||
		options.completionHandler !== undefined ||
		options.directoryReadHandler !== undefined ||
		options.resultTransform !== undefined ||
		options.cacheHints !== undefined ||
		options.requiredClientExtensions !== undefined ||
		options.toolSchemaLookup !== undefined
	);
}

/**
 * Whether this POST carries a single JSON-RPC message that Tedix answers
 * before the SDK engine: `server/discover` or `subscriptions/listen`.
 */
async function classifyTransportOwnedPost(
	request: Request,
): Promise<"discover" | "subscriptions-listen" | "other" | "too-large"> {
	try {
		const body = await readBoundedRequestBody(request.clone());
		if (body.tooLarge) return "too-large";
		const raw: unknown = JSON.parse(body.text);
		if (!isRecord(raw)) return "other";
		if (raw.method === "server/discover") return "discover";
		if (raw.method === SUBSCRIPTIONS_LISTEN_METHOD) {
			return "subscriptions-listen";
		}
		return "other";
	} catch {
		return "other";
	}
}

/**
 * Serve a simple mount through the official SDK's `createMcpHandler` engine.
 *
 * The SDK owns the whole JSON-RPC pipeline for POSTs: era classification
 * (modern envelope vs 2025-era stateless fallback), the SEP-2243 header
 * ladder, inbound `Mcp-Param-*` validation against the server's own
 * `toolInputSchemaJson`, era binding (its own `setNegotiatedProtocolVersion`
 * — the legacy path's `_negotiatedProtocolVersion` reach-around is
 * unnecessary here), and `responseMode: 'auto'` SSE promotion when a handler
 * emits a mid-call notification.
 *
 * Tedix keeps ownership of three edges the SDK does not cover:
 *
 * - Non-POST method semantics (OPTIONS preflight, DELETE 200, GET 405) —
 *   byte-parity with the hand-rolled transport.
 * - `server/discover` when the mount configures `discover`: the discover
 *   advertisement is mount-option-authored (serverInfo/capabilities/
 *   supported-version list exactly as the caller declared them), so those
 *   POSTs are answered by a {@link StatelessMcpTransport} instance — the same
 *   code path, validation ladder included, that extension mounts use. The
 *   transport special-cases discover before any server dispatch, so no
 *   `server.connect()` is involved.
 * - `subscriptions/listen`, answered the same way with the stateless
 *   `-32601` rejection. SDK 2.2.0 closes a listen stream only when NO
 *   requested notification type is honored, and `McpServer` advertises
 *   `tools.listChanged`, so the SDK would hold an SSE stream open forever on
 *   a per-request event bus nothing publishes to.
 * - Response envelope headers: CORS + `Cache-Control: private, no-store`
 *   (never let the Workers Cache edge tier store JSON-RPC results across
 *   callers/orgs — see the matching note in `handlePost`).
 */
async function serveSimpleMountViaSdk(
	server: SdkMcpServer,
	request: Request,
	options: MountMcpOptions,
): Promise<Response> {
	switch (request.method) {
		case "OPTIONS":
			return new Response(null, {
				status: 200,
				headers: corsHeaders(options.cors, true),
			});
		case "DELETE":
			// 405 per MCP 2026-07-28 `basic/transports`; byte-parity with the
			// hand-rolled engine above, which is the stated invariant for these two.
			return rpcError(
				405,
				-32_601,
				"Method not found: DELETE is not supported by Tedix stateless MCP transport",
				options.cors,
			);
		case "GET":
			return rpcError(
				405,
				-32_601,
				"Method not found: GET is not supported by Tedix stateless MCP transport",
				options.cors,
			);
		case "POST":
			break;
		default:
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32_000, message: "Method not allowed." },
					id: null,
				}),
				{
					status: 405,
					headers: {
						Allow: "GET, POST, DELETE, OPTIONS",
						"Content-Type": "application/json",
					},
				},
			);
	}

	const classification = await classifyTransportOwnedPost(request);
	if (classification === "too-large") {
		return requestBodyTooLargeResponse(options.cors);
	}
	if (
		classification === "subscriptions-listen" ||
		(classification === "discover" && options.discover)
	) {
		const transport = new StatelessMcpTransport({
			cors: options.cors,
			discover: options.discover,
		});
		return transport.handleRequest(request);
	}

	// Per-request handler over the caller's per-request server: `mountMcp()`'s
	// contract is a fresh `McpServer` per request, so an adapter closure
	// returning the already-built instance satisfies the factory (each leg of
	// the entry invokes it at most once per exchange).
	const handler = createMcpHandler(() => server, {
		legacy: "stateless",
		responseMode: "auto",
		onerror: (error) => {
			console.error("[mcp-transport] createMcpHandler:", error);
		},
	});
	const response = await handler.fetch(request);
	// Re-wrap (streams pass through) to stamp the Tedix envelope headers.
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	for (const [name, value] of Object.entries(
		corsHeaders(options.cors, false),
	)) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Mount an `McpServer` against an incoming Web `Request`. Returns a `Response`.
 *
 * Dispatches on the SHAPE of the options ({@link requiresLegacyMcpTransport}):
 * simple mounts are served by the official SDK's `createMcpHandler` engine;
 * extension mounts connect the SDK's own `server.connect(transport)` to the
 * hand-rolled single-exchange stateless transport. Callers already build a
 * fresh `McpServer` per request, so both engines are per-request.
 *
 * @example
 * ```ts
 * import { mountMcp } from "@tedix/mcp-shared/transport";
 *
 * const server = createMcpServer({ name: "tedix", version: "1.0.0" });
 * // ...register tools...
 * return mountMcp(server, request, { cors: { origin: "https://chat.openai.com" } });
 * ```
 */
export async function mountMcp(
	server: SdkMcpServer,
	request: Request,
	options: MountMcpOptions = {},
): Promise<Response> {
	const route = options.route === null ? null : (options.route ?? "/mcp");
	if (route !== null) {
		const url = new URL(request.url);
		if (url.pathname !== route) {
			return new Response("Not Found", { status: 404 });
		}
	}

	if (!requiresLegacyMcpTransport(options)) {
		return serveSimpleMountViaSdk(server, request, options);
	}

	// Default the SEP-2243 inbound schema source to the mounted server itself.
	// `null` disables it (proxy surfaces that don't hold the upstream schema);
	// an explicit function overrides it.
	const toolSchemaLookup =
		options.toolSchemaLookup === null
			? undefined
			: (options.toolSchemaLookup ??
				((toolName: string) => server.toolInputSchemaJson(toolName)));

	const transport = new StatelessMcpTransport({
		cors: options.cors,
		toolResponseTimeoutMs: options.toolResponseTimeoutMs,
		cacheHints: options.cacheHints,
		discover: options.discover,
		resultTransform: options.resultTransform,
		taskHandlers: options.taskHandlers,
		completionHandler: options.completionHandler,
		directoryReadHandler: options.directoryReadHandler,
		requiredClientExtensions: options.requiredClientExtensions,
		toolSchemaLookup,
	});

	await server.connect(transport);

	// Bind the SDK server instance to the 2026-07-28 wire era when the caller
	// declares it. The SDK's era is per-Protocol-instance state it only sets on
	// its own serving entries (`createMcpHandler`) or a legacy `initialize`; a
	// plain `server.connect(transport)` leaves the instance on the legacy
	// codec, which (a) routes native `inputRequired()` handler returns into the
	// legacy interactive shim — server→client requests this stateless transport
	// can never deliver — and (b) keeps removed 2025 methods answerable.
	// Callers build a fresh `McpServer` per request (stateless invariant), so
	// this is request-scoped, and legacy/unscoped requests stay untouched.
	// `_negotiatedProtocolVersion` is `protected` on the SDK `Protocol` class
	// with no public setter as of 2.2.0; the conformance suite
	// (`packages/mcp/conformance`, MRTR + removed-method scenarios) pins this
	// seam and fails loudly if an SDK bump renames the field.
	if (
		request.headers.get(MCP_PROTOCOL_VERSION_HEADER)?.trim() ===
		MODERN_PROTOCOL_VERSION
	) {
		(
			server.server as unknown as { _negotiatedProtocolVersion?: string }
		)._negotiatedProtocolVersion = MODERN_PROTOCOL_VERSION;
	}

	return transport.handleRequest(request);
}
