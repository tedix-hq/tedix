import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders, sessionDrivers } from "astro/config";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

// Production assets use the installation origin, supplied explicitly or by
// the materialized Worker configuration. Local builds stay on localhost.
const workerConfig = parse(
	readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
);
const production = process.env.CLOUDFLARE_ENV === "production";
const MCP_UI_URL =
	process.env.MCP_UI_URL ??
	(production
		? (workerConfig.env?.production?.vars?.MCP_UI_URL ??
			workerConfig.vars?.MCP_UI_URL)
		: "http://localhost:3001");
if (
	production &&
	(!MCP_UI_URL ||
		!URL.canParse(MCP_UI_URL) ||
		new URL(MCP_UI_URL).protocol !== "https:")
) {
	throw new Error(
		"Set MCP_UI_URL to the installation's HTTPS origin before a production build.",
	);
}
const MCP_UI_INSPECTOR_PORT = Number(process.env.MCP_UI_INSPECTOR_PORT ?? 9231);

// https://astro.build/config
export default defineConfig({
	output: "server",
	// Production: Use absolute URLs for all Astro-generated assets (including island component-url/renderer-url)
	// This was fixed in Astro #6862 to properly apply assetsPrefix to astro-island elements
	// Dev mode: server.origin handles Vite assets, but URL rewriting in MCP handles remaining relative paths
	build: {
		assetsPrefix: MCP_UI_URL,
	},
	// Rendering does not use Astro sessions. An explicit in-memory driver
	// prevents the adapter from provisioning default KV session storage.
	session: {
		driver: sessionDrivers.lruCache({ max: 1 }),
	},
	adapter: cloudflare({
		inspectorPort: MCP_UI_INSPECTOR_PORT,
	}),
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
			// Force a single React instance across the app, @tedix/widget-ui, and the
			// @json-render/* packages. Without this the dev optimizer can split React
			// across separate optimize-deps chunks (different `?v=` hashes), leaving the
			// hooks dispatcher null in the secondary chunk — recharts-based DataChart
			// widgets then crash with "Cannot read properties of null (reading 'useRef')"
			// while non-hook components (tables) survive. Mirrors apps/landing.
			//
			// json-render core/react are deduped for a second reason: every
			// @json-render/* package pins `@json-render/core` as an exact
			// dependency (not a peer), so a version skew installs two cores.
			// `registerActionObserver` keeps a module-level observer Set and
			// `@json-render/react` carries its own StateContext, so a split
			// resolves to a mismatched pair — widget state silently stops
			// persisting, and shadcn controls throw at render. Deduping turns
			// that class of skew into a build failure instead.
			dedupe: ["react", "react-dom", "@json-render/core", "@json-render/react"],
		},
		server: {
			allowedHosts: (process.env.TEDIX_DEV_ALLOWED_HOSTS ?? "")
				.split(",")
				.map((host) => host.trim())
				.filter(Boolean),
			// Generate absolute URLs in dev mode for iframe embedding
			// This helps when widgets are loaded in ChatGPT's sandbox iframe
			// which has a different origin (*.web-sandbox.oaiusercontent.com)
			origin: MCP_UI_URL,
			// CORS for ChatGPT's sandbox iframe (*.web-sandbox.oaiusercontent.com)
			// This is the official Vite way to handle CORS for all requests including:
			// - /@fs/ (file system access)
			// - /@id/ (virtual modules like astro:scripts/before-hydration.js)
			// - /@vite/ (Vite internals)
			// - /src/ (source files)
			// - /node_modules/ (dependencies)
			cors: {
				origin: "*",
				methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
				allowedHeaders: [
					"Content-Type",
					"Authorization",
					"CF-Access-Client-Id",
					"CF-Access-Client-Secret",
				],
				maxAge: 86400,
			},
		},
		ssr: {
			// Allow workspace packages to be processed
			noExternal: ["@tedix/widget-ui", "@tedix/api-client"],
			// Pin the SSR (deps_ssr) optimizer to the same React set as the client
			// (deps) optimizer below, so the two stay in lockstep. Astro runs two
			// separate dep optimizers; when a mid-session bun.lock change re-optimizes
			// one generation but not the other, the SSR-rendered @astrojs/react island
			// renderer (react-dom) ends up on a different React generation than the
			// client component (react) — separate ReactSharedInternals, null hooks
			// dispatcher, "Cannot read properties of null (reading 'useState')" in dev.
			// Listing React in both optimizers keeps their generations aligned.
			optimizeDeps: {
				include: [
					"react",
					"react-dom",
					"react-dom/client",
					"react/jsx-runtime",
				],
			},
		},
		optimizeDeps: {
			// Pre-bundle workspace packages so Vite uses /node_modules/.vite/deps/
			// Must specify package exports individually since there is no global export from @tedix/widget-ui
			// instead of /@fs/ local paths (which ChatGPT sandbox can't access)
			exclude: ["astro/compiler-runtime"],
			include: [
				// Co-bundle React with every react-importing package in one optimize pass
				// so they all resolve to the single deduped React instance (see resolve.dedupe).
				"react",
				"react-dom",
				"react-dom/client",
				"@tedix/widget-ui/layouts",
				// recharts is imported by @tedix/widget-ui's GeneratedChart (DataChart).
				// It is a direct dependency of apps/mcp-ui so it resolves here as a bare
				// specifier and gets pulled into the INITIAL optimize pass. Otherwise it
				// is discovered late — the first time a chart renders — forcing a
				// mid-session re-optimize that bumps React's browserHash and desyncs the
				// SSR/client React instances (null hooks dispatcher → blank DataChart
				// widgets while non-chart widgets like tables render fine).
				"recharts",
				"@json-render/core",
				"@json-render/react",
				"@json-render/shadcn",
				"@json-render/directives",
				"@json-render/devtools-react",
			],
		},
	},
});
