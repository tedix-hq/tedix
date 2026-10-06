/**
 * Browser oRPC Router
 * Stateless Cloudflare Browser Run quick-action endpoints.
 */

import { implement } from "@orpc/server";
import { browserContract } from "@tedix/api-contract/contracts/browser";
import { validateUrl } from "@tedix/ssrf-guard";
import type {
	BrowserRunAction,
	BrowserRunEngine,
	BrowserRunRestConfig,
} from "../../integrations/browser-run/client";
import {
	browserRunTransport,
	captureScreenshot,
	extractLinks,
	fetchRenderedContent,
	runBrowserQuickAction,
	scrapeMarkdownPage,
} from "../../integrations/browser-run/client";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const DEFAULT_TEXT_RESPONSE_CHARS = 20_000;
const MAX_TEXT_RESPONSE_CHARS = 100_000;
const DEFAULT_SCREENSHOT_MAX_BYTES = 5_000_000;
const MAX_TIMEOUT_MS = 60_000;

type QuickActionOptions = {
	url: string;
	timeoutMs?: number;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	waitForSelector?: string;
	waitForTimeoutMs?: number;
	engine?: BrowserRunEngine;
};

const browserOs = implement(browserContract).$context<BaseContext>();
const authed = browserOs.use(withAuth);

function assertPublicHttpUrl(rawUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"url must be a valid absolute URL",
		);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw createError(ErrorCodes.BAD_REQUEST, "url must use http or https");
	}

	// Shared guard: private/loopback/link-local/metadata IPs in every textual
	// form, localhost, *.local/*.localhost/*.internal. Tedix-served origins stay
	// reachable (a tedi may render its own tenant's `{slug}.cms.tedix.dev` site).
	if (validateUrl(rawUrl, { allowHttp: true, allowTedixHosts: true })) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"browser tools only accept public http(s) URLs",
		);
	}
}

function requireBrowserBinding(context: BaseContext): unknown {
	const browserBinding = context.env.BROWSER;
	if (!browserBinding) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"BROWSER binding not configured",
		);
	}
	return browserBinding;
}

function browserRunRestConfig(context: BaseContext): BrowserRunRestConfig {
	const env = context.env as CloudflareEnv & {
		CLOUDFLARE_API_TOKEN?: string;
	};
	return {
		accountId: env.CF_ACCOUNT_ID,
		apiToken: env.CLOUDFLARE_API_TOKEN ?? "",
	};
}

function browserRunExecution(
	action: BrowserRunAction,
	engine: BrowserRunEngine | undefined,
) {
	return {
		engine: engine ?? "chromium",
		transport: browserRunTransport(action, engine),
	};
}

function browserRunError(action: string, error: unknown): never {
	throw createError(
		ErrorCodes.BAD_GATEWAY,
		`Browser Run ${action} failed: ${
			error instanceof Error ? error.message : String(error)
		}`,
		error,
	);
}

function quickActionPayload(
	input: QuickActionOptions,
): Record<string, unknown> {
	return {
		url: input.url,
		...(input.timeoutMs || input.waitUntil
			? {
					gotoOptions: {
						...(input.timeoutMs
							? { timeout: Math.min(input.timeoutMs, MAX_TIMEOUT_MS) }
							: {}),
						...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
					},
				}
			: {}),
		...(input.waitForSelector
			? { waitForSelector: input.waitForSelector }
			: {}),
		...(input.waitForTimeoutMs
			? { waitForTimeout: Math.min(input.waitForTimeoutMs, MAX_TIMEOUT_MS) }
			: {}),
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function quickActionResult(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const obj = parsed as Record<string, unknown>;
	if ("result" in obj) return obj.result;
	if ("data" in obj) return obj.data;
	return parsed;
}

function stringifyResult(result: unknown): string {
	return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function truncateForResponse(
	text: string,
	maxChars: number | undefined,
): {
	text: string;
	chars: number;
	truncated: boolean;
	maxResponseChars: number;
} {
	const maxResponseChars = Math.max(
		1,
		Math.min(maxChars ?? DEFAULT_TEXT_RESPONSE_CHARS, MAX_TEXT_RESPONSE_CHARS),
	);
	const truncated = text.length > maxResponseChars;
	return {
		text: truncated ? text.slice(0, maxResponseChars) : text,
		chars: text.length,
		truncated,
		maxResponseChars,
	};
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

async function callJsonQuickAction(
	context: BaseContext,
	action: "scrape" | "json" | "crawl",
	payload: Record<string, unknown>,
	engine?: BrowserRunEngine,
): Promise<unknown> {
	try {
		const response = await runBrowserQuickAction(
			requireBrowserBinding(context),
			action,
			payload,
			{ engine, rest: browserRunRestConfig(context) },
		);
		const text = await response.text();
		return quickActionResult(parseJson(text)) ?? text;
	} catch (error) {
		browserRunError(action, error);
	}
}

export const capturePage = authed.capturePage
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		try {
			const screenshot = await captureScreenshot(
				requireBrowserBinding(context),
				input.url,
				{
					timeoutMs: input.timeoutMs,
					waitUntil: input.waitUntil,
					waitForSelector: input.waitForSelector,
					waitForTimeoutMs: input.waitForTimeoutMs,
					engine: input.engine,
					rest: browserRunRestConfig(context),
				},
			);
			const maxResponseBytes = Math.min(
				input.screenshotMaxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES,
				10_000_000,
			);
			const includeBase64 =
				input.includeBase64 === true &&
				screenshot.bytes.byteLength <= maxResponseBytes;
			return {
				ok: true as const,
				url: input.url,
				...browserRunExecution("screenshot", input.engine),
				screenshot: {
					contentType: screenshot.contentType,
					bytes: screenshot.bytes.byteLength,
					...(includeBase64 ? { base64: bytesToBase64(screenshot.bytes) } : {}),
					...(input.includeBase64 === true && !includeBase64
						? {
								omittedReason: "screenshot_bytes_exceeded_limit",
								maxResponseBytes,
							}
						: {}),
				},
				timing: {
					totalMs: Date.now() - startedAt,
					...(screenshot.browserMsUsed !== undefined
						? { browserMsUsed: screenshot.browserMsUsed }
						: {}),
				},
				source: "cloudflare-browser-run-quick-action" as const,
			};
		} catch (error) {
			browserRunError("screenshot", error);
		}
	});

export const extractMarkdown = authed.extractMarkdown
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		try {
			const page = await scrapeMarkdownPage(
				requireBrowserBinding(context),
				input.url,
				{
					timeoutMs: input.timeoutMs,
					waitUntil: input.waitUntil,
					waitForSelector: input.waitForSelector,
					waitForTimeoutMs: input.waitForTimeoutMs,
					engine: input.engine,
					rest: browserRunRestConfig(context),
				},
			);
			if (!page)
				throw new Error("Browser Run returned an empty Markdown document");
			const response = truncateForResponse(
				page.markdown,
				input.maxResponseChars,
			);
			return {
				ok: true as const,
				url: input.url,
				...browserRunExecution("markdown", input.engine),
				finalUrl: page.finalUrl,
				title: page.title,
				markdown: input.includeMarkdown === false ? undefined : response.text,
				metadata: page.metadata,
				response: {
					chars: response.chars,
					truncated: response.truncated,
					maxResponseChars: response.maxResponseChars,
				},
				timing: {
					totalMs: Date.now() - startedAt,
					...(page.browserMsUsed !== undefined
						? { browserMsUsed: page.browserMsUsed }
						: {}),
				},
				source: "cloudflare-browser-run-quick-action" as const,
			};
		} catch (error) {
			browserRunError("markdown", error);
		}
	});

export const extractContent = authed.extractContent
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		try {
			const content = await fetchRenderedContent(
				requireBrowserBinding(context),
				input.url,
				{
					timeoutMs: input.timeoutMs,
					waitUntil: input.waitUntil,
					waitForSelector: input.waitForSelector,
					waitForTimeoutMs: input.waitForTimeoutMs,
					engine: input.engine,
					rest: browserRunRestConfig(context),
				},
			);
			const response = truncateForResponse(
				content.html,
				input.maxResponseChars,
			);
			return {
				ok: true as const,
				url: input.url,
				...browserRunExecution("content", input.engine),
				finalUrl: content.finalUrl,
				html: input.includeHtml === true ? response.text : undefined,
				metadata: content.metadata,
				response: {
					chars: response.chars,
					truncated: response.truncated,
					maxResponseChars: response.maxResponseChars,
				},
				timing: { totalMs: Date.now() - startedAt },
				source: "cloudflare-browser-run-quick-action" as const,
			};
		} catch (error) {
			browserRunError("content", error);
		}
	});

export const extractLinksProcedure = authed.extractLinks
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		try {
			const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
			const result = await extractLinks(
				requireBrowserBinding(context),
				input.url,
				{
					limit,
					timeoutMs: input.timeoutMs,
					waitUntil: input.waitUntil,
					waitForSelector: input.waitForSelector,
					waitForTimeoutMs: input.waitForTimeoutMs,
					engine: input.engine,
					rest: browserRunRestConfig(context),
				},
			);
			return {
				ok: true as const,
				url: input.url,
				...browserRunExecution("links", input.engine),
				links: result.links,
				totalReturned: result.links.length,
				limit,
				timing: { totalMs: Date.now() - startedAt },
				source: "cloudflare-browser-run-quick-action" as const,
			};
		} catch (error) {
			browserRunError("links", error);
		}
	});

export const scrapeElements = authed.scrapeElements
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		const selectors = [...new Set(input.selectors.map((item) => item.trim()))]
			.filter(Boolean)
			.slice(0, 20);
		if (selectors.length === 0) {
			throw createError(ErrorCodes.BAD_REQUEST, "selectors required");
		}
		const result = await callJsonQuickAction(
			context,
			"scrape",
			{
				...quickActionPayload(input),
				elements: selectors.map((selector) => ({ selector })),
			},
			input.engine,
		);
		const responseBody = stringifyResult(result);
		const response = truncateForResponse(responseBody, input.maxResponseChars);
		return {
			ok: true as const,
			url: input.url,
			...browserRunExecution("scrape", input.engine),
			selectors,
			result: parseJson(response.text) ?? response.text,
			response: {
				chars: response.chars,
				truncated: response.truncated,
				maxResponseChars: response.maxResponseChars,
			},
			timing: { totalMs: Date.now() - startedAt },
			source: "cloudflare-browser-run-quick-action" as const,
		};
	});

export const extractJson = authed.extractJson
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		if (!input.prompt && !input.responseFormat) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"prompt or responseFormat is required",
			);
		}
		const startedAt = Date.now();
		const result = await callJsonQuickAction(
			context,
			"json",
			{
				...quickActionPayload(input),
				...(input.prompt ? { prompt: input.prompt } : {}),
				...(input.responseFormat
					? { response_format: input.responseFormat }
					: {}),
			},
			input.engine,
		);
		return {
			ok: true as const,
			url: input.url,
			...browserRunExecution("json", input.engine),
			result,
			timing: { totalMs: Date.now() - startedAt },
			source: "cloudflare-browser-run-quick-action" as const,
		};
	});

export const startCrawl = authed.startCrawl
	.use(AUTHZ.toolsRead)
	.handler(async ({ context, input }) => {
		assertPublicHttpUrl(input.url);
		const startedAt = Date.now();
		const result = await callJsonQuickAction(
			context,
			"crawl",
			{
				url: input.url,
				...(input.limit ? { limit: input.limit } : {}),
				...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
				...(input.formats ? { formats: input.formats } : {}),
			},
			input.engine,
		);
		const resultObject =
			result && typeof result === "object"
				? (result as Record<string, unknown>)
				: null;
		const resultId = resultObject?.id;
		return {
			ok: true as const,
			url: input.url,
			...browserRunExecution("crawl", input.engine),
			crawlJobId:
				typeof result === "string"
					? result
					: typeof resultId === "string"
						? resultId
						: undefined,
			result,
			note: "Browser Run crawl is asynchronous; this tool starts the job. Polling crawl results needs the account REST endpoint and is intentionally not exposed without an account-scoped API token.",
			timing: { totalMs: Date.now() - startedAt },
			source: "cloudflare-browser-run-quick-action" as const,
		};
	});

export const browserContractRouter = browserOs.router({
	capturePage,
	extractMarkdown,
	extractContent,
	extractLinks: extractLinksProcedure,
	scrapeElements,
	extractJson,
	startCrawl,
});
