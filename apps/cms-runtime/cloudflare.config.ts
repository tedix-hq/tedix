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
		? live.worker("cms-runtime", "public-installation-cms-runtime-production")
		: "public-installation-cms-runtime";
	const liveUrl = (host: string) =>
		live.active ? `https://${live.host(host, "")}` : PLACEHOLDER;
	const liveVar = (name: string) =>
		bindings.text(live.vars("cms-runtime", name, PLACEHOLDER));
	const bucket = (key: string) =>
		live.r2(key, { name: "public-installation-bucket" });
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
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/index.ts",
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			...(live.active ? { domains: live.domains("cms-runtime", []) } : {}),
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
			},
			cache: { enabled: true },
			// Production only. Cloudflare-for-SaaS custom hostnames match no hostname
			// route and reach this Worker through the zone-wide `*/*` catch-all, so it
			// stays declared or a deploy deletes it; more specific routes and
			// API-managed `script: null` exclusions still win, but `*/*` needs
			// Cloudflare for SaaS on the zone, so the deploy values leave it out
			// until that is enabled. The cron fans out to
			// each active tenant bundle's Emdash scheduled() handler; other lanes share
			// production data, so a second cron would double-run it.
			triggers: production
				? [
						// Blog, CMS media, theme assets and feeds stay on the apex; these
						// beat landing's apex route because they are more specific.
						...live
							.routes("cms-runtime", [])
							.map((route) => triggers.fetch(route)),
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
					worker: workerName,
					exportName: "EmDashDB",
				}),
				CLI_RELEASES: bindings.r2({
					...bucket("cliReleases"),
					dev: { remote: remoteDev },
				}),
				RECOVERY_STORAGE: bindings.r2({
					...bucket("cms"),
					dev: { remote: remoteDev },
				}),
				// Tenant bundles keyed by `${slug}/v${version}/...`.
				TENANT_BUNDLES: bindings.r2({
					...bucket("cmsBundles"),
					dev: { remote: remoteDev },
				}),
				CMS_RECOVERY_WORKFLOW: bindings.workflow({
					worker: workerName,
					exportName: "CmsRecoveryWorkflow",
					name: "cms-recovery-captures",
				}),
				CMS_SITE_RESTORE_WORKFLOW: bindings.workflow({
					worker: workerName,
					exportName: "CmsSiteRestoreWorkflow",
					name: workflow("cms-site-restore"),
				}),
				CMS_PITR_SELF_TEST_WORKFLOW: bindings.workflow({
					worker: workerName,
					exportName: "CmsPitrSelfTestWorkflow",
					name: workflow("cms-pitr-self-test"),
				}),
				CMS_SITE_RESTORE_DRILL_WORKFLOW: bindings.workflow({
					worker: workerName,
					exportName: "CmsSiteRestoreDrillWorkflow",
					name: workflow("cms-site-restore-drill"),
				}),
				// Read-only slug -> org and active bundle lookup. Local runs use the
				// zero id every local Worker shares.
				PLATFORM_DB: bindings.d1({
					...live.d1("main", {
						id: "00000000-0000-0000-0000-000000000000",
						name: "public-installation-database",
					}),
					dev: { remote: remoteDev },
				}),
				// Shared session storage, prefixed per tenant.
				SESSION: bindings.kv({
					id: live.kv("cmsRuntimeSession", "00000000000000000000000000000000"),
					dev: { remote: remoteDev },
				}),
				// Parent-only: serves Emdash /_image transforms before Worker Loader
				// dispatch. Native bindings cannot be forwarded into a tenant isolate.
				IMAGES: bindings.images(),
				// Remote-only; the isolated lane and the workerd suite omit it.
				...(!local
					? {
							AI_SEARCH: bindings.aiSearchNamespace({
								namespace: live.aiSearch(
									"cmsSites",
									"public-installation-namespace",
								),
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
								worker: live.worker("api", "public-installation-api"),
								exportName: "InternalEntrypoint",
							}),
							CMS_SESSION_BROKER: bindings.worker({
								worker: live.worker(
									"session-broker",
									"public-installation-session-broker",
								),
								exportName: "CmsSessionBroker",
							}),
						}
					: {}),
				MARKETING_SITE_SLUG: liveVar("MARKETING_SITE_SLUG"),
				MARKETING_DOMAINS: liveVar("MARKETING_DOMAINS"),
				CLI_DOWNLOAD_HOST: bindings.text(live.host("downloads", PLACEHOLDER)),
				API_URL: bindings.text(local ? localLane.apiUrl : liveUrl("api")),
				TEDIX_MARKETING_ORG_ID: liveVar("TEDIX_MARKETING_ORG_ID"),
				TEDIX_CMO_TEDI_ID: liveVar("TEDIX_CMO_TEDI_ID"),
				TEDIX_DEMAND_OBJECTIVE_ID: liveVar("TEDIX_DEMAND_OBJECTIVE_ID"),
				TEDIX_DEMAND_PROJECT_ID: liveVar("TEDIX_DEMAND_PROJECT_ID"),
				TEDIX_DEMAND_INTAKE_PARENT_ID: liveVar("TEDIX_DEMAND_INTAKE_PARENT_ID"),
				ENVIRONMENT: bindings.text(production ? "production" : "development"),
				GIT_SHA: bindings.text(releaseSha),
				CF_ACCOUNT_ID: bindings.text(
					local ? localLane.cfAccountId : live.account(PLACEHOLDER),
				),
				// R2 jurisdiction of tenant media buckets; empty for the default.
				CF_R2_JURISDICTION: bindings.text(
					bucket("cliReleases").jurisdiction ?? "",
				),
				DESCOPE_BASE_URL: bindings.text(
					local ? localLane.descopeBaseUrl : liveUrl("auth"),
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
