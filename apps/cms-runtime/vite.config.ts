import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

// @emdash-cms/cloudflare/db/do-sql pulls EmDashConfigurationError from the root
// `emdash` package, whose dist chunk statically imports these Astro-only virtual
// modules. This Worker never reaches that code; without the aliases the build
// fails to resolve them.
export const emdashVirtualStubs = Object.fromEntries(
	[
		"virtual:emdash/config",
		"virtual:emdash/seed",
		"virtual:emdash/dialect",
		"astro:content",
	].map((specifier) => [
		specifier,
		path.resolve(__dirname, "src/emdash-virtual-stubs.ts"),
	]),
);

export default defineConfig({
	plugins: lazyPlugins(() => [
		cloudflare({
			inspectorPort: 19243,
			persistState: { path: path.resolve(__dirname, "../../.wrangler/state") },
			experimental: { newConfig: { cfBuildOutput: true } },
		}),
	]),
	resolve: { alias: emdashVirtualStubs },
	server: {
		port: 3015,
	},
});
