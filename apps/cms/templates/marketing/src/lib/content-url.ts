import { getCollectionInfo } from "emdash";
import { getPublicSiteUrl } from "./site-url";

interface ContentUrlOptions {
	locale?: string;
	defaultLocale?: string;
	trailingSlash?: boolean;
}

const collectionPatternValueCache = new Map<string, string | null>();

async function getCollectionPattern(
	collection: string,
): Promise<string | null> {
	if (collectionPatternValueCache.has(collection)) {
		return collectionPatternValueCache.get(collection) ?? null;
	}

	const info = await getCollectionInfo(collection);
	const pattern = info?.urlPattern?.trim();
	const value = pattern && pattern.length > 0 ? pattern : null;
	collectionPatternValueCache.set(collection, value);
	return value;
}

function normalisePath(path: string, trailingSlash: boolean): string {
	const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
	const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
	if (collapsed === "/") return collapsed;
	const withoutTrailingSlash = collapsed.replace(/\/+$/, "");
	return trailingSlash ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
}

function localePrefix(locale?: string, defaultLocale?: string): string {
	if (!locale || !defaultLocale || locale === defaultLocale) return "";
	return `/${locale}`;
}

function collectionIndexPathFromPattern(pattern: string): string | null {
	const normalized = normalisePath(pattern, false);
	const match = normalized.match(/^(.*)\/\{(?:slug|id)\}$/);
	if (!match) return null;

	const parent = (match[1] ?? "").replace(/\/+$/, "");
	if (parent.includes("{") || parent.includes("}")) return null;
	return parent.length > 0 ? `${parent}/` : "/";
}

export async function contentPath(
	collection: string,
	slugOrId: string,
	options: ContentUrlOptions = {},
): Promise<string> {
	const pattern = await getCollectionPattern(collection);
	const encoded = encodeURIComponent(slugOrId);
	const path = pattern
		? pattern.replaceAll("{slug}", encoded).replaceAll("{id}", encoded)
		: `/${collection}/${encoded}`;
	return normalisePath(
		`${localePrefix(options.locale, options.defaultLocale)}${path}`,
		options.trailingSlash ?? !pattern?.endsWith("}"),
	);
}

export async function contentHref(
	collection: string,
	slugOrId: string,
	options: ContentUrlOptions = {},
): Promise<string> {
	return `${getPublicSiteUrl()}${await contentPath(collection, slugOrId, options)}`;
}

export async function contentMarkdownHref(
	collection: string,
	slugOrId: string,
	options: Omit<ContentUrlOptions, "trailingSlash"> = {},
): Promise<string> {
	const path = await contentPath(collection, slugOrId, {
		...options,
		trailingSlash: false,
	});
	return `${getPublicSiteUrl()}${path}.md`;
}

export async function collectionIndexPath(
	collection: string,
	options: Omit<ContentUrlOptions, "trailingSlash"> = {},
): Promise<string> {
	const pattern = await getCollectionPattern(collection);
	const prefix = localePrefix(options.locale, options.defaultLocale);
	const patternIndexPath = pattern
		? collectionIndexPathFromPattern(pattern)
		: null;
	if (patternIndexPath) {
		return normalisePath(`${prefix}${patternIndexPath}`, true);
	}
	return normalisePath(`${prefix}/${collection}`, true);
}

export async function collectionIndexHref(
	collection: string,
	options: Omit<ContentUrlOptions, "trailingSlash"> = {},
): Promise<string> {
	return `${getPublicSiteUrl()}${await collectionIndexPath(collection, options)}`;
}
