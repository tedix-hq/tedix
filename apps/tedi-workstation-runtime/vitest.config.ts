import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// egress.ts is SDK-free, so it tests under plain node. index.ts imports
		// the Cloudflare Sandbox SDK (cloudflare:workers) and is exercised via
		// deploy + live runtime, not unit tests.
		include: ["src/**/*.test.ts"],
	},
});
