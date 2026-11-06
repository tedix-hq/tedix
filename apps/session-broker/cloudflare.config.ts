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
// Shown wherever production takes a value from the private deploy values.
const PLACEHOLDER = "configured-via-private-overlay";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const workerName = production
		? live.worker(
				"session-broker",
				"public-installation-session-broker-production",
			)
		: "public-installation-session-broker";

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-08-17",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			placement: { mode: "smart" },
			triggers: live.active
				? live
						.routes("session-broker", [])
						.map((route) => triggers.fetch(route))
				: undefined,
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
				API_SERVICE: bindings.worker({
					worker: production
						? live.worker("api", "public-installation-api-production")
						: "public-installation-api",
					exportName: "InternalEntrypoint",
				}),
				SESSION_ROTATION: bindings.durableObject({
					worker: workerName,
					exportName: "SessionRotationOwner",
				}),
				SESSION_INTENTS: bindings.durableObject({
					worker: workerName,
					exportName: "SessionIntentOwner",
				}),
				// `bun dev` (scripts/dev-local.ts) passes disabled Descope placeholders
				// so a local broker never reaches the live project.
				DESCOPE_BASE_URL: bindings.text(
					(!production && runtimeEnv?.DESCOPE_BASE_URL) ||
						(live.active ? `https://${live.host("auth", "")}` : PLACEHOLDER),
				),
				DESCOPE_PROJECT_ID: bindings.text(
					(!production && runtimeEnv?.DESCOPE_PROJECT_ID) ||
						live.vars("session-broker", "DESCOPE_PROJECT_ID", PLACEHOLDER),
				),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
			},
		}),
	};
});
