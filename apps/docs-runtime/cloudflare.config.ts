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
	const test = mode === "test";

	return {
		worker: defineWorker({
			name: production
				? "public-installation-docs-runtime-production"
				: "public-installation-docs-runtime",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-07-29",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			env: {
				DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: false },
				}),
				DOCS_BUILDS: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: false },
				}),
				...(!test
					? {
							DOCS_SESSION_BROKER: bindings.worker({
								worker: "public-installation-session-broker",
								exportName: "DocsSessionBroker",
							}),
						}
					: {}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				DOCS_BASE_DOMAIN: bindings.text("configured-via-private-overlay"),
				DOCS_ROOT_SITE_SLUG: bindings.text("configured-via-private-overlay"),
				DOCS_HOST_ALIASES: bindings.text("configured-via-private-overlay"),
				DESCOPE_PROJECT_ID: bindings.text("configured-via-private-overlay"),
				DESCOPE_BASE_URL: bindings.text("configured-via-private-overlay"),
			},
		}),
	};
});
