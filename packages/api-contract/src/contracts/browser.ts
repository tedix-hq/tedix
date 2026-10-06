import "@orpc/openapi/extensions/route";
/**
 * Browser Contract for oRPC
 * Stateless Cloudflare Browser Run quick-action endpoints.
 */

import { oc } from "@orpc/contract";
import {
	BrowserCapturePageInputSchema,
	BrowserCapturePageOutputSchema,
	BrowserCrawlStartInputSchema,
	BrowserCrawlStartOutputSchema,
	BrowserExtractContentInputSchema,
	BrowserExtractContentOutputSchema,
	BrowserExtractJsonInputSchema,
	BrowserExtractJsonOutputSchema,
	BrowserExtractLinksInputSchema,
	BrowserExtractLinksOutputSchema,
	BrowserExtractMarkdownInputSchema,
	BrowserExtractMarkdownOutputSchema,
	BrowserScrapeElementsInputSchema,
	BrowserScrapeElementsOutputSchema,
} from "../schemas/browser";

export const browserContract = oc
	.route({ tags: ["browser"], prefix: "/browser" })
	.router({
		capturePage: oc
			.route({
				method: "POST",
				path: "/capture-page",
				summary: "Capture a rendered page screenshot",
				description:
					"Capture a public http(s) URL with Cloudflare Browser Run. Stateless: no cookies, tedi identity, mailbox, or durable browser session.",
			})
			.input(BrowserCapturePageInputSchema)
			.output(BrowserCapturePageOutputSchema),

		extractMarkdown: oc
			.route({
				method: "POST",
				path: "/extract-markdown",
				summary: "Extract Markdown from a rendered page",
				description:
					"Convert a rendered public http(s) page to Markdown with Cloudflare Browser Run quickAction('markdown').",
			})
			.input(BrowserExtractMarkdownInputSchema)
			.output(BrowserExtractMarkdownOutputSchema),

		extractContent: oc
			.route({
				method: "POST",
				path: "/extract-content",
				summary: "Extract rendered HTML content",
				description:
					"Extract fully rendered HTML content from a public http(s) page with Cloudflare Browser Run quickAction('content').",
			})
			.input(BrowserExtractContentInputSchema)
			.output(BrowserExtractContentOutputSchema),

		extractLinks: oc
			.route({
				method: "POST",
				path: "/extract-links",
				summary: "Extract links from a rendered page",
				description:
					"Extract and normalize links from a public http(s) page with Cloudflare Browser Run quickAction('links').",
			})
			.input(BrowserExtractLinksInputSchema)
			.output(BrowserExtractLinksOutputSchema),

		scrapeElements: oc
			.route({
				method: "POST",
				path: "/scrape-elements",
				summary: "Scrape elements by CSS selector",
				description:
					"Scrape specific CSS selectors from a rendered public http(s) page with Cloudflare Browser Run quickAction('scrape').",
			})
			.input(BrowserScrapeElementsInputSchema)
			.output(BrowserScrapeElementsOutputSchema),

		extractJson: oc
			.route({
				method: "POST",
				path: "/extract-json",
				summary: "Extract structured JSON from a rendered page",
				description:
					"Extract structured JSON from a public http(s) page with Cloudflare Browser Run quickAction('json'). Requires a prompt or responseFormat.",
			})
			.input(BrowserExtractJsonInputSchema)
			.output(BrowserExtractJsonOutputSchema),

		startCrawl: oc
			.route({
				method: "POST",
				path: "/start-crawl",
				summary: "Start a Browser Run crawl job",
				description:
					"Start an asynchronous Cloudflare Browser Run crawl job from a public http(s) seed URL.",
			})
			.input(BrowserCrawlStartInputSchema)
			.output(BrowserCrawlStartOutputSchema),
	});

export type BrowserContract = typeof browserContract;
