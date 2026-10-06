import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
	plugins: lazyPlugins(() => [
		cloudflare({
			inspectorPort: 19229,
			// Local D1 state is shared with apps/api; a launcher may relocate it.
			persistState: {
				path: path.resolve(
					process.env.TEDIX_LOCAL_PERSIST_TO ||
						path.resolve(__dirname, "../../.wrangler/state"),
				),
			},
			experimental: { newConfig: { cfBuildOutput: true } },
		}),
	]),
	resolve: { alias: { "@": path.resolve(__dirname, "src") } },
	server: {
		port: 3000,
	},
});
