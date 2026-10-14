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
		// workerd cannot read Vitest's on-disk module cache (default since 5.0.4).
		fsModuleCache: false,
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
