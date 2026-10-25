import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { wranglerCompatibilityDate } from "../../scripts/vite/task-config";

// Deliberately isolated: never load the production Worker bindings; only the
// compatibility date is read from wrangler.jsonc.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "test/pi-runtime/worker.ts"),
			// Imported facet classes need explicit test-wrapper inference, not DO bindings.
			additionalExports: {
				CodemodeRuntime: "DurableObject",
				ConversationFacet: "DurableObject",
			},
			miniflare: {
				compatibilityDate: wranglerCompatibilityDate(
					path.resolve(import.meta.dirname, "wrangler.jsonc"),
				),
				compatibilityFlags: ["nodejs_compat"],
				workerLoaders: { LOADER: {} },
				bindings: { SECRETS_MASTER_KEY: "pi-native-fixture-token" },
				r2Buckets: ["TEDI_STORAGE"],
				d1Databases: ["DB"],
				// test:workers runs this suite separately: recovery fixtures abort local Workflow state.
				workflows: {
					TURN_ADMISSION_WORKFLOW: {
						name: "turn-admission-fixture",
						className: "TurnAdmissionWorkflowFixture",
					},
					WORKFLOW_CALLBACK: {
						name: "callback-fixture",
						className: "WorkflowCallbackFixture",
					},
				},
				durableObjects: {
					TURN_ADMISSION: {
						className: "TurnAdmissionFixture",
						useSQLite: true,
					},
					DURABLE_CODE_RECOVERY: {
						className: "DurableCodeRecoveryFixture",
						useSQLite: true,
					},
					PI_PLATFORM: { className: "PiPlatformFixture", useSQLite: true },
					REGISTRY_RESTORE: {
						className: "RegistryRestoreFixture",
						useSQLite: true,
					},
					PI_STORAGE: { className: "PiStorageFixture", useSQLite: true },
					PI_FACET_MEDIA: { className: "PiFacetMediaFixture", useSQLite: true },
					PI_ADMISSION_PARENT: {
						className: "PiAdmissionParentFixture",
						useSQLite: true,
					},
					PI_TEST: { className: "PiRuntimeFixture", useSQLite: true },
					PI_JUDGE: { className: "PiJudgeFixture", useSQLite: true },
					PI_SYNTHESIS: { className: "PiSynthesisFixture", useSQLite: true },
					PI_CONVERSATION: {
						className: "PiConversationFixture",
						useSQLite: true,
					},
					COMPUTER_TURN: { className: "ComputerTurnFixture", useSQLite: true },
					TEDI_COMPUTER_WORKSPACE: {
						className: "TediComputerWorkspaceDO",
						useSQLite: true,
					},
					KERNEL_WAKE: { className: "KernelWakeFixture", useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.workerd.test.ts"],
		testTimeout: 15_000,
		// workerd cannot read Vitest's on-disk module cache (default since 5.0.4).
		fsModuleCache: false,
	},
});
