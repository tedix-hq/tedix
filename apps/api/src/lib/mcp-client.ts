/**
 * Direct MCP Client
 *
 * Connects to one MCP server per call (scans, health checks, tool tests,
 * adapters) without the Agents SDK's state management, on the official
 * `@modelcontextprotocol/client` v2 `Client` + `StreamableHTTPClientTransport`.
 *
 * The SDK owns the wire: `server/discover` version negotiation with the legacy
 * `initialize` fallback, the per-request `_meta` envelope and routing headers,
 * JSON and SSE response parsing, and session ids. This module owns only what is
 * Tedix policy:
 * - the caller's fetch (SSRF-guarded or a service binding) plus static headers
 *   and a cookie jar for vendors that pin sessions behind a sticky load balancer;
 * - Tedix-owned hosts must speak 2026-07-28 (pinned, no legacy fallback);
 * - auth-challenge and WAF classification into {@link AuthRequiredError};
 * - bounded, truncation-aware catalog pagination (`@tedix/mcp-shared/bounded-list`).
 *
 * The SDK is imported lazily (through `./mcp-client-sdk`) inside the connect
 * and call paths: several importers are reachable from `worker-app`, and the
 * Worker's startup CPU budget is 1s.
 *
 * @see https://modelcontextprotocol.io/specification/
 */

import type {
	Client,
	PriorDiscovery,
	StandardSchemaV1,
} from "@modelcontextprotocol/client";
import {
	type BoundedMcpList,
	collectBoundedMcpList,
} from "@tedix/mcp-shared/bounded-list";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_RESULT_TYPE_INPUT_REQUIRED,
	readInputRequiredResult,
} from "@tedix/mcp-shared/protocol";

// =============================================================================
// Types
// =============================================================================

/**
 * Icon object per MCP 2025-11-25 spec.
 * Applies to tools, resources, and prompts.
 */
export interface McpIcon {
	src: string;
	mimeType?: string;
	sizes?: string[];
	theme?: "light" | "dark";
}

export interface McpToolSchema {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: {
		type: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
	outputSchema?: Record<string, unknown>;
	icons?: McpIcon[];
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		openWorldHint?: boolean;
		idempotentHint?: boolean;
	};
	execution?: {
		taskSupport?: "forbidden" | "optional" | "required";
	};
	_meta?: Record<string, unknown>;
}

export interface McpResourceSchema {
	name?: string;
	title?: string;
	uri: string;
	description?: string;
	mimeType?: string;
	icons?: McpIcon[];
	annotations?: {
		audience?: string[];
		priority?: number;
	};
	_meta?: Record<string, unknown>;
}

export interface McpResourceTemplateSchema {
	name: string;
	title?: string;
	uriTemplate: string;
	description?: string;
	mimeType?: string;
	icons?: McpIcon[];
	annotations?: {
		audience?: string[];
		priority?: number;
	};
	_meta?: Record<string, unknown>;
}

export interface McpPromptSchema {
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
}

/** SEP-2640 skills/list entry. Resource bytes are intentionally not fetched during scans. */
export interface McpSkillManifest {
	uri: string;
	frontmatter: Record<string, unknown>;
	resources: Array<{ uri: string; digest: string; size: number }> | "dynamic";
}

export interface McpServerCapabilities {
	extensions?: Record<string, unknown>;
	experimental?: Record<string, unknown>;
	logging?: Record<string, unknown>;
	prompts?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	tools?: { listChanged?: boolean };
}

export interface McpServerInfo {
	name: string;
	version?: string;
	protocolVersion?: string;
	capabilities?: McpServerCapabilities;
	instructions?: string;
	tools: McpToolSchema[];
	resources: McpResourceSchema[];
	resourceTemplates: McpResourceTemplateSchema[];
	prompts: McpPromptSchema[];
	skills: McpSkillManifest[];
	/**
	 * Per-list truncation, carried beside the arrays because absence of evidence
	 * is not evidence of absence: a consumer that treats a cut-short array as the
	 * server's complete catalog concludes a tool, resource, or prompt does not
	 * exist when it is merely past the pagination bound. A list that failed
	 * outright is reported truncated too — its error is in {@link methodErrors}
	 * and its emptiness proves nothing.
	 */
	listsTruncated: {
		tools: boolean;
		resources: boolean;
		resourceTemplates: boolean;
		prompts: boolean;
		skills: boolean;
	};
	methodErrors?: Record<string, string>;
	partialAuth?: boolean;
}

export interface McpConnectionResult {
	success: boolean;
	serverInfo?: McpServerInfo;
	transport: "streamable-http" | "sse";
	requiresAuth: boolean;
	authUrl?: string;
	error?: string;
	errorCode?: string;
	connectTimeMs: number;
	totalTimeMs: number;
	wafProvider?: string;
	partialAuth?: boolean;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ServiceBindingFetcher = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export function serviceBindingFetchFn(fetcher: ServiceBindingFetcher) {
	return (url: string, init?: RequestInit) =>
		fetcher.fetch(new Request(url, init));
}

// =============================================================================
// Shared MCP Utilities (used by health, widget-test, and eval workflows)
// =============================================================================

/**
 * Build the MCP endpoint URL from a base URL (sets pathname to /mcp).
 */
export function buildMcpUrl(mcpBaseUrl: string): string {
	const url = new URL(mcpBaseUrl);
	url.pathname = "/mcp";
	return url.toString();
}

/**
 * Build the X-Tedix-Host header value for subdomain routing.
 */
export function buildMcpHost(appSlug: string, mcpBaseUrl: string): string {
	const url = new URL(mcpBaseUrl);
	return `${appSlug}.${url.hostname}`;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * A 2026-07-28 `resultType: "input_required"` tools/call outcome: the server
 * halted for caller input (e.g. Tedix's destructive-tool approval gate) and
 * did NOT execute the tool. Thrown instead of returning a success-shaped
 * result; `inputRequests`/`requestState` carry the retry envelope.
 */
export class InputRequiredError extends Error {
	constructor(
		public toolName: string,
		public inputRequests?: Record<string, unknown>,
		public requestState?: string,
	) {
		super(
			`Tool "${toolName}" returned resultType "input_required": it requires caller-provided input (e.g. an approval) and was NOT executed. Retry echoing inputResponses + requestState to resolve it.`,
		);
		this.name = "InputRequiredError";
	}
}

/**
 * The server (or a WAF in front of it) refused the request: an HTTP 401/403, or
 * a JSON-RPC error that says the caller is unauthenticated.
 */
export class AuthRequiredError extends Error {
	constructor(
		message: string,
		/** The RFC 9728 `resource_metadata` URL from the `WWW-Authenticate` challenge. */
		public authUrl?: string,
		public wafProvider?: string,
	) {
		super(message);
		this.name = "AuthRequiredError";
	}

	get isWafBlock(): boolean {
		return !!this.wafProvider;
	}
}

function detectWafProvider(
	server: string,
	body: string,
	status: number,
): string | undefined {
	if (status !== 403) return undefined;
	if (server.includes("cloudfront")) return "CloudFront";
	if (server.includes("cloudflare")) return "Cloudflare";
	if (server.includes("akamai") || body.includes("Akamai")) return "Akamai";
	if (server.includes("varnish")) return "Varnish";
	if (body.includes("Access Denied") && !server) return "WAF";
	return undefined;
}

// =============================================================================
// SDK session
// =============================================================================

type McpSdk = typeof import("./mcp-client-sdk");

let mcpSdk: Promise<McpSdk> | undefined;

/** Loaded on first use; see `./mcp-client-sdk` for why it is a named subset. */
function loadMcpSdk(): Promise<McpSdk> {
	mcpSdk ??= import("./mcp-client-sdk");
	return mcpSdk;
}

const SCANNER_CLIENT_NAME = "tedix-mcp-scanner";
const SCANNER_USER_AGENT = "tedix-mcp-scanner/1.0";

/** Tedix-owned MCP servers must speak the current sessionless revision. */
function requiresModernProtocol(endpoint: string): boolean {
	const hostname = new URL(endpoint).hostname.toLowerCase();
	return hostname === "tedix.dev" || hostname.endsWith(".tedix.dev");
}

function getSetCookieHeaders(headers: Headers): string[] {
	const withGetSetCookie = headers as Headers & {
		getSetCookie?: () => string[];
	};
	const explicit = withGetSetCookie.getSetCookie?.();
	if (explicit && explicit.length > 0) return explicit;

	const combined = headers.get("Set-Cookie");
	if (!combined) return [];

	return combined
		.split(/,(?=\s*[^;,]+=)/)
		.map((value) => value.trim())
		.filter(Boolean);
}

interface McpSession {
	sdk: McpSdk;
	client: Client;
	connect(options: { timeout: number; prior?: PriorDiscovery }): Promise<void>;
	/** Run one request, surfacing an auth refusal as {@link AuthRequiredError}. */
	run<T>(operation: () => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

interface McpSessionOptions {
	fetchFn: FetchFn;
	headers?: Record<string, string>;
	clientName?: string;
	clientCapabilities?: Record<string, unknown>;
}

/**
 * Build an SDK client over the caller's fetch. The transport's fetch is the one
 * seam for Tedix policy: static headers, the sticky-session cookie jar, and
 * recording 401/403 challenges (with WAF fingerprinting) before the SDK turns
 * them into its own typed errors.
 */
async function createMcpSession(
	endpoint: string,
	options: McpSessionOptions,
): Promise<McpSession> {
	const sdk = await loadMcpSdk();
	const pinned = requiresModernProtocol(endpoint);
	const cookies = new Map<string, string>();
	let challenge: AuthRequiredError | undefined;

	const client = new sdk.Client(
		{ name: options.clientName ?? SCANNER_CLIENT_NAME, version: "1.0.0" },
		{
			capabilities: options.clientCapabilities ?? {},
			versionNegotiation: {
				mode: pinned ? { pin: MCP_MODERN_PROTOCOL_VERSION } : "auto",
			},
			// input_required is reported to the caller, never fulfilled here.
			inputRequired: { autoFulfill: false },
		},
	);

	const transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint), {
		fetch: async (input, init) => {
			// One-shot calls never hold the standalone SSE listen stream open;
			// 405 is the spec's "no stream offered" answer.
			if (init?.method === "GET") return new Response(null, { status: 405 });

			const headers = new Headers(init?.headers);
			headers.set("User-Agent", SCANNER_USER_AGENT);
			for (const [name, value] of Object.entries(options.headers ?? {}))
				headers.set(name, value);
			if (cookies.size > 0)
				headers.set(
					"Cookie",
					Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "),
				);

			const response = await options.fetchFn(String(input), {
				...init,
				headers,
			});

			for (const header of getSetCookieHeaders(response.headers)) {
				const [pair] = header.split(";");
				const separatorIndex = pair?.indexOf("=") ?? -1;
				if (!pair || separatorIndex <= 0) continue;
				const name = pair.slice(0, separatorIndex).trim();
				if (name) cookies.set(name, pair.slice(separatorIndex + 1).trim());
			}

			if (response.status === 401 || response.status === 403) {
				const server = (response.headers.get("Server") ?? "").toLowerCase();
				const body = await response
					.clone()
					.text()
					.catch(() => "");
				const wafProvider = detectWafProvider(server, body, response.status);
				challenge = new AuthRequiredError(
					wafProvider ? `Blocked by ${wafProvider}` : "Authentication required",
					sdk.extractWWWAuthenticateParams(response).resourceMetadataUrl?.href,
					wafProvider,
				);
			}
			return response;
		},
	});

	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		challenge = undefined;
		try {
			return await operation();
		} catch (error) {
			if (challenge) throw challenge;
			if (
				error instanceof sdk.ProtocolError &&
				(error.code === -32001 ||
					/unauthorized|authentication/i.test(error.message))
			)
				throw new AuthRequiredError(error.message);
			throw error;
		}
	};

	return {
		sdk,
		client,
		connect: ({ timeout, prior }) =>
			run(async () => {
				try {
					await client.connect(transport, {
						timeout,
						...(prior ? { prior } : {}),
					});
				} catch (error) {
					if (!pinned || challenge || isTimeout(sdk, error)) throw error;
					throw new Error(
						`Unsupported MCP server: server/discover must advertise ${MCP_MODERN_PROTOCOL_VERSION} (${errorMessage(sdk, error)})`,
					);
				}
			}),
		run,
		close: () => client.close().catch(() => {}),
	};
}

function isTimeout(sdk: McpSdk, error: unknown): boolean {
	if (error instanceof sdk.SdkError)
		return error.code === sdk.SdkErrorCode.RequestTimeout;
	return error instanceof Error && error.name === "AbortError";
}

function errorMessage(sdk: McpSdk, error: unknown): string {
	if (error instanceof sdk.SdkHttpError)
		return `HTTP ${error.status}: ${error.message}`;
	if (isTimeout(sdk, error))
		return `MCP request timeout: ${error instanceof Error ? error.message : String(error)}`;
	return error instanceof Error ? error.message : String(error);
}

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

// =============================================================================
// Protocol era memory (tool calls)
// =============================================================================

// A remembered era verdict lets a warm tool call skip the `server/discover`
// probe (modern) or go straight to `initialize` (legacy). Keyed by endpoint AND
// the caller's header identity, since a discover result is only reusable within
// one authorization context. Only verdicts from a successful connect are
// stored; a failed call evicts, so the next call re-probes.
const ERA_TTL_MS = 10 * 60_000;
const MAX_ERA_ENTRIES = 256;
const eras = new Map<string, { prior: PriorDiscovery; expiresAt: number }>();

/** Test-only: forget every remembered upstream protocol era. */
/** @internal */
export function resetMcpEraCache(): void {
	eras.clear();
}

async function eraKey(
	endpoint: string,
	headers: Record<string, string> | undefined,
): Promise<string> {
	const identity = JSON.stringify([
		endpoint,
		Object.entries(headers ?? {})
			.map(([name, value]): [string, string] => [name.toLowerCase(), value])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(identity),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function rememberedEra(key: string): PriorDiscovery | undefined {
	const entry = eras.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt > Date.now()) return entry.prior;
	eras.delete(key);
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
	eras.delete(key);
	if (eras.size >= MAX_ERA_ENTRIES) {
		const oldest = eras.keys().next().value;
		if (oldest !== undefined) eras.delete(oldest);
	}
	eras.set(key, { prior, expiresAt: Date.now() + ERA_TTL_MS });
}

// =============================================================================
// Main Connection Function
// =============================================================================

function classifyConnectFailure(sdk: McpSdk | undefined, error: unknown) {
	const message = sdk
		? errorMessage(sdk, error)
		: error instanceof Error
			? error.message
			: String(error);
	let errorCode = "UNKNOWN";
	if (
		(sdk && isTimeout(sdk, error)) ||
		message.includes("timeout") ||
		message.includes("aborted")
	) {
		errorCode = "TIMEOUT";
	} else if (message.includes("ENOTFOUND") || message.includes("DNS")) {
		errorCode = "DNS";
	} else if (message.includes("certificate") || message.includes("SSL")) {
		errorCode = "TLS";
	} else if (message.includes("ECONNREFUSED") || message.includes("refused")) {
		errorCode = "CONNECTION_REFUSED";
	} else if (message.includes("403") || message.includes("blocked")) {
		errorCode = "BLOCKED";
	}
	return { message, errorCode };
}

/**
 * Connect to an MCP server and extract its capabilities
 *
 * Handles:
 * - Protocol era negotiation (2026-07-28 `server/discover`, or the older
 *   Streamable HTTP `initialize` handshake for external upstreams)
 * - OAuth requirement and WAF block detection
 * - Full tool/resource/prompt/skill schema extraction, bounded per list
 *
 * @param endpoint - The MCP server endpoint URL
 * @param options - Connection options
 */
export async function connectMcpServer(
	endpoint: string,
	options: {
		timeout?: number;
		preferredTransport?: "streamable-http" | "sse" | "auto";
		fetchFn?: FetchFn;
		headers?: Record<string, string>;
	} = {},
): Promise<McpConnectionResult> {
	const { timeout = 30000, preferredTransport = "auto" } = options;
	const startTime = Date.now();

	// Validate URL
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return {
			success: false,
			transport: "streamable-http",
			requiresAuth: false,
			error: "Invalid URL",
			errorCode: "INVALID_URL",
			connectTimeMs: 0,
			totalTimeMs: Date.now() - startTime,
		};
	}

	if (!["http:", "https:"].includes(url.protocol)) {
		return {
			success: false,
			transport: "streamable-http",
			requiresAuth: false,
			error: `Invalid protocol: ${url.protocol}`,
			errorCode: "INVALID_PROTOCOL",
			connectTimeMs: 0,
			totalTimeMs: Date.now() - startTime,
		};
	}

	// Current Tedix clients support only Streamable HTTP.
	const isSSE = url.pathname.toLowerCase().endsWith("/sse");
	if (isSSE || preferredTransport === "sse") {
		return {
			success: false,
			transport: "streamable-http",
			requiresAuth: false,
			error:
				"Legacy MCP SSE transport is not supported; use MCP 2026-07-28 Streamable HTTP",
			errorCode: "UNSUPPORTED_TRANSPORT",
			connectTimeMs: 0,
			totalTimeMs: Date.now() - startTime,
		};
	}
	const transport = "streamable-http" as const;

	const connectStartTime = Date.now();
	let session: McpSession | undefined;

	try {
		session = await createMcpSession(endpoint, {
			fetchFn: options.fetchFn ?? defaultFetch,
			headers: options.headers,
		});
		await session.connect({ timeout });
		const serverInfo = await readServerInfo(session, timeout);

		return {
			success: true,
			serverInfo,
			transport,
			requiresAuth: false,
			partialAuth: serverInfo.partialAuth,
			connectTimeMs: Date.now() - connectStartTime,
			totalTimeMs: Date.now() - startTime,
		};
	} catch (e) {
		const connectTimeMs = Date.now() - connectStartTime;

		if (e instanceof AuthRequiredError) {
			return {
				success: false,
				transport,
				requiresAuth: !e.isWafBlock,
				wafProvider: e.wafProvider,
				authUrl: e.authUrl,
				error: e.message,
				errorCode: e.isWafBlock ? "WAF_BLOCKED" : "AUTH_REQUIRED",
				connectTimeMs,
				totalTimeMs: Date.now() - startTime,
			};
		}

		const { message, errorCode } = classifyConnectFailure(session?.sdk, e);
		return {
			success: false,
			transport,
			requiresAuth: false,
			error: message,
			errorCode,
			connectTimeMs,
			totalTimeMs: Date.now() - startTime,
		};
	} finally {
		await session?.close();
	}
}

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

function parseMcpSkillManifest(value: unknown): McpSkillManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid skills/list entry: expected an object");
	}
	const entry = value as Record<string, unknown>;
	if (typeof entry.uri !== "string" || entry.uri.length === 0) {
		throw new Error("Invalid skills/list entry: uri is required");
	}
	if (
		!entry.frontmatter ||
		typeof entry.frontmatter !== "object" ||
		Array.isArray(entry.frontmatter)
	) {
		throw new Error("Invalid skills/list entry: frontmatter must be an object");
	}
	const frontmatter = entry.frontmatter as Record<string, unknown>;
	if (
		typeof frontmatter.name !== "string" ||
		typeof frontmatter.description !== "string"
	) {
		throw new Error(
			"Invalid skills/list entry: frontmatter name and description are required",
		);
	}
	if (entry.resources === "dynamic")
		return { uri: entry.uri, frontmatter, resources: "dynamic" };
	if (!Array.isArray(entry.resources)) {
		throw new Error(
			'Invalid skills/list entry: resources must be an array or "dynamic"',
		);
	}
	const resources = entry.resources.map((resource) => {
		if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
			throw new Error("Invalid skills/list resource: expected an object");
		}
		const item = resource as Record<string, unknown>;
		if (
			typeof item.uri !== "string" ||
			typeof item.digest !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(item.digest) ||
			!Number.isSafeInteger(item.size) ||
			(item.size as number) < 0
		) {
			throw new Error(
				"Invalid skills/list resource: expected uri, sha256 digest, and non-negative byte size",
			);
		}
		return { uri: item.uri, digest: item.digest, size: item.size as number };
	});
	return { uri: entry.uri, frontmatter, resources };
}

/**
 * Walk one list method page by page under the shared bounds. Each page is a
 * `client.request` with an explicit cursor rather than the SDK's aggregating
 * `listTools()`: that path throws away every entry when its page cap is hit
 * (a cut-short catalog must be kept and marked truncated), gates on the
 * advertised capability, and re-projects entries through the spec schema,
 * dropping vendor fields a scan records. `skills/list` (SEP-2640) has no SDK
 * method at all.
 */
function listMethod<T>(
	session: McpSession,
	method: string,
	field: string,
	timeout: number,
	parse: (value: unknown) => T = (value) => value as T,
): Promise<BoundedMcpList<T>> {
	return collectBoundedMcpList<T>(async (cursor) => {
		const result = await session.run(() =>
			session.client.request(
				{ method, params: cursor === undefined ? {} : { cursor } },
				RESULT_OBJECT,
				{ timeout },
			),
		);
		const items = result[field];
		return {
			items: Array.isArray(items) ? items.map(parse) : undefined,
			nextCursor: result.nextCursor,
		};
	});
}

async function settleMcpList<T>(
	fn: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
	try {
		return { status: "fulfilled", value: await fn() };
	} catch (reason) {
		return { status: "rejected", reason };
	}
}

/**
 * Read the connected server's identity and the catalogs it advertises, keeping
 * each list's truncation beside its entries.
 */
async function readServerInfo(
	session: McpSession,
	timeout: number,
): Promise<McpServerInfo> {
	const { client } = session;
	const serverVersion = client.getServerVersion();
	const capabilities = client.getServerCapabilities() as
		| McpServerCapabilities
		| undefined;

	const complete = <T>(): PromiseSettledResult<BoundedMcpList<T>> => ({
		status: "fulfilled",
		value: { items: [], truncated: false },
	});
	const toolsResult = await settleMcpList(() =>
		listMethod<McpToolSchema>(session, "tools/list", "tools", timeout),
	);
	const resourcesResult = capabilities?.resources
		? await settleMcpList(() =>
				listMethod<McpResourceSchema>(
					session,
					"resources/list",
					"resources",
					timeout,
				),
			)
		: complete<McpResourceSchema>();
	const resourceTemplatesResult = capabilities?.resources
		? await settleMcpList(() =>
				listMethod<McpResourceTemplateSchema>(
					session,
					"resources/templates/list",
					"resourceTemplates",
					timeout,
				),
			)
		: complete<McpResourceTemplateSchema>();
	const promptsResult = capabilities?.prompts
		? await settleMcpList(() =>
				listMethod<McpPromptSchema>(
					session,
					"prompts/list",
					"prompts",
					timeout,
				),
			)
		: complete<McpPromptSchema>();
	const skillsAdvertised = Object.hasOwn(
		capabilities?.extensions ?? {},
		"io.modelcontextprotocol/skills",
	);
	const skillsResult = skillsAdvertised
		? await settleMcpList(() =>
				listMethod(
					session,
					"skills/list",
					"skills",
					timeout,
					parseMcpSkillManifest,
				),
			)
		: complete<McpSkillManifest>();

	// A rejected list yields no entries AND no knowledge, so it is truncated:
	// the empty array must never be read as "the server has none".
	const entries = <T>(result: PromiseSettledResult<BoundedMcpList<T>>): T[] =>
		result.status === "fulfilled" ? result.value.items : [];
	const truncated = (
		result: PromiseSettledResult<BoundedMcpList<unknown>>,
	): boolean => result.status !== "fulfilled" || result.value.truncated;

	const allResults = [
		toolsResult,
		resourcesResult,
		resourceTemplatesResult,
		promptsResult,
		skillsResult,
	];
	const authErrors = allResults.filter(
		(r) => r.status === "rejected" && r.reason instanceof AuthRequiredError,
	);

	const methodErrors: Record<string, string> = {};
	const failure = (result: PromiseSettledResult<unknown>) =>
		result.status === "rejected"
			? errorMessage(session.sdk, result.reason)
			: undefined;
	for (const [name, result] of [
		["tools", toolsResult],
		["resources", resourcesResult],
		["resourceTemplates", resourceTemplatesResult],
		["prompts", promptsResult],
		["skills", skillsResult],
	] as const) {
		const message = failure(result);
		if (message !== undefined) methodErrors[name] = message;
	}

	return {
		name: serverVersion?.name ?? "unknown",
		version: serverVersion?.version,
		protocolVersion: client.getNegotiatedProtocolVersion(),
		capabilities,
		instructions: client.getInstructions(),
		tools: entries(toolsResult),
		resources: entries(resourcesResult),
		resourceTemplates: entries(resourceTemplatesResult),
		prompts: entries(promptsResult),
		skills: entries(skillsResult),
		listsTruncated: {
			tools: truncated(toolsResult),
			resources: truncated(resourcesResult),
			resourceTemplates: truncated(resourceTemplatesResult),
			prompts: truncated(promptsResult),
			skills: truncated(skillsResult),
		},
		methodErrors:
			Object.keys(methodErrors).length > 0 ? methodErrors : undefined,
		partialAuth: authErrors.length > 0 && authErrors.length < allResults.length,
	};
}

// =============================================================================
// Tool Call Interface
// =============================================================================

export interface ToolCallResult {
	success: boolean;
	output?: unknown;
	/** Full MCP result including vendor extensions like _meta, structuredContent */
	rawResult?: Record<string, unknown>;
	error?: string;
	errorCode?: string;
	latencyMs: number;
	isError?: boolean;
}

export interface CallMcpToolOptions {
	timeout?: number;
	fetchFn?: FetchFn;
	headers?: Record<string, string>;
	clientName?: string;
	clientCapabilities?: Record<string, unknown>;
}

/**
 * Call an MCP tool and return its result
 *
 * `tools/call` is sent exactly once: input_required is reported as
 * `INPUT_REQUIRED` (never auto-fulfilled), and the explicit tool definition
 * disables the SDK's `-32020` list-and-resend.
 *
 * @param endpoint - The MCP server endpoint URL
 * @param toolName - Name of the tool to call
 * @param args - Arguments to pass to the tool
 * @param options - Call options (timeout)
 */
export async function callMcpTool(
	endpoint: string,
	toolName: string,
	args: Record<string, unknown>,
	options: CallMcpToolOptions = {},
): Promise<ToolCallResult> {
	const { timeout = 15000 } = options;
	const startTime = Date.now();

	// Validate URL
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return {
			success: false,
			error: "Invalid URL",
			errorCode: "INVALID_URL",
			latencyMs: 0,
		};
	}

	let session: McpSession | undefined;
	let key: string | undefined;
	let stage: "connect" | "call" = "connect";
	try {
		if (url.pathname.toLowerCase().endsWith("/sse"))
			throw new Error(
				"Legacy MCP SSE transport is not supported; use MCP 2026-07-28 Streamable HTTP",
			);

		session = await createMcpSession(endpoint, {
			fetchFn: options.fetchFn ?? defaultFetch,
			headers: options.headers,
			clientName: options.clientName,
			clientCapabilities: options.clientCapabilities,
		});
		key = await eraKey(endpoint, options.headers);
		await session.connect({ timeout, prior: rememberedEra(key) });
		rememberEra(key, session.client);

		stage = "call";
		const { client } = session;
		const result = (await session.run(() =>
			client.callTool(
				{ name: toolName, arguments: args },
				{
					timeout,
					allowInputRequired: true,
					toolDefinition: { name: toolName, inputSchema: { type: "object" } },
				},
			),
		)) as Record<string, unknown>;

		const inputRequired = readInputRequiredResult(result);
		if (inputRequired) {
			throw new InputRequiredError(
				toolName,
				inputRequired.inputRequests,
				inputRequired.requestState,
			);
		}

		const rawResult = {
			content: result.content,
			isError: result.isError as boolean | undefined,
			_meta: result._meta,
			structuredContent: result.structuredContent,
		};
		return {
			success: true,
			output: rawResult.content,
			rawResult,
			isError: rawResult.isError,
			latencyMs: Date.now() - startTime,
		};
	} catch (e) {
		const latencyMs = Date.now() - startTime;
		// A JSON-RPC error answering tools/call says nothing about the era.
		if (
			key &&
			(stage === "connect" ||
				!(session && e instanceof session.sdk.ProtocolError))
		)
			eras.delete(key);

		if (e instanceof AuthRequiredError) {
			return {
				success: false,
				error: e.message,
				errorCode: "AUTH_REQUIRED",
				latencyMs,
			};
		}

		if (e instanceof InputRequiredError) {
			return {
				success: false,
				error: e.message,
				errorCode: "INPUT_REQUIRED",
				rawResult: {
					resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
					...(e.inputRequests ? { inputRequests: e.inputRequests } : {}),
					...(e.requestState ? { requestState: e.requestState } : {}),
				},
				isError: true,
				latencyMs,
			};
		}

		const error = session
			? errorMessage(session.sdk, e)
			: e instanceof Error
				? e.message
				: String(e);
		let errorCode = "UNKNOWN";
		if (
			(session && isTimeout(session.sdk, e)) ||
			error.includes("timeout") ||
			error.includes("aborted")
		) {
			errorCode = "TIMEOUT";
		} else if (error.includes("401") || error.includes("403")) {
			errorCode = "AUTH_REQUIRED";
		}

		return { success: false, error, errorCode, latencyMs };
	} finally {
		await session?.close();
	}
}
