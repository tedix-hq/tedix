import { bindings, defineConfig, defineWorker } from "cf/config";

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
	const test = mode === "test";

	return {
		worker: defineWorker({
			name: test
				? "public-installation-tedi-workstation-egress-broker-test"
				: production
					? "public-installation-tedi-workstation-egress-broker-production"
					: "public-installation-tedi-workstation-egress-broker",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			placement: { mode: "smart" },
			logpush: true,
			observability: {
				enabled: true,
				logs: {
					invocationLogs: true,
					headSamplingRate: 1,
				},
				traces: {
					enabled: true,
					headSamplingRate: 0.01,
				},
			},
			env: {
				...(!test
					? {
							API_SERVICE: bindings.worker({
								worker: "public-installation-api",
								exportName: "InternalEntrypoint",
							}),
							TEDI_SERVICE: bindings.worker({
								worker: "public-installation-tedi",
								exportName: "InternalEntrypoint",
							}),
							GITHUB_APP_ID: bindings.secret(),
							GITHUB_APP_PRIVATE_KEY_PKCS8: bindings.secret(),
						}
					: {}),
				ENVIRONMENT: bindings.text(
					test ? "test" : production ? "production" : "development",
				),
				GIT_SHA: bindings.text(releaseSha),
				GITHUB_APP_ENABLED: bindings.text("configured-via-private-overlay"),
			},
		}),
	};
});
