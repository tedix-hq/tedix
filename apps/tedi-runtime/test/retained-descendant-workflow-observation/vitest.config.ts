import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../../../scripts/vite/task-config";
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "worker.ts"),
			additionalExports: {
				RawCutoverDO: "DurableObject",
				LegacyChild: "DurableObject",
			},
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				bindings: { SECRETS_MASTER_KEY: "retained-descendant-test-token" },
				d1Databases: ["DB"],
				durableObjects: {
					TEDI_AGENT: { className: "AgentTediDO", useSQLite: true },
				},
				workflowExports: {
					OriginalCallbackWorkflow: {
						name: "retained-descendant-native-workflow",
					},
				},
				workflows: {
					CHAT_TURN_WORKFLOW: {
						name: "retained-descendant-native-workflow",
						className: "OriginalCallbackWorkflow",
					},
				},
			},
		}),
	],
	test: {
		include: ["test/retained-descendant-workflow-observation/*.native.test.ts"],
		testTimeout: 20000,
	},
});
