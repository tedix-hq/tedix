import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";
import {
	isLocalOsBuildLane,
	readWorkerVars,
	resolveOsBuildConfig,
} from "./dev/build-config";
import { apiProxyForOsDevLane, resolveOsDevLane } from "./dev/dev-lane";
import { localApiPlugin } from "./dev/local-api-plugin";
import { localApiProxyOptions } from "./dev/local-api-proxy";

const optionalPublicValue = (name: string) =>
	process.env[`TEDIX_BUILD_${name}`]?.trim() || "";

// `bun run dev:fixtures` answers /api/* from deterministic fixtures. The root
// product-evaluation launcher instead proxies same-origin calls to its isolated
// API/D1 process. VITE_LIVE_API remains an explicit direct-origin escape hatch.
const localApiProxy = localApiProxyOptions(
	process.env.TEDIX_LOCAL_API_PROXY_URL,
);
const devLane = resolveOsDevLane(process.env, Boolean(localApiProxy));
const viteApiProxy = apiProxyForOsDevLane(devLane, localApiProxy);
const useRemoteWorker = devLane === "remote-worker";
const useLocalWorker = devLane === "local-worker";
const useLocalFixtures = devLane === "fixtures";

// cloudflare.config.ts selects the lane's bindings from the same environment.
// Builds always emit the Worker so `cf deploy --prebuilt` has a Build Output.
const workerPlugin = () =>
	cloudflare({
		inspectorPort: 19238,
		...(useRemoteWorker
			? {}
			: {
					persistState: {
						path: path.resolve(
							process.env.TEDIX_LOCAL_PERSIST_TO ||
								path.resolve(__dirname, "../../.wrangler/run-local"),
						),
					},
				}),
		experimental: { newConfig: { cfBuildOutput: true } },
	});

export default defineConfig(async ({ command, mode, isPreview }) => {
	// Public identity has NO Tedix Cloud default (dev/build-config.ts): env,
	// then the local sentinel in the isolated lane, then the committed
	// cloudflare.config.ts vars the Worker itself runs on, otherwise a hard
	// failure.
	const buildConfig = resolveOsBuildConfig({
		environment: process.env,
		localLane: isLocalOsBuildLane(process.env, devLane, command),
		workerVars: await readWorkerVars(mode),
	});
	const withWorker =
		command === "build" || isPreview || useRemoteWorker || useLocalWorker;
	return {
		plugins: [
			...(withWorker ? [workerPlugin()] : []),
			TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
			react(),
			tailwindcss(),
			...(useLocalFixtures ? [localApiPlugin()] : []),
		],
		define: {
			__API_URL__: JSON.stringify(buildConfig.API_URL),
			__DESCOPE_PROJECT_ID__: JSON.stringify(buildConfig.DESCOPE_PROJECT_ID),
			__DESCOPE_BASE_URL__: JSON.stringify(buildConfig.DESCOPE_BASE_URL),
			__OS_URL__: JSON.stringify(buildConfig.OS_URL),
			__SESSION_BROKER_URL__: JSON.stringify(buildConfig.SESSION_BROKER_URL),
			// Optional shared Descope style id; empty
			// means the project default, so it is env-only and needs no wrangler var.
			__DESCOPE_STYLE_ID__: JSON.stringify(
				optionalPublicValue("DESCOPE_STYLE_ID"),
			),
			__LOCAL_DEMO_ENABLED__: JSON.stringify(
				process.env.TEDIX_BUILD_LOCAL_DEMO_ENABLED === "true",
			),
			__LOCAL_FIRST_RUN_ENABLED__: JSON.stringify(
				process.env.TEDIX_BUILD_LOCAL_FIRST_RUN_ENABLED === "true",
			),
			__LOCAL_INFERENCE_BACKEND__: JSON.stringify(
				process.env.TEDIX_LOCAL_INFERENCE_BACKEND ?? "",
			),
			__LOCAL_INFERENCE_ENABLED__: JSON.stringify(
				process.env.TEDIX_BUILD_LOCAL_INFERENCE_ENABLED === "true",
			),
		},
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "src"),
			},
			dedupe: ["react", "react-dom", "react/jsx-runtime"],
		},
		server: {
			port: 3010,
			allowedHosts: [
				"localhost",
				".localhost",
				...(process.env.TEDIX_DEV_ALLOWED_HOSTS ?? "")
					.split(",")
					.map((host) => host.trim())
					.filter(Boolean),
			],
			...(viteApiProxy ? { proxy: { "/api": viteApiProxy } } : {}),
		},
		build: { target: "es2022" },
		test: {
			// A package-local config replaces the root `test` block rather than merging
			// with it, so the root's deliberate timeouts have to be spread back in —
			// without this line these suites silently ran at vitest's 5s default, the
			// exact bound the root config raised because it makes CI redness track CI
			// load.
			...sharedTestConfig,
			environment: "happy-dom",
			// `scripts/**` carries the gate policy suites. This include list replaces
			// vitest's default glob, so a co-located `scripts/*.test.ts` is invisible
			// unless it is named here — which is how the bundle guard shipped a
			// prose-only design claim with nothing testing it.
			include: [
				"src/**/*.test.{ts,tsx}",
				"dev/**/*.test.ts",
				"scripts/**/*.test.ts",
			],
			// `*.workerd.test.ts` needs a real Cloudflare runtime and runs from
			// vitest.workers.config.ts (`bun run test:workerd`); the two pools
			// cannot share one config.
			exclude: ["**/node_modules/**", "src/**/*.workerd.test.ts"],
		},
	};
});
