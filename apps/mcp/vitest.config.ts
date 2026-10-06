import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * Two projects, so `test:run` and the pre-push `vp test related` query both
 * reach workerd: the Node project holds the unit tests, and the workerd
 * project runs `*.workerd.test.ts` in the real runtime, where native globals
 * such as `fetch` enforce what no Node stub does (the 2026-09-29 upstream
 * "Illegal invocation" outage passed every Node test).
 */
export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					globals: true,
					environment: "node",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.workerd.test.ts"],
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
			},
			"./vitest.workerd.config.ts",
		],
	},
});
