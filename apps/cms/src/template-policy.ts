import {
	CMS_TEMPLATE_SLUGS,
	type CmsTemplateSlug,
} from "@tedix/api-contract/schemas/cms-template";
export { CMS_TEMPLATE_SLUGS, type CmsTemplateSlug };
export const DEFAULT_CMS_TEMPLATE_SLUG: CmsTemplateSlug = "tedix";

/**
 * Shared infrastructure in every canonical CMS starter. These paths are
 * deployment-critical (worker entry, auth, discovery routes, plugin glue) and
 * must stay synchronized across tenant sandboxes.
 */
export const LOCKED_FILES = [
	"src/middleware.ts",
	"src/middleware/site-builder-auth-bridge.ts",
	"src/worker.ts",
	"src/live.config.ts",
	"src/env.d.ts",
	"src/auth/descope.ts",
	"src/auth/descope-jwt-boundary.ts",
	"src/pages/rss.xml.ts",
	// Discovery routes that are still Tedix-specific. Emdash 0.11 owns
	// sitemap.xml, per-collection sitemaps, and robots.txt natively via
	// hasSeo, urlPattern, per-entry noIndex, and site:seo.robotsTxt.
	"src/pages/llms.txt.ts",
	"src/pages/_tedix/search.json.ts",
	"src/pages/posts/[slug].md.ts",
	"src/pages/[...path].md.ts",
	"src/pages/api/ai-search.ts",
	"src/pages/_emdash/api/tedix/complete-existing-setup.ts",
	"astro.config.mjs",
	"package.json",
	// Keep the resolved dependency set paired with package.json. Persistent
	// sandboxes otherwise retain a stale lockfile and can request removed patches.
	"bun.lock",
	"patches/@emdash-cms/cloudflare@1.1.0.patch",
	"patches/@emdash-cms/plugin-forms@0.2.9.patch",
	"patches/emdash@1.1.0.patch",
	"tsconfig.json",
	"wrangler.jsonc",
	// Emdash plugins — locked infrastructure, not user-vibe-coded.
	// Must be present in the sandbox before `astro build` runs.
	"src/plugins/tedix-seo-aeo/index.ts",
	"src/plugins/tedix-seo-aeo/metadata.ts",
	"src/plugins/tedix-page-search/index.ts",
	"src/plugins/tedix-homepage-policy/index.ts",
	"src/plugins/tedix-editor-actions/index.ts",
	"src/plugins/tedix-editor-actions/metadata.ts",
	"src/plugins/emdash-newsletter/index.ts",
	"src/plugins/tedix-tedi-bridge/index.ts",
	"src/plugins/tedix-site-builder/index.ts",
	"src/plugins/tedix-site-builder/admin.tsx",
	// Public site URL helper — drives canonical/og:url/llms.txt emission
	// against the customer's reverse-proxy host. Imported by the locked
	// discovery routes; locking it keeps the helper signature stable.
	"src/lib/portable-content.ts",
	"src/lib/tedix-home-validation.ts",
	"src/lib/tedix-home-fields.json",
	"src/lib/tedix-home-copy-keys.json",
	"src/lib/platform-rpc.ts",
	"src/lib/site-url.ts",
	"src/lib/content-url.ts",
	"src/lib/post-markdown.ts",
	"src/lib/worker-loader-durable-objects.mjs",
	"src/lib/worker-loader-do-sql-runtime.ts",
	"src/lib/tenant-plugin-runner.ts",
] as const;

/** Branding transport remains platform infrastructure; presentation belongs to the site. */
const NATIVE_THEME_LOCKED_FILES = [
	"src/components/ThemeInit.astro",
	"src/components/ThemeControls.astro",
	"src/lib/theme-preference.ts",
	"src/lib/blog-pagination.ts",
] as const;
export const MARKETING_LOCKED_FILES = [
	"src/lib/platform-branding.ts",
	...NATIVE_THEME_LOCKED_FILES,
] as const;
export const TEDIX_LOCKED_FILES = [...NATIVE_THEME_LOCKED_FILES] as const;
export const MARKETING_LOCKED_DIRS = [] as const;

const MARKETING_ALL_LOCKED_FILES = [
	...LOCKED_FILES,
	...MARKETING_LOCKED_FILES,
] as const;

/** Explicit adoption of site-owned presentation; old partial source cannot be restored safely. */
export const THEME_SOURCE_MANIFEST_PATH = "src/theme-source.json";
export const THEME_SOURCE_VERSION = 2;

export const EDITABLE_FILES = [
	THEME_SOURCE_MANIFEST_PATH,
	"src/styles/theme.css",
	"src/components/PostCard.astro",
	"src/pages/index.astro",
	"src/pages/404.astro",
	"src/pages/category/[slug].astro",
	"src/pages/tag/[slug].astro",
] as const;

export const EDITABLE_DIRS = [
	"src/components/",
	"src/layouts/",
	"src/pages/",
	"src/styles/",
	"src/i18n/",
	"src/utils/",
	"src/icons/",
] as const;

export function normalizeCmsTemplateSlug(
	templateSlug: string | null | undefined,
): CmsTemplateSlug {
	const slug = templateSlug?.trim() || DEFAULT_CMS_TEMPLATE_SLUG;
	if (!(CMS_TEMPLATE_SLUGS as readonly string[]).includes(slug)) {
		throw new Error(`Unknown CMS template: ${slug}`);
	}
	return slug as CmsTemplateSlug;
}

export function lockedFilesForTemplate(
	templateSlug?: string | null,
): readonly string[] {
	const slug = normalizeCmsTemplateSlug(templateSlug);
	if (slug === "marketing") return MARKETING_ALL_LOCKED_FILES;
	if (slug === "tedix") return [...LOCKED_FILES, ...TEDIX_LOCKED_FILES];
	return [...LOCKED_FILES, "cms.config.mjs"];
}

export function lockedDirsForTemplate(
	templateSlug?: string | null,
): readonly string[] {
	return normalizeCmsTemplateSlug(templateSlug) === "marketing"
		? MARKETING_LOCKED_DIRS
		: [];
}
