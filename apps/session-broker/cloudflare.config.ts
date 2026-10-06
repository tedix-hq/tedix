import { bindings, defineConfig, defineWorker, exports } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";

	return {
		worker: defineWorker({
			name: production
				? "public-installation-session-broker-production"
				: "public-installation-session-broker",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-08-17",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			placement: { mode: "smart" },
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.01 },
			},
			// Live SQLite-backed classes. Once deployed, keep each entry with the same
			// storage: a changed storage is rejected and a deleted state drops data.
			exports: {
				SessionRotationOwner: exports.durableObject({ storage: "sqlite" }),
				SessionIntentOwner: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				SESSION_ROTATION: bindings.durableObject({
					worker: production
						? "public-installation-session-broker-production"
						: "public-installation-session-broker",
					exportName: "SessionRotationOwner",
				}),
				SESSION_INTENTS: bindings.durableObject({
					worker: production
						? "public-installation-session-broker-production"
						: "public-installation-session-broker",
					exportName: "SessionIntentOwner",
				}),
				// `bun dev` (scripts/dev-local.ts) passes disabled Descope placeholders
				// so a local broker never reaches the live project.
				DESCOPE_BASE_URL: bindings.text(
					(!production && runtimeEnv?.DESCOPE_BASE_URL) ||
						"configured-via-private-overlay",
				),
				DESCOPE_PROJECT_ID: bindings.text(
					(!production && runtimeEnv?.DESCOPE_PROJECT_ID) ||
						"configured-via-private-overlay",
				),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
