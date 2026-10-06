import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import {
	byCredentialOrIp,
	byIp,
	type RateLimiter,
	rateLimit,
} from "./rate-limit";

function createApp(limiter: RateLimiter) {
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.use(
		"*",
		rateLimit(() => limiter, byIp),
	);
	app.get("/", (c) => c.text("ok"));
	return app;
}

function createCredentialApp(limiter: RateLimiter) {
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.use(
		"*",
		rateLimit(() => limiter, byCredentialOrIp),
	);
	app.get("/", (c) => c.text("ok"));
	return app;
}

afterEach(() => vi.restoreAllMocks());

describe("rateLimit service-binding trust boundary", () => {
	it("bypasses the public bucket for a service-binding call", async () => {
		const limit = vi.fn(() => Promise.resolve({ success: false }));
		const response = await createApp({ limit }).request("https://api/", {
			headers: { "X-Service-Binding": "true" },
		});

		expect(response.status).toBe(200);
		expect(limit).not.toHaveBeenCalled();
	});

	it("does not trust a spoofed service-binding header from a public request", async () => {
		const limit = vi.fn(() => Promise.resolve({ success: false }));
		// Public ingress (the default export) strips the marker before routing.
		const response = await createApp({ limit }).request(
			stripServiceBindingMarker(
				new Request("https://api.tedix.dev/", {
					headers: {
						"CF-Connecting-IP": "203.0.113.42",
						"X-Service-Binding": "true",
					},
				}),
			),
		);

		expect(response.status).toBe(429);
		expect(limit).toHaveBeenCalledOnce();
	});
});

describe("byCredentialOrIp", () => {
	it("keeps repeated requests from one Descope session in one bucket", async () => {
		const limit = vi.fn(() => Promise.resolve({ success: true }));
		const app = createCredentialApp({ limit });

		await app.request("https://api.tedix.dev/", {
			headers: { Cookie: "other=value; DS=session-one" },
		});
		await app.request("https://api.tedix.dev/", {
			headers: { Cookie: "DS=session-one; other=changed" },
		});

		expect(limit).toHaveBeenCalledTimes(2);
		const firstKey = limit.mock.calls[0]?.[0].key;
		const secondKey = limit.mock.calls[1]?.[0].key;
		expect(firstKey).toMatch(/^session:/);
		expect(secondKey).toBe(firstKey);
	});

	it("isolates distinct Descope sessions from each other", async () => {
		const limit = vi.fn(() => Promise.resolve({ success: true }));
		const app = createCredentialApp({ limit });

		await app.request("https://api.tedix.dev/", {
			headers: { Cookie: "DS=session-one" },
		});
		await app.request("https://api.tedix.dev/", {
			headers: { Cookie: "DS=session-two" },
		});

		const firstKey = limit.mock.calls[0]?.[0].key;
		const secondKey = limit.mock.calls[1]?.[0].key;
		expect(firstKey).toMatch(/^session:/);
		expect(secondKey).toMatch(/^session:/);
		expect(secondKey).not.toBe(firstKey);
	});

	it("preserves API-key and bearer credential precedence", async () => {
		const limit = vi.fn(() => Promise.resolve({ success: true }));
		const app = createCredentialApp({ limit });

		await app.request("https://api.tedix.dev/", {
			headers: {
				Authorization: "Bearer bearer-token",
				Cookie: "DS=session-one",
			},
		});
		await app.request("https://api.tedix.dev/", {
			headers: {
				Authorization: "Bearer bearer-token",
				Cookie: "DS=session-one",
				"X-API-Key": "sk_api-key",
			},
		});

		expect(limit.mock.calls[0]?.[0].key).toMatch(/^auth:/);
		expect(limit.mock.calls[1]?.[0].key).toMatch(/^api-key:/);
	});
});

describe("rateLimit diagnostics", () => {
	it("logs a stable binding-unavailable event when configured to skip", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		app.use(
			"*",
			rateLimit(() => undefined, byIp, { skipOnError: true }),
		);
		app.get("/", (c) => c.text("ok"));

		const response = await app.request("https://api.tedix.dev/", {
			headers: { "CF-Connecting-IP": "203.0.113.42" },
		});
		expect(response.status).toBe(200);
		expect(warn).toHaveBeenCalledWith({
			component: "api-rate-limit",
			event: "rate_limit.binding_unavailable",
			outcome: "skipped",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113.42");
	});

	it("does not log the caller IP or credential bucket on denial", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const limiter = { limit: vi.fn(async () => ({ success: false })) };
		const response = await createApp(limiter).request(
			"https://api.tedix.dev/",
			{
				headers: { "CF-Connecting-IP": "203.0.113.42" },
			},
		);

		expect(response.status).toBe(429);
		expect(warn).toHaveBeenCalledWith({
			component: "api-rate-limit",
			event: "rate_limit.denied",
			outcome: "denied",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113.42");
	});

	it("logs bounded causes and retains fail-closed and configured fail-open responses", async () => {
		const fail = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const error = new Error("203.0.113.42 sk_live_secret", {
			cause: new TypeError("DSR=refresh-secret"),
		});
		const limiter = { limit: vi.fn(async () => Promise.reject(error)) };
		const request = {
			headers: { "CF-Connecting-IP": "203.0.113.42" },
		};

		const closed = await createApp(limiter).request(
			"https://api.tedix.dev/",
			request,
		);
		expect(closed.status).toBe(503);
		const openApp = new Hono<{ Bindings: CloudflareEnv }>();
		openApp.use(
			"*",
			rateLimit(() => limiter, byIp, { skipOnError: true }),
		);
		openApp.get("/", (c) => c.text("ok"));
		const open = await openApp.request("https://api.tedix.dev/", request);
		expect(open.status).toBe(200);
		expect(fail).toHaveBeenCalledWith({
			component: "api-rate-limit",
			event: "rate_limit.check_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
			outcome: "unavailable",
		});
		expect(fail).toHaveBeenCalledWith({
			component: "api-rate-limit",
			event: "rate_limit.check_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
			outcome: "allowed",
		});
		expect(JSON.stringify(fail.mock.calls)).not.toMatch(
			/203\.0\.113\.42|sk_live_secret|DSR=refresh-secret/,
		);
	});
});
