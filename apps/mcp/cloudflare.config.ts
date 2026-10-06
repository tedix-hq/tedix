import { bindings, defineConfig, defineWorker, exports } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
const aggregateEpochKvId = runtimeEnv?.MCP_AGGREGATE_EPOCH_KV_ID?.trim();
// `bun run dev:remote` opts into shared production data; `bun dev` stays local.
const remoteDev =
	runtimeEnv?.TEDIX_DEV_REMOTE_TARGET === "shared-production-data";
export const compatibilityDate = "2026-05-14";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	// Isolated `bun dev`: no remote data, no production ids.
	const local = !production && !remoteDev;
	const worker = (name: string) => (production ? `${name}-production` : name);
	const lane = production ? "production" : "development";

	return {
		worker: defineWorker({
			name: worker("public-installation-mcp"),
			entrypoint: "src/index.ts",
			compatibilityDate,
			// `global_fetch_strictly_public` is a security boundary. This Worker
			// fetches URLs it did not choose (an app's `upstreamMcpUrl`, upstream
			// redirects, an OAuth client's metadata document). `@tedix/ssrf-guard`
			// screens the URL before DNS, so a public-looking hostname that resolves
			// to a private address passes it; the flag makes every global `fetch()`
			// leave as public Internet traffic instead of reaching a zone origin.
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			// Workers Cache key: entrypoint, URL, Vary values and ctx.props; caller
			// scope rides a header and is not part of it. Only the unauthenticated
			// `.well-known` discovery documents send a cacheable `Cache-Control`;
			// `/mcp` never does and `/health` sends `no-store`. Cross-version reuse
			// stays off so a response shape never outlives its deploy.
			cache: { enabled: true },
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			// Live SQLite-backed class. Keep it with the same storage: a changed
			// storage is rejected and a deleted state drops every subscription stream.
			exports: {
				McpSubscriptionDurableObject: exports.durableObject({
					storage: "sqlite",
				}),
			},
			env: {
				// Optional KV Instant namespace for the tiny activation pointer only.
				// KV Instant is private beta and uses the normal KV binding API after
				// the namespace is created with mode="instant". Leaving the id unset
				// preserves the existing R2/Cache API path in every lane.
				...(aggregateEpochKvId
					? {
							AGGREGATE_EPOCH_KV: bindings.kv({
								id: aggregateEpochKvId,
								dev: { remote: remoteDev },
							}),
						}
					: {}),
				// Shared D1 database. Local runs use the zero id every local Worker shares.
				DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				// Precomputed aggregate tool surface, read by a cold isolate instead of
				// re-running the live fan-out.
				AGGREGATE_CACHE: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				ANALYTICS: bindings.analyticsEngineDataset({
					name: "public_installation_dataset",
				}),
				CODEMODE_ANALYTICS: bindings.analyticsEngineDataset({
					name: "public_installation_dataset",
				}),
				// Code Mode sandbox for the search and execute meta-tools.
				LOADER: bindings.workerLoader(),
				WORKER_VERSION: bindings.versionMetadata(),
				// Stateful SSE streams for subscriptions/listen.
				MCP_SUBSCRIPTIONS: bindings.durableObject({
					worker: worker("public-installation-mcp"),
					exportName: "McpSubscriptionDurableObject",
				}),
				// Runs config-driven async MCP tools (tasks) and backs `mcp_tasks` rows.
				GENERIC_TASKS_WORKFLOW: bindings.workflow({
					worker: worker("public-installation-mcp"),
					exportName: "GenericTasksWorkflow",
					name: worker("generic-tasks-workflow"),
				}),
				MCP_RATE_LIMITER: bindings.rateLimit({
					namespace: "1001",
					simple: { limit: 100, period: 60 },
				}),
				MCP_WRITE_RATE_LIMITER: bindings.rateLimit({
					namespace: "1002",
					simple: { limit: 30, period: 60 },
				}),
				MCP_HIGH_RISK_RATE_LIMITER: bindings.rateLimit({
					namespace: "1003",
					simple: { limit: 5, period: 60 },
				}),
				API_SERVICE: bindings.worker({
					// scripts/dev-local.ts runs apps/api under this local name.
					worker: local
						? "public-installation-api"
						: worker("public-installation-api"),
					exportName: "InternalEntrypoint",
				}),
				TEDI_SERVICE: bindings.worker({
					worker: worker("public-installation-tedi"),
					exportName: "InternalEntrypoint",
				}),
				CMS: bindings.worker({ worker: worker("public-installation-cms") }),
				DOCS: bindings.worker({ worker: worker("public-installation-docs") }),
				ENVIRONMENT: bindings.text(lane),
				GIT_SHA: bindings.text(
					production ? releaseSha : "configured-via-private-overlay",
				),
				MCP_URL: bindings.text(
					production
						? "configured-via-private-overlay"
						: local
							? "http://localhost:3000"
							: "configured-via-private-overlay",
				),
				API_URL: bindings.text(
					production
						? "configured-via-private-overlay"
						: local
							? runtimeEnv?.TEDIX_LOCAL_API_URL?.trim() ||
								"http://localhost:8787"
							: "configured-via-private-overlay",
				),
				MCP_UI_URL: bindings.text(
					production
						? "configured-via-private-overlay"
						: local
							? "http://localhost:3001"
							: "configured-via-private-overlay",
				),
				// Always api.descope.com: custom domains do not proxy /v1/apps/agentic/*.
				DESCOPE_AIH_BASE_URL: bindings.text(
					local ? "http://127.0.0.1:9" : "configured-via-private-overlay",
				),
				// Resolves base-domain MCP requests to this app slug in local runs.
				DEFAULT_APP_SLUG: bindings.text(""),
				// Opts out of the Skybridge runtime's telemetry counter.
				DO_NOT_TRACK: bindings.text("configured-via-private-overlay"),
				...(local
					? {
							// `bun dev` (scripts/dev-local.ts) passes disabled Descope
							// placeholders so a local edge never reaches the live project.
							DESCOPE_PROJECT_ID: bindings.text(
								runtimeEnv?.DESCOPE_PROJECT_ID || "local-development-disabled",
							),
							DESCOPE_BASE_URL: bindings.text(
								runtimeEnv?.DESCOPE_BASE_URL || "http://127.0.0.1:9",
							),
							TEDIX_LOCAL_DEMO_ENABLED: bindings.text("true"),
						}
					: {
							DESCOPE_PROJECT_ID: bindings.secret(),
							DESCOPE_BASE_URL: bindings.secret(),
							// Signs the destructive-approval request state and authenticates
							// service-binding calls; key resolution fails closed without it.
							PLATFORM_SERVICE_TOKEN: bindings.secret(),
							// Payload-capture stream. Live in production; the feature is a
							// no-op wherever they are unset.
							MCP_PAYLOAD_STREAM_ENDPOINT: bindings.secret(),
							MCP_PAYLOAD_STREAM_TOKEN: bindings.secret(),
						}),
			},
		}),
	};
});
