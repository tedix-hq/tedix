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
// `bun run dev:remote` opts into shared production data; `bun dev` stays local.
const remoteDev =
	runtimeEnv?.TEDIX_DEV_REMOTE_TARGET === "shared-production-data";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const test = mode === "test";
	// Isolated `bun dev` and the workerd suite: no remote data, no production ids.
	const local = !production && !remoteDev;
	const worker = (name: string) => (production ? `${name}-production` : name);
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const service = (surface: string, name: string) =>
		production ? live.worker(surface, worker(name)) : name;
	const workerName = service("tedi", "public-installation-tedi");
	const liveUrl = (host: string) =>
		live.active ? `https://${live.host(host, "")}` : PLACEHOLDER;
	const vars = (name: string) => live.vars("tedi", name, PLACEHOLDER);

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			placement: { mode: "smart" },
			...(live.active
				? {
						domains: live.domains("tedi", []),
						// The custom domain alone loses to the zone-wide CMS catch-all,
						// so the apex also needs its route.
						triggers: live
							.routes("tedi", [])
							.map((route) => triggers.fetch(route)),
					}
				: {}),
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			env: {
				// Tedi config lookups in the D1 database shared with apps/api. Local runs
				// use the zero id every local Worker shares.
				DB: bindings.d1({
					...live.d1("main", {
						id: "00000000-0000-0000-0000-000000000000",
						name: "public-installation-database",
					}),
					dev: { remote: remoteDev },
				}),
				// Tedi workspace persistence, namespaced per tedi (tedis/{tediId}/*).
				TEDI_STORAGE: bindings.r2({
					...live.r2("tedi", { name: "public-installation-bucket" }),
					dev: { remote: remoteDev },
				}),
				BACKUP_BUCKET: bindings.r2({
					...live.r2("tedi", { name: "public-installation-bucket" }),
					dev: { remote: remoteDev },
				}),
				// One Git repository per tedi for operating text state. Remote-only.
				...(!local
					? {
							ARTIFACTS: bindings.artifacts({
								namespace: live.artifacts(
									"namespace",
									"public-installation-namespace",
								),
								dev: { remote: true },
							}),
						}
					: {}),
				...(!test
					? {
							// The workstation Sandbox class lives in apps/tedi-workstation-runtime.
							TEDI_WORKSTATION_RUNTIME_SANDBOX: bindings.durableObject({
								worker: service(
									"tedi-workstation-runtime",
									"public-installation-tedi-workstation-runtime",
								),
								exportName: "TediWorkstationRuntimeSandbox",
							}),
							API_SERVICE: bindings.worker({
								// scripts/dev-local.ts runs apps/api under this local name.
								worker: local
									? "public-installation-api"
									: service("api", "public-installation-api"),
								exportName: "InternalEntrypoint",
							}),
							TEDI_SERVICE: bindings.worker({
								worker: workerName,
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
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				API_URL: bindings.text(
					production
						? liveUrl("api")
						: local
							? runtimeEnv?.TEDIX_LOCAL_API_URL?.trim() ||
								"http://localhost:8787"
							: PLACEHOLDER,
				),
				OS_URL: bindings.text(
					production
						? liveUrl("os")
						: local
							? "http://localhost:3030"
							: PLACEHOLDER,
				),
				// Read by @cloudflare/sandbox with the R2_ACCESS_KEY_ID and
				// R2_SECRET_ACCESS_KEY secrets to reach the backup bucket over S3.
				BACKUP_BUCKET_NAME: bindings.text(
					live.r2("tedi", { name: PLACEHOLDER }).name,
				),
				AZURE_OPENAI_RESOURCE: bindings.text(vars("AZURE_OPENAI_RESOURCE")),
				AZURE_OPENAI_TTS_DEPLOYMENT: bindings.text(
					vars("AZURE_OPENAI_TTS_DEPLOYMENT"),
				),
				AZURE_OPENAI_TTS_VOICE: bindings.text(vars("AZURE_OPENAI_TTS_VOICE")),
				AZURE_OPENAI_STT_DEPLOYMENT: bindings.text(
					vars("AZURE_OPENAI_STT_DEPLOYMENT"),
				),
				AZURE_OPENAI_STT_API_VERSION: bindings.text(
					vars("AZURE_OPENAI_STT_API_VERSION"),
				),
				AZURE_OPENAI_REALTIME_DEPLOYMENT: bindings.text(
					vars("AZURE_OPENAI_REALTIME_DEPLOYMENT"),
				),
				TEDIX_ARTIFACTS_ENABLED_TEDI_SLUGS: bindings.text(
					vars("TEDIX_ARTIFACTS_ENABLED_TEDI_SLUGS"),
				),
				...(production ? {} : {}),
				// Warm window for workstation coding sessions; exec calls renew it.
				// Opts out of the Skybridge runtime's telemetry counter.
				DO_NOT_TRACK: bindings.text(vars("DO_NOT_TRACK")),
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
						}
					: {
							DESCOPE_PROJECT_ID: bindings.secret(),
							DESCOPE_BASE_URL: bindings.secret(),
							SECRETS_MASTER_KEY: bindings.secret(),
							KUGEL_API_KEY: bindings.secret(),
							TWILIO_ACCOUNT_SID: bindings.secret(),
							TWILIO_AUTH_TOKEN: bindings.secret(),
							GEMINI_API_KEY: bindings.secret(),
							R2_ACCESS_KEY_ID: bindings.secret(),
							R2_SECRET_ACCESS_KEY: bindings.secret(),
						}),
			},
		}),
	};
});
