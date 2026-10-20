import { type MarketingEnv } from "./marketing";
import type { TenantAiSearchNamespace } from "./tenant-ai-search";
import { type CmsSessionBrokerEnv } from "./session-broker";
// The bindings this Worker uses, declared explicitly. `cloudflare.config.ts`
// is their source of truth.
export interface Env extends CmsSessionBrokerEnv, MarketingEnv {
	LOADER: WorkerLoader;
	DB_DO: DurableObjectNamespace;
	TENANT_BUNDLES: R2Bucket;
	RECOVERY_STORAGE: R2Bucket;
	CMS_RECOVERY_WORKFLOW: Workflow<
		import("./cms-recovery-workflow").CmsRecoveryParams
	>;
	CMS_SITE_RESTORE_WORKFLOW: Workflow<
		import("./cms-site-restore-workflow").CmsSiteRestoreParams
	>;
	PLATFORM_DB: D1Database;
	SESSION: KVNamespace;
	AI_SEARCH: TenantAiSearchNamespace;
	WEBMCP_RATE_LIMITER: RateLimit;
	/**
	 * Native Cloudflare Images binding — parent-Worker-only. Never forwarded
	 * into a Worker Loader-dispatched tenant isolate (native bindings can't be
	 * passed directly, same class of gap as R2/D1/KV); used exclusively to
	 * serve Emdash's /_image transform requests intercepted before dispatch.
	 * See imageTransformResponse() below.
	 */
	IMAGES: ImagesBinding;
	ENVIRONMENT: string;
	GIT_SHA: string;
	CF_ACCOUNT_ID: string;
	CLOUDFLARE_R2_API_TOKEN: string;
	/** Optional override for the platform API URL injected into tenant isolates. */
	PLATFORM_API_URL?: string;
	/** Descope project ID — forwarded to tenant isolates for CMS admin auth. Set via CF secret. */
	DESCOPE_PROJECT_ID?: string;
	/** Descope session issuer/JWKS base forwarded to tenant isolates. */
	DESCOPE_BASE_URL?: string;
	/** Shared secret accepted by tenant auth for Studio service-binding CMS API calls. */
	CMS_INTERNAL_AUTH_TOKEN?: string;
	EMDASH_ENCRYPTION_KEY?: string;
	/** Parent-only HMAC key for tenant-scoped lead IP pseudonyms. */
	LEAD_FORM_IP_HASH_HMAC_KEY?: string;
}
