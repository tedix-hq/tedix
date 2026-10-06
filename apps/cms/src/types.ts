import type { SiteBuilderSandboxRuntime } from "./container/site-builder-sandbox";
import type { CmsDeployWorkflowParams } from "./agent/deploy-admission";
import type { ImageGenerationWorkflowParams } from "./agent/image-generation-workflow";

// Cloudflare's generated binding types are the provider contract.
export type ArtifactsRepoHandle = ArtifactsRepo;
export type ArtifactsBinding = Pick<Artifacts, "get" | "create">;

export interface AppBindings {
	API_SERVICE: Fetcher;
	SITE_BUILDER_SANDBOX: DurableObjectNamespace<SiteBuilderSandboxRuntime>;
	DB: D1Database;
	SITE_BUILDER_STORAGE: R2Bucket;
	BUNDLES_BUCKET: R2Bucket;
	ARTIFACTS?: ArtifactsBinding;
	DEPLOY_WORKFLOW: Workflow<CmsDeployWorkflowParams>;
	IMAGE_GENERATION_WORKFLOW: Workflow<ImageGenerationWorkflowParams>;
	ENVIRONMENT: string;
	GIT_SHA: string;
	DESCOPE_PROJECT_ID: string;
	DESCOPE_BASE_URL: string;
	DESCOPE_MANAGEMENT_KEY: string;
	CF_ACCOUNT_ID: string;
	PLATFORM_SERVICE_TOKEN?: string;
	CMS_INTERNAL_AUTH_TOKEN?: string;
	GEMINI_API_KEY: string;
	/**
	 * Required AI Gateway attribution/observability for Gemini blog generation.
	 * The tool fails closed when any value is absent; it never calls the provider
	 * directly.
	 */
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Workers AI binding. Carries the AI Gateway request for every provider
	 * listed in `AI_GATEWAY_BINDING_PROVIDERS` — see
	 * `@tedix/workers-ai/gateway-transport`. Opt a provider out through that
	 * allowlist, never by removing this binding.
	 */
	AI?: Ai;
	/**
	 * Comma-separated allowlist of AI Gateway provider segments served by an
	 * in-account gateway, which therefore ride the Workers AI binding instead of
	 * public HTTPS. Listing `google-ai-studio` routes Gemini blog generation over
	 * the binding.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
	/**
	 * JSON map of org-slug → Emdash PAT (ec_pat_...) for service-to-service CMS calls.
	 * Used when the forwarded auth is an API key rather than a Descope user JWT.
	 * Example: {"tedix":"ec_pat_xxx","acme":"ec_pat_yyy"}
	 */
	CMS_SERVICE_KEYS?: string;
	CMS_DISPATCH?: Fetcher;
}

export type AppEnv = { Bindings: AppBindings };
