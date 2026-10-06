import {
	bindings,
	defineConfig,
	defineContainer,
	defineWorker,
	exports,
} from "cf/config";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
// `bun run dev:remote` opts into shared production data; `bun dev` stays local.
const remoteDev =
	runtimeEnv?.TEDIX_DEV_REMOTE_TARGET === "shared-production-data";
// Isolated-lane values. scripts/dev-local.ts passes disabled Descope
// placeholders so a local Worker never reaches a live project.
const localLane = {
	descopeProjectId:
		runtimeEnv?.DESCOPE_PROJECT_ID || "local-development-disabled",
	descopeBaseUrl: runtimeEnv?.DESCOPE_BASE_URL || "http://127.0.0.1:9",
	databaseId: "00000000-0000-0000-0000-000000000000",
} as const;
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	// Isolated `bun dev` and the test suite: no remote data, no production ids.
	const local = !production && !remoteDev;
	const workerName = production
		? "public-installation-docs-production"
		: "public-installation-docs";

	// Checks out tenant source and runs the pinned Nimbus/Astro build. Cloudflare
	// cannot convert the retired default-policy application in place, so the
	// native Durable Object-managed runtime has its own canonical name.
	const docsBuildContainer = defineContainer({
		name: "public-installation-container",
		schedulingPolicy: "durable-object",
		images: {
			sandbox: { dockerfile: "./Dockerfile" },
		},
	});

	return {
		containers: [docsBuildContainer],
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-07-29",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			// Live SQLite-backed class with its container. Keep the storage and the
			// class name: a deleted or renamed state drops every build sandbox.
			exports: {
				DocsBuildSandbox: exports.durableObject({
					storage: "sqlite",
					container: docsBuildContainer,
				}),
			},
			env: {
				// @cloudflare/config through 0.22.0 requires a worker name and emits
				// script_name for bindings.durableObject(). Same-Worker namespaces must
				// omit script_name, so keep this native metadata until that API changes.
				DOCS_BUILD_SANDBOX: {
					type: "unsafe:durable_object_namespace",
					class_name: "DocsBuildSandbox",
				},
				DOCS_BUILD_WORKFLOW: bindings.workflow({
					worker: workerName,
					exportName: "DocsBuildWorkflow",
					name: production ? "docs-builds-production" : "docs-builds",
				}),
				// Local runs use the zero id every local Worker shares.
				DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				DOCS_BUILDS: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				// Remote-only; the isolated lane omits them.
				...(!local
					? {
							DOCS_AI_SEARCH: bindings.aiSearchNamespace({
								namespace: "public-installation-namespace",
								dev: { remote: remoteDev },
							}),
							ARTIFACTS: bindings.artifacts({
								namespace: "public-installation-namespace",
								dev: { remote: true },
							}),
						}
					: {}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				DOCS_BASE_DOMAIN: bindings.text("configured-via-private-overlay"),
				DOCS_ADMIN_URL: bindings.text("configured-via-private-overlay"),
				...(local
					? {
							DESCOPE_PROJECT_ID: bindings.text(localLane.descopeProjectId),
							DESCOPE_BASE_URL: bindings.text(localLane.descopeBaseUrl),
						}
					: {
							DESCOPE_PROJECT_ID: bindings.secret(),
							DESCOPE_BASE_URL: bindings.secret(),
							DESCOPE_MANAGEMENT_KEY: bindings.secret(),
							PLATFORM_SERVICE_TOKEN: bindings.secret(),
						}),
			},
		}),
	};
});
