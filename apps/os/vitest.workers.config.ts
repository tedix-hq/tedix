import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import cloudflareConfig from "./cloudflare.config";

/**
 * The workerd lane: tests that need a REAL Cloudflare runtime, currently the
 * Cap'n Web `/capn` client↔Worker roundtrip (`*.workerd.test.ts`). It is a
 * second config rather than a second project because `vite.config.ts` pins
 * `environment: "happy-dom"` over the whole `src/**` tree and the two pools
 * cannot be merged.
 *
 * Miniflare is configured INLINE instead of from `cloudflare.config.ts`, on purpose:
 * that config carries an assets binding plus the CollabRoom Durable Object that
 * a socket-level RPC test has no use for. Only its compatibility date is read,
 * so the test runtime matches the one the Worker ships with.
 */
export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			miniflare: {
				compatibilityDate: (
					await cloudflareConfig({ mode: "production", isPreview: false })
				).worker.compatibilityDate,
				compatibilityFlags: ["nodejs_compat"],
			},
		}),
	],
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
	},
	test: {
		include: ["src/**/*.workerd.test.ts"],
	},
}));
