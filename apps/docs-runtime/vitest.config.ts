import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		cloudflareTest({
			experimental: { newConfig: true },
			remoteBindings: false,
		}),
	],
	test: {
		include: ["src/**/*.test.ts"],
		// workerd cannot read Vitest's on-disk module cache (default since 5.0.4).
		fsModuleCache: false,
	},
});
