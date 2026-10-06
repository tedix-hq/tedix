const MCP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MCP_SURFACE_SUFFIXES = {
	production: ".mcp.tedix.dev",
	development: ".mcp.tedix.tech",
} as const;

export type TedixMcpAudienceSurface = keyof typeof MCP_SURFACE_SUFFIXES;

export interface ParsedTedixMcpAudience {
	slug: string;
	surface: TedixMcpAudienceSurface;
}

export interface TedixMcpOwnership {
	app: string;
}

export const TEDIX_MCP_OWNED_TAG_PREFIXES = [
	"managed-by:",
	"resource:",
	"environment:",
	"app:",
] as const;

function assertMcpSlug(slug: string): void {
	if (!MCP_SLUG_PATTERN.test(slug)) {
		throw new Error(`Invalid MCP app slug: ${slug}`);
	}
}

/** Canonical OAuth Resource URI for a production Tedix MCP gateway. */
export function buildTedixMcpResourceUri(slug: string): string {
	assertMcpSlug(slug);
	return `https://${slug}${MCP_SURFACE_SUFFIXES.production}/mcp`;
}

/** Canonical single-audience shape required by Descope OAuth Resources. */
export function buildTedixMcpAuthorizationAudiences(slug: string): string[] {
	return [buildTedixMcpResourceUri(slug)];
}

/** Parse only canonical Tedix MCP audience URLs; aliases and wildcards fail. */
export function parseTedixMcpAudience(
	value: string,
): ParsedTedixMcpAudience | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (
		url.href !== value ||
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/mcp" ||
		url.search ||
		url.hash
	) {
		return null;
	}

	for (const [surface, suffix] of Object.entries(MCP_SURFACE_SUFFIXES) as Array<
		[TedixMcpAudienceSurface, string]
	>) {
		if (!url.hostname.endsWith(suffix)) continue;
		const slug = url.hostname.slice(0, -suffix.length);
		if (!MCP_SLUG_PATTERN.test(slug)) return null;
		return { slug, surface };
	}
	return null;
}

function isTedixOwnedTag(tag: string): boolean {
	return TEDIX_MCP_OWNED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/**
 * Replace Tedix-owned metadata with the canonical shared MCP server tags while
 * retaining unrelated operator or provider tags in their original order.
 */
export function reconcileTedixMcpOwnershipTags(
	existingTags: readonly string[] | null | undefined,
	ownership: TedixMcpOwnership,
): string[] {
	assertMcpSlug(ownership.app);
	const unrelated = (existingTags ?? []).filter((tag) => !isTedixOwnedTag(tag));
	return [
		...unrelated,
		"managed-by:tedix",
		"resource:mcp-app",
		"environment:shared",
		`app:${ownership.app}`,
	];
}
