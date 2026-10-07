import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../../../scripts/vite/task-config";
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "worker.ts"),
			additionalExports: {
				AgentTediDO: "DurableObject",
			},
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				bindings: { SECRETS_MASTER_KEY: "parent-diagnostics-token" },
				durableObjects: {
					TEDI_AGENT: { className: "DiagnosticParent", useSQLite: true },
					TEDI_COMPUTER_WORKSPACE: {
						className: "DiagnosticProbe",
						useSQLite: true,
					},
				},
			},
		}),
	],
	test: {
		include: ["test/parent-diagnostics/*.native.test.ts"],
		testTimeout: 20000,
	},
});
