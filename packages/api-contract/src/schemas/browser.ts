/**
 * Browser Run schemas for stateless browser MCP/API tools.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const BrowserWaitUntilSchema = z.enum([
	"load",
	"domcontentloaded",
	"networkidle0",
	"networkidle2",
]);

export const BrowserUrlSchema = z
	.url("url must be a valid absolute URL")
	.max(2048);

export const BrowserEngineSchema = z
	.enum(["chromium", "kitesurf"])
	.optional()
	.describe(
		"Browser Run engine for this call. Omitted or 'chromium' keeps the current default " +
			"(Cloudflare Browser Rendering / Chromium) behavior. 'kitesurf' opts this single call " +
			"into Cloudflare's Kitesurf preview engine (stateless, lower CPU/memory, slower wall " +
			"time, beta with no committed SLA yet) — see https://blog.cloudflare.com/kitesurf/.",
	);

export const BrowserQuickActionBaseInputSchema = z.object({
	url: BrowserUrlSchema.describe("Absolute http(s) URL to render."),
	engine: BrowserEngineSchema,
	timeoutMs: z
		.number()
		.int()
		.min(1000)
		.max(60_000)
		.optional()
		.describe("Navigation timeout in milliseconds."),
	waitUntil: BrowserWaitUntilSchema.optional().describe(
		"Navigation readiness signal.",
	),
	waitForSelector: z
		.string()
		.min(1)
		.max(1000)
		.optional()
		.describe("Optional CSS selector to wait for before extraction."),
	waitForTimeoutMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.optional()
		.describe("Additional wait after load before extraction."),
	maxResponseChars: z
		.number()
		.int()
		.min(1)
		.max(100_000)
		.optional()
		.describe("Maximum text characters returned inline."),
});

export const BrowserCapturePageInputSchema = z.object({
	url: BrowserUrlSchema.describe("Absolute http(s) URL to capture."),
	engine: BrowserEngineSchema,
	timeoutMs: z
		.number()
		.int()
		.min(1000)
		.max(60_000)
		.optional()
		.describe("Navigation timeout in milliseconds."),
	waitUntil: BrowserWaitUntilSchema.optional().describe(
		"Navigation readiness signal.",
	),
	waitForSelector: z
		.string()
		.min(1)
		.max(1000)
		.optional()
		.describe("Optional CSS selector to wait for before capture."),
	waitForTimeoutMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.optional()
		.describe("Additional wait after load before capture."),
	includeBase64: z
		.boolean()
		.optional()
		.describe("Include screenshot base64 in the response. Defaults to false."),
	screenshotMaxBytes: z
		.number()
		.int()
		.min(1)
		.max(10_000_000)
		.optional()
		.describe(
			"Maximum screenshot bytes allowed inline when includeBase64 is true.",
		),
});

export const BrowserExtractMarkdownInputSchema =
	BrowserQuickActionBaseInputSchema.extend({
		includeMarkdown: z
			.boolean()
			.optional()
			.describe("Include Markdown in the response. Defaults to true."),
	});

export const BrowserExtractContentInputSchema =
	BrowserQuickActionBaseInputSchema.extend({
		includeHtml: z
			.boolean()
			.optional()
			.describe("Include full HTML in the response. Defaults to false."),
	});

export const BrowserExtractLinksInputSchema =
	BrowserQuickActionBaseInputSchema.omit({ maxResponseChars: true }).extend({
		limit: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe("Maximum normalized links to return. Defaults to 200."),
	});

export const BrowserScrapeElementsInputSchema =
	BrowserQuickActionBaseInputSchema.extend({
		selectors: z
			.array(z.string().min(1).max(1000))
			.min(1)
			.max(20)
			.describe("CSS selectors to scrape."),
	});

export const BrowserExtractJsonInputSchema =
	BrowserQuickActionBaseInputSchema.omit({ maxResponseChars: true }).extend({
		prompt: z
			.string()
			.min(1)
			.max(5000)
			.optional()
			.describe("Natural-language extraction instruction."),
		responseFormat: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Optional JSON schema-style response format."),
	});

export const BrowserCrawlStartInputSchema = z.object({
	url: BrowserUrlSchema.describe("Absolute http(s) seed URL."),
	engine: BrowserEngineSchema,
	limit: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe("Maximum pages to crawl."),
	maxDepth: z.number().int().min(0).max(10).optional(),
	formats: z
		.array(z.enum(["markdown", "html", "json"]))
		.min(1)
		.max(3)
		.optional()
		.describe("Requested output formats for the crawl job."),
});

export const BrowserTimingSchema = z.object({
	totalMs: z.number().int().nonnegative(),
	browserMsUsed: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Browser time reported by Cloudflare in X-Browser-Ms-Used."),
});

const BrowserExecutionOutputShape = {
	engine: z.enum(["chromium", "kitesurf"]),
	transport: z.enum(["workers-binding", "rest"]),
};

export const BrowserTextResponseSchema = z.object({
	chars: z.number().int().nonnegative(),
	truncated: z.boolean(),
	maxResponseChars: z.number().int().positive(),
});

export const BrowserCapturePageOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	screenshot: z.object({
		contentType: z.string(),
		bytes: z.number().int().nonnegative(),
		base64: z.string().optional(),
		omittedReason: z.string().optional(),
		maxResponseBytes: z.number().int().positive().optional(),
	}),
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserExtractMarkdownOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	finalUrl: z.string().optional(),
	title: z.string().optional(),
	markdown: z.string().optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
	response: BrowserTextResponseSchema,
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserExtractContentOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	finalUrl: z.string().optional(),
	html: z.string().optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
	response: BrowserTextResponseSchema,
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserExtractLinksOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	links: z.array(z.string()),
	totalReturned: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserScrapeElementsOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	selectors: z.array(z.string()),
	result: z.unknown(),
	response: BrowserTextResponseSchema,
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserExtractJsonOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	result: z.unknown(),
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export const BrowserCrawlStartOutputSchema = z.object({
	ok: z.literal(true),
	url: z.string(),
	...BrowserExecutionOutputShape,
	crawlJobId: z.string().optional(),
	result: z.unknown(),
	note: z.string(),
	timing: BrowserTimingSchema,
	source: z.literal("cloudflare-browser-run-quick-action"),
});

export type BrowserWaitUntil = z.infer<typeof BrowserWaitUntilSchema>;
export type BrowserEngine = z.infer<typeof BrowserEngineSchema>;
export type BrowserQuickActionBaseInput = z.infer<
	typeof BrowserQuickActionBaseInputSchema
>;
