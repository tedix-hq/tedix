/**
 * Read-only WebMCP bridge for Emdash tenant sites.
 *
 * The browser bridge is the shared `@tedix/webmcp-core` ES module (it follows
 * Cloudflare's `mcp-server-client` pack shape) while the backing endpoint
 * implements the stateless MCP 2026-07-28 request model. This is a public
 * surface: every input, subrequest, redirect, and response is bounded here
 * rather than relying on the tenant bundle.
 */

import {
	WEBMCP_BRIDGE_PROTOCOL_VERSION,
	webMcpBridgeScript,
} from "@tedix/webmcp-core/bridge-script";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export const WEBMCP_BRIDGE_PATH = "/_tedix/webmcp/bridge.js";
export const WEBMCP_MCP_PATH = "/_tedix/webmcp/mcp";
/** Kept in lockstep with the shared bridge so the endpoint and script agree. */
export const WEBMCP_PROTOCOL_VERSION = WEBMCP_BRIDGE_PROTOCOL_VERSION;

const WEBMCP_USER_AGENT = "TedixWebMCPBridge/2.0 (+https://tedix.dev)";
const WEBMCP_REQUEST_MAX_BYTES = 16 * 1024;
const WEBMCP_SEARCH_MAX_BYTES = 256 * 1024;
const WEBMCP_PAGE_MAX_BYTES = 512 * 1024;
// Native multi-collection search takes ~7s over tenant DB RPCs; allow it to finish.
const WEBMCP_FETCH_TIMEOUT_MS = 15_000;
const WEBMCP_MAX_REDIRECTS = 3;
const SEARCH_QUERY_MAX_CHARS = 160;
const READ_PAGE_PATH_MAX_CHARS = 1_024;
const READ_PAGE_MAX_CHARS = 4_000;
const TOOL_LIST_TTL_MS = 60 * 60 * 1_000;

export type WebMcpToolPack = "site-search" | "page-reader";
const DEFAULT_WEBMCP_TOOL_PACKS: readonly WebMcpToolPack[] = [
	"site-search",
	"page-reader",
];

export interface WebMcpOrgInfo {
	slug: string;
	siteTitle: string;
	publicSiteUrl: string;
	publicPathPrefix: string | null;
	webMcpToolPacks: readonly WebMcpToolPack[];
}

export function normalizeWebMcpToolPacks(value: unknown): WebMcpToolPack[] {
	if (value === undefined) return [...DEFAULT_WEBMCP_TOOL_PACKS];
	if (!Array.isArray(value)) return [];
	const allowed = new Set<WebMcpToolPack>(DEFAULT_WEBMCP_TOOL_PACKS);
	return Array.from(
		new Set(
			value.filter((entry): entry is WebMcpToolPack =>
				allowed.has(entry as WebMcpToolPack),
			),
		),
	);
}

const TOOL_BY_PACK = {
	"site-search": {
		name: "search_site",
		title: "Search published pages",
		description:
			"Search this site's published content and return titles, URLs, and text excerpts.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					minLength: 1,
					maxLength: SEARCH_QUERY_MAX_CHARS,
				},
				collections: {
					type: "array",
					maxItems: 20,
					items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
				},
				locale: { type: "string", pattern: "^[a-zA-Z0-9-]{1,35}$" },
				limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
			},
			required: ["query"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							url: { type: "string" },
							title: { type: "string" },
							excerpt: { type: "string" },
						},
						required: ["url", "title"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, untrustedContentHint: true },
	},
	"page-reader": {
		name: "read_page",
		title: "Read a published page",
		description:
			"Fetch a page on this site and return its title and bounded readable text content.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					minLength: 1,
					maxLength: READ_PAGE_PATH_MAX_CHARS,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				url: { type: "string" },
				title: { type: "string" },
				text: { type: "string", maxLength: READ_PAGE_MAX_CHARS },
			},
			required: ["url", "title", "text"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, untrustedContentHint: true },
	},
} as const;

function toolsForOrg(org: WebMcpOrgInfo) {
	return org.webMcpToolPacks.map((pack) => TOOL_BY_PACK[pack]);
}

export function webMcpBridgeScriptResponse(head = false): Response {
	return new Response(head ? null : webMcpBridgeScript(), {
		status: 200,
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "public, max-age=3600",
			"x-content-type-options": "nosniff",
		},
	});
}

export function ensureWebMcpBridge(html: string, org: WebMcpOrgInfo): string {
	if (
		org.webMcpToolPacks.length === 0 ||
		html.includes("data-tedix-webmcp") ||
		html.includes(WEBMCP_BRIDGE_PATH)
	) {
		return html;
	}
	const prefix = org.publicPathPrefix ?? "";
	const mcpUrl = `${prefix}${WEBMCP_MCP_PATH}`;
	const scriptSrc = `${prefix}${WEBMCP_BRIDGE_PATH}?mcp-url=${encodeURIComponent(mcpUrl)}`;
	return html.replace(
		/<\/head>/i,
		`\n\t\t<script type="module" src="${scriptSrc}" data-packs="mcp-server-client" data-mcp-url="${mcpUrl}" data-tedix-webmcp></script>\n$&`,
	);
}

interface WebMcpRateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function handleWebMcpRequest(
	request: Request,
	org: WebMcpOrgInfo,
	pathname: string,
	rateLimiter: WebMcpRateLimiter,
): Promise<Response | null> {
	if (pathname === WEBMCP_BRIDGE_PATH) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			});
		}
		if (org.webMcpToolPacks.length === 0)
			return new Response("Not Found", { status: 404 });
		return webMcpBridgeScriptResponse(request.method === "HEAD");
	}
	if (pathname !== WEBMCP_MCP_PATH) return null;
	if (org.webMcpToolPacks.length === 0)
		return new Response("Not Found", { status: 404 });
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	}

	const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
	const rate = await rateLimiter.limit({ key: `${org.slug}:${actor}` });
	if (!rate.success) {
		return jsonRpcResponse(
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32000, message: "Rate limit exceeded" },
			},
			429,
			{ "retry-after": "60" },
		);
	}
	return handleWebMcpJsonRpc(request, org);
}

type JsonRpcId = string | number;
interface JsonRpcRequestBody {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
	_meta: Record<string, unknown>;
}

function jsonRpcResponse(
	body: unknown,
	status = 200,
	extraHeaders?: HeadersInit,
): Response {
	const headers = new Headers(extraHeaders);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("x-content-type-options", "nosniff");
	return new Response(JSON.stringify(body), { status, headers });
}

function rpcError(
	id: JsonRpcId | null,
	code: number,
	message: string,
	status = 200,
): Response {
	return jsonRpcResponse(
		{ jsonrpc: "2.0", id, error: { code, message } },
		status,
	);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return keys.every((key) => allowed.includes(key));
}

async function readBoundedRequestBody(request: Request): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > WEBMCP_REQUEST_MAX_BYTES) {
		throw new Error("Request body too large");
	}
	if (!request.body) return "";
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > WEBMCP_REQUEST_MAX_BYTES)
				throw new Error("Request body too large");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		void reader.cancel();
	}
}

function validateProtocolRequest(
	value: unknown,
	request: Request,
): JsonRpcRequestBody | string {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["jsonrpc", "id", "method", "params", "_meta"])
	)
		return "Invalid JSON-RPC request";
	if (value.jsonrpc !== "2.0") return "jsonrpc must be 2.0";
	if (typeof value.id !== "string" && typeof value.id !== "number")
		return "id must be a string or number";
	if (typeof value.method !== "string") return "method must be a string";
	if (value.params !== undefined && !isRecord(value.params))
		return "params must be an object";
	if (!isRecord(value._meta)) return "_meta is required";
	if (
		value._meta["io.modelcontextprotocol/protocolVersion"] !==
		WEBMCP_PROTOCOL_VERSION
	)
		return `Unsupported protocol version; expected ${WEBMCP_PROTOCOL_VERSION}`;
	if (!isRecord(value._meta["io.modelcontextprotocol/clientInfo"]))
		return "clientInfo metadata is required";
	if (!isRecord(value._meta["io.modelcontextprotocol/clientCapabilities"]))
		return "clientCapabilities metadata is required";
	const headerVersion = request.headers.get("mcp-protocol-version");
	const headerMethod = request.headers.get("mcp-method");
	if (
		headerVersion !== WEBMCP_PROTOCOL_VERSION ||
		headerMethod !== value.method
	)
		return "MCP routing headers do not match the request";
	if (
		value.method === "tools/call" &&
		request.headers.get("mcp-name") !== value.params?.name
	)
		return "Mcp-Name does not match the tool call";
	return value as unknown as JsonRpcRequestBody;
}

async function handleWebMcpJsonRpc(
	request: Request,
	org: WebMcpOrgInfo,
): Promise<Response> {
	if (
		!(request.headers.get("content-type") ?? "")
			.toLowerCase()
			.startsWith("application/json")
	)
		return rpcError(null, -32600, "Content-Type must be application/json", 415);
	let decoded: unknown;
	try {
		decoded = JSON.parse(await readBoundedRequestBody(request));
	} catch (error) {
		const tooLarge =
			error instanceof Error && error.message === "Request body too large";
		return rpcError(
			null,
			tooLarge ? -32600 : -32700,
			tooLarge ? "Request body too large" : "Parse error",
			tooLarge ? 413 : 200,
		);
	}
	const validated = validateProtocolRequest(decoded, request);
	if (typeof validated === "string")
		return rpcError(
			isRecord(decoded) &&
				(typeof decoded.id === "string" || typeof decoded.id === "number")
				? decoded.id
				: null,
			-32600,
			validated,
		);
	const { id, method, params } = validated;

	if (method === "tools/list") {
		if (
			params &&
			(!hasOnlyKeys(params, ["cursor"]) ||
				(params.cursor !== undefined && typeof params.cursor !== "string"))
		)
			return rpcError(id, -32602, "Invalid tools/list parameters");
		if (params?.cursor)
			return rpcError(id, -32602, "Pagination cursor is not supported");
		return jsonRpcResponse({
			jsonrpc: "2.0",
			id,
			result: {
				resultType: "complete",
				tools: toolsForOrg(org),
				ttlMs: TOOL_LIST_TTL_MS,
				cacheScope: "public",
			},
		});
	}

	if (method === "tools/call") {
		if (
			!params ||
			!hasOnlyKeys(params, ["name", "arguments"]) ||
			typeof params.name !== "string" ||
			(params.arguments !== undefined && !isRecord(params.arguments))
		)
			return rpcError(id, -32602, "Invalid tools/call parameters");
		const tool = toolsForOrg(org).find(
			(candidate) => candidate.name === params.name,
		);
		if (!tool)
			return rpcError(id, -32602, `Unknown or disabled tool: ${params.name}`);
		try {
			const result = await callWebMcpTool(
				org,
				params.name,
				(params.arguments ?? {}) as Record<string, unknown>,
			);
			return jsonRpcResponse({
				jsonrpc: "2.0",
				id,
				result: { resultType: "complete", ...result },
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Tool execution failed";
			return jsonRpcResponse({
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				},
			});
		}
	}

	return rpcError(id, -32601, `Method not found: ${method}`);
}

async function callWebMcpTool(
	org: WebMcpOrgInfo,
	name: string,
	args: Record<string, unknown>,
) {
	if (name === "search_site") {
		if (
			!hasOnlyKeys(args, ["query", "collections", "locale", "limit"]) ||
			typeof args.query !== "string"
		)
			throw new Error("query must be a string");
		if (
			args.collections !== undefined &&
			(!Array.isArray(args.collections) ||
				args.collections.length > 20 ||
				args.collections.some(
					(value) =>
						typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value),
				))
		)
			throw new Error("collections must contain valid collection slugs");
		if (
			args.locale !== undefined &&
			(typeof args.locale !== "string" ||
				!/^[a-zA-Z0-9-]{1,35}$/.test(args.locale))
		)
			throw new Error("locale must be a valid locale code");
		if (
			args.limit !== undefined &&
			(typeof args.limit !== "number" ||
				!Number.isInteger(args.limit) ||
				args.limit < 1 ||
				args.limit > 100)
		)
			throw new Error("limit must be an integer from 1 to 100");
		return searchSite(org, args.query, {
			collections: args.collections as string[] | undefined,
			locale: args.locale as string | undefined,
			limit: (args.limit as number | undefined) ?? 10,
		});
	}
	if (name === "read_page") {
		if (!hasOnlyKeys(args, ["path"]) || typeof args.path !== "string")
			throw new Error("path must be a string");
		return readPage(org, args.path);
	}
	throw new Error(`Unknown tool: ${name}`);
}

function publicBase(org: WebMcpOrgInfo): URL | null {
	try {
		const url = new URL(org.publicSiteUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url;
	} catch {
		return null;
	}
}

function isPathWithinPrefix(pathname: string, prefix: string | null): boolean {
	if (!prefix) return true;
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function assertAllowedPublicUrl(org: WebMcpOrgInfo, url: URL): void {
	const base = publicBase(org);
	if (
		!base ||
		url.origin !== base.origin ||
		!isPathWithinPrefix(url.pathname, org.publicPathPrefix)
	)
		throw new Error(
			"URL must stay on this tenant's public site and path prefix",
		);
}

function publicUrlFor(org: WebMcpOrgInfo, path: string): URL | null {
	const base = publicBase(org);
	if (!base) return null;
	const prefix = org.publicPathPrefix ?? "";
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const prefixedPath = isPathWithinPrefix(normalizedPath, org.publicPathPrefix)
		? normalizedPath
		: `${prefix}${normalizedPath}`;
	const url = new URL(prefixedPath, base.origin);
	assertAllowedPublicUrl(org, url);
	return url;
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new Error("Upstream response is too large");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Upstream response is too large");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		void reader.cancel();
	}
}

async function fetchTenantResource(
	org: WebMcpOrgInfo,
	initial: URL,
	maxBytes: number,
): Promise<{ response: Response; body: string; finalUrl: URL }> {
	let current = initial;
	for (let redirects = 0; redirects <= WEBMCP_MAX_REDIRECTS; redirects++) {
		assertAllowedPublicUrl(org, current);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			WEBMCP_FETCH_TIMEOUT_MS,
		);
		let response: Response;
		try {
			response = await fetch(current, {
				redirect: "manual",
				signal: controller.signal,
				headers: { "User-Agent": WEBMCP_USER_AGENT },
			});
		} catch (error) {
			if (controller.signal.aborted)
				throw new Error("Upstream request timed out");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Upstream redirect has no location");
			if (redirects === WEBMCP_MAX_REDIRECTS)
				throw new Error("Too many upstream redirects");
			current = new URL(location, current);
			assertAllowedPublicUrl(org, current);
			continue;
		}
		if (!response.ok)
			throw new Error(`Upstream request failed (${response.status})`);
		return {
			response,
			body: await readBoundedResponse(response, maxBytes),
			finalUrl: current,
		};
	}
	throw new Error("Too many upstream redirects");
}

async function searchSite(
	org: WebMcpOrgInfo,
	query: string,
	options: { collections?: string[]; locale?: string; limit: number },
) {
	const trimmed = query.trim();
	if (!trimmed || trimmed.length > SEARCH_QUERY_MAX_CHARS)
		throw new Error(
			`query must contain 1-${SEARCH_QUERY_MAX_CHARS} characters`,
		);
	const searchUrl = publicUrlFor(org, "/_tedix/search.json");
	if (!searchUrl) throw new Error("This site has no public URL configured");
	searchUrl.search = new URLSearchParams({
		q: trimmed,
		...(options.limit !== 10 ? { limit: String(options.limit) } : {}),
		...(options.collections?.length
			? { collections: options.collections.join(",") }
			: {}),
		...(options.locale ? { locale: options.locale } : {}),
	}).toString();
	const { body } = await fetchTenantResource(
		org,
		searchUrl,
		WEBMCP_SEARCH_MAX_BYTES,
	);
	const payload: unknown = JSON.parse(body);
	if (
		!isRecord(payload) ||
		!isRecord(payload.data) ||
		!Array.isArray(payload.data.items)
	)
		throw new Error("Invalid native search response");
	const matches = payload.data.items
		.slice(0, options.limit)
		.flatMap((item: unknown) => {
			if (
				!isRecord(item) ||
				typeof item.collection !== "string" ||
				typeof item.id !== "string"
			)
				return [];
			if (typeof item.url !== "string" || typeof item.title !== "string")
				return [];
			try {
				const url = new URL(item.url);
				assertAllowedPublicUrl(org, url);
				// Native snippets contain escaped source text and literal highlight marks.
				// Match EmDash WebMcpSearch's plain-text excerpt conversion.
				const excerpt =
					typeof item.snippet === "string"
						? item.snippet
								.replace(/<\/?mark>/g, "")
								.replaceAll("&lt;", "<")
								.replaceAll("&gt;", ">")
								.replaceAll("&quot;", '\"')
								.replaceAll("&#39;", "'")
								.replaceAll("&amp;", "&")
						: undefined;
				return [
					{
						url: url.toString(),
						title: item.title,
						...(excerpt ? { excerpt } : {}),
					},
				];
			} catch {
				throw new Error(
					"Native search URL is outside this tenant's public site or mount.",
				);
			}
		});
	const text = matches.length
		? matches
				.map(
					(match) =>
						`${match.title} — ${match.url}${match.excerpt ? `\n${match.excerpt}` : ""}`,
				)
				.join("\n")
		: `No pages matched "${trimmed}".`;
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: { results: matches },
	};
}

async function extractReadablePage(
	response: Response,
): Promise<{ title: string; text: string }> {
	let title = "";
	const chunks: string[] = [];
	let totalLen = 0;
	let skipDepth = 0;
	const skipTag = {
		element(element: Element) {
			skipDepth++;
			element.onEndTag(() => {
				skipDepth = Math.max(0, skipDepth - 1);
			});
		},
	};
	const rewriter = new HTMLRewriter()
		.on("title", {
			text(chunk) {
				title += chunk.text;
			},
		})
		.on("script", skipTag)
		.on("style", skipTag)
		.on("noscript", skipTag)
		.on("body *", {
			text(chunk) {
				if (skipDepth > 0 || totalLen >= READ_PAGE_MAX_CHARS) return;
				const piece = chunk.text.replace(/\s+/g, " ");
				if (piece.trim()) {
					chunks.push(piece);
					totalLen += piece.length;
				}
			},
		});
	await rewriter.transform(response).arrayBuffer();
	return {
		title: title.trim(),
		text: chunks
			.join(" ")
			.replace(/\s{2,}/g, " ")
			.trim()
			.slice(0, READ_PAGE_MAX_CHARS),
	};
}

async function readPage(org: WebMcpOrgInfo, path: string) {
	const trimmed = path.trim();
	if (!trimmed || trimmed.length > READ_PAGE_PATH_MAX_CHARS)
		throw new Error(
			`path must contain 1-${READ_PAGE_PATH_MAX_CHARS} characters`,
		);
	let target: URL;
	try {
		target = /^https?:\/\//i.test(trimmed)
			? new URL(trimmed)
			: publicUrlFor(org, trimmed)!;
		assertAllowedPublicUrl(org, target);
	} catch {
		throw new Error(
			"path must be a URL on this tenant's public site and path prefix",
		);
	}
	const { response, body, finalUrl } = await fetchTenantResource(
		org,
		target,
		WEBMCP_PAGE_MAX_BYTES,
	);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("html"))
		throw new Error("Page is not HTML");
	const { title, text } = await extractReadablePage(
		new Response(body, { headers: response.headers }),
	);
	return {
		content: [
			{
				type: "text" as const,
				text: `${title || finalUrl.toString()}\n\n${text}`,
			},
		],
		structuredContent: { url: finalUrl.toString(), title, text },
	};
}
