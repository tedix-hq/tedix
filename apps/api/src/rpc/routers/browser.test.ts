import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { browserContractRouter } from "./browser";

function createContext(quickAction: CloudflareEnv["BROWSER"]["quickAction"]) {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			BROWSER: { quickAction },
			CF_ACCOUNT_ID: "account-1",
			CLOUDFLARE_API_TOKEN: "browser-token",
			ENVIRONMENT: "test",
		} as CloudflareEnv,
		headers: new Headers(),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/browser"),
		user: {
			sub: "user-1",
			dct: "tenant-1",
			permissions: ["apps:read"],
			roles: [],
		},
	} as BaseContext;
}

function createClient(quickAction: CloudflareEnv["BROWSER"]["quickAction"]) {
	return createRouterClient(browserContractRouter, {
		context: createContext(quickAction),
	});
}

describe("browser router", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("runs Markdown extraction through Browser Run quick actions", async () => {
		const quickAction = vi.fn(
			async (_action: string, _payload: unknown) =>
				new Response(
					JSON.stringify({
						markdown: "# Example",
						metadata: { title: "Example" },
						url: "https://example.com/",
					}),
					{
						headers: {
							"content-type": "application/json",
							"x-browser-ms-used": "321",
						},
					},
				),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		const result = await client.extractMarkdown({
			url: "https://example.com",
			waitUntil: "domcontentloaded",
			waitForTimeoutMs: 25,
		});

		expect(result).toMatchObject({
			ok: true,
			engine: "chromium",
			finalUrl: "https://example.com/",
			markdown: "# Example",
			timing: { browserMsUsed: 321 },
			transport: "workers-binding",
			source: "cloudflare-browser-run-quick-action",
		});
		expect(quickAction).toHaveBeenCalledWith(
			"markdown",
			expect.objectContaining({
				url: "https://example.com",
				gotoOptions: { waitUntil: "domcontentloaded" },
				waitForTimeout: 25,
			}),
		);
	});

	it("returns screenshot base64 only when requested and under the byte cap", async () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const quickAction = vi.fn(
			async () =>
				new Response(png, {
					headers: {
						"content-type": "image/png",
						"x-browser-ms-used": "654",
					},
				}),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		const result = await client.capturePage({
			url: "https://example.com",
			includeBase64: true,
			screenshotMaxBytes: 10,
		});

		expect(result.screenshot).toEqual({
			base64: "iVBORw0KGgo=",
			bytes: 8,
			contentType: "image/png",
		});
		expect(result.timing.browserMsUsed).toBe(654);
		expect(quickAction).toHaveBeenCalledWith(
			"screenshot",
			expect.objectContaining({
				url: "https://example.com",
			}),
		);
	});

	it("routes Kitesurf screenshots through the binding and validates the image", async () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const quickAction = vi.fn(
			async () =>
				new Response(png, {
					headers: {
						"content-type": "image/png",
						"x-browser-ms-used": "432",
					},
				}),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const restFetch = vi.fn();
		vi.stubGlobal("fetch", restFetch);
		const client = createClient(quickAction);

		const result = await client.capturePage({
			url: "https://example.com",
			engine: "kitesurf",
		});

		expect(result).toMatchObject({
			engine: "kitesurf",
			screenshot: { bytes: 8, contentType: "image/png" },
			timing: { browserMsUsed: 432 },
			transport: "workers-binding",
		});
		expect(quickAction).toHaveBeenCalledWith(
			"screenshot",
			expect.objectContaining({
				url: "https://example.com",
				browser: "kitesurf",
			}),
		);
		expect(restFetch).not.toHaveBeenCalled();
	});

	it("keeps the default Chromium engine when engine is omitted", async () => {
		const quickAction = vi.fn(async (_action: string, _payload: unknown) =>
			Response.json({ markdown: "# Example", url: "https://example.com/" }),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		await client.extractMarkdown({ url: "https://example.com" });

		expect(quickAction).toHaveBeenCalledWith(
			"markdown",
			expect.objectContaining({ url: "https://example.com" }),
		);
	});

	it("routes Kitesurf Markdown through the Browser Run binding", async () => {
		const quickAction = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						result: "# Kitesurf Example",
					}),
					{
						headers: {
							"content-type": "application/json",
							"x-browser-ms-used": "987",
						},
					},
				),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const restFetch = vi.fn();
		vi.stubGlobal("fetch", restFetch);
		const client = createClient(quickAction);

		const result = await client.extractMarkdown({
			url: "https://example.com",
			engine: "kitesurf",
		});

		expect(result).toMatchObject({
			engine: "kitesurf",
			markdown: "# Kitesurf Example",
			timing: { browserMsUsed: 987 },
			transport: "workers-binding",
		});
		expect(quickAction).toHaveBeenCalledWith(
			"markdown",
			expect.objectContaining({
				url: "https://example.com",
				browser: "kitesurf",
			}),
		);
		expect(restFetch).not.toHaveBeenCalled();
	});

	it("keeps unsupported Kitesurf links on the REST transport", async () => {
		const quickAction =
			vi.fn() as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const restFetch = vi.fn(async () => Response.json({ links: ["/next"] }));
		vi.stubGlobal("fetch", restFetch);
		const client = createClient(quickAction);

		const result = await client.extractLinks({
			url: "https://example.com",
			engine: "kitesurf",
		});

		expect(result).toMatchObject({
			engine: "kitesurf",
			transport: "rest",
			links: ["https://example.com/next"],
		});
		expect(quickAction).not.toHaveBeenCalled();
		expect(restFetch).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/accounts/account-1/browser-run/links?browser=kitesurf",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("rejects blank and semantically incomplete Markdown envelopes", async () => {
		const quickAction = vi.fn(async () =>
			Response.json({ success: true, result: "---\ntitle: Empty\n---\n" }),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		await expect(
			client.extractMarkdown({ url: "https://example.com" }),
		).rejects.toThrow("empty Markdown document");
	});

	it("rejects screenshot responses without a supported image signature", async () => {
		const quickAction = vi.fn(
			async () =>
				new Response(new Uint8Array([1, 2, 3]), {
					headers: { "content-type": "image/png" },
				}),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		await expect(
			client.capturePage({ url: "https://example.com" }),
		).rejects.toThrow("unusable image");
	});

	it("blocks loopback URLs before calling Browser Run", async () => {
		const quickAction = vi.fn(
			async () => new Response("not reached"),
		) as unknown as CloudflareEnv["BROWSER"]["quickAction"];
		const client = createClient(quickAction);

		await expect(
			client.extractLinks({ url: "http://localhost:8787" }),
		).rejects.toThrow("browser tools only accept public http(s) URLs");
		expect(quickAction).not.toHaveBeenCalled();
	});
});
