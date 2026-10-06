import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { loadDocsProvenance } from "./docs-provenance";

export interface SitemapItem {
	url: string;
	lastmod?: string;
	changefreq?:
		| "always"
		| "hourly"
		| "daily"
		| "weekly"
		| "monthly"
		| "yearly"
		| "never";
	priority?: number;
	links?: { lang: string; url: string }[];
}

const DEFAULT_OUTPUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../dist",
);

function metaAttributes(html: string): Map<string, string>[] {
	return [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => {
		const attributes = new Map<string, string>();
		for (const attribute of match[0].matchAll(
			/([^\s=]+)\s*=\s*(["'])(.*?)\2/g,
		)) {
			const name = attribute[1];
			const value = attribute[3];
			if (name !== undefined && value !== undefined) {
				attributes.set(name.toLowerCase(), value);
			}
		}
		return attributes;
	});
}

export function hasNoindexRobotsMeta(html: string): boolean {
	return metaAttributes(html).some((attributes) => {
		if (attributes.get("name")?.toLowerCase() !== "robots") return false;
		return (attributes.get("content") ?? "")
			.toLowerCase()
			.split(/[\s,]+/)
			.includes("noindex");
	});
}

export function articleModifiedTime(html: string): string | undefined {
	for (const attributes of metaAttributes(html)) {
		if (attributes.get("property") !== "article:modified_time") continue;
		const value = attributes.get("content");
		if (value && Number.isFinite(Date.parse(value))) return value;
	}
	return undefined;
}

function outputPagePath(url: string, outputDir: string): string | undefined {
	let pathname: string;
	try {
		const parsed = new URL(url);
		const authorityEnd = url.indexOf("/", url.indexOf("://") + 3);
		const rawPathname =
			authorityEnd === -1
				? "/"
				: (url.slice(authorityEnd).split(/[?#]/, 1)[0] ?? "/");
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return undefined;
		}
		pathname = decodeURIComponent(rawPathname);
	} catch {
		return undefined;
	}
	if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
	const segments = pathname.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return undefined;
	}
	const candidate = resolve(outputDir, ...segments, "index.html");
	const prefix = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
	return candidate === resolve(outputDir, "index.html") ||
		candidate.startsWith(prefix)
		? candidate
		: undefined;
}

async function provenanceModifiedTime(
	url: string,
): Promise<string | undefined> {
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(url).pathname);
	} catch {
		return undefined;
	}
	if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
	const route = pathname.replace(/^\/+|\/+$/g, "");
	if (route.split("/").some((segment) => segment === "." || segment === "..")) {
		return undefined;
	}
	const candidates = route
		? [`${route}.md`, `${route}.mdx`, `${route}/index.md`, `${route}/index.mdx`]
		: process.env.TEDIX_DOCS_ENTRY_PATH === "/readme"
			? ["README.md", "README.mdx", "readme.md", "readme.mdx"]
			: ["index.md", "index.mdx"];
	const provenance = await loadDocsProvenance();
	for (const candidate of candidates) {
		const updatedAt = provenance?.pages.get(candidate)?.updatedAt;
		if (updatedAt) return new Date(updatedAt).toISOString();
	}
	return undefined;
}

/** Copy the page's declared modification time into its sitemap entry. */
export function createLastUpdatedSitemapSerializer(options?: {
	outputDir?: string;
	read?: (path: string) => Promise<string>;
	lookup?: (url: string) => Promise<string | undefined>;
}): (item: SitemapItem) => Promise<SitemapItem | undefined> {
	const outputDir = resolve(options?.outputDir ?? DEFAULT_OUTPUT_DIR);
	const read = options?.read ?? ((path: string) => readFile(path, "utf8"));
	const lookup = options?.lookup ?? provenanceModifiedTime;
	return async (item) => {
		const path = outputPagePath(item.url, outputDir);
		if (!path) return item;
		try {
			const html = await read(path);
			// Nimbus 0.15 filters noindex pages from its agent/search indexes but
			// still submits them to @astrojs/sitemap. The rendered robots metadata
			// is authoritative, so remove those URLs before sitemap serialization.
			if (hasNoindexRobotsMeta(html)) return undefined;
			const lastmod = articleModifiedTime(html);
			if (lastmod) return { ...item, lastmod };
		} catch {
			// A route can be generated without a matching HTML page. Provenance
			// remains the only safe fallback; missing files never imply freshness.
		}
		try {
			const lastmod = await lookup(item.url);
			return lastmod ? { ...item, lastmod } : item;
		} catch {
			return item;
		}
	};
}

export const sitemapLastUpdated = createLastUpdatedSitemapSerializer();
