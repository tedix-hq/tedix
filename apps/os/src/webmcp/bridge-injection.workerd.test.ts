/**
 * The HTMLRewriter half of the bridge injection, in a REAL workerd isolate —
 * the node lane can only prove the pass-through, because HTMLRewriter exists
 * nowhere else. What matters here: the tag lands inside <head>, the already-
 * stamped security headers survive the transform, and every should-not-inject
 * shape comes back byte-identical.
 */
import { describe, expect, it } from "vite-plus/test";
import { injectWebMcpBridge, webMcpBridgeTag } from "./bridge-injection";

const SHELL_HTML =
	'<!doctype html><html><head><meta charset="utf-8"><title>Tedix OS</title></head><body><div id="root"></div></body></html>';

function stampedShell(): Response {
	return new Response(SHELL_HTML, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"X-Robots-Tag": "noindex, nofollow, noarchive",
			"Cache-Control": "private, no-store",
		},
	});
}

describe("injectWebMcpBridge (workerd)", () => {
	it("appends the bridge tag inside <head> on a tenant host", async () => {
		const result = injectWebMcpBridge(stampedShell(), "tenant");
		const html = await result.text();
		expect(html).toContain(webMcpBridgeTag());
		const headEnd = html.indexOf("</head>");
		expect(html.indexOf("data-tedix-webmcp")).toBeGreaterThan(-1);
		expect(html.indexOf("data-tedix-webmcp")).toBeLessThan(headEnd);
		// The document around the tag is intact.
		expect(html).toContain("<title>Tedix OS</title>");
		expect(html).toContain('<div id="root"></div>');
	});

	it("preserves the stamped security headers through the rewrite", async () => {
		const result = injectWebMcpBridge(stampedShell(), "tenant");
		expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(result.headers.get("X-Frame-Options")).toBe("DENY");
		expect(result.headers.get("Referrer-Policy")).toBe(
			"strict-origin-when-cross-origin",
		);
		expect(result.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
		expect(result.headers.get("Cache-Control")).toBe("private, no-store");
		expect(result.status).toBe(200);
		await result.text();
	});

	it("does not inject on the launcher — it has no /mcp relay", async () => {
		const result = injectWebMcpBridge(stampedShell(), "launcher");
		expect(await result.text()).toBe(SHELL_HTML);
	});

	it("does not touch non-HTML tenant responses", async () => {
		const json = new Response('{"ok":true}', {
			headers: { "Content-Type": "application/json" },
		});
		const result = injectWebMcpBridge(json, "tenant");
		expect(result).toBe(json);
		expect(await result.text()).toBe('{"ok":true}');
	});
});
