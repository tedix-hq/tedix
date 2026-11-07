import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Isolated from production bindings: every binding here is a local fixture.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "test/worker.ts"),
			additionalExports: {
				TurnFacet: "DurableObject",
			},
			miniflare: {
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat"],
				workerLoaders: { LOADER: {} },
				d1Databases: ["DB"],
				r2Buckets: ["R2_BUCKET"],
				bindings: { DO_JURISDICTION: "", ENVIRONMENT: "test" },
				durableObjects: {
					WORKSPACE: { className: "WorkspaceDO", useSQLite: true },
					TEDI_AGENT: { className: "TediAgentFixture", useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.workerd.test.ts"],
		testTimeout: 30_000,
		fsModuleCache: false,
	},
});
