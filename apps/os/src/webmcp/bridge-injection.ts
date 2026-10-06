import { webMcpBridgeScript } from "@tedix/webmcp-core/bridge-script";

/**
 * WebMCP bridge serving and SPA-shell injection for Tedix OS.
 *
 * The Cloudflare zone-level WebMCP toggle is off, so
 * this Worker serves the shared `@tedix/webmcp-core` bridge itself and injects
 * its `<script type="module">` tag into the shell document — the same
 * mechanism `apps/cms-runtime/src/webmcp.ts` uses for tenant sites.
 *
 * Injection happens on TENANT hosts only: the same-origin `/mcp` relay the
 * bridge talks to is mounted exclusively on provisioned tenant hostnames, so
 * on the launcher (and the local-dev host) a bridge would only probe an
 * endpoint that does not exist. The script itself is still served on the
 * launcher so the path behaves uniformly across OS hosts.
 *
 * Typed against structural HTMLRewriter interfaces: `worker.ts` and this
 * module stay importable in the app's DOM-lib test environment, where the
 * workerd global is absent and injection degrades to a pass-through.
 */

export const WEBMCP_BRIDGE_PATH = "/_tedix/webmcp/bridge.js";

/** The same-origin MCP relay the injected bridge is pointed at. */
export const WEBMCP_ENDPOINT_PATH = "/mcp";

/**
 * Documents are `private, no-store`, but the bridge is static JS whose content
 * changes only on deploy — an hour of private caching is safe and saves a
 * round-trip per navigation.
 */
export const WEBMCP_BRIDGE_CACHE_CONTROL = "private, max-age=3600";

type OsTenantKind = "tenant" | "launcher" | "local" | "invalid";

/**
 * The tag mirrors cms-runtime's conventions: `mcp-url` rides in the module
 * URL's query (because `document.currentScript` is undefined for ES modules,
 * the bridge reads `import.meta.url`) AND in `data-mcp-url`, with
 * `data-tedix-webmcp` marking the injection.
 */
export function webMcpBridgeTag(): string {
	const src = `${WEBMCP_BRIDGE_PATH}?mcp-url=${encodeURIComponent(WEBMCP_ENDPOINT_PATH)}`;
	return `<script type="module" src="${src}" data-mcp-url="${WEBMCP_ENDPOINT_PATH}" data-tedix-webmcp></script>`;
}

/** The bridge script is served on every real OS host, tenant or launcher. */
export function servesWebMcpBridge(kind: OsTenantKind): boolean {
	return kind === "tenant" || kind === "launcher";
}

/** Inject only where the same-origin `/mcp` relay actually exists. */
export function shouldInjectWebMcpBridge(
	kind: OsTenantKind,
	response: Response,
): boolean {
	if (kind !== "tenant") return false;
	const contentType = response.headers.get("Content-Type") ?? "";
	return contentType.toLowerCase().includes("text/html");
}

/**
 * `GET /_tedix/webmcp/bridge.js`. The caller passes its response finalizer
 * (the Worker's `withSecurityHeaders`) so the bridge carries the exact same
 * header set as every other response — except `Cache-Control`, re-stamped
 * after finalization because the document policy (`private, no-store`) is
 * deliberately not applied to this static script.
 */
export function webMcpBridgeResponse(
	request: Request,
	finalize: (response: Response) => Response = (response) => response,
): Response {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return finalize(
			new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			}),
		);
	}
	const response = finalize(
		new Response(request.method === "HEAD" ? null : webMcpBridgeScript(), {
			status: 200,
			headers: { "Content-Type": "text/javascript; charset=utf-8" },
		}),
	);
	response.headers.set("Cache-Control", WEBMCP_BRIDGE_CACHE_CONTROL);
	return response;
}

/** Structural slice of workerd's HTMLRewriter so DOM-lib tests can import this module. */
interface HtmlRewriterElementLike {
	append(content: string, options?: { html?: boolean }): unknown;
}
interface HtmlRewriterLike {
	on(
		selector: string,
		handlers: { element(element: HtmlRewriterElementLike): void },
	): HtmlRewriterLike;
	transform(response: Response): Response;
}

/**
 * Append the bridge tag into `<head>` of an HTML document response. The input
 * is the already-header-stamped response; HTMLRewriter's `transform` preserves
 * status and headers, so the security header set survives injection intact.
 * Outside workerd (the DOM-lib test environment) this is a pass-through.
 */
export function injectWebMcpBridge(
	response: Response,
	kind: OsTenantKind,
): Response {
	if (!shouldInjectWebMcpBridge(kind, response)) return response;
	const Rewriter = (globalThis as { HTMLRewriter?: new () => HtmlRewriterLike })
		.HTMLRewriter;
	if (!Rewriter) return response;
	return new Rewriter()
		.on("head", {
			element(element) {
				element.append(webMcpBridgeTag(), { html: true });
			},
		})
		.transform(response);
}
