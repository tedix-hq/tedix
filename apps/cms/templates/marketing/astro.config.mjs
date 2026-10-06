import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { r2 } from "@emdash-cms/cloudflare";
import { aiSearch } from "@emdash-cms/cloudflare/plugins";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import emdash from "emdash/astro";
import { emprivacyPlugin } from "emprivacy";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { defineConfig, fontProviders } from "astro/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workerLoaderDurableObjects as durableObjects } from "./src/lib/worker-loader-durable-objects.mjs";
import { editorActionsMetadata } from "./src/plugins/tedix-editor-actions/metadata.ts";

const siteBuilderAuthBridgeEntrypoint = fileURLToPath(
	new URL("./src/middleware/site-builder-auth-bridge.ts", import.meta.url),
);
const workerLoaderDoSqlEntrypoint = fileURLToPath(
	new URL("./src/lib/worker-loader-do-sql-runtime.ts", import.meta.url),
);
const templateDirectory = dirname(fileURLToPath(import.meta.url));

// The deployed marketing workspace overlays this starter on the baked Tedix
// base, while a repository-local build starts from the marketing directory
// alone. Resolve shared locked plugins locally after snapshot materialization,
// and from the canonical Tedix starter during a standalone source build.
function sharedLockedSource(relativePath) {
	const localPath = resolve(templateDirectory, relativePath);
	const sourcePath = existsSync(localPath)
		? localPath
		: resolve(templateDirectory, "../tedix", relativePath);
	return pathToFileURL(sourcePath).href;
}

const { seoAeoPluginMetadata } = await import(
	sharedLockedSource("src/plugins/tedix-seo-aeo/metadata.ts")
);

const privacyBannerEnabled = process.env.PRIVACY_BANNER_ENABLED === "true";
const cmsDatabaseName = process.env.ORG_SLUG ?? "preview";
if (!process.env.PUBLIC_SITE_URL && cmsDatabaseName !== "preview") {
	throw new Error(
		`CMS tenant ${cmsDatabaseName} requires PUBLIC_SITE_URL at build time`,
	);
}
const publicSiteUrl =
	process.env.PUBLIC_SITE_URL ?? "https://preview.cms.tedix.dev";
const publicPathPrefix = process.env.PUBLIC_PATH_PREFIX ?? "";
const publicHostname = new URL(publicSiteUrl).hostname;

export default defineConfig({
	output: "server",
	// Emdash adds the unprefixed same-origin media route. The public proxy may
	// preserve the tenant mount prefix, so authorize that exact route as well.
	image: publicPathPrefix
		? {
				remotePatterns: [
					{
						protocol: "https",
						hostname: publicHostname,
						pathname: `${publicPathPrefix}/_emdash/api/media/file/**`,
					},
				],
			}
		: undefined,
	// Inline all CSS into HTML <style> tags. The dispatched user worker is
	// uploaded as JS modules only — there's no Workers Assets binding, so
	// /_astro/*.css would 500. Inlining ships every page with its CSS.
	build: { inlineStylesheets: "always" },
	// Platform-wide i18n superset. The locale list here must be a superset of
	// every org's enabled locales. `defaultLocale: "en"` is the template
	// default — patchLocaleConfig in deploy-workflow.ts rewrites this to the
	// org's actual primary language before each build (e.g. "de" for a
	// German-language org). With `prefixDefaultLocale: false`:
	//   English-default org: `/` = English, `/de/` = German (via fallback)
	//   German-default org:  `/` = German, `/en/` = English (via fallback)
	// patchLocaleConfig also rewrites the fallback map so every secondary
	// locale falls back to the org's default.
	i18n: {
		defaultLocale: "en",
		locales: ["en", "de", "es", "fr", "it", "pt", "nl"],
		// English-default orgs keep fallback empty; patchLocaleConfig rewrites
		// this map for non-English orgs so secondary locales fall back to the
		// org's default language before each tenant build.
		fallback: {},
		routing: { prefixDefaultLocale: false },
	},
	adapter: cloudflare({
		sessions: { enabled: false },
		// /_image is served by the parent-level interception in cms-runtime.
		imageService: "cloudflare-binding",
	}),
	integrations: [
		{
			name: "tedix-existing-site-setup",
			hooks: {
				"astro:config:setup": ({ injectRoute }) => {
					// Astro skips underscore directories in filesystem routing.
					injectRoute({
						pattern: "/_emdash/api/tedix/complete-existing-setup",
						entrypoint: sharedLockedSource(
							"src/pages/_emdash/api/tedix/complete-existing-setup.ts",
						),
						prerender: false,
					});
					injectRoute({
						pattern: "/_tedix/search.json",
						entrypoint: sharedLockedSource("src/pages/_tedix/search.json.ts"),
						prerender: false,
					});
				},
			},
		},
		react(),
		emdash({
			// Emdash 0.34 `middleware.outer` wraps the complete Emdash request
			// pipeline: before next() it runs ahead of runtime and database
			// initialization, so the broker redirect for an unauthenticated admin
			// navigation returns without paying init cost, and after next() it sees
			// the fully mutated response. This replaces the hand-rolled
			// `tedix-site-builder-auth-bridge` Astro integration that registered the same
			// module with order: "pre".
			middleware: { outer: siteBuilderAuthBridgeEntrypoint },
			// Client mode keeps public HTML session-neutral while preserving editor
			// access. Shared parent response caching is deliberately disabled.
			toolbar: "client",
			siteUrl: publicSiteUrl,
			auth: {
				type: "descope",
				entrypoint: sharedLockedSource("src/auth/descope.ts"),
				config: {
					baseUrlEnvVar: "DESCOPE_BASE_URL",
					projectIdEnvVar: "DESCOPE_PROJECT_ID",
					tenantIdEnvVar: "DESCOPE_TENANT_ID",
					defaultRole: 10,
					syncRoles: true,
					roleMapping: {
						"platform-admin": 50,
						owner: 50,
						admin: 50,
						"Org Admin": 50,
						editor: 40,
						"Content Manager": 40,
						member: 40,
						Member: 40,
						viewer: 10,
					},
				},
			},
			database: durableObjects(
				{
					binding: "DB_DO",
					name: cmsDatabaseName,
					session: "auto",
				},
				workerLoaderDoSqlEntrypoint,
			),
			storage: r2({ binding: "MEDIA" }),
			// Emdash routes <Image>/getImage() through /_image. The parent CMS
			// runtime serves transforms with its own native IMAGES binding; the
			// Worker Loader-dispatched tenant bundle receives no such binding.
			images: true,
			sandboxRunner: fileURLToPath(
				new URL("./src/lib/tenant-plugin-runner.ts", import.meta.url),
			),
			registry: {
				aggregatorUrl: "https://registry.emdashcms.com",
				policy: {
					minimumReleaseAge: "72h",
				},
			},
			admin: {
				siteName: "Sites",
				favicon: "https://tedix.dev/favicon.ico",
				logo: "https://tedix.dev/images/tedi-astronaut-waving.png",
			},
			// Trusted Emdash plugins. Order matters: when enabled, EmPrivacy
			// registers first so its page fragments run before any analytics or
			// marketing trackers. Some tenants rely on their primary site's own
			// privacy/cookie layer when the CMS is reverse-proxied into that site.
			// EmPrivacy is opt-in per tenant via PRIVACY_BANNER_ENABLED=true.
			plugins: [
				...(privacyBannerEnabled ? [emprivacyPlugin()] : []),
				embedsPlugin(),
				...(cmsDatabaseName === "tedix-landing"
					? [
							{
								id: "tedix-page-search",
								version: "0.1.0",
								format: "standard",
								entrypoint: sharedLockedSource(
									"src/plugins/tedix-page-search/index.ts",
								),
								capabilities: ["content:write"],
							},
							{
								id: "tedix-homepage-policy",
								version: "0.1.0",
								format: "standard",
								entrypoint: sharedLockedSource(
									"src/plugins/tedix-homepage-policy/index.ts",
								),
								capabilities: ["hooks.content-policy:register"],
							},
						]
					: []),
				{
					...editorActionsMetadata,
					entrypoint: sharedLockedSource(
						"src/plugins/tedix-editor-actions/index.ts",
					),
				},
				{
					id: "tedix-seo-aeo",
					...seoAeoPluginMetadata,
					version: "0.1.0",
					format: "standard",
					// Absolute file:// URL so the virtual emdash/plugins module can resolve
					// this at build time (relative paths fail because the virtual module has
					// no on-disk location to anchor them).
					entrypoint: sharedLockedSource("src/plugins/tedix-seo-aeo/index.ts"),
					capabilities: ["content:read"],
				},
				{
					// Bridges Emdash publish events into the org's tedi
					// platform brain via /rpc/memory/learn. Reads per-org
					// settings (`tedi.platformApiKey`, `tedi.id`, ...) from
					// Emdash settings KV. See
					// `src/plugins/tedix-tedi-bridge/index.ts`.
					id: "tedix-tedi-bridge",
					version: "0.1.0",
					format: "standard",
					entrypoint: sharedLockedSource(
						"src/plugins/tedix-tedi-bridge/index.ts",
					),
					capabilities: [
						"content:read",
						"taxonomies:read",
						"network:request:unrestricted",
					],
					settingsSchema: {
						"tedi.platformApiUrl": {
							type: "url",
							label: "Platform API URL",
							default: "https://api.tedix.dev",
						},
						"tedi.platformApiKey": {
							type: "secret",
							label: "Tedix API Key",
						},
						"tedi.id": { type: "string", label: "Tedi ID" },
						"tedi.domain": {
							type: "string",
							label: "Knowledge domain",
							default: "content-published",
						},
						"tedi.collections": {
							type: "string",
							label: "Bridged collections",
							description: "Comma- or newline-separated collection slugs.",
							default: "posts",
							multiline: true,
						},
						"tedi.bridgeDisabled": {
							type: "boolean",
							label: "Disable bridge",
							default: false,
						},
					},
				},
				{
					// Double-opt-in newsletter. Routes:
					//   POST /_emdash/api/plugins/emdash-newsletter/subscribe
					//   GET  /_emdash/api/plugins/emdash-newsletter/confirm?token=…
					//   GET  /_emdash/api/plugins/emdash-newsletter/unsubscribe?token=…
					// Hook content:afterPublish fans out a digest to active
					// subscribers. Outbound mail uses the platform endpoint
					// `tediEmail.sendEmail` via Cloudflare Email Service. Reads
					// `newsletter.platformApiKey` (sk_…) from Emdash settings.
					// See `src/plugins/emdash-newsletter/index.ts`.
					id: "emdash-newsletter",
					version: "0.1.0",
					format: "standard",
					entrypoint: sharedLockedSource(
						"src/plugins/emdash-newsletter/index.ts",
					),
					capabilities: ["content:read", "network:request:unrestricted"],
					storage: {
						subscribers: {
							indexes: ["status", "confirmToken", "unsubscribeToken"],
							uniqueIndexes: ["email"],
						},
					},
					settingsSchema: {
						"newsletter.platformApiUrl": {
							type: "url",
							label: "Platform API URL",
							default: "https://api.tedix.dev",
						},
						"newsletter.platformApiKey": {
							type: "secret",
							label: "Tedix API Key",
						},
						"newsletter.orgSlug": {
							type: "string",
							label: "Org / app slug",
						},
						"newsletter.disabled": {
							type: "boolean",
							label: "Disable newsletter",
							default: false,
						},
						"newsletter.digestCollections": {
							type: "string",
							label: "Digest collections",
							description: "Comma- or newline-separated collection slugs.",
							default: "posts",
							multiline: true,
						},
						"newsletter.digestPageSize": {
							type: "number",
							label: "Digest page size",
							min: 1,
							max: 200,
							default: 25,
						},
					},
				},
				// Native field widget and a link to platform code/deployment controls.
				{
					id: "tedix-site-builder",
					version: "1.0.0",
					format: "native",
					capabilities: [],
					entrypoint: sharedLockedSource(
						"src/plugins/tedix-site-builder/index.ts",
					),
					adminEntry: sharedLockedSource(
						"src/plugins/tedix-site-builder/admin.tsx",
					),
					fieldWidgets: [
						{
							name: "derived-search-text",
							label: "Generated search text",
							fieldTypes: ["text"],
						},
					],
					adminPages: [
						{
							path: "/development",
							label: "Code and deployments",
							icon: "code",
						},
					],
				},
				// Forms — @emdash-cms/plugin-forms@0.2.4 (published on npm). Build
				// forms in the admin, embed them in content via Portable Text, and
				// accept anonymous submissions. The marketing template's /kontakt
				// page renders an admin-authored `contact` form via this plugin's
				// embed; the native form must be configured before publication.
				formsPlugin(),
				aiSearch(),
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Raleway",
			cssVariable: "--font-sans",
			weights: ["100 900"],
			styles: ["normal", "italic"],
			fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Comfortaa",
			cssVariable: "--font-display",
			weights: ["300 700"],
			styles: ["normal"],
			fallbacks: ["ui-rounded", "system-ui", "sans-serif"],
		},
	],
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			dedupe: ["react", "react-dom"],
		},
		server: {
			allowedHosts: true,
		},
	},
	devToolbar: { enabled: false },
	// experimental.cache + cloudflareCache() were removed because they break
	// the dispatched user worker — every route returns the catch-all 404
	// HTML page: all routes (including native sitemap routes, locked Tedix
	// discovery routes such as llms.txt, robots.txt, posts/[slug].md.ts, and
	// post detail pages) are eaten by the cache provider's init failure in the
	// dispatched isolate.
	//
	// If we want edge caching back, gate it behind the actual presence of
	// CF_ZONE_ID + CF_CACHE_PURGE_TOKEN in env (the cms-runtime's per-isolate
	// env injection isn't passing these through right now) and add a runtime
	// smoke test that verifies native sitemap routes, locked Tedix discovery
	// routes, and post detail routes still work after build.
});
