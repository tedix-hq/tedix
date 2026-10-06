/**
 * URL-scheme allowlist tests.
 *
 * Written against the obfuscation cases specifically, because that is the part
 * of a scheme filter that is normally wrong: a naive
 * `startsWith("javascript:")` check passes every one of the `rejects
 * obfuscated` cases below, and so does a lowercase-and-trim check for half of
 * them.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	isSafeLinkHref,
	SAFE_LINK_SCHEMES,
	SAFE_MEDIA_SCHEMES,
	safeImageSrc,
	safeLinkHref,
} from "./safe-url";

describe("safeLinkHref", () => {
	it("accepts the allowlisted schemes", () => {
		expect(safeLinkHref("https://example.com/product/1")).toBe(
			"https://example.com/product/1",
		);
		expect(safeLinkHref("mailto:sales@example.com")).toBe(
			"mailto:sales@example.com",
		);
		expect(safeLinkHref("tel:+15555550123")).toBe("tel:+15555550123");
	});

	it("returns the parsed URL, not the raw input", () => {
		// Uppercase host and scheme normalize; query and fragment survive. The
		// value rendered has to be the value validated.
		expect(safeLinkHref("HTTPS://Example.COM/a?b=1#c")).toBe(
			"https://example.com/a?b=1#c",
		);
	});

	it("rejects javascript: in every obfuscated form", () => {
		const hostile = [
			"javascript:alert(1)",
			// Mixed / upper case — the parser lowercases the scheme.
			"JavaScript:alert(1)",
			"JAVASCRIPT:alert(1)",
			// Leading whitespace and C0 controls: stripped by the URL parser
			// before the scheme is read, exactly as a browser would.
			"  javascript:alert(1)",
			"\tjavascript:alert(1)",
			"\njavascript:alert(1)",
			"\rjavascript:alert(1)",
			"\u0001javascript:alert(1)",
			"\u000Bjavascript:alert(1)",
			// Embedded tab / newline inside the scheme: removed by the parser,
			// so this IS `javascript:` and must be rejected as such.
			"java\tscript:alert(1)",
			"java\nscript:alert(1)",
			"java\rscript:alert(1)",
			"jav\na\tscri\rpt:alert(1)",
			// Combination of the above.
			"  Java\nScript:alert(1)",
			// Not a parseable URL at all (internal NUL is not stripped, U+00A0
			// is not C0 whitespace) — rejected by failing to parse.
			"jav\u0000ascript:alert(1)",
			"\u00A0javascript:alert(1)",
		];
		for (const value of hostile) {
			expect(safeLinkHref(value), value).toBeUndefined();
			expect(isSafeLinkHref(value), value).toBe(false);
		}
	});

	it("rejects the other dangerous schemes", () => {
		const hostile = [
			"data:text/html,<script>alert(1)</script>",
			"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
			"DATA:text/html,<script>alert(1)</script>",
			" data:text/html,x",
			"da\nta:text/html,x",
			"vbscript:msgbox(1)",
			"VBScript:msgbox(1)",
			"vb\tscript:msgbox(1)",
			"blob:https://example.com/1234",
			"file:///etc/passwd",
			"about:blank",
			"chrome://settings",
			"ws://example.com/socket",
		];
		for (const value of hostile) {
			expect(safeLinkHref(value), value).toBeUndefined();
		}
	});

	it("rejects http: — the widget only ever renders in an https document", () => {
		expect(safeLinkHref("http://example.com/a")).toBeUndefined();
	});

	it("rejects relative and protocol-relative targets", () => {
		// Deliberate: a model-supplied target resolves against the HOST's
		// document base, not ours, so a relative URL is never meaningful.
		for (const value of [
			"/product/1",
			"./product/1",
			"../product/1",
			"#anchor",
			"?q=1",
			"//evil.example/pwn",
			"example.com/product",
		]) {
			expect(safeLinkHref(value), value).toBeUndefined();
		}
	});

	it("rejects non-string and empty input", () => {
		for (const value of [undefined, null, "", 0, 42, true, {}, [], () => {}]) {
			expect(safeLinkHref(value)).toBeUndefined();
		}
	});

	it("keeps the allowlist itself narrow", () => {
		expect([...SAFE_LINK_SCHEMES]).toEqual(["https:", "mailto:", "tel:"]);
		expect([...SAFE_MEDIA_SCHEMES]).toEqual(["https:"]);
	});
});

describe("safeImageSrc", () => {
	it("accepts https", () => {
		expect(safeImageSrc("https://cdn.example.com/a.png")).toBe(
			"https://cdn.example.com/a.png",
		);
	});

	it("rejects everything the link allowlist rejects, plus mailto/tel/data", () => {
		for (const value of [
			"javascript:alert(1)",
			"java\nscript:alert(1)",
			"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
			"mailto:sales@example.com",
			"tel:+15555550123",
			"http://cdn.example.com/a.png",
			"/local.png",
		]) {
			expect(safeImageSrc(value), value).toBeUndefined();
		}
	});
});
