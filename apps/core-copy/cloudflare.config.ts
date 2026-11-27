import {
	bindings,
	defineConfig,
	defineWorker,
	exports,
	triggers,
} from "cf/config";
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
	// Live production values when TEDIX_DEPLOY_VALUES is set; otherwise every
	// lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const workerName = production
		? live.worker("core-copy", "public-installation-core-copy-production")
		: "public-installation-core-copy";

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["nodejs_compat"],
			// Admin calls reach the workers.dev address; every route but /healthz
			// requires CORE_COPY_ADMIN_TOKEN.
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			// The cron only walks the plan while the run state says running.
			triggers: production
				? [triggers.scheduled({ schedule: "*/5 * * * *" })]
				: undefined,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.25 },
			},
			// Live SQLite-backed class. Keep it with the same storage: a changed
			// storage is rejected and a deleted state drops every checkpoint.
			exports: {
				CheckpointDO: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				// Core D1 database; the copy only reads from it.
				DB: bindings.d1(
					live.d1("main", {
						id: "00000000-0000-0000-0000-000000000000",
						name: "public-installation-database",
					}),
				),
				HYPERDRIVE: bindings.hyperdrive({
					id: live.hyperdrive("hyperdrive", "00000000000000000000000000000000"),
				}),
				COPY_CHECKPOINTS: bindings.durableObject({
					worker: workerName,
					exportName: "CheckpointDO",
				}),
				CORE_COPY_ADMIN_TOKEN: bindings.secret(),
				DO_JURISDICTION: bindings.text(production ? "eu" : ""),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
