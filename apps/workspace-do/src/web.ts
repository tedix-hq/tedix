/**
 * Reads public web pages for the workspace agent. The fetch runs here in the
 * workspace object, never in the sandbox (which keeps no network). Only
 * https URLs on public hosts are fetched; every redirect hop is checked
 * again. HTML comes back as readable text, bounded in size and time.
 *
 * The first fetch from a domain in a conversation holds for the person's
 * approval through the usual approval card; once approved, later pages on
 * the same domain in that conversation load without asking again.
 */
import {
	neutralizeFenceMarkers,
	wrapUntrustedInput,
} from "@tedix/chat-transport/untrusted-input";
import { guardedFetch, SsrfBlockedError, validateUrl } from "@tedix/ssrf-guard";
import type { WorkspaceStorage } from "./runtime";

export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_BYTES = 2_000_000;
export const WEB_FETCH_MAX_CHARS = 40_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2_048;

const TEXT_TYPES = [
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/ld+json",
	"application/xml",
	"text/xml",
	"application/rss+xml",
	"application/atom+xml",
];

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebPage {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	title: string;
	text: string;
	truncated: boolean;
}

/** Throws a plain-English error when the URL may not be fetched. */
export function checkWebUrl(raw: unknown): URL {
	if (typeof raw !== "string" || !raw.trim())
		throw new Error("web.fetch needs a URL");
	if (raw.length > MAX_URL_LENGTH) throw new Error("That URL is too long");
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("That is not a valid URL");
	}
	if (url.protocol !== "https:")
		throw new Error("Only https web pages can be read");
	if (url.username || url.password)
		throw new Error("URLs with a user name or password cannot be read");
	const blocked = validateUrl(url.toString());
	if (blocked)
		throw new Error(`That address cannot be read (${blocked.toLowerCase()})`);
	return url;
}

/** The domain an approval covers: the host without a leading "www.". */
export function approvalDomain(url: URL): string {
	return url.hostname
		.toLowerCase()
		.replace(/\.$/, "")
		.replace(/^www\./, "");
}

/** The approval card's heading for a page: "Read example.com". */
export function webApprovalTitle(url: unknown): string | null {
	try {
		return `Read ${approvalDomain(checkWebUrl(url))}`;
	} catch {
		return null;
	}
}

/** Fetch one public page and return it as readable text. */
export async function fetchReadablePage(
	raw: string,
	options: { fetchFn?: FetchFn; timeoutMs?: number; maxBytes?: number } = {},
): Promise<WebPage> {
	const url = checkWebUrl(raw);
	const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? WEB_FETCH_MAX_BYTES;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let finalUrl = url.toString();
		const fetchFn: FetchFn = options.fetchFn ?? ((u, i) => fetch(u, i));
		const response = await guardedFetch(
			url.toString(),
			{
				headers: {
					Accept:
						"text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
					"User-Agent": "Tedix workspace agent",
				},
				signal: controller.signal,
			},
			{
				maxRedirects: WEB_FETCH_MAX_REDIRECTS,
				fetchFn: (next, init) => {
					// Every hop must stay https; the guard already blocks private hosts.
					checkWebUrl(next);
					finalUrl = next;
					return fetchFn(next, init);
				},
			},
		).catch((error: unknown) => {
			if (error instanceof SsrfBlockedError)
				throw new Error(
					`That page redirects to an address that cannot be read (${error.reason.toLowerCase()})`,
				);
			if (controller.signal.aborted)
				throw new Error(`The page did not answer within ${timeoutMs / 1000} s`);
			throw error;
		});
		const contentType = (response.headers.get("content-type") ?? "")
			.split(";")[0]!
			.trim()
			.toLowerCase();
		const isHtml =
			contentType === "text/html" || contentType === "application/xhtml+xml";
		if (contentType && !isHtml && !TEXT_TYPES.includes(contentType)) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(
				`That page is not text (it is ${contentType}); it cannot be read`,
			);
		}
		const { body, cut } = await readBounded(response, maxBytes).catch(
			(error: unknown) => {
				if (controller.signal.aborted)
					throw new Error(
						`The page did not finish loading within ${timeoutMs / 1000} s`,
					);
				throw error;
			},
		);
		const decoded = decodeText(body, response.headers.get("content-type"));
		const page =
			isHtml || (!contentType && /^\s*</.test(decoded))
				? await htmlToReadableText(decoded)
				: { title: "", text: decoded.trim() };
		const truncated = cut || page.text.length > WEB_FETCH_MAX_CHARS;
		return {
			url: url.toString(),
			finalUrl,
			status: response.status,
			contentType: contentType || "unknown",
			title: neutralizeFenceMarkers(page.title.slice(0, 500)),
			// The page is outside data: fenced so the model never takes it as instructions.
			text: wrapUntrustedInput(page.text.slice(0, WEB_FETCH_MAX_CHARS), "web"),
			truncated,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<{ body: Uint8Array; cut: boolean }> {
	if (!response.body) return { body: new Uint8Array(), cut: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let cut = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - size;
		if (value.byteLength >= room) {
			chunks.push(value.subarray(0, room));
			size += room;
			cut = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, cut };
}

function decodeText(body: Uint8Array, contentType: string | null): string {
	const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
	try {
		return new TextDecoder(charset || "utf-8").decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

const SKIPPED_ELEMENTS = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"head",
];
const BLOCK_ELEMENTS =
	"p,div,section,article,main,header,footer,aside,nav,li,ul,ol,tr,table,blockquote,pre,br,hr,dt,dd,figure,figcaption";

/** Readable text from an HTML page: title, headings, paragraphs and list items. */
export async function htmlToReadableText(
	html: string,
): Promise<{ title: string; text: string }> {
	let title = "";
	let out = "";
	let skipDepth = 0;
	const push = (piece: string) => {
		if (out.length < WEB_FETCH_MAX_CHARS * 2) out += piece;
	};
	const skip = {
		element(element: Element) {
			skipDepth += 1;
			element.onEndTag(() => {
				skipDepth = Math.max(0, skipDepth - 1);
			});
		},
	};
	let rewriter = new HTMLRewriter().on("title", {
		text(chunk) {
			title += chunk.text;
		},
	});
	for (const tag of SKIPPED_ELEMENTS) rewriter = rewriter.on(tag, skip);
	rewriter = rewriter
		.on("h1,h2,h3,h4,h5,h6", {
			element(element) {
				const level = Number(element.tagName.slice(1)) || 2;
				push(`\n\n${"#".repeat(level)} `);
				element.onEndTag(() => push("\n\n"));
			},
		})
		.on(BLOCK_ELEMENTS, {
			element(element) {
				push(element.tagName === "li" ? "\n- " : "\n");
			},
		})
		.on("a[href]", {
			element(element) {
				const href = element.getAttribute("href") ?? "";
				if (!/^https?:\/\//i.test(href)) return;
				element.onEndTag(() => push(` (${href})`));
			},
		})
		.on("*", {
			text(chunk) {
				if (skipDepth > 0) return;
				push(chunk.text);
			},
		});
	await rewriter.transform(new Response(html)).arrayBuffer();
	const text = decodeEntities(out)
		.replace(/[ \t\f\v ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n- (?=\n)/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text };
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	copy: "©",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
		const key = String(code);
		if (key[0] === "#") {
			const point =
				key[1] === "x" || key[1] === "X"
					? Number.parseInt(key.slice(2), 16)
					: Number.parseInt(key.slice(1), 10);
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff
				? String.fromCodePoint(point)
				: match;
		}
		return NAMED_ENTITIES[key.toLowerCase()] ?? match;
	});
}

export const WEB_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_domain_grants (
	conversation_id TEXT NOT NULL,
	domain TEXT NOT NULL,
	granted_at TEXT NOT NULL,
	PRIMARY KEY (conversation_id, domain)
);
`;

/** What the web binding needs from the object for one conversation. */
export interface WebPort {
	conversationId: string;
	isDomainAllowed(domain: string): boolean;
	allowDomain(domain: string): void;
	fetchPage(url: string): Promise<WebPage>;
}

export function createWebPort(
	storage: WorkspaceStorage,
	conversationId: string,
	fetchFn?: FetchFn,
): WebPort {
	storage.run(WEB_SCHEMA);
	return {
		conversationId,
		isDomainAllowed: (domain) =>
			storage.exec(
				"SELECT domain FROM web_domain_grants WHERE conversation_id = ? AND domain = ?",
				conversationId,
				domain,
			).length > 0,
		allowDomain: (domain) =>
			storage.run(
				"INSERT OR IGNORE INTO web_domain_grants (conversation_id, domain, granted_at) VALUES (?, ?, ?)",
				conversationId,
				domain,
				new Date().toISOString(),
			),
		fetchPage: (url) => fetchReadablePage(url, { fetchFn }),
	};
}
