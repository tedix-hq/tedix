import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
// @astrojs/sitemap removed — replaced by custom dynamic sitemaps:
// sitemap-index.xml.ts, sitemap-blog.xml.ts, sitemap-apps.xml.ts
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders, sessionDrivers } from "astro/config";

const LANDING_INSPECTOR_PORT = Number(
	process.env.LANDING_INSPECTOR_PORT ?? 9233,
);

// https://astro.build/config
export default defineConfig({
	site: "https://tedix.dev",
	output: "server",
	// The CMS blog keeps /_astro/* on the apex during the interim cutover.
	// Put this Worker's generated CSS, JS and fonts in a separate namespace.
	build: { assets: "_landing" },
	trailingSlash: "ignore",
	i18n: {
		defaultLocale: "en",
		locales: ["en", "de", "es"],
		routing: {
			prefixDefaultLocale: false,
		},
	},
	prefetch: {
		defaultStrategy: "viewport",
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	// Landing does not use Astro sessions. A concrete non-KV driver prevents the
	// Cloudflare adapter from auto-provisioning a SESSION binding.
	session: {
		driver: sessionDrivers.lruCache({ max: 1 }),
	},
	adapter: cloudflare({
		imageService: { build: "compile", runtime: "passthrough" },
		inspectorPort: LANDING_INSPECTOR_PORT,
	}),
	// Workers Cache (requires wrangler.jsonc `cache.enabled: true`, set
	// above). The Cloudflare provider sets Cloudflare-CDN-Cache-Control /
	// Cache-Tag response headers — additive to any hand-set `Cache-Control`
	// headers already used on individual pages/endpoints, so it doesn't
	// conflict with them. Conservative site-wide default: this is a public
	// marketing site where freshness matters more than hit ratio.
	cache: {
		provider: cacheCloudflare(),
	},
	routeRules: {
		"/[...all]": { maxAge: 300, swr: 3600 },
	},
	integrations: [react()],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Raleway",
			cssVariable: "--font-raleway",
			weights: ["100 900"],
			styles: ["normal", "italic"],
			fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Comfortaa",
			cssVariable: "--font-comfortaa",
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
			// Allow cloudflared tunnel domains. The landing dev host is
			// landing.tedix.tech (the tedix.tech apex is an external site).
			allowedHosts: (process.env.TEDIX_DEV_ALLOWED_HOSTS ?? "")
				.split(",")
				.map((host) => host.trim())
				.filter(Boolean),
		},
		ssr: {
			// Allow workspace packages to be processed
			noExternal: [
				"@tedix/widget-ui",
				"@tedix/api-client",
				"@tedix/api-contract",
			],
		},
	},
});
