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
// placeholders so a local Site Builder never reaches a live project.
const localLane = {
	cfAccountId: "local-development-disabled",
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

	// The builder is a native Sandbox v1 Durable Object. Its image and instance
	// are selected by SiteBuilderSandboxRuntime at startup.
	const siteBuilderContainer = defineContainer({
		name: "public-installation-container",
		schedulingPolicy: "durable-object",
		images: {
			sandbox: { dockerfile: "./Dockerfile" },
		},
	});

	return {
		containers: [siteBuilderContainer],
		worker: defineWorker({
			name: production
				? "public-installation-cms-production"
				: "public-installation-cms",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			// Tenant CMS fallback URLs come from Tedix-owned surface routing, so
			// global fetch stays on the public edge instead of bypassing Worker routes.
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			// SiteBuilderSandboxRuntime is the sole builder namespace. Builder
			// workspaces are disposable; active tenant source lives in Artifacts and
			// is rematerialized on demand.
			exports: {
				SiteBuilderSandboxRuntime: exports.durableObject({
					storage: "sqlite",
					container: siteBuilderContainer,
				}),
			},
			env: {
				// @cloudflare/config through 0.22.0 requires a worker name and emits
				// script_name for bindings.durableObject(). Same-Worker namespaces must
				// omit script_name, so keep this native metadata until that API changes.
				SITE_BUILDER_SANDBOX: {
					type: "unsafe:durable_object_namespace",
					class_name: "SiteBuilderSandboxRuntime",
				},
				// Local runs use the zero id every local Worker shares.
				DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				SITE_BUILDER_STORAGE: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				BUNDLES_BUCKET: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				// Durable, retryable theme deploys: build, snapshot, dispatch, finalize.
				DEPLOY_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-production"
						: "public-installation-cms",
					exportName: "DeployWorkflow",
					name: production ? "cms-deploys-production" : "cms-deploys",
				}),
				IMAGE_GENERATION_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-production"
						: "public-installation-cms",
					exportName: "ImageGenerationWorkflow",
					name: production
						? "cms-image-generations-production"
						: "cms-image-generations",
				}),
				// Backs env.AI.run/toMarkdown and the AI Gateway providers listed in
				// AI_GATEWAY_BINDING_PROVIDERS. To move a provider back to HTTPS,
				// shorten that list; do not remove this binding.
				AI: bindings.ai(),
				// Remote-only; the isolated lane omits them.
				...(!local
					? {
							ARTIFACTS: bindings.artifacts({
								namespace: "public-installation-namespace",
								dev: { remote: true },
							}),
							API_SERVICE: bindings.worker({
								worker: "public-installation-api",
								exportName: "InternalEntrypoint",
							}),
							CMS_DISPATCH: bindings.worker({
								worker: "public-installation-cms-runtime",
							}),
						}
					: {}),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				AI_GATEWAY_ACCOUNT_ID: bindings.text("configured-via-private-overlay"),
				AI_GATEWAY_ID: bindings.text("configured-via-private-overlay"),
				// Provider paths served by the in-account gateway, which ride the AI
				// binding instead of public HTTPS and CF_AI_GATEWAY_TOKEN.
				AI_GATEWAY_BINDING_PROVIDERS: bindings.text(
					"configured-via-private-overlay",
				),
				...(local
					? {
							DESCOPE_PROJECT_ID: bindings.text(localLane.descopeProjectId),
							DESCOPE_BASE_URL: bindings.text(localLane.descopeBaseUrl),
							CF_ACCOUNT_ID: bindings.text(localLane.cfAccountId),
						}
					: {
							DESCOPE_PROJECT_ID: bindings.secret(),
							DESCOPE_BASE_URL: bindings.secret(),
							DESCOPE_MANAGEMENT_KEY: bindings.secret(),
							CF_ACCOUNT_ID: bindings.secret(),
							PLATFORM_SERVICE_TOKEN: bindings.secret(),
							CMS_INTERNAL_AUTH_TOKEN: bindings.secret(),
							GEMINI_API_KEY: bindings.secret(),
							CF_AI_GATEWAY_TOKEN: bindings.secret(),
						}),
			},
		}),
	};
});
