import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

// Without this config `vp dev` started a bare Vite server on the default 5173
// with no Cloudflare plugin at all: the Worker never ran, its API_SERVICE
// binding did not exist, and the declared dev.port 3028 went unbound while two
// such apps raced for 5173/5174. `configPath` takes the sanitized config
// scripts/dev-local.ts generates, so this app is isolated like every other
// Worker in the root `bun dev` stack rather than reading its account-bound
// committed config.
export default defineConfig({
	plugins: lazyPlugins(() => [
		cloudflare({
			inspectorPort: 19255,
			persistState: { path: path.resolve(__dirname, "../../.wrangler/state") },
			experimental: { newConfig: { cfBuildOutput: true } },
		}),
	]),
	server: {
		port: 3028,
	},
});
