import { describe, expect, it, vi } from "vite-plus/test";
import {
	isRetryableUpstreamError,
	UPSTREAM_ATTEMPT_TIMEOUT_MS,
	UPSTREAM_RETRY_AFTER_SECONDS,
	upstreamUnavailableResponse,
	withUpstreamRetry,
} from "./upstream";

/** Minimal stand-in for the @orpc/client ORPCError shape (code + status). */
const orpcError = (code: string, status: number): Error => {
	const e = new Error(code) as Error & { code: string; status: number };
	e.code = code;
	e.status = status;
	return e;
};

/** The Cloudflare remote-RPC drop: plain Error, no code/status. */
const networkLost = (): Error => {
	const e = new Error("Network connection lost.") as Error & {
		remote: boolean;
		retryable: boolean;
	};
	e.remote = true;
	e.retryable = true;
	return e;
};

describe("isRetryableUpstreamError", () => {
	it("matches apps/api 5xx ORPCErrors", () => {
		expect(
			isRetryableUpstreamError(orpcError("SERVICE_UNAVAILABLE", 503)),
		).toBe(true);
		expect(isRetryableUpstreamError(orpcError("BAD_GATEWAY", 502))).toBe(true);
		expect(isRetryableUpstreamError(orpcError("GATEWAY_TIMEOUT", 504))).toBe(
			true,
		);
		expect(isRetryableUpstreamError(orpcError("INTERNAL_ERROR", 500))).toBe(
			true,
		);
	});

	it("never matches genuine 4xx outcomes", () => {
		expect(isRetryableUpstreamError(orpcError("BAD_REQUEST", 400))).toBe(false);
		expect(isRetryableUpstreamError(orpcError("UNAUTHORIZED", 401))).toBe(
			false,
		);
		expect(isRetryableUpstreamError(orpcError("FORBIDDEN", 403))).toBe(false);
		expect(isRetryableUpstreamError(orpcError("NOT_FOUND", 404))).toBe(false);
		expect(isRetryableUpstreamError(orpcError("RATE_LIMITED", 429))).toBe(
			false,
		);
	});

	it("matches a code-only SERVICE_UNAVAILABLE with no numeric status", () => {
		expect(isRetryableUpstreamError({ code: "SERVICE_UNAVAILABLE" })).toBe(
			true,
		);
	});

	it("uses the HTTP status in malformed oRPC response causes", () => {
		const malformed = (status: number) => ({
			code: "MALFORMED_ORPC_RESPONSE",
			cause: { response: { status } },
		});
		expect(isRetryableUpstreamError(malformed(503))).toBe(true);
		expect(isRetryableUpstreamError(malformed(404))).toBe(false);
		expect(isRetryableUpstreamError({ code: "MALFORMED_ORPC_RESPONSE" })).toBe(
			false,
		);
	});

	it("matches the Network connection lost drop (flag and/or message)", () => {
		expect(isRetryableUpstreamError(networkLost())).toBe(true);
		expect(
			isRetryableUpstreamError(new Error("Network connection lost.")),
		).toBe(true);
		expect(isRetryableUpstreamError({ retryable: true })).toBe(true);
	});

	it("does not match app-not-found or unrelated errors", () => {
		expect(isRetryableUpstreamError(new Error("App not found: acme"))).toBe(
			false,
		);
		expect(isRetryableUpstreamError(new Error("boom"))).toBe(false);
		expect(isRetryableUpstreamError(null)).toBe(false);
		expect(isRetryableUpstreamError(undefined)).toBe(false);
		expect(isRetryableUpstreamError("Network connection lost.")).toBe(false);
		expect(isRetryableUpstreamError(503)).toBe(false);
	});
});

describe("withUpstreamRetry", () => {
	it("returns immediately on success without retrying", async () => {
		const fn = vi.fn(async () => "ok");
		await expect(withUpstreamRetry(fn)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries a transient failure then succeeds", async () => {
		let calls = 0;
		const fn = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw orpcError("SERVICE_UNAVAILABLE", 503);
			return "recovered";
		});
		await expect(withUpstreamRetry(fn)).resolves.toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("gives up after the attempt cap on a persistent transient failure", async () => {
		const fn = vi.fn(async () => {
			throw networkLost();
		});
		await expect(withUpstreamRetry(fn)).rejects.toThrow(
			/network connection lost/i,
		);
		// 1 initial attempt + 1 retry = 2 total.
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not retry a genuine 4xx", async () => {
		const fn = vi.fn(async () => {
			throw orpcError("NOT_FOUND", 404);
		});
		await expect(withUpstreamRetry(fn)).rejects.toThrow("NOT_FOUND");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-transient error", async () => {
		const fn = vi.fn(async () => {
			throw new Error("App not found: acme");
		});
		await expect(withUpstreamRetry(fn)).rejects.toThrow("App not found");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("bounds a service-binding call that never settles", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fn = vi.fn(() => new Promise<never>(() => {}));

		await expect(
			withUpstreamRetry(fn, {
				operation: "resolve_app",
				resource: "mcp-subdomain:tedix-unified",
				timeoutMs: 10,
			}),
		).rejects.toThrow("Upstream service binding timed out after 10ms");

		expect(fn).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0]?.[0]).toContain('"event":"attempt_timeout"');
		// Must exceed an apps/api cold start; at 3_000 both attempts time out
		// on every request into a cold isolate and the gateway answers 503.
		expect(UPSTREAM_ATTEMPT_TIMEOUT_MS).toBe(12_000);
		warn.mockRestore();
	});
});

describe("upstreamUnavailableResponse", () => {
	it("is a 503 with a Retry-After header and matching body", async () => {
		const res = upstreamUnavailableResponse();
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe(
			String(UPSTREAM_RETRY_AFTER_SECONDS),
		);
		const body = (await res.json()) as { retryAfter: number };
		expect(body.retryAfter).toBe(UPSTREAM_RETRY_AFTER_SECONDS);
	});
});
