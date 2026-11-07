import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

/**
 * The conformance suite runs inside workerd so both implementations use real
 * object storage, a real Worker Loader and real WebSockets. The two namespaces
 * below are the test Worker's objects, one per implementation.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			main: "./test/worker.ts",
			miniflare: {
				compatibilityDate: "2026-10-01",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					CLOUDFLARE_WORKSPACE: {
						className: "CloudflareWorkspaceObject",
						useSQLite: true,
					},
					WORKERD_WORKSPACE: {
						className: "WorkerdWorkspaceObject",
						useSQLite: true,
					},
				},
				workerLoaders: { LOADER: {} },
			},
		}),
	],
	test: {
		// workerd cannot read Vitest's on-disk module cache (default since 5.0.4).
		fsModuleCache: false,
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
