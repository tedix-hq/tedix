import { tool, type ToolSet } from "ai";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { wrapUntrustedInput } from "./untrusted-input";

export const BROWSER_INLINE_CHARS = 50_000;
const RESULT_DIRECTORY = "/workspace/browser-results";
const RECOVERY =
	"Use browser_read_result with resultId to page/search the full result or read feed entries. Continue the authorized task; truncation is not an approval requirement. Respect actual policy denials and remaining budgets.";

export interface BrowserResultFiles {
	mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
	writeFile(path: string, content: string): Promise<unknown>;
	readFile(path: string): Promise<string | null>;
}

interface FeedEntry {
	title: string;
	url: string;
	published: string;
	summary: string;
}

const list = (value: unknown): any[] =>
	value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string =>
	typeof value === "string"
		? value
		: typeof value === "number"
			? String(value)
			: (value?.["#text"] ?? "");

/** Parse XML, including the fenced XML returned by Browser Run. Never expand DTDs. */
export function browserFeedEntries(source: string): FeedEntry[] | null {
	const xml = source.trim().replace(/^```(?:xml)?\s*\n([\s\S]*?)\n```$/, "$1");
	if (!/^\s*(?:<\?xml[^>]*>\s*)?<(?:rss\b|feed\b)/i.test(xml)) return null;
	if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
		return null;
	const parsed = new XMLParser({
		ignoreAttributes: false,
		parseTagValue: false,
		removeNSPrefix: true,
	}).parse(xml);
	if (parsed.rss?.channel)
		return list(parsed.rss.channel.item).map((item) => ({
			title: text(item.title),
			url: text(item.link),
			published: text(item.pubDate),
			summary: text(item.description),
		}));
	if (parsed.feed)
		return list(parsed.feed.entry).map((item) => ({
			title: text(item.title),
			url:
				list(item.link).find(
					(link) => !link["@_rel"] || link["@_rel"] === "alternate",
				)?.["@_href"] ?? "",
			published: text(item.published ?? item.updated),
			summary: text(item.summary),
		}));
	return null;
}

function chunk(source: string, offset: number, limit: number) {
	let end = Math.min(source.length, offset + limit);
	// Offsets are UTF-16 characters, but never split a Unicode surrogate pair.
	if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1] ?? ""))
		end = end - 1 === offset ? Math.min(source.length, end + 1) : end - 1;
	return {
		content: wrapUntrustedInput(source.slice(offset, end), "browser"),
		offset,
		nextOffset: end < source.length ? end : null,
	};
}

function feedPage(entries: FeedEntry[], offset: number, limit: number) {
	const page: FeedEntry[] = [];
	let size = 2;
	for (const entry of entries.slice(offset, offset + limit)) {
		const length = JSON.stringify(entry).length + 1;
		if (size + length > BROWSER_INLINE_CHARS) break;
		page.push(entry);
		size += length;
	}
	return {
		format: "feed",
		totalEntries: entries.length,
		offset,
		returnedEntries: page.length,
		nextOffset:
			offset + page.length < entries.length ? offset + page.length : null,
		content: wrapUntrustedInput(JSON.stringify(page), "browser"),
		...(page.length === 0 && offset < entries.length
			? {
					note: "This entry exceeds the inline budget. Read/search the retained source in text mode.",
				}
			: {}),
	};
}

/** SDK quick-action caps must be disabled: retention happens before any projection. */
export async function retainBrowserResult(
	value: unknown,
	files: BrowserResultFiles,
) {
	const source =
		typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
	const entries = typeof value === "string" ? browserFeedEntries(source) : null;
	if (source.length <= BROWSER_INLINE_CHARS && entries === null) {
		return {
			truncated: false,
			totalChars: source.length,
			content: wrapUntrustedInput(source, "browser"),
		};
	}
	const resultId = crypto.randomUUID();
	const path = `${RESULT_DIRECTORY}/${resultId}.txt`;
	await files.mkdir(RESULT_DIRECTORY, { recursive: true });
	// A failed durable write fails the call rather than claiming recoverability.
	await files.writeFile(path, source);
	return {
		resultId,
		path,
		totalChars: source.length,
		inlineLimitChars: BROWSER_INLINE_CHARS,
		truncated: entries === null && source.length > BROWSER_INLINE_CHARS,
		truncationReason: entries === null ? "inline_character_budget" : null,
		retained: true,
		projection: entries === null ? "text_preview" : "feed_metadata",
		recovery: RECOVERY,
		...(entries === null
			? chunk(source, 0, BROWSER_INLINE_CHARS)
			: feedPage(entries, 0, 10)),
	};
}

export function browserResultTools(files: BrowserResultFiles): ToolSet {
	return {
		browser_read_result: tool({
			description:
				"Read retained browser results without refetching or consuming browser calls. Text mode pages by character offset and optionally searches for a literal query. Feed mode returns complete RSS/Atom metadata entries by entry offset, excluding article bodies. Offsets start at zero. The result belongs only to this conversation/work scope.",
			inputSchema: z.object({
				resultId: z.uuid(),
				mode: z.enum(["text", "feed"]).default("text"),
				offset: z.number().int().nonnegative().default(0),
				limit: z.number().int().positive().max(BROWSER_INLINE_CHARS).optional(),
				query: z.string().min(1).max(1000).optional(),
			}),
			execute: async ({ resultId, mode, offset, limit, query }) => {
				// Also validate here because internal callers may bypass the schema.
				z.uuid().parse(resultId);
				const source = await files.readFile(
					`${RESULT_DIRECTORY}/${resultId}.txt`,
				);
				if (source === null)
					throw new Error("Browser result is unavailable in this work scope");
				if (mode === "feed") {
					const entries = browserFeedEntries(source);
					if (entries === null)
						throw new Error(
							"Result is not a complete RSS/Atom feed; use text mode",
						);
					return {
						resultId,
						...feedPage(entries, offset, Math.min(limit ?? 10, 100)),
					};
				}
				const start = query ? source.indexOf(query, offset) : offset;
				if (start < 0)
					return { resultId, found: false, totalChars: source.length };
				return {
					resultId,
					totalChars: source.length,
					...chunk(source, start, limit ?? BROWSER_INLINE_CHARS),
				};
			},
		}),
	};
}
