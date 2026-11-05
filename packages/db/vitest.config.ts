import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	test: {
		...sharedTestConfig,
		exclude: ["src/**/*.postgres.test.ts"],
		include: ["src/**/*.test.ts"],
		globalSetup: "./src/test/migrated-sqlite-global-setup.ts",
		// Migration/CLI fixtures compete for CPU with other admitted suite jobs.
		maxWorkers: 1,
	},
});
