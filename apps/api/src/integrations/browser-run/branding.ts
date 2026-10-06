import { fetchRenderedContent } from "./client";

export interface BrandingResult {
	logo?: string;
	colors?: {
		primary?: string;
		secondary?: string;
		accent?: string;
		background?: string;
		text?: string;
		textSecondary?: string;
		link?: string;
		success?: string;
		warning?: string;
		error?: string;
	};
	fonts?: {
		heading?: string;
		body?: string;
	};
	images?: {
		logo?: string;
		favicon?: string;
		ogImage?: string;
	};
	colorScheme?: "light" | "dark";
}

export interface MetadataResult {
	title?: string;
	description?: string;
	ogSiteName?: string;
	[key: string]: unknown;
}

export interface BrandingScrapeResult {
	success: boolean;
	branding?: BrandingResult;
	metadata?: MetadataResult;
	error?: string;
}

function ensureHttpUrl(url: string): string {
	return url.startsWith("http://") || url.startsWith("https://")
		? url
		: `https://${url}`;
}

function attr(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
	return match?.[1]?.trim();
}

function absoluteUrl(
	base: string,
	value: string | undefined,
): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value, base).toString();
	} catch {
		return undefined;
	}
}

function collectMeta(html: string): MetadataResult {
	const metadata: MetadataResult = {};
	const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
	for (const tag of metaTags) {
		const name = attr(tag, "name") ?? attr(tag, "property");
		const content = attr(tag, "content");
		if (!name || !content) continue;
		switch (name.toLowerCase()) {
			case "title":
				metadata.title = content;
				break;
			case "description":
				metadata.description = content;
				break;
			case "og:title":
				metadata.ogTitle = content;
				break;
			case "og:description":
				metadata.ogDescription = content;
				break;
			case "og:site_name":
				metadata.ogSiteName = content;
				break;
			case "og:image":
				metadata.ogImage = content;
				break;
			default:
				if (name.startsWith("twitter:")) metadata[name] = content;
				break;
		}
	}

	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
	if (title && !metadata.title) metadata.title = title;
	if (!metadata.title && typeof metadata.ogTitle === "string") {
		metadata.title = metadata.ogTitle;
	}
	if (!metadata.description && typeof metadata.ogDescription === "string") {
		metadata.description = metadata.ogDescription;
	}
	return metadata;
}

function collectLinks(html: string, baseUrl: string) {
	const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
	let favicon: string | undefined;
	let logo: string | undefined;
	for (const tag of linkTags) {
		const rel = (attr(tag, "rel") ?? "").toLowerCase();
		const href = absoluteUrl(baseUrl, attr(tag, "href"));
		if (!href) continue;
		if (!favicon && (rel.includes("icon") || rel.includes("shortcut"))) {
			favicon = href;
		}
		if (
			!logo &&
			(rel.includes("mask-icon") || rel.includes("apple-touch-icon"))
		) {
			logo = href;
		}
	}
	return { favicon, logo };
}

function pickColor(html: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const tag = html.match(
		new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
	)?.[0];
	const color = attr(tag ?? "", "content");
	return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
}

export async function scrapeBrandingFromUrl(
	params: { url: string },
	browserBinding: unknown | undefined,
): Promise<BrandingScrapeResult> {
	try {
		const url = ensureHttpUrl(params.url);
		console.log(`[BrowserRun] Scraping branding: ${url}`);
		const rendered = await fetchRenderedContent(browserBinding, url, {
			timeoutMs: 30_000,
		});
		const baseUrl = rendered.finalUrl ?? url;
		const metadata = {
			...collectMeta(rendered.html),
			...rendered.metadata,
		} as MetadataResult;
		const links = collectLinks(rendered.html, baseUrl);
		const ogImage = absoluteUrl(
			baseUrl,
			typeof metadata.ogImage === "string" ? metadata.ogImage : undefined,
		);
		const primary = pickColor(rendered.html, "theme-color");
		const branding: BrandingResult = {
			logo: links.logo ?? ogImage ?? links.favicon,
			colors: {
				primary,
			},
			images: {
				logo: links.logo,
				favicon: links.favicon,
				ogImage,
			},
		};

		if (!metadata.title && !metadata.description && !branding.logo) {
			return {
				success: false,
				error: "Failed to scrape homepage - no branding or metadata extracted",
			};
		}

		return {
			success: true,
			branding,
			metadata,
		};
	} catch (error) {
		console.error("[BrowserRun] Branding scrape error:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
