/**
 * Apps SDK Widget Utilities (Astro SSR)
 *
 * Fetches SSR HTML from Astro server and transforms it for ChatGPT's iframe sandbox.
 *
 * ChatGPT's CSP includes `base-uri 'self'` which blocks <base href> changes.
 * Instead, we rewrite all relative URLs to absolute URLs server-side.
 *
 * This matches Vercel's approach but done at the MCP server level instead of
 * relying on assetPrefix (which only works for Next.js production builds).
 *
 * Widget Theming:
 * When fetching widget HTML, we pass app branding via `X-Tedix-App-Theme` header.
 * This allows the widget to render with app-specific colors/fonts at SSR time,
 * avoiding FOUC (flash of unstyled content) and extra API calls.
 *
 * @see https://vercel.com/blog/running-nextjs-inside-chatgpt
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	BrandingProfile,
	WidgetThemePayload,
} from "@tedix/api-contract/schemas/widget-theme";
import { contentFreeMcpException, createMcpLogger } from "../../log";
import type { OpenAiWidgetCSP } from "../types";

const log = createMcpLogger("mcp.widget.fetch");

/**
 * Default CSP domains for widgets.
 * Core infrastructure domains are added dynamically via buildCoreCspDomains().
 */
const DEFAULT_WIDGET_CSP: OpenAiWidgetCSP = {
	connect_domains: [],
	resource_domains: ["https://cdn.openai.com"], // KaTeX fonts
};

/**
 * Merge additional CSP domains with defaults.
 */
export function createWidgetCSP(
	additionalDomains?: Partial<OpenAiWidgetCSP>,
): OpenAiWidgetCSP {
	return {
		connect_domains: [
			...(DEFAULT_WIDGET_CSP.connect_domains ?? []),
			...(additionalDomains?.connect_domains ?? []),
		].filter((d): d is string => Boolean(d)),
		resource_domains: [
			...(DEFAULT_WIDGET_CSP.resource_domains ?? []),
			...(additionalDomains?.resource_domains ?? []),
		].filter((d): d is string => Boolean(d)),
		...(additionalDomains?.frame_domains && {
			frame_domains: additionalDomains.frame_domains,
		}),
		...(additionalDomains?.redirect_domains && {
			redirect_domains: additionalDomains.redirect_domains,
		}),
	};
}

/**
 * Rewrite all relative URLs in HTML to absolute URLs.
 *
 * ChatGPT's sandbox CSP blocks <base href> changes with `base-uri 'self'`.
 * This function rewrites URLs server-side to work around that limitation.
 *
 * Standard HTML attributes rewritten:
 * - src, href, action, data-src, poster, srcset
 *
 * Astro-specific attributes rewritten:
 * - component-url, renderer-url, before-hydration-url
 *
 * JavaScript patterns rewritten:
 * - import("/..." → import("https://mcp-ui.tedix.tech/..."
 * - from "/..." → from "https://mcp-ui.tedix.tech/..."
 *
 * CSS patterns rewritten:
 * - url(/...) → url(https://mcp-ui.tedix.tech/...)
 */
export function rewriteRelativeUrls(html: string, baseUrl: string): string {
	// Normalize baseUrl (remove trailing slash)
	const base = baseUrl.replace(/\/$/, "");

	// List of HTML attributes that can contain URLs
	// Includes standard HTML + Astro-specific attributes
	const urlAttributes = [
		// Standard HTML
		"src",
		"href",
		"action",
		"data-src",
		"poster",
		"srcset",
		// Astro island attributes
		"component-url",
		"renderer-url",
		"before-hydration-url",
	].join("|");

	// Rewrite URL attributes: attr="/path" or attr='/path'
	// Uses a simpler, more reliable pattern that matches paths starting with /
	const attrRegex = new RegExp(
		`((?:${urlAttributes})\\s*=\\s*)(['"])(/[^'"]*)(\\2)`,
		"gi",
	);

	let result = html.replace(attrRegex, (match, prefix, quote, path) => {
		// Don't rewrite protocol-relative URLs (//...) or data: URLs
		if (path.startsWith("//") || path.startsWith("/data:")) {
			return match;
		}
		return `${prefix}${quote}${base}${path}${quote}`;
	});

	// Rewrite dynamic imports: import("/...")
	result = result.replace(
		/import\s*\(\s*(['"])(\/[^'"]*)\1\s*\)/g,
		(match, quote, path) => {
			if (path.startsWith("//")) return match;
			return `import(${quote}${base}${path}${quote})`;
		},
	);

	// Rewrite static imports: from "/..."
	result = result.replace(
		/from\s+(['"])(\/[^'"]*)\1/g,
		(match, quote, path) => {
			if (path.startsWith("//")) return match;
			return `from ${quote}${base}${path}${quote}`;
		},
	);

	// Rewrite url() in inline styles: url(/...)
	result = result.replace(
		/url\s*\(\s*(['"]?)(\/[^'")]*)\1\s*\)/gi,
		(match, quote, path) => {
			if (path.startsWith("//") || path.startsWith("/data:")) return match;
			return `url(${quote}${base}${path}${quote})`;
		},
	);

	return result;
}

/**
 * Options for fetching widget HTML
 */
export interface FetchWidgetOptions {
	/**
	 * App theme payload to pass via X-Tedix-App-Theme header.
	 * Contains app ID, slug, name, and branding for SSR theming.
	 */
	theme?: WidgetThemePayload;
	/**
	 * Additional headers to pass to the widget server.
	 * Used by render widgets to pass layout specs via X-Tedix-Layout-Spec.
	 */
	extraHeaders?: Record<string, string>;
}

/**
 * Fetch and transform widget HTML from Astro SSR server.
 *
 * Works the same in dev and production - fetches SSR HTML, rewrites
 * relative URLs to absolute. Host discovery belongs to the guest SDK.
 *
 * Production: Astro's build.assetsPrefix handles most URLs natively.
 * Development: URL rewriting catches Vite's relative paths.
 *
 * Widget Theming:
 * When `options.theme` is provided, the app's branding is passed via
 * `X-Tedix-App-Theme` header. The widget server reads this header and
 * injects CSS variables at render time, avoiding FOUC and extra API calls.
 *
 * @param baseUrl - Base URL of the widget server (e.g., "https://mcp-ui.tedix.dev")
 * @param path - Widget route path (e.g., "/tedix/search-listings")
 * @param options - Optional configuration including theme payload
 */
export async function getAppsSDKCompatibleHtml(
	baseUrl: string,
	path: string,
	options?: FetchWidgetOptions,
): Promise<string> {
	const url = `${baseUrl}${path}`;

	// Build request headers
	const headers: Record<string, string> = {};

	// Pass app theme via header if provided
	if (options?.theme) {
		try {
			headers["X-Tedix-App-Theme"] = JSON.stringify(options.theme);
		} catch (error) {
			log.warn("Widget theme serialization failed", {
				event: "widget.theme_serialization_failed",
				outcome: "invalid",
				error: contentFreeMcpException(error),
			});
		}
	}

	// Pass any extra headers (e.g., X-Tedix-Layout-Spec for render widgets)
	if (options?.extraHeaders) {
		Object.assign(headers, options.extraHeaders);
	}

	const response = await fetch(url, {
		headers: Object.keys(headers).length > 0 ? headers : undefined,
	});

	if (!response.ok) {
		log.error("Widget fetch failed", {
			event: "widget.fetch_failed",
			status: response.status,
			outcome: "unavailable",
		});
		throw new Error(
			`Widget fetch failed: ${response.status} ${response.statusText}`,
		);
	}

	const html = await response.text();

	// Detect Astro 404 pages
	const is404Page =
		html.includes("<title>404") ||
		html.includes("404: Not found") ||
		html.includes("404: Not Found");

	if (is404Page) {
		log.error("Widget route not found", {
			event: "widget.route_missing",
			status: 404,
			outcome: "invalid",
		});
		throw new Error(`Widget route not found: ${path}`);
	}

	return rewriteRelativeUrls(html, baseUrl);
}

/**
 * Build a WidgetThemePayload from app data and branding
 *
 * Helper function for MCP agent to construct the theme payload
 * that will be passed via X-Tedix-App-Theme header.
 *
 * @param app - App data with id, slug, name
 * @param branding - Flattened branding profile for CSS variable generation
 * @param widgetConfig - Optional widget-specific configuration overrides
 */
export function buildWidgetThemePayload(
	app: { id: string; slug: string; name: string },
	branding: BrandingProfile,
	widgetConfig?: Record<string, JsonValue>,
): WidgetThemePayload {
	return {
		id: app.id,
		slug: app.slug,
		name: app.name,
		branding,
		...(widgetConfig && { widgetConfig }),
	};
}
