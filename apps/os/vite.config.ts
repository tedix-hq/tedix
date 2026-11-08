import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";
import { osVersionPlugin, readOsBuildSha } from "./dev/os-version-plugin";
import {
	isLocalOsBuildLane,
	readWorkerVars,
	resolveOsBuildConfig,
} from "./dev/build-config";
import {
	apiProxyForOsDevLane,
	resolveOsDevLane,
	sampleDataForOsLane,
} from "./dev/dev-lane";
import { fixturePackEnabled, localApiPlugin } from "./dev/local-api-plugin";
import { localApiProxyOptions } from "./dev/local-api-proxy";
import { phosphorImports } from "./dev/phosphor-imports";

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

// A `vp dev` that serves browser specs: fixture servers carry
// TEDIX_BROWSER_FIXTURE, and spec children spawn their own dev servers with
// the OS_FIXTURE_ORIGIN run-specs gave them. Up to three of these run at once
// on one checkout, so each needs its own optimize-deps store: a re-bundle
// rewrites every chunk's ?v= browserHash in the shared node_modules/.vite and
// leaves another server's live pages holding URLs that now 504. The fixture
// lane additionally runs with HMR off, so its pages cannot even reload out of
// that state.
const fixtureLane = process.env.TEDIX_BROWSER_FIXTURE === "1";
const specOwnedServer =
	!fixtureLane && process.env.OS_FIXTURE_ORIGIN !== undefined;
const browserSpecServer = fixtureLane || specOwnedServer;

// cloudflare.config.ts selects the lane's bindings from the same environment.
// Builds always emit the Worker so `cf deploy --prebuilt` has a Build Output.
const workerPlugin = () =>
	cloudflare({
		// Let the runtime allocate a free inspector port for concurrent stacks.
		inspectorPort: 0,
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
	const buildSha = readOsBuildSha(process.env);
	const iconImports = command === "serve" ? phosphorImports() : undefined;
	return {
		// Pin tsconfig for every transform and resolve. Auto-discovery walks
		// ancestors for files no `include` owns (index.html among them); a
		// sibling checkout's broken `extends` then fails every transform
		// (vitejs/vite#23672).
		tsconfig: "./tsconfig.json",
		plugins: [
			osVersionPlugin(buildSha),
			...(iconImports ? [{ ...iconImports, enforce: "pre" as const }] : []),
			...(withWorker ? [workerPlugin()] : []),
			TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
			react(),
			tailwindcss(),
			...(useLocalFixtures ? [localApiPlugin()] : []),
		],
		// Per spec server (see browserSpecServer): an optimize-deps store
		// siblings cannot rewrite. In the fixture lane a scan of every fixture
		// entry plus the routed app graph finishes discovery before spec pages
		// connect, and serving a still-present stale chunk is safer than a 504
		// a page cannot reload itself out of. Spec-owned servers keep today's
		// entry inference: their pages can still reload when their own store
		// re-bundles.
		cacheDir: browserSpecServer
			? `node_modules/.cache/vite-${process.pid}`
			: "node_modules/.vite",
		// Kumo also imports the barrel; rewriting only app source still eagerly
		// initializes thousands of unused SVG weight maps on every navigation.
		optimizeDeps: {
			...(iconImports ? { rolldownOptions: { plugins: [iconImports] } } : {}),
			...(fixtureLane
				? { entries: ["index.html", "browser-tests/*.html"] }
				: {}),
			...(browserSpecServer ? { ignoreOutdatedRequests: true } : {}),
		},
		define: {
			__OS_BUILD_SHA__: JSON.stringify(buildSha),
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
			// Sample data: the fixture pack, or the seeded `bun run-local --demo` company.
			__SAMPLE_DATA__: JSON.stringify(
				sampleDataForOsLane(
					process.env,
					devLane,
					command,
					fixturePackEnabled(),
				),
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
			// Ignore file events during browser checks; watch:null also disables Vite's resolver cache.
			watch: browserSpecServer ? { ignored: () => true } : undefined,
			// Specs own every navigation: a late-discovered dependency otherwise
			// re-bundles and full-reloads every connected page mid-interaction.
			hmr: fixtureLane ? false : undefined,
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
		environments: {
			client: {
				build: {
					rolldownOptions: {
						output: {
							strictExecutionOrder: true,
							codeSplitting: {
								groups: [
									{
										name: "bootstrap",
										tags: ["$initial"],
										includeDependenciesRecursively: false,
									},
									{
										name: "shared-ui",
										test: /@cloudflare[\\/]kumo[\\/]/,
										minShareCount: 10,
										includeDependenciesRecursively: false,
									},
									{
										name: "shared-icons",
										test: /@phosphor-icons[\\/]react[\\/]/,
										minShareCount: 10,
										includeDependenciesRecursively: false,
									},
								],
							},
						},
					},
				},
			},
		},
		test: {
			// A package-local config replaces the root `test` block rather than merging
			// with it, so the root's deliberate timeouts have to be spread back in —
			// without this line these suites silently ran at vitest's 5s default, the
			// exact bound the root config raised because it makes CI redness track CI
			// load.
			...sharedTestConfig,
			// Leave CPU headroom for other agent worktrees.
			maxWorkers: 4,
			environment: "happy-dom",
			// happy-dom 21 blocks iframe loads by default; widget frame tests need one.
			environmentOptions: {
				happyDOM: { settings: { enableIframePageLoading: true } },
			},
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
