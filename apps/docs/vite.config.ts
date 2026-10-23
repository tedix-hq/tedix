import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
	plugins: lazyPlugins(() => [
		cloudflare({
			inspectorPort: 19251,
			persistState: { path: path.resolve(__dirname, "../../.wrangler/state") },
		}),
	]),
	resolve: { alias: { "@": path.resolve(__dirname, "src") } },
	server: {
		port: 3023,
	},
});
