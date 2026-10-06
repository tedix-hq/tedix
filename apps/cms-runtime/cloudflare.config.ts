import {
	bindings,
	defineConfig,
	defineWorker,
	exports,
	triggers,
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
// placeholders so a local runtime never reaches a live project.
const localLane = {
	apiUrl: runtimeEnv?.TEDIX_LOCAL_API_URL?.trim() || "http://localhost:8787",
	cfAccountId: "local-development-disabled",
	descopeProjectId:
		runtimeEnv?.DESCOPE_PROJECT_ID || "local-development-disabled",
	descopeBaseUrl: runtimeEnv?.DESCOPE_BASE_URL || "http://127.0.0.1:9",
	demoEnabled: "true",
	databaseId: "00000000-0000-0000-0000-000000000000",
} as const;
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	// Isolated `bun dev` and the workerd suite: no remote data, no production ids.
	const local = !production && !remoteDev;
	// The recovery Workflow was registered without a mode suffix; the others
	// carry the suffix of the lane that registered them.
	const workflow = (name: string) =>
		production
			? `${name}-production`
			: remoteDev
				? `${name}-development`
				: name;

	return {
		worker: defineWorker({
			name: production
				? "public-installation-cms-runtime-production"
				: "public-installation-cms-runtime",
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			cache: { enabled: true },
			// Production only. Cloudflare-for-SaaS custom hostnames match no hostname
			// route and reach this Worker through the zone-wide `*/*` catch-all, so it
			// stays declared or a deploy deletes it; more specific routes and
			// API-managed `script: null` exclusions still win. The cron fans out to
			// each active tenant bundle's Emdash scheduled() handler; other lanes share
			// production data, so a second cron would double-run it.
			triggers: production
				? [
						// Blog, CMS media, theme assets and feeds stay on the apex; these
						// beat landing's tedix.dev/* because they are more specific.
						triggers.scheduled({ schedule: "* * * * *" }),
					]
				: undefined,
			// Live SQLite-backed class. Keep it with the same storage: a changed
			// storage is rejected and a deleted state drops every tenant database.
			exports: {
				default: exports.worker({ cache: { enabled: false } }),
				CmsOutboundProxy: exports.worker({ cache: { enabled: false } }),
				TenantCachedAssets: exports.worker({ cache: { enabled: true } }),
				EmDashDB: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				// Loads each tenant's Astro+Emdash bundle into its own isolate.
				LOADER: bindings.workerLoader(),
				// Each tenant's Emdash database, one object per slug.
				DB_DO: bindings.durableObject({
					worker: production
						? "public-installation-cms-runtime-production"
						: "public-installation-cms-runtime",
					exportName: "EmDashDB",
				}),
				CLI_RELEASES: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				RECOVERY_STORAGE: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				// Tenant bundles keyed by `${slug}/v${version}/...`.
				TENANT_BUNDLES: bindings.r2({
					name: "public-installation-bucket",
					dev: { remote: remoteDev },
				}),
				CMS_RECOVERY_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-runtime-production"
						: "public-installation-cms-runtime",
					exportName: "CmsRecoveryWorkflow",
					name: "cms-recovery-captures",
				}),
				CMS_SITE_RESTORE_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-runtime-production"
						: "public-installation-cms-runtime",
					exportName: "CmsSiteRestoreWorkflow",
					name: workflow("cms-site-restore"),
				}),
				CMS_PITR_SELF_TEST_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-runtime-production"
						: "public-installation-cms-runtime",
					exportName: "CmsPitrSelfTestWorkflow",
					name: workflow("cms-pitr-self-test"),
				}),
				CMS_SITE_RESTORE_DRILL_WORKFLOW: bindings.workflow({
					worker: production
						? "public-installation-cms-runtime-production"
						: "public-installation-cms-runtime",
					exportName: "CmsSiteRestoreDrillWorkflow",
					name: workflow("cms-site-restore-drill"),
				}),
				// Read-only slug -> org and active bundle lookup. Local runs use the
				// zero id every local Worker shares.
				PLATFORM_DB: bindings.d1({
					id: "00000000-0000-0000-0000-000000000000",
					name: "public-installation-database",
					dev: { remote: remoteDev },
				}),
				// Shared session storage, prefixed per tenant.
				SESSION: bindings.kv({
					id: "00000000000000000000000000000000",
					dev: { remote: remoteDev },
				}),
				// Parent-only: serves Emdash /_image transforms before Worker Loader
				// dispatch. Native bindings cannot be forwarded into a tenant isolate.
				IMAGES: bindings.images(),
				// Remote-only; the isolated lane and the workerd suite omit it.
				...(!local
					? {
							AI_SEARCH: bindings.aiSearchNamespace({
								namespace: "public-installation-namespace",
								dev: { remote: remoteDev },
							}),
						}
					: {}),
				// Public WebMCP calls are anonymous. A permissive per-colo abuse bound,
				// keyed by tenant + actor in code, not billing-grade accounting.
				WEBMCP_RATE_LIMITER: bindings.rateLimit({
					namespace: "1011",
					simple: { limit: 60, period: 60 },
				}),
				...(!local
					? {
							API_SERVICE: bindings.worker({
								worker: "public-installation-api",
								exportName: "InternalEntrypoint",
							}),
							CMS_SESSION_BROKER: bindings.worker({
								worker: "public-installation-session-broker",
								exportName: "CmsSessionBroker",
							}),
						}
					: {}),
				MARKETING_SITE_SLUG: bindings.text("configured-via-private-overlay"),
				MARKETING_DOMAINS: bindings.text("configured-via-private-overlay"),
				CLI_DOWNLOAD_HOST: bindings.text("configured-via-private-overlay"),
				API_URL: bindings.text(
					local ? localLane.apiUrl : "configured-via-private-overlay",
				),
				TEDIX_MARKETING_ORG_ID: bindings.text("configured-via-private-overlay"),
				TEDIX_CMO_TEDI_ID: bindings.text("configured-via-private-overlay"),
				TEDIX_DEMAND_OBJECTIVE_ID: bindings.text(
					"configured-via-private-overlay",
				),
				TEDIX_DEMAND_PROJECT_ID: bindings.text(
					"configured-via-private-overlay",
				),
				TEDIX_DEMAND_INTAKE_PARENT_ID: bindings.text(
					"configured-via-private-overlay",
				),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				CF_ACCOUNT_ID: bindings.text(
					local ? localLane.cfAccountId : "configured-via-private-overlay",
				),
				DESCOPE_BASE_URL: bindings.text(
					local ? localLane.descopeBaseUrl : "configured-via-private-overlay",
				),
				...(local
					? {
							DESCOPE_PROJECT_ID: bindings.text(localLane.descopeProjectId),
							TEDIX_LOCAL_DEMO_ENABLED: bindings.text(localLane.demoEnabled),
						}
					: {
							DESCOPE_PROJECT_ID: bindings.secret(),
							CLOUDFLARE_R2_API_TOKEN: bindings.secret(),
							CMS_INTERNAL_AUTH_TOKEN: bindings.secret(),
							EMDASH_ENCRYPTION_KEY: bindings.secret(),
							LEAD_FORM_IP_HASH_HMAC_KEY: bindings.secret(),
						}),
			},
		}),
	};
});
