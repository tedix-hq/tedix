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
				ConversationFacet: "DurableObject",
				RawCutoverDO: "DurableObject",
			},
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				bindings: { SECRETS_MASTER_KEY: "guard-native-token" },
				durableObjects: {
					TEDI_AGENT: { className: "GuardParent", useSQLite: true },
					GUARD_PI: { className: "GuardPi", useSQLite: true },
					GUARD_PROBE: { className: "GuardProbe", useSQLite: true },
					TEDI_COMPUTER_WORKSPACE: { className: "GuardProbe", useSQLite: true },
				},
				workflowExports: { GuardWorkflow: { name: "guard-native-workflow" } },
				workflows: {
					CHAT_TURN_WORKFLOW: {
						name: "guard-native-workflow",
						className: "GuardWorkflow",
					},
				},
			},
		}),
	],
	test: {
		include: ["test/historical-execution-guard/*.native.test.ts"],
		testTimeout: 20000,
	},
});
