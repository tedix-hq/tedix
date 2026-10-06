/**
 * Shared WebMCP browser bridge, served as a string by any Worker that exposes
 * a same-origin MCP JSON-RPC endpoint (cms-runtime tenant sites today, more
 * surfaces next). The emitted script is a dependency-free vanilla ES module:
 * it feature-detects the WebMCP surface, resolves the endpoint from its own
 * `import.meta.url` (because `document.currentScript` is null for ES modules),
 * enforces same-origin, lists tools over JSON-RPC, and registers each one as
 * a proxy that forwards `tools/call` back to the endpoint.
 *
 * Two deliberate improvements over the original cms-runtime copy:
 *
 * 1. Detection follows the current draft at `document.modelContext` first and
 *    falls back to `navigator.modelContext` for deployed experiments. Neither
 *    present is still a silent no-op — the bridge must never break the page.
 * 2. Current `registerTool(tool, { signal })` is preferred, with the older
 *    whole-set `provideContext({ tools })` retained as a compatibility fallback.
 *
 * Retry policy: endpoint discovery /
 * tools/list failures retry with EXPONENTIAL BACKOFF and FULL JITTER — base
 * ~5s, factor 2, cap ~5min, reset on a successful response. The previous
 * fixed-interval retry meant every open tab hammered a struggling MCP endpoint
 * in lockstep (29 consecutive relay 502s, one retry per ~16s per tab, no
 * backoff), which is exactly the load pattern that keeps a wedged upstream
 * wedged.
 */

export const WEBMCP_BRIDGE_PROTOCOL_VERSION = "2026-07-28";

const BRIDGE_JS_SOURCE = `// Tedix WebMCP bridge — shared @tedix/webmcp-core build.
(function () {
	"use strict";
	var readinessAttempts = 0;
	var maxReadinessAttempts = 50;
	var readinessDelayMs = 100;
	// Exponential backoff with full jitter for endpoint discovery/tools-list
	// retries: delay = random() * min(cap, base * 2^attempt). Reset on success.
	var retryAttempt = 0;
	var retryBaseMs = 5000;
	var retryCapMs = 300000;

	function boot() {
		var surface =
			(typeof document !== "undefined" ? document.modelContext : undefined) ??
			(typeof navigator !== "undefined" ? navigator.modelContext : undefined) ??
			null;
		if (!surface) {
			if (readinessAttempts++ < maxReadinessAttempts) {
				setTimeout(boot, readinessDelayMs);
			}
			return;
		}
		var canRegisterTool = typeof surface.registerTool === "function";
		var canProvideContext = typeof surface.provideContext === "function";
		if (!canRegisterTool && !canProvideContext) return;

		var moduleUrl = new URL(import.meta.url);
	var configuredMcpUrl = moduleUrl.searchParams.get("mcp-url");
	var fallbackPath = moduleUrl.pathname.endsWith("/bridge.js")
		? moduleUrl.pathname.slice(0, -"bridge.js".length) + "mcp"
		: "/_tedix/webmcp/mcp";
	var absoluteMcpUrl = new URL(configuredMcpUrl || fallbackPath, moduleUrl.origin);
	if (absoluteMcpUrl.origin !== window.location.origin) return;
	var nextId = 1;

	function rpc(method, params, name) {
		var id = nextId++;
		var headers = {
			"accept": "application/json",
			"content-type": "application/json",
			"mcp-protocol-version": "${WEBMCP_BRIDGE_PROTOCOL_VERSION}",
			"mcp-method": method,
		};
		if (name) headers["mcp-name"] = name;
		return fetch(absoluteMcpUrl.toString(), {
			method: "POST",
			credentials: "same-origin",
			headers: headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: id,
				method: method,
				params: params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "${WEBMCP_BRIDGE_PROTOCOL_VERSION}",
					"io.modelcontextprotocol/clientInfo": { name: "tedix-webmcp-bridge", version: "2.0.0" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			}),
		}).then(function (res) {
			return res.json().then(function (payload) {
				if (!res.ok || (payload && payload.error)) throw new Error((payload && payload.error && payload.error.message) || "MCP request failed");
				return payload && payload.result;
			});
		});
	}

	function toolDefFor(tool) {
		return {
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			execute: function (args) {
				return rpc("tools/call", { name: tool.name, arguments: args || {} }, tool.name);
			},
		};
	}

		function scheduleRetry() {
			var expo = retryBaseMs * Math.pow(2, retryAttempt);
			var cappedMs = expo < retryCapMs ? expo : retryCapMs;
			retryAttempt++;
			setTimeout(listAndRegisterTools, Math.random() * cappedMs);
		}

		function listAndRegisterTools() {
		return rpc("tools/list", {})
		.then(function (result) {
			// The endpoint answered: reset the backoff so a later transient
			// failure starts again from the base delay.
			retryAttempt = 0;
			var tools = ((result && result.tools) || []).map(toolDefFor);
			if (canRegisterTool) {
				var controller = new AbortController();
				return Promise.all(tools.map(function (tool) {
					return surface.registerTool(tool, { signal: controller.signal });
				})).catch(function (error) {
					controller.abort();
					throw error;
				});
			} else {
				surface.provideContext({ tools: tools });
			}
		})
		.catch(function () {
			scheduleRetry();
		});
		}

		listAndRegisterTools();
	}

	boot();
})();
`;

/** The bridge ES-module source, ready to serve as `application/javascript`. */
export function webMcpBridgeScript(): string {
	return BRIDGE_JS_SOURCE;
}
