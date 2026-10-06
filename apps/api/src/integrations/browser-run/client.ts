type QuickActionResponse = Response;

export type BrowserRunAction =
	| "content"
	| "screenshot"
	| "pdf"
	| "markdown"
	| "snapshot"
	| "scrape"
	| "json"
	| "links"
	| "crawl";

export interface BrowserRunBinding {
	quickAction?: (
		action: BrowserRunAction | string,
		payload: Record<string, unknown>,
	) => Promise<QuickActionResponse>;
}

export interface BrowserRunMarkdownPage {
	url: string;
	finalUrl?: string;
	title: string;
	markdown: string;
	metadata: Record<string, unknown>;
	browserMsUsed?: number;
}

export interface BrowserRunLinksResult {
	url: string;
	links: string[];
}

export interface BrowserRunRenderedContent {
	url: string;
	finalUrl?: string;
	html: string;
	metadata: Record<string, unknown>;
}

export interface BrowserRunScreenshot {
	bytes: Uint8Array;
	contentType: string;
	browserMsUsed?: number;
}

/**
 * Browser Run engine selection. "chromium" (or omitted) is the current default
 * (Cloudflare Browser Rendering / Chromium) behavior. "kitesurf" opts a single
 * call into Cloudflare's Kitesurf preview engine — stateless, V8-isolate based,
 * lower CPU/memory but slower wall time, beta with no committed SLA yet.
 * See https://blog.cloudflare.com/kitesurf/.
 *
 * Supported Workers binding quick actions select Kitesurf with the payload's
 * `browser` option. Other actions retain the REST transport with
 * `?browser=kitesurf` because their binding options reject an alternate backend.
 */
export type BrowserRunEngine = "chromium" | "kitesurf";

const KITESURF_BINDING_ACTIONS = new Set<BrowserRunAction>([
	"content",
	"screenshot",
	"pdf",
	"markdown",
	"json",
]);

export function browserRunTransport(
	action: BrowserRunAction,
	engine: BrowserRunEngine | undefined,
): "workers-binding" | "rest" {
	return engine === "kitesurf" && !KITESURF_BINDING_ACTIONS.has(action)
		? "rest"
		: "workers-binding";
}

export interface BrowserRunRestConfig {
	accountId: string;
	apiToken: string;
	fetch?: typeof fetch;
}

export class BrowserRunQuickActionError extends Error {
	constructor(
		message: string,
		readonly browserMsUsed?: number,
	) {
		super(message);
		this.name = "BrowserRunQuickActionError";
	}
}

function asBrowserRunBinding(binding: unknown | undefined): BrowserRunBinding {
	if (!binding) {
		throw new Error("BROWSER binding not configured");
	}
	const browser = binding as BrowserRunBinding;
	if (typeof browser.quickAction !== "function") {
		throw new Error(
			'BROWSER binding does not expose quickAction(); set the Browser binding to remote mode for local dev and use compatibility_date >= "2026-03-24"',
		);
	}
	return browser;
}

function withOptionalFields(
	payload: Record<string, unknown>,
	options: Record<string, unknown | undefined>,
): Record<string, unknown> {
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) payload[key] = value;
	}
	return payload;
}

function quickActionPayload(
	url: string,
	options: {
		timeoutMs?: number;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		waitForSelector?: string;
		waitForTimeoutMs?: number;
	} = {},
): Record<string, unknown> {
	return withOptionalFields(
		{
			url,
			...(options.timeoutMs || options.waitUntil
				? {
						gotoOptions: {
							...(options.timeoutMs
								? { timeout: Math.min(options.timeoutMs, 60_000) }
								: {}),
							...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
						},
					}
				: {}),
		},
		{
			waitForSelector: options.waitForSelector,
			waitForTimeout: options.waitForTimeoutMs
				? Math.min(options.waitForTimeoutMs, 60_000)
				: undefined,
		},
	);
}

export async function runBrowserQuickAction(
	binding: unknown | undefined,
	action: BrowserRunAction,
	payload: Record<string, unknown>,
	options: {
		engine?: BrowserRunEngine;
		rest?: BrowserRunRestConfig;
	} = {},
): Promise<Response> {
	const transport = browserRunTransport(action, options.engine);
	const response =
		transport === "rest"
			? await runBrowserRestQuickAction(action, payload, options.rest)
			: await asBrowserRunBinding(binding).quickAction!(
					action,
					options.engine === "kitesurf"
						? { ...payload, browser: "kitesurf" }
						: payload,
				);
	if (!response.ok) {
		let body = "";
		try {
			body = await response.text();
		} catch {
			body = "";
		}
		throw new BrowserRunQuickActionError(
			`Browser Run ${action} failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 500)}` : ""}`,
			browserMsUsed(response),
		);
	}
	return response;
}

async function runBrowserRestQuickAction(
	action: BrowserRunAction,
	payload: Record<string, unknown>,
	config: BrowserRunRestConfig | undefined,
): Promise<Response> {
	const accountId = config?.accountId.trim();
	const apiToken = config?.apiToken.trim();
	if (!accountId || !apiToken) {
		throw new Error(
			"Kitesurf requires CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the Browser Run REST transport",
		);
	}
	return (config?.fetch ?? fetch)(
		`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-run/${action}?browser=kitesurf`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
	);
}

function browserMsUsed(response: Response): number | undefined {
	const raw = response.headers.get("x-browser-ms-used")?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function tryJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function getPath(value: unknown, path: string[]): unknown {
	let current = value;
	for (const part of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function firstString(value: unknown, paths: string[][]): string | undefined {
	for (const path of paths) {
		const found = getPath(value, path);
		if (typeof found === "string" && found.trim()) return found;
	}
	return undefined;
}

function firstObject(
	value: unknown,
	paths: string[][],
): Record<string, unknown> | undefined {
	for (const path of paths) {
		const found = getPath(value, path);
		if (found && typeof found === "object" && !Array.isArray(found)) {
			return found as Record<string, unknown>;
		}
	}
	return undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function collectStrings(
	value: unknown,
	keys: Set<string>,
	output: string[],
): void {
	if (!value) return;
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, keys, output);
		return;
	}
	if (typeof value !== "object") return;

	for (const [key, nested] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (keys.has(key)) {
			collectStrings(nested, keys, output);
		} else if (key === "url" || key === "href") {
			if (typeof nested === "string") output.push(nested);
		} else if (typeof nested === "object") {
			collectStrings(nested, keys, output);
		}
	}
}

function normalizeLinks(url: string, links: string[], limit: number): string[] {
	const base = new URL(url);
	return uniqueStrings(
		links
			.map((link) => {
				try {
					return new URL(link, base).toString();
				} catch {
					return "";
				}
			})
			.filter(
				(link) => link.startsWith("http://") || link.startsWith("https://"),
			),
	).slice(0, limit);
}

function titleFromMarkdown(markdown: string, url: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	try {
		return new URL(url).hostname;
	} catch {
		return "Untitled";
	}
}

export async function scrapeMarkdownPage(
	binding: unknown | undefined,
	url: string,
	options: {
		timeoutMs?: number;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		waitForSelector?: string;
		waitForTimeoutMs?: number;
		engine?: BrowserRunEngine;
		rest?: BrowserRunRestConfig;
	} = {},
): Promise<BrowserRunMarkdownPage | null> {
	const response = await runBrowserQuickAction(
		binding,
		"markdown",
		quickActionPayload(url, options),
		{ engine: options.engine, rest: options.rest },
	);
	const text = await response.text();
	const json = tryJson(text);
	const markdown = json
		? firstString(json, [
				["markdown"],
				["content"],
				["text"],
				["data", "markdown"],
				["data", "content"],
				["result"],
				["result", "markdown"],
			])
		: text;
	if (!markdown || !hasMeaningfulMarkdown(markdown)) return null;

	const metadata =
		firstObject(json, [
			["metadata"],
			["data", "metadata"],
			["result", "metadata"],
		]) ?? {};
	const finalUrl =
		firstString(json, [
			["url"],
			["finalUrl"],
			["data", "url"],
			["data", "finalUrl"],
		]) ?? url;
	const title =
		firstString(metadata, [["ogTitle"], ["title"], ["twitterTitle"]]) ??
		titleFromMarkdown(markdown, finalUrl);

	return {
		url,
		finalUrl,
		title,
		markdown,
		metadata,
		browserMsUsed: browserMsUsed(response),
	};
}

function hasMeaningfulMarkdown(markdown: string): boolean {
	const withoutFrontmatter = markdown.replace(/^---\s*[\s\S]*?\s*---\s*/, "");
	return /[\p{L}\p{N}]/u.test(withoutFrontmatter);
}

export async function fetchRenderedContent(
	binding: unknown | undefined,
	url: string,
	options: {
		timeoutMs?: number;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		waitForSelector?: string;
		waitForTimeoutMs?: number;
		engine?: BrowserRunEngine;
		rest?: BrowserRunRestConfig;
	} = {},
): Promise<BrowserRunRenderedContent> {
	const response = await runBrowserQuickAction(
		binding,
		"content",
		quickActionPayload(url, options),
		{ engine: options.engine, rest: options.rest },
	);
	const text = await response.text();
	const json = tryJson(text);
	const html =
		firstString(json, [
			["html"],
			["content"],
			["data", "html"],
			["data", "content"],
		]) ?? text;
	const metadata =
		firstObject(json, [
			["metadata"],
			["data", "metadata"],
			["result", "metadata"],
		]) ?? {};
	const finalUrl =
		firstString(json, [
			["url"],
			["finalUrl"],
			["data", "url"],
			["data", "finalUrl"],
		]) ?? url;
	return { url, finalUrl, html, metadata };
}

export async function extractLinks(
	binding: unknown | undefined,
	url: string,
	options: {
		limit?: number;
		timeoutMs?: number;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		waitForSelector?: string;
		waitForTimeoutMs?: number;
		engine?: BrowserRunEngine;
		rest?: BrowserRunRestConfig;
	} = {},
): Promise<BrowserRunLinksResult> {
	const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
	const response = await runBrowserQuickAction(
		binding,
		"links",
		quickActionPayload(url, options),
		{ engine: options.engine, rest: options.rest },
	);
	const text = await response.text();
	const json = tryJson(text);
	const rawLinks: string[] = [];
	collectStrings(
		json ??
			text
				.match(/href=["']([^"']+)["']/gi)
				?.map((href) => href.replace(/^href=["']|["']$/g, "")) ??
			[],
		new Set(["links", "urls", "hrefs", "results"]),
		rawLinks,
	);
	return { url, links: normalizeLinks(url, rawLinks, limit) };
}

export async function captureScreenshot(
	binding: unknown | undefined,
	url: string,
	options: {
		timeoutMs?: number;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		waitForSelector?: string;
		waitForTimeoutMs?: number;
		engine?: BrowserRunEngine;
		rest?: BrowserRunRestConfig;
	} = {},
): Promise<BrowserRunScreenshot> {
	const response = await runBrowserQuickAction(
		binding,
		"screenshot",
		quickActionPayload(url, options),
		{ engine: options.engine, rest: options.rest },
	);
	const arrayBuffer = await response.arrayBuffer();
	const bytes = new Uint8Array(arrayBuffer);
	const contentType = response.headers.get("content-type") ?? "";
	if (!isUsableScreenshot(bytes, contentType)) {
		throw new Error(
			`Browser Run screenshot returned an unusable image (${contentType || "missing content-type"}, ${bytes.byteLength} bytes)`,
		);
	}
	return {
		bytes,
		contentType,
		browserMsUsed: browserMsUsed(response),
	};
}

export function isUsableScreenshot(
	bytes: Uint8Array,
	contentType: string,
): boolean {
	if (!contentType.toLowerCase().startsWith("image/")) return false;
	const png =
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a;
	const jpeg =
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff;
	const webp =
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
	return png || jpeg || webp;
}
