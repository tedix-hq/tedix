import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, runnerImport } from "vite-plus";
import { compatibilityDate } from "./cloudflare.config";

type UpstreamFixture = typeof import("./test/fixtures/upstream-mcp");
let upstreamFixture: Promise<UpstreamFixture> | undefined;

/**
 * Outbound network for the Worker: fixture MCP upstreams, 599 for the rest.
 * Loaded through Vite's module runner because the fixture imports workspace
 * TypeScript (`@tedix/mcp-shared`) that plain Node cannot resolve.
 */
async function outboundService(request: Request): Promise<Response> {
	upstreamFixture ??= runnerImport<UpstreamFixture>(
		fileURLToPath(new URL("./test/fixtures/upstream-mcp.ts", import.meta.url)),
		{ configFile: false, logLevel: "error" },
	).then(({ module }) => module);
	return (await upstreamFixture).upstreamOutbound(request);
}

/**
 * Real-Worker boundary suite: the `workerd` project of vitest.config.ts, so it
 * runs in `test:run` and pre-push `related`; ordinary unit tests keep their
 * Node stub.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate,
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				workerLoaders: { LOADER: {} },
				bindings: {
					ENVIRONMENT: "test",
					MCP_URL: "https://mcp.tedix.dev",
					API_URL: "https://api.invalid",
					MCP_UI_URL: "https://widget.invalid",
					GIT_SHA: "workerd-test",
					DEFAULT_APP_SLUG: "",
					DO_NOT_TRACK: "1",
				},
				serviceBindings: {
					API_SERVICE: { name: "fixture-api" },
				},
				outboundService,
				workers: [
					{
						name: "fixture-api",
						modules: true,
						scriptPath: fileURLToPath(
							new URL("./test/fixtures/api-service.mjs", import.meta.url),
						),
						compatibilityDate,
					},
				],
			},
		}),
	],
	test: {
		name: "workerd",
		include: ["src/**/*.workerd.test.ts"],
		testTimeout: 20_000,
	},
});
