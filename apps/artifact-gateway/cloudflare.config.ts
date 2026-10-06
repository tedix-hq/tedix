import { bindings, defineConfig, defineWorker } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
export const productionIngress = {
	workersDev: true,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";

	return {
		worker: defineWorker({
			name: production
				? "public-installation-artifact-gateway-production"
				: "public-installation-artifact-gateway",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-08-17",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: production ? productionIngress.workersDev : false,
			previewUrls: production ? productionIngress.previewUrls : false,
			placement: { mode: "smart" },
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.01 },
			},
			env: {
				API_SERVICE: bindings.worker({
					worker: "public-installation-api",
				}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
