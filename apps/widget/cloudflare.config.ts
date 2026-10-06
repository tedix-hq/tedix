import { bindings, defineConfig, defineWorker } from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
export const productionIngress = {
	workersDev: true,
	previewUrls: true,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";

	return {
		worker: defineWorker({
			name: production
				? "public-installation-widget-production"
				: "public-installation-widget",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			assets: {
				runWorkerFirst: true,
			},
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			env: {
				ASSETS: bindings.assets(),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
