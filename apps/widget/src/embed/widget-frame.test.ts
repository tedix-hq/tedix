import { describe, expect, it } from "vite-plus/test";
import {
	MCP_APP_ORIGIN,
	resolveWidgetFrameSource,
	WIDGET_FRAME_SANDBOX,
} from "./widget-frame";

const HOST = {
	pageHref: "https://shop.example.com/cart?step=2",
	pageOrigin: "https://shop.example.com",
};

/** A host page that is itself sandboxed reports the literal string "null". */
const SANDBOXED_HOST = {
	pageHref: "https://shop.example.com/cart",
	pageOrigin: "null",
};

describe("resolveWidgetFrameSource", () => {
	it("admits the MCP app origin", () => {
		expect(
			resolveWidgetFrameSource(`${MCP_APP_ORIGIN}/acme/r/layout-1`, HOST),
		).toBe(`${MCP_APP_ORIGIN}/acme/r/layout-1`);
	});

	it("admits a same-origin widget, including a relative URL", () => {
		expect(resolveWidgetFrameSource("/widgets/cart", HOST)).toBe(
			"https://shop.example.com/widgets/cart",
		);
	});

	it("refuses a lookalike host that merely starts with the trusted one", () => {
		expect(
			resolveWidgetFrameSource("https://mcp-ui.tedix.dev.evil.example/r", HOST),
		).toBeNull();
		expect(
			resolveWidgetFrameSource("https://evil.example/mcp-ui.tedix.dev", HOST),
		).toBeNull();
	});

	it("refuses a scheme downgrade of the trusted origin", () => {
		expect(
			resolveWidgetFrameSource("http://mcp-ui.tedix.dev/acme/r/x", HOST),
		).toBeNull();
	});

	it("refuses an unrelated https origin", () => {
		expect(resolveWidgetFrameSource("https://evil.example/x", HOST)).toBeNull();
	});

	it("refuses junk and empty input without throwing", () => {
		for (const value of [null, undefined, "", "   ", 42, {}, "http://"]) {
			expect(resolveWidgetFrameSource(value, HOST)).toBeNull();
		}
	});

	/**
	 * The vulnerability this module was extracted to close. `javascript:` and
	 * `data:` both report origin "null", and so does `location.origin` when the
	 * HOST page is sandboxed without `allow-same-origin`. The previous inline
	 * check was `parsed.origin !== location.origin`, so in that context the two
	 * "null"s matched and the URL was admitted into an `allow-scripts` iframe.
	 */
	it("refuses opaque-origin URLs even when the host page is itself sandboxed", () => {
		for (const host of [HOST, SANDBOXED_HOST]) {
			expect(resolveWidgetFrameSource("javascript:alert(1)", host)).toBeNull();
			expect(
				resolveWidgetFrameSource("data:text/html,<script>x()</script>", host),
			).toBeNull();
		}
	});

	it("still admits the trusted origin from a sandboxed host", () => {
		expect(
			resolveWidgetFrameSource(`${MCP_APP_ORIGIN}/acme/r/x`, SANDBOXED_HOST),
		).toBe(`${MCP_APP_ORIGIN}/acme/r/x`);
	});

	it("admits nothing same-origin when the host origin is opaque", () => {
		expect(
			resolveWidgetFrameSource("/widgets/cart", SANDBOXED_HOST),
		).toBeNull();
	});
});

describe("WIDGET_FRAME_SANDBOX", () => {
	/**
	 * The single most consequential token in the widget. With `allow-scripts`
	 * already present, adding `allow-same-origin` would give framed content a
	 * real origin and let a same-origin widget reach into the host page. This
	 * assertion is the reason that cannot be added casually.
	 */
	it("never grants allow-same-origin", () => {
		expect(WIDGET_FRAME_SANDBOX).not.toContain("allow-same-origin");
	});

	it("grants exactly the tokens the widget needs", () => {
		expect(WIDGET_FRAME_SANDBOX.split(" ").sort()).toEqual([
			"allow-forms",
			"allow-popups",
			"allow-popups-to-escape-sandbox",
			"allow-scripts",
		]);
	});
});
