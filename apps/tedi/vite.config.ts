import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
	plugins: lazyPlugins(() => [
		cloudflare({
			inspectorPort: 19235,
			persistState: { path: path.resolve(__dirname, "../../.wrangler/state") },
			experimental: { newConfig: { cfBuildOutput: true } },
		}),
	]),
	server: {
		port: 3007,
		// Additional development hosts require explicit operator configuration.
		allowedHosts: (process.env.TEDIX_DEV_ALLOWED_HOSTS ?? "")
			.split(",")
			.map((host) => host.trim())
			.filter(Boolean),
	},
});
