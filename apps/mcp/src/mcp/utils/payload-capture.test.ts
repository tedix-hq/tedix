import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	capturePayloadRecord,
	type PayloadCaptureRecord,
	payloadCaptureAllowed,
	redactAndTruncate,
	redactSecretValues,
} from "./payload-capture";

describe("payloadCaptureAllowed (P1.6 consent gate)", () => {
	it("honors an explicit per-app opt-in/opt-out over the platform default", () => {
		expect(
			payloadCaptureAllowed({ MCP_PAYLOAD_CAPTURE_DEFAULT: "off" }, true),
		).toBe(true);
		expect(payloadCaptureAllowed({}, false)).toBe(false);
	});
	it("falls back to platform default ON when the app sets nothing", () => {
		expect(payloadCaptureAllowed({}, undefined)).toBe(true);
		expect(
			payloadCaptureAllowed({ MCP_PAYLOAD_CAPTURE_DEFAULT: "on" }, undefined),
		).toBe(true);
	});
	it("respects platform default-deny (off) for unconsented apps", () => {
		expect(
			payloadCaptureAllowed({ MCP_PAYLOAD_CAPTURE_DEFAULT: "off" }, undefined),
		).toBe(false);
	});
});

function makeRecord(
	overrides: Partial<PayloadCaptureRecord> = {},
): PayloadCaptureRecord {
	return {
		traceId: "trace-1",
		executionId: "",
		appId: "app-1",
		appSlug: "demo",
		organizationId: "org-1",
		toolName: "list_things",
		eventType: "tool_call",
		success: 1,
		errorCode: "",
		durationMs: 12,
		timestamp: "2026-06-11T00:00:00.000Z",
		userId: "user-1",
		tediId: "",
		authType: "user",
		inputArgs: "{}",
		inputBytes: 2,
		outputBody: "{}",
		outputBytes: 2,
		truncated: 0,
		...overrides,
	};
}

describe("redactAndTruncate", () => {
	it("redacts sensitive nested keys and keeps non-sensitive values", () => {
		const { json } = redactAndTruncate({
			query: "shoes",
			authorization: "Bearer abc",
			nested: {
				api_key: "sk_live_123",
				password: "hunter2",
				safeField: "keep-me",
				deeper: { client_secret: "xyz", normal: 5 },
			},
		});
		const parsed = JSON.parse(json);
		expect(parsed.query).toBe("shoes");
		expect(parsed.authorization).toBe("[REDACTED]");
		expect(parsed.nested.api_key).toBe("[REDACTED]");
		expect(parsed.nested.password).toBe("[REDACTED]");
		expect(parsed.nested.safeField).toBe("keep-me");
		expect(parsed.nested.deeper.client_secret).toBe("[REDACTED]");
		expect(parsed.nested.deeper.normal).toBe(5);
	});

	it("matches a range of secret-bearing key names", () => {
		const { json } = redactAndTruncate({
			token: "a",
			passwd: "b",
			"X-Api-Key": "c",
			cookie: "d",
			credential: "e",
			privateKey: "f",
			access_key: "g",
			auth: "h",
			sk_test_x: "i",
		});
		const parsed = JSON.parse(json) as Record<string, string>;
		for (const v of Object.values(parsed)) {
			expect(v).toBe("[REDACTED]");
		}
	});

	it("truncates oversized input, sets the flag, and reports original byte length", () => {
		const long = "x".repeat(5000);
		const { json, bytes, truncated } = redactAndTruncate({ long }, 1024);
		const original = JSON.stringify({ long });
		expect(bytes).toBe(new TextEncoder().encode(original).length);
		expect(truncated).toBe(true);
		expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(1024);
	});

	it("does not truncate when under the byte limit", () => {
		const { json, bytes, truncated } = redactAndTruncate({ a: 1 });
		expect(truncated).toBe(false);
		expect(json).toBe('{"a":1}');
		expect(bytes).toBe(7);
	});

	it("cuts on a char boundary for multi-byte content", () => {
		// Each "😀" is 4 UTF-8 bytes; truncating mid-emoji must not corrupt.
		const { json, truncated } = redactAndTruncate({ e: "😀".repeat(100) }, 20);
		expect(truncated).toBe(true);
		// Decodes without throwing / no replacement char from a split code point.
		expect(json).not.toContain("�");
		expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(20);
	});

	it("redacts secret VALUES passed under innocuous keys", () => {
		const { json } = redactAndTruncate({
			note: "call with Bearer abc123DEF456ghi789",
			jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
			stripe: "sk_live_FAKEFAKEFAKEFAKE",
			cf: "cfat-0123456789abcdef0123456789abcdef0123",
			// Assembled so the published source holds no token-shaped literal.
			gh: ["ghp", "0123456789abcdefghij0123"].join("_"),
			webhook: "https://u:p@example.com/hook",
		});
		const parsed = JSON.parse(json) as Record<string, string>;
		expect(parsed.note).toContain("[REDACTED]");
		expect(parsed.note).not.toContain("abc123DEF456ghi789");
		expect(parsed.jwt).toBe("[REDACTED]");
		expect(parsed.stripe).toContain("[REDACTED]");
		expect(parsed.stripe).not.toContain("sk_live_FAKE");
		expect(parsed.cf).toContain("[REDACTED]");
		expect(parsed.cf).not.toContain("cfat-");
		expect(parsed.gh).toContain("[REDACTED]");
		expect(parsed.gh).not.toContain("ghp_");
		// URL basic-auth: scheme kept, user:pass@ redacted.
		expect(parsed.webhook).toBe("https://[REDACTED]@example.com/hook");
	});

	it("does not mangle normal prose, a UUID, or a plain email (PII off)", () => {
		const prose =
			"The quick brown fox jumps over the lazy dog several times today.";
		const uuid = "5eed0020-0000-4000-8000-000000000020";
		const email = "owner@acme.example";
		expect(redactSecretValues(prose)).toBe(prose);
		expect(redactSecretValues(uuid)).toBe(uuid);
		// REDACT_PII defaults to false → emails pass through untouched.
		expect(redactSecretValues(email)).toBe(email);

		const { json } = redactAndTruncate({ prose, uuid, email });
		const parsed = JSON.parse(json) as Record<string, string>;
		expect(parsed.prose).toBe(prose);
		expect(parsed.uuid).toBe(uuid);
		expect(parsed.email).toBe(email);
	});

	it("degrades gracefully on non-serializable input", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const { json } = redactAndTruncate(circular);
		expect(json).toBe("[unserializable]");
	});
});

describe("capturePayloadRecord", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("is a no-op when env is unset (does not fetch)", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		capturePayloadRecord({}, undefined, makeRecord());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is a no-op when only the endpoint is set", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		capturePayloadRecord(
			{ MCP_PAYLOAD_STREAM_ENDPOINT: "https://sink.example/ingest" },
			undefined,
			makeRecord(),
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("POSTs a one-element array with auth header when configured", () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null));
		vi.stubGlobal("fetch", fetchMock);
		const record = makeRecord({ toolName: "search" });
		capturePayloadRecord(
			{
				MCP_PAYLOAD_STREAM_ENDPOINT: "https://sink.example/ingest",
				MCP_PAYLOAD_STREAM_TOKEN: "secret-token",
			},
			undefined,
			record,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{
				method: string;
				headers: Record<string, string>;
				body: string;
			},
		];
		expect(url).toBe("https://sink.example/ingest");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer secret-token");
		expect(init.headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init.body)).toEqual([record]);
	});

	it("routes the send through ctx.waitUntil when available", () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null));
		vi.stubGlobal("fetch", fetchMock);
		const waitUntil = vi.fn();
		capturePayloadRecord(
			{
				MCP_PAYLOAD_STREAM_ENDPOINT: "https://sink.example/ingest",
				MCP_PAYLOAD_STREAM_TOKEN: "t",
			},
			{ waitUntil },
			makeRecord(),
		);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		const [promise] = waitUntil.mock.calls[0] as [Promise<unknown>];
		expect(promise).toBeInstanceOf(Promise);
	});

	it("never throws when fetch rejects", () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);
		expect(() =>
			capturePayloadRecord(
				{
					MCP_PAYLOAD_STREAM_ENDPOINT: "https://sink.example/ingest",
					MCP_PAYLOAD_STREAM_TOKEN: "t",
				},
				undefined,
				makeRecord(),
			),
		).not.toThrow();
	});
});
