import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	test: {
		...sharedTestConfig,
		include: ["src/**/*.postgres.test.ts"],
		maxWorkers: 1,
		testTimeout: 60_000,
	},
});
