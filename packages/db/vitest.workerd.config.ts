import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

/**
 * Real-runtime TenantStore suite: SQLite Durable Objects in workerd. The
 * `workerd` project of vitest.config.ts, so it runs in `test:run`.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./test/tenant-store/worker.ts",
			miniflare: {
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					TENANT_STORE: { className: "TenantStore", useSQLite: true },
					TENANT_STORE_FIXTURE: {
						className: "TenantStoreFixture",
						useSQLite: true,
					},
				},
			},
		}),
	],
	test: {
		...sharedTestConfig,
		// workerd cannot read Vitest's on-disk module cache (default since 5.0.4).
		fsModuleCache: false,
		name: "workerd",
		// Run after the Node project instead of competing with it for CPU.
		sequence: { groupOrder: 1 },
		include: ["src/**/*.workerd.test.ts"],
		// The first Durable Object start includes module load and migration.
		testTimeout: 60_000,
	},
});
