import { bindings, defineConfig, defineWorker } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
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

	return {
		worker: defineWorker({
			name: worker("public-installation-tedi"),
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			placement: { mode: "smart" },
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
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				// Tedi workspace persistence, namespaced per tedi (tedis/{tediId}/*).
				TEDI_STORAGE: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				BACKUP_BUCKET: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				// One Git repository per tedi for operating text state. Remote-only.
				...(!local
					? {
							ARTIFACTS: bindings.artifacts({
								namespace: "public-installation-namespace",
								dev: { remote: true },
							}),
						}
					: {}),
				...(!test
					? {
							// The workstation Sandbox class lives in apps/tedi-workstation-runtime.
							TEDI_WORKSTATION_RUNTIME_SANDBOX: bindings.durableObject({
								worker: worker("public-installation-tedi-workstation-runtime"),
								exportName: "TediWorkstationRuntimeSandbox",
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
							TEDI_RUNTIME_SERVICE: bindings.worker({
								worker: worker("public-installation-tedi-runtime"),
							}),
						}
					: {}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				API_URL: bindings.text(
					production
						? "configured-via-private-overlay"
						: local
							? runtimeEnv?.TEDIX_LOCAL_API_URL?.trim() ||
								"http://localhost:8787"
							: "configured-via-private-overlay",
				),
				OS_URL: bindings.text(
					production
						? "configured-via-private-overlay"
						: local
							? "http://localhost:3030"
							: "configured-via-private-overlay",
				),
				// Read by @cloudflare/sandbox with the R2_ACCESS_KEY_ID and
				// R2_SECRET_ACCESS_KEY secrets to reach the backup bucket over S3.
				BACKUP_BUCKET_NAME: bindings.text("configured-via-private-overlay"),
				AZURE_OPENAI_RESOURCE: bindings.text("configured-via-private-overlay"),
				AZURE_OPENAI_TTS_DEPLOYMENT: bindings.text(
					"configured-via-private-overlay",
				),
				AZURE_OPENAI_TTS_VOICE: bindings.text("configured-via-private-overlay"),
				AZURE_OPENAI_STT_DEPLOYMENT: bindings.text(
					"configured-via-private-overlay",
				),
				AZURE_OPENAI_STT_API_VERSION: bindings.text(
					"configured-via-private-overlay",
				),
				AZURE_OPENAI_REALTIME_DEPLOYMENT: bindings.text(
					"configured-via-private-overlay",
				),
				TEDIX_ARTIFACTS_ENABLED_TEDI_SLUGS: bindings.text(
					"configured-via-private-overlay",
				),
				...(production ? {} : {}),
				// Warm window for workstation coding sessions; exec calls renew it.
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
