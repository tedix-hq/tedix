import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	test: {
		...sharedTestConfig,
		// Migration/CLI fixtures compete for CPU with other admitted suite jobs.
		maxWorkers: 1,
	},
});
