import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../scripts/vite/task-config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				outboundService: (request) => {
					if (request.url !== "https://redirect.example.test/start")
						throw new Error(`Unexpected outbound request: ${request.url}`);
					return new Response(null, {
						status: 302,
						headers: { location: "https://redirect.example.test/target" },
					});
				},
			},
		}),
	],
	test: {
		include: ["test/app-runtime/redirect/redirect.workerd.test.ts"],
		fsModuleCache: false,
	},
});
