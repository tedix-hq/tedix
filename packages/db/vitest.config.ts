import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	test: {
		...sharedTestConfig,
		// Migration/CLI fixtures compete for CPU with other admitted suite jobs.
		maxWorkers: 1,
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.postgres.test.ts", "src/**/*.workerd.test.ts"],
					globalSetup: "./src/test/migrated-sqlite-global-setup.ts",
				},
			},
			"./vitest.workerd.config.ts",
		],
	},
});
