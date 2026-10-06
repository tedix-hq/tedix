/**
 * Tedi Worker type definitions
 */

import type { WorkstationEgressPolicy } from "@tedix/api-contract/schemas/workstation";
import type {
	PolicyPackDefinition,
	RuntimeProfileConfig,
	WorkspaceTemplateSetDefinition,
} from "@tedix/db/schema/control-plane";
import type { RuntimeBodyLauncher } from "./runtime/body-launcher";
import type {
	WorkstationRuntimeBody,
	WorkstationRuntimeNamespace,
} from "./workstation/computer-body";

/**
 * Environment bindings for the Tedi Worker
 */
export interface TediEnv {
	TEDI_WORKSTATION_RUNTIME_SANDBOX: WorkstationRuntimeNamespace;

	// Storage
	TEDI_STORAGE: R2Bucket;
	BACKUP_BUCKET: R2Bucket;
	DB: D1Database;
	ARTIFACTS?: Artifacts;

	// Environment
	ENVIRONMENT: string;
	// The release SHA, read from GIT_SHA when the production build evaluates
	// cloudflare.config.ts. Optional because local dev and tests run without it; /health
	// degrades to "unknown" rather than omitting the field.
	GIT_SHA?: string;
	TEDIX_ARTIFACTS_ENABLED_TEDI_SLUGS?: string;

	// Secrets encryption
	SECRETS_MASTER_KEY?: string;

	// Outbound API sync (tedi -> apps/api projection ingest)
	API_URL?: string;
	OS_URL?: string;
	ALLOWED_WS_ORIGINS?: string; // comma/space separated extra browser origins for WS proxy access
	API_SERVICE?: Fetcher; // Service binding for direct Worker-to-Worker communication (tedi → api)
	TEDI_SERVICE?: Fetcher; // Self-service binding for tedi-to-tedi peer calls via X-Tedix-Host

	// Auth — Descope JWT validation for end-user proxy auth
	DESCOPE_PROJECT_ID: string;
	DESCOPE_BASE_URL?: string;

	// Platform-default model keys (Worker-level secrets)
	// Per-tedi tedi_secrets override these when BYOM is needed
	OPENAI_API_KEY?: string;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_BASE_URL?: string;
	GEMINI_API_KEY?: string;
	GOOGLE_API_KEY?: string;
	AZURE_OPENAI_TTS_DEPLOYMENT?: string;
	AZURE_OPENAI_TTS_VOICE?: string;
	AZURE_OPENAI_STT_DEPLOYMENT?: string;
	AZURE_OPENAI_STT_API_VERSION?: string;
	AZURE_OPENAI_REALTIME_DEPLOYMENT?: string;
	AZURE_OPENAI_REALTIME_API_VERSION?: string;
	GRADIUM_API_KEY?: string;

	// Platform-default KugelAudio TTS (ElevenLabs-compatible proxy, ~39ms TTFA)
	// Falls back to main AZURE_OPENAI_* credentials for Azure TTS
	KUGEL_API_KEY?: string;

	// Platform-default Twilio credentials (Worker-level secrets)
	// Per-tedi TWILIO_PHONE_NUMBER comes from tedi_secrets
	TWILIO_ACCOUNT_SID?: string;
	TWILIO_AUTH_TOKEN?: string;

	// Local dev — fallback when cloudflared can't preserve wildcard subdomains
	// Value: tedi slug e.g. "tedi"
	DEFAULT_TEDI_SLUG?: string;

	TEDI_RUNTIME_SERVICE?: Fetcher;
}

/**
 * Resolved tedi config from D1 lookup
 */
export interface TediConfig {
	id: string;
	slug: string;
	displayName: string;
	environment?: string;
	/**
	 * Optional per-tedi bucket name override.
	 *
	 * If unset, the Tedi Worker uses the environment default bucket and isolates by prefix.
	 */
	r2BucketName?: string | null;

	// Organization that owns this tedi (for JWT org ownership checks)
	organizationId: string | null;
	/**
	 * Descope tenant ID that owns this tedi.
	 * Used to validate Descope JWT tenant claims since `organizationId` is a D1 UUID.
	 */
	organizationDescopeTenantId: string | null;
	/**
	 * Descope user ID of the tedi owner (personal tedis only). Used by
	 * `/chat/enqueue` (#133) to detect when an incoming Tedix OS chat operator
	 * matches the registered owner so the platform can inject a verified-
	 * operator banner the model can trust without a code-word challenge.
	 */
	ownerUserId?: string | null;

	// Runtime and workstation secrets resolved from tedi_secrets.
	secrets: {
		OPENAI_API_KEY?: string;
		GEMINI_API_KEY?: string;
		GOOGLE_API_KEY?: string;
		TELEGRAM_BOT_TOKEN?: string;
		[key: string]: string | undefined;
	};

	// Platform config for MCP plugin env vars and runtime-origin policy
	platformDomain?: string;
	apiBaseUrl?: string;
	runtimeBaseUrl?: string;
	osBaseUrl?: string;
	mcpBaseUrl?: string;
	descopeProjectId?: string;
	descopeBaseUrl?: string;
	descopeMcpResourceId?: string | null;

	// Workstation sleep policy (e.g., '10m', '1h', 'never')
	sleepAfter?: string;

	/**
	 * Explicit always-on flag from runtime profile's `runtimePolicy.alwaysOn`.
	 * - `true`  → force keepAlive regardless of channel adapters (use for daily co-worker tedis)
	 * - `false` → respect env default sleepAfter even when bot tokens are present
	 *             (use for on-demand tedis the operator summons via `wake_tedi`)
	 * - `undefined` → fall back to the Telegram-token heuristic in apps/tedi/src/index.ts
	 */
	alwaysOn?: boolean;

	/**
	 * Instance tier for sandbox sizing.
	 *
	 * NOTE: Workstation tier support requires runtime Worker configuration with
	 * different instance types. At runtime we can't dynamically change the
	 * instance_type; this field is informational.
	 */
	instanceTier?:
		| "micro"
		| "small"
		| "standard"
		| "large"
		| "xlarge"
		| "xxlarge";

	// Control-plane config (always present — system defaults assigned on creation, null only if referenced record deleted)
	runtimeProfileConfig?: RuntimeProfileConfig | null;
	policyPackDefinition?: PolicyPackDefinition | null;
	workspaceTemplateSetDefinition?: WorkspaceTemplateSetDefinition | null;

	// Pre-rendered markdown of top platform brain facts for runtime prompts.
	platformKnowledge?: string;

	// Pre-rendered markdown of high-success muscle memory entries.
	muscleMemory?: string;

	// Repository config for coding agent workloads.
	// worktreePath is optional and body-specific. Tedix Sandbox workstations
	// derive /home/tedi/workstation/repos/{owner}/{repo} from repoUrl.
	repoConfig?: {
		repoUrl: string;
		branch: string;
		worktreePath?: string;
		githubRepositoryId?: number;
		githubInstallationId?: number;
		githubAppEnabled?: boolean;
	} | null;

	// Runtime kind set via tedis.runtime_kind D1 column. All tedis use the
	// Cloudflare Agents with native Pi Agent runtime; workstation access is additive.
	runtimeKind?: "agent";

	// DO instance name for isolate-backed tedis. Derived from slug when null.
	isolateAgentId?: string | null;

	/**
	 * Per-workstation egress allow/deny lists for the Cloudflare Sandbox body.
	 *
	 * Sourced from `runtime_profiles.config.runtimePolicy.workstationEgress`
	 * (config-driven D1, not hardcoded). Applied through the workstation
	 * runtime's outbound handler under Tedix-private param names so the
	 * Cloudflare SDK does not pre-gate before Tedix records egress events. When
	 * `allowedHosts` is empty the launcher installs a deny-all sentinel so the
	 * default posture is "deny all but the configured domains" — the static
	 * `outbound` SSRF guard in the workstation runtime is the second layer
	 * underneath. Hostname globs only (e.g. `*.github.com`).
	 */
	workstationEgress?: WorkstationEgressPolicy | null;
}

/**
 * Hono app environment type
 */
export type AppEnv = {
	Bindings: TediEnv;
	Variables: {
		runtimeBodyLauncher: RuntimeBodyLauncher<WorkstationRuntimeBody> | null;
		sandbox: WorkstationRuntimeBody;
		/**
		 * The container body this request resolved to, recorded onto the lease so
		 * a Cloudflare instance row can be mapped back to a lease. `name` is the
		 * Sandbox Durable Object name the dashboard prints; `id` is
		 * `idFromName(name)`, the 64-hex object id. Null on the passive status
		 * path, which deliberately never constructs a Sandbox client.
		 */
		workstationBodyInstance: { id: string; name: string } | null;
		tediConfig: TediConfig;
		tediId: string;
		workstationRuntimeSelection: {
			attemptId?: string | null;
			released?: boolean;
			workItemId?: string | null;
			leaseId: string;
			participantTediId: string;
			workstationId: string;
		} | null;
		r2Prefix: string; // Namespaced R2 prefix for this tedi
	};
};
