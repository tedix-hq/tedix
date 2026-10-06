import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../scripts/vite/task-config";
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(
				import.meta.dirname,
				"test/pi-runtime/exclusion-worker.ts",
			),
			additionalExports: {
				RawCutoverDO: "DurableObject",
				ExclusionChild: "DurableObject",
			},
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				bindings: {
					SECRETS_MASTER_KEY: "exclusion-native-token",
					EXCLUSION_TEST_LANE: "dedicated",
				},
				d1Databases: ["DB"],
				durableObjects: {
					TEDI_AGENT: { className: "ExclusionAgent", useSQLite: true },
					EXCLUSION_BARRIER: { className: "ExclusionBarrier", useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ["test/pi-runtime/exclusion.workerd.test.ts"],
		testTimeout: 15000,
	},
});
