import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { emdashVirtualStubs } from "./vite.config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			experimental: { newConfig: true },
			remoteBindings: false,
			miniflare: {
				// The config binds the class and Workflows by this Worker's name. The
				// pool runs the Worker under its own runner name, so bind them locally.
				durableObjects: { DB_DO: { className: "EmDashDB", useSQLite: true } },
				workflows: {
					CMS_RECOVERY_WORKFLOW: {
						name: "cms-recovery-captures",
						className: "CmsRecoveryWorkflow",
					},
					CMS_SITE_RESTORE_WORKFLOW: {
						name: "cms-site-restore",
						className: "CmsSiteRestoreWorkflow",
					},
					CMS_PITR_SELF_TEST_WORKFLOW: {
						name: "cms-pitr-self-test",
						className: "CmsPitrSelfTestWorkflow",
					},
					CMS_SITE_RESTORE_DRILL_WORKFLOW: {
						name: "cms-site-restore-drill",
						className: "CmsSiteRestoreDrillWorkflow",
					},
				},
			},
		}),
	],
	resolve: { alias: emdashVirtualStubs },
	test: { include: ["src/**/*.test.ts"] },
});
