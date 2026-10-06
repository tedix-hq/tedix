import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
		server: {
			deps: {
				inline: ["@cloudflare/codemode"],
			},
		},
		alias: {
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
});
