import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	test: {
		...sharedTestConfig,
		// Migration-replay fixtures are CPU-bound. Unbounded file workers cause
		// otherwise independent tests to time out when API/MCP run alongside DB.
		maxWorkers: 4,
	},
});
