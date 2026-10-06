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
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
