import { bindings, defineConfig, defineWorker, triggers } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
// `bun run dev:remote` opts into shared production D1/R2; `bun dev` stays local.
const remoteDev =
	runtimeEnv?.TEDIX_DEV_REMOTE_TARGET === "shared-production-data";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const test = mode === "test";

	return {
		worker: defineWorker({
			name: production
				? "public-installation-skill-runtime-production"
				: "public-installation-skill-runtime",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-06-11",
			// src/outbound-proxy.ts is the `globalOutbound` for skill isolates that
			// ask for `capabilities.network: true` and forwards tenant-authored URLs,
			// so fetches must never reach private or Cloudflare-internal addresses.
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			triggers: production
				? [triggers.scheduled({ schedule: "*/5 * * * *" })]
				: undefined,
			env: {
				// Shared production DB: pinned skill_runs snapshots, evidence, control
				// receipts, and durable submission reconciliation.
				DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				// Step outputs over 16 KiB, keyed by {runId}/{path}; smaller payloads
				// stay inline in skill_run_artifacts.content_inline.
				SKILL_ARTIFACTS: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				VIDEO_BUCKET: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				// Runs tenant skill code in a per-call isolate.
				LOADER: bindings.workerLoader(),
				// `SkillWorkflow` comes from createDynamicWorkflowEntrypoint() and
				// dispatches each run to a freshly loaded tenant Worker via LOADER.
				WORKFLOWS: bindings.workflow({
					worker: production
						? "public-installation-skill-runtime-production"
						: "public-installation-skill-runtime",
					exportName: "SkillWorkflow",
					name: production ? "skill-workflow-production" : "skill-workflow",
				}),
				...(!test
					? {
							API_SERVICE: bindings.worker({
								worker: "public-installation-api",
								exportName: "InternalEntrypoint",
							}),
							MCP_SERVICE: bindings.worker({
								worker: "public-installation-mcp",
								exportName: "InternalEntrypoint",
							}),
							TEDI_RUNTIME_SERVICE: bindings.worker({
								worker: "public-installation-tedi-runtime",
							}),
						}
					: {}),
				RUN_RATE_LIMITER: bindings.rateLimit({
					namespace: "1010",
					simple: { limit: 60, period: 60 },
				}),
				// Immutable runtime provenance recorded in each run's manifest artifact.
				WORKER_VERSION: bindings.versionMetadata(),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				MCP_URL: bindings.text("configured-via-private-overlay"),
				VERTEX_VIDEO_ENDPOINT: bindings.text("configured-via-private-overlay"),
				PLATFORM_SERVICE_TOKEN: bindings.secret(),
				GOOGLE_SERVICE_ACCOUNT_KEY: bindings.secret(),
				GEMINI_API_KEY: bindings.secret(),
			},
		}),
	};
});
