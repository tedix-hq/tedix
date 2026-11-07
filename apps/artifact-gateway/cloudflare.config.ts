import { bindings, defineConfig, defineWorker } from "cf/config";
import { deployValues } from "@tedix/deploy-values";

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
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: production
				? live.worker(
						"artifact-gateway",
						"public-installation-artifact-gateway-production",
					)
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
					worker: production
						? live.worker("api", "public-installation-api")
						: "public-installation-api",
				}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
