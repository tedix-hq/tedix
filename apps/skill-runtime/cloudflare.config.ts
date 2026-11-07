import { bindings, defineConfig, defineWorker, triggers } from "cf/config";
import { deployValues } from "@tedix/deploy-values";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
// Shown wherever production takes a value from the private deploy values.
const PLACEHOLDER = "configured-via-private-overlay";
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
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const service = (surface: string, name: string) =>
		production ? live.worker(surface, name) : name;
	const workerName = production
		? live.worker(
				"skill-runtime",
				"public-installation-skill-runtime-production",
			)
		: "public-installation-skill-runtime";

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-06-11",
			// src/outbound-proxy.ts is the `globalOutbound` for skill isolates that
			// ask for `capabilities.network: true` and forwards tenant-authored URLs,
			// so fetches must never reach private or Cloudflare-internal addresses.
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			...(live.active ? { domains: live.domains("skill-runtime", []) } : {}),
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			triggers: production
				? [
						...live
							.routes("skill-runtime", [])
							.map((route) => triggers.fetch(route)),
						triggers.scheduled({ schedule: "*/5 * * * *" }),
					]
				: undefined,
			env: {
				// Shared production DB: pinned skill_runs snapshots, evidence, control
				// receipts, and durable submission reconciliation.
				DB: bindings.d1({
					...live.d1("main", {
						id: "00000000-0000-0000-0000-000000000000",
						name: "public-installation-database",
					}),
					dev: { remote: remoteDev },
				}),
				// Step outputs over 16 KiB, keyed by {runId}/{path}; smaller payloads
				// stay inline in skill_run_artifacts.content_inline.
				SKILL_ARTIFACTS: bindings.r2({
					...live.r2("skillArtifacts", { name: "public-installation-bucket" }),
					dev: { remote: remoteDev },
				}),
				VIDEO_BUCKET: bindings.r2({
					...live.r2("tedi", { name: "public-installation-bucket" }),
					dev: { remote: remoteDev },
				}),
				// Runs tenant skill code in a per-call isolate.
				LOADER: bindings.workerLoader(),
				// `SkillWorkflow` comes from createDynamicWorkflowEntrypoint() and
				// dispatches each run to a freshly loaded tenant Worker via LOADER.
				WORKFLOWS: bindings.workflow({
					worker: workerName,
					exportName: "SkillWorkflow",
					name: production ? "skill-workflow-production" : "skill-workflow",
				}),
				...(!test
					? {
							API_SERVICE: bindings.worker({
								worker: service("api", "public-installation-api"),
								exportName: "InternalEntrypoint",
							}),
							MCP_SERVICE: bindings.worker({
								worker: service("mcp", "public-installation-mcp"),
								exportName: "InternalEntrypoint",
							}),
							TEDI_RUNTIME_SERVICE: bindings.worker({
								worker: service(
									"tedi-runtime",
									"public-installation-tedi-runtime",
								),
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
				MCP_URL: bindings.text(
					live.active ? `https://${live.host("mcp", "")}` : PLACEHOLDER,
				),
				VERTEX_VIDEO_ENDPOINT: bindings.text(
					live.vars("skill-runtime", "VERTEX_VIDEO_ENDPOINT", PLACEHOLDER),
				),
				PLATFORM_SERVICE_TOKEN: bindings.secret(),
				GOOGLE_SERVICE_ACCOUNT_KEY: bindings.secret(),
				GEMINI_API_KEY: bindings.secret(),
			},
		}),
	};
});
