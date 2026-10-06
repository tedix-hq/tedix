// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { webMcpBridgeScript } from "@tedix/webmcp-core/bridge-script";
import {
	injectWebMcpBridge,
	servesWebMcpBridge,
	shouldInjectWebMcpBridge,
	WEBMCP_BRIDGE_CACHE_CONTROL,
	WEBMCP_BRIDGE_PATH,
	webMcpBridgeResponse,
	webMcpBridgeTag,
} from "./bridge-injection";

const htmlResponse = () =>
	new Response("<html><head></head><body></body></html>", {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});

describe("webMcpBridgeTag", () => {
	it("mirrors the cms-runtime attribute conventions", () => {
		expect(webMcpBridgeTag()).toBe(
			`<script type="module" src="${WEBMCP_BRIDGE_PATH}?mcp-url=%2Fmcp" data-mcp-url="/mcp" data-tedix-webmcp></script>`,
		);
	});
});

describe("servesWebMcpBridge", () => {
	it("serves the script on tenant hosts and the launcher only", () => {
		expect(servesWebMcpBridge("tenant")).toBe(true);
		expect(servesWebMcpBridge("launcher")).toBe(true);
		expect(servesWebMcpBridge("local")).toBe(false);
		expect(servesWebMcpBridge("invalid")).toBe(false);
	});
});

describe("shouldInjectWebMcpBridge", () => {
	it("injects only into tenant-host HTML documents", () => {
		expect(shouldInjectWebMcpBridge("tenant", htmlResponse())).toBe(true);
	});

	it("skips the launcher — it mounts no same-origin /mcp relay", () => {
		expect(shouldInjectWebMcpBridge("launcher", htmlResponse())).toBe(false);
		expect(shouldInjectWebMcpBridge("local", htmlResponse())).toBe(false);
	});

	it("skips non-HTML responses", () => {
		expect(
			shouldInjectWebMcpBridge(
				"tenant",
				new Response("{}", {
					headers: { "Content-Type": "application/json" },
				}),
			),
		).toBe(false);
		expect(shouldInjectWebMcpBridge("tenant", new Response(null))).toBe(false);
	});
});

describe("webMcpBridgeResponse", () => {
	it("serves the shared bridge as JavaScript with a bounded private cache", async () => {
		const response = webMcpBridgeResponse(
			new Request("https://acme.os.tedix.dev/_tedix/webmcp/bridge.js"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(response.headers.get("Cache-Control")).toBe(
			WEBMCP_BRIDGE_CACHE_CONTROL,
		);
		expect(await response.text()).toBe(webMcpBridgeScript());
	});

	it("runs the caller's finalizer, then re-stamps only Cache-Control", () => {
		const response = webMcpBridgeResponse(
			new Request("https://acme.os.tedix.dev/_tedix/webmcp/bridge.js"),
			(inner) => {
				// The Worker's withSecurityHeaders: stamps the document policy.
				inner.headers.set("Cache-Control", "private, no-store");
				inner.headers.set("X-Frame-Options", "DENY");
				inner.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
				return inner;
			},
		);
		expect(response.headers.get("Cache-Control")).toBe(
			WEBMCP_BRIDGE_CACHE_CONTROL,
		);
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
	});

	it("answers HEAD with headers and no body", async () => {
		const response = webMcpBridgeResponse(
			new Request("https://acme.os.tedix.dev/_tedix/webmcp/bridge.js", {
				method: "HEAD",
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});

	it("refuses non-GET methods through the finalizer", () => {
		let finalized = false;
		const response = webMcpBridgeResponse(
			new Request("https://acme.os.tedix.dev/_tedix/webmcp/bridge.js", {
				method: "POST",
			}),
			(inner) => {
				finalized = true;
				return inner;
			},
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
		expect(finalized).toBe(true);
	});
});

describe("injectWebMcpBridge outside workerd", () => {
	it("passes HTML through untouched where HTMLRewriter is absent", async () => {
		const response = htmlResponse();
		const result = injectWebMcpBridge(response, "tenant");
		expect(result).toBe(response);
		expect(await result.text()).not.toContain("data-tedix-webmcp");
	});
});
