import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../../../scripts/vite/task-config";
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "worker.ts"),
			additionalExports: { RawCutoverDO: "DurableObject" },
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				bindings: {
					SECRETS_MASTER_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
				},
				d1Databases: ["DB"],
				durableObjects: {
					TEDI_AGENT: { className: "CaptureRoot", useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: [
			"test/historical-capture-size/historical-capture-size.native.test.ts",
		],
		testTimeout: 15000,
	},
});
