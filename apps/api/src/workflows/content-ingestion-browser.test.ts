import { describe, expect, it, vi } from "vite-plus/test";
import {
	IngestionBrowserError,
	isKitesurfIngestionEligible,
	scrapeIngestionPage,
} from "./content-ingestion-browser";

const MARKDOWN = "# Example\n\nMeaningful public content.";

function markdownResponse(markdown = MARKDOWN, browserMsUsed = 100) {
	return new Response(JSON.stringify({ success: true, result: markdown }), {
		headers: {
			"content-type": "application/json",
			"x-browser-ms-used": String(browserMsUsed),
		},
	});
}

describe("content ingestion browser canary", () => {
	it("limits Kitesurf to explicitly opted-in public external sources", () => {
		const eligible = {
			appVisibility: "public" as const,
			sourceType: "webpage",
			config: { browserEngine: "kitesurf" },
			url: "https://example.com/docs",
		};
		expect(isKitesurfIngestionEligible(eligible)).toBe(true);
		expect(
			isKitesurfIngestionEligible({ ...eligible, appVisibility: "private" }),
		).toBe(false);
		expect(isKitesurfIngestionEligible({ ...eligible, config: null })).toBe(
			false,
		);
		expect(
			isKitesurfIngestionEligible({ ...eligible, sourceType: "pdf" }),
		).toBe(false);
		expect(
			isKitesurfIngestionEligible({ ...eligible, url: "http://127.0.0.1" }),
		).toBe(false);
	});

	it("selects Kitesurf when its semantic Markdown result succeeds", async () => {
		const quickAction = vi.fn(async () => markdownResponse(MARKDOWN, 240));

		const result = await scrapeIngestionPage(
			{ quickAction },
			"https://example.com",
			{ requestKitesurf: true },
		);

		expect(result.page.content).toBe(MARKDOWN);
		expect(result.telemetry).toMatchObject({
			requestedEngine: "kitesurf",
			selectedEngine: "kitesurf",
			transport: "workers-binding",
			retryCount: 0,
			browserMsUsed: 240,
			attempts: [{ engine: "kitesurf", status: "succeeded" }],
		});
		expect(quickAction).toHaveBeenCalledWith(
			"markdown",
			expect.objectContaining({ browser: "kitesurf" }),
		);
	});

	it("falls back to Chromium exactly once and preserves both attempts", async () => {
		const quickAction = vi.fn(
			async (_action: string, payload: Record<string, unknown>) =>
				payload.browser === "kitesurf"
					? new Response("Kitesurf unavailable", {
							status: 503,
							headers: { "x-browser-ms-used": "20" },
						})
					: markdownResponse(MARKDOWN, 80),
		);

		const result = await scrapeIngestionPage(
			{ quickAction },
			"https://example.com",
			{ requestKitesurf: true },
		);

		expect(result.telemetry).toMatchObject({
			requestedEngine: "kitesurf",
			selectedEngine: "chromium",
			transport: "workers-binding",
			retryCount: 1,
			browserMsUsed: 100,
			attempts: [
				{ engine: "kitesurf", status: "failed" },
				{ engine: "chromium", status: "succeeded", browserMsUsed: 80 },
			],
		});
		expect(result.telemetry.fallbackReason).toContain("HTTP 503");
		expect(quickAction).toHaveBeenCalledTimes(2);
		expect(quickAction).toHaveBeenNthCalledWith(
			1,
			"markdown",
			expect.objectContaining({ browser: "kitesurf" }),
		);
		expect(quickAction).toHaveBeenNthCalledWith(
			2,
			"markdown",
			expect.not.objectContaining({ browser: "kitesurf" }),
		);
	});

	it("uses only Chromium when the source is not selected for the canary", async () => {
		const quickAction = vi.fn(async () => markdownResponse(MARKDOWN, 60));

		const result = await scrapeIngestionPage(
			{ quickAction },
			"https://example.com",
			{ requestKitesurf: false },
		);

		expect(result.telemetry).toMatchObject({
			requestedEngine: "chromium",
			selectedEngine: "chromium",
			transport: "workers-binding",
			retryCount: 0,
			browserMsUsed: 60,
		});
		expect(quickAction).toHaveBeenCalledTimes(1);
	});

	it("preserves telemetry when both the canary and fallback fail", async () => {
		const quickAction = vi.fn(
			async () => new Response("binding failed", { status: 502 }),
		);

		try {
			await scrapeIngestionPage({ quickAction }, "https://example.com", {
				requestKitesurf: true,
			});
			expect.unreachable("expected browser ingestion to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(IngestionBrowserError);
			expect((error as IngestionBrowserError).telemetry).toMatchObject({
				requestedEngine: "kitesurf",
				retryCount: 1,
				attempts: [
					{ engine: "kitesurf", status: "failed" },
					{ engine: "chromium", status: "failed" },
				],
			});
		}
		expect(quickAction).toHaveBeenCalledTimes(2);
	});
});
