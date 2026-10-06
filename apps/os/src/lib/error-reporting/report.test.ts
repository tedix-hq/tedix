import { describe, expect, it } from "vite-plus/test";
import { normalizeOsClientErrorReport, normalizePageLocation } from "./report";
import {
	MAX_MESSAGE_CHARS,
	MAX_STACK_CHARS,
	MAX_STRING_CHARS,
} from "./serialize-exception";

describe("normalizePageLocation", () => {
	it("keeps origin and pathname only", () => {
		expect(
			normalizePageLocation("https://acme.os.tedix.dev/workspaces/1"),
		).toBe("https://acme.os.tedix.dev/workspaces/1");
	});

	it("drops the query string", () => {
		expect(
			normalizePageLocation("https://acme.os.tedix.dev/outputs?token=secret"),
		).toBe("https://acme.os.tedix.dev/outputs");
	});

	it("drops a share-capability fragment", () => {
		// The fragment is a bearer capability in Tedix; it must never leave the tab.
		expect(
			normalizePageLocation(
				"https://acme.os.tedix.dev/outputs/9#share=cap_live_abc123",
			),
		).toBe("https://acme.os.tedix.dev/outputs/9");
	});

	it("drops URL credentials that a textual trim would keep", () => {
		const href = "https://user:secret@acme.os.tedix.dev/workspaces?a=1#b";
		expect(href.split("?")[0]).toContain("secret");
		expect(normalizePageLocation(href)).toBe(
			"https://acme.os.tedix.dev/workspaces",
		);
	});

	it("rejects non-http(s) schemes", () => {
		expect(
			normalizePageLocation("data:text/html,<script>alert(1)</script>"),
		).toBeUndefined();
		expect(normalizePageLocation("javascript:alert(1)")).toBeUndefined();
		expect(
			normalizePageLocation("blob:https://acme.os.tedix.dev/abc"),
		).toBeUndefined();
		expect(
			normalizePageLocation("file:///Users/owner/secret.txt"),
		).toBeUndefined();
	});

	it("rejects unparseable and non-string values", () => {
		expect(normalizePageLocation("/relative/path")).toBeUndefined();
		expect(normalizePageLocation(undefined)).toBeUndefined();
		expect(normalizePageLocation(42)).toBeUndefined();
	});
});

describe("normalizeOsClientErrorReport", () => {
	const base = {
		schemaVersion: 1,
		failureSite: "browser.window-error",
		severity: "error",
		handled: false,
		captureMechanism: "window.error",
	};

	it("rejects anything that is not a v1 report", () => {
		expect(normalizeOsClientErrorReport(null)).toBeNull();
		expect(normalizeOsClientErrorReport("boom")).toBeNull();
		expect(normalizeOsClientErrorReport([base])).toBeNull();
		expect(
			normalizeOsClientErrorReport({ ...base, schemaVersion: 2 }),
		).toBeNull();
	});

	it("rebuilds an allowlisted object and drops unknown keys", () => {
		const report = normalizeOsClientErrorReport({
			...base,
			sessionId: "session-1",
			pageLocation: "https://acme.os.tedix.dev/outputs/9#share=cap_live_abc123",
			exception: { type: "TypeError", message: "x is not a function" },
			apiKey: "sk_live_should_not_survive",
		});

		expect(report).toEqual({
			schemaVersion: 1,
			failureSite: "browser.window-error",
			severity: "error",
			handled: false,
			captureMechanism: "window.error",
			sessionId: "session-1",
			pageLocation: "https://acme.os.tedix.dev/outputs/9",
			exception: { type: "TypeError", message: "x is not a function" },
		});
		expect(Object.keys(report ?? {})).not.toContain("apiKey");
	});

	it("falls back for unknown severity and capture mechanism", () => {
		const report = normalizeOsClientErrorReport({
			...base,
			severity: "catastrophic",
			captureMechanism: "telepathy",
			handled: "yes",
			failureSite: "",
		});

		expect(report?.severity).toBe("error");
		expect(report?.captureMechanism).toBe("explicit");
		expect(report?.handled).toBe(true);
		expect(report?.failureSite).toBe("browser.unknown");
	});

	it("normalizes the page location before bounding it", () => {
		// A long query must not consume the budget for the origin and pathname.
		const pathname = `/w/${"a".repeat(60)}`;
		const report = normalizeOsClientErrorReport({
			...base,
			pageLocation: `https://acme.os.tedix.dev${pathname}?q=${"z".repeat(5000)}`,
		});

		expect(report?.pageLocation).toBe(`https://acme.os.tedix.dev${pathname}`);
		expect(report?.truncated).toBeUndefined();
	});

	it("drops a page location that is not an ordinary page URL", () => {
		const report = normalizeOsClientErrorReport({
			...base,
			pageLocation: "javascript:alert(1)",
		});

		// A policy strip is not a truncation.
		expect(report?.pageLocation).toBeUndefined();
		expect(report?.truncated).toBeUndefined();
	});

	it("bounds oversized strings and marks the report truncated", () => {
		const report = normalizeOsClientErrorReport({
			...base,
			failureSite: "f".repeat(MAX_STRING_CHARS + 10),
			exception: {
				type: "Error",
				message: "m".repeat(MAX_MESSAGE_CHARS + 10),
				stack: "s".repeat(MAX_STACK_CHARS + 10),
			},
		});

		expect(report?.failureSite).toHaveLength(MAX_STRING_CHARS);
		expect(report?.exception?.message).toHaveLength(MAX_MESSAGE_CHARS);
		expect(report?.exception?.stack).toHaveLength(MAX_STACK_CHARS);
		expect(report?.truncated).toBe(true);
	});

	it("serializes a non-object exception claim", () => {
		const report = normalizeOsClientErrorReport({
			...base,
			exception: "just a string",
		});

		expect(report?.exception).toEqual({
			type: "stringThrown",
			message: "just a string",
		});
	});

	it("survives a payload whose getters throw", () => {
		const hostile = {
			schemaVersion: 1,
			get failureSite(): string {
				throw new Error("hostile getter");
			},
		};

		// Accessors are never invoked: every read goes through a value descriptor.
		expect(normalizeOsClientErrorReport(hostile)?.failureSite).toBe(
			"browser.unknown",
		);
	});
});
