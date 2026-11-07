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
export const productionIngress = {
	workersDev: true,
	previewUrls: true,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const test = mode === "test";
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const vars = (name: string) => live.vars("docs-runtime", name, PLACEHOLDER);

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: production
				? live.worker(
						"docs-runtime",
						"public-installation-docs-runtime-production",
					)
				: "public-installation-docs-runtime",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-07-29",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			...(live.active
				? {
						domains: live.domains("docs-runtime", []),
						triggers: live
							.routes("docs-runtime", [])
							.map((route) => triggers.fetch(route)),
					}
				: {}),
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			env: {
				DB: bindings.d1({
					...live.d1("main", {
						id: "00000000-0000-0000-0000-000000000000",
						name: "public-installation-database",
					}),
					dev: { remote: false },
				}),
				DOCS_BUILDS: bindings.r2({
					...live.r2("docsBuilds", { name: "public-installation-bucket" }),
					dev: { remote: false },
				}),
				...(!test
					? {
							DOCS_SESSION_BROKER: bindings.worker({
								worker: production
									? live.worker(
											"session-broker",
											"public-installation-session-broker",
										)
									: "public-installation-session-broker",
								exportName: "DocsSessionBroker",
							}),
						}
					: {}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				DOCS_BASE_DOMAIN: bindings.text(live.host("docs", PLACEHOLDER)),
				DOCS_ROOT_SITE_SLUG: bindings.text(vars("DOCS_ROOT_SITE_SLUG")),
				DOCS_HOST_ALIASES: bindings.text(vars("DOCS_HOST_ALIASES")),
				DESCOPE_PROJECT_ID: bindings.text(vars("DESCOPE_PROJECT_ID")),
				DESCOPE_BASE_URL: bindings.text(
					live.active ? `https://${live.host("auth", "")}` : PLACEHOLDER,
				),
			},
		}),
	};
});
