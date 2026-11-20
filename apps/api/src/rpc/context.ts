/**
 * The request context, split out of `./orpc` so the kernel Durable Objects can
 * build one without paying for the auth stack.
 *
 * `orpc.ts` authenticates, so it statically imports `@tedix/auth/jwt`, which
 * pulls `jose` (185 modules), `@descope/node-sdk`, `cross-fetch`, `node-fetch`,
 * `whatwg-url` and `tr46`. That is fine on the request path, which loads lazily
 * behind the thin `src/index.ts`. It is NOT fine for `KernelDOv4` /
 * `KernelVoiceDO`: the runtime needs real exported classes at startup, so every
 * static import they reach is EVALUATED on each cold isolate — and apps/api
 * runs ~0.9 req/s, so isolates evict constantly and a large share of requests
 * pay that cost (cpu p50 2,200-2,800ms in low-traffic windows vs 10-17ms warm).
 *
 * `createContext` never needed any of it — a D1 session and the request, that
 * is all. Keeping it here also keeps it SYNCHRONOUS, which matters: the DO's
 * `turnContext()` is a sync method used in expression position at 11 call
 * sites, so making it async would ripple through the whole class.
 *
 * Keep this module dependency-free. Anything added here is paid by every cold
 * start; auth, routers and workflow code belong in `./orpc` or behind a lazy
 * import (see `src/kernel/kernel-lazy.ts`).
 *
 * `orpc.ts` re-exports both symbols, so existing call sites are unaffected.
 */

import { getServiceBindingPrincipal } from "../service-principal";

// Type-only: erased at compile time, so it costs the eager graph nothing.
import type { ApiKeyPurpose } from "@tedix/api-contract/schemas/organization";
import type { JWTPayload } from "@tedix/auth/types";
import {
	configureLogStore,
	type createDbClient,
	type D1SessionConstraint,
	type DbSession,
	createDbSession,
	D1_BOOKMARK_HEADER,
} from "@tedix/db/client";

/**
 * Read-only procedures on the per-agent-call path whose first query may go to
 * a D1 read replica. Each runs on every MCP call (grant check) or every MCP
 * surface rebuild (discovery), so when the primary is saturated by heavy
 * scans these are the reads that should not queue behind it.
 *
 * Replication state is an operator setting on the database. When disabled,
 * `first-unconstrained` still routes to the primary. When enabled, these
 * procedures may observe replica lag; grant verification retries a negative
 * answer on the primary. Writes always go to the primary, and the session
 * keeps them read-your-own-writes.
 */
export const D1_REPLICA_READ_RPC_PATHS: ReadonlySet<string> = new Set([
	"/rpc/organizations/verifyMultiOrgMcpGrant",
	"/rpc/apps/getBySlugWithTools",
	"/rpc/apps/getBySlugsWithTools",
	"/rpc/apps/getByDomain",
	"/rpc/tedis/listRuntimeMetaBySlugs",
	"/rpc/skills/listByApp",
	"/rpc/skills/listSummariesByApps",
]);

/** How a request's D1 session picks its first query's target. */
export function d1SessionConstraintFor(request: Request): D1SessionConstraint {
	try {
		return D1_REPLICA_READ_RPC_PATHS.has(new URL(request.url).pathname)
			? "first-unconstrained"
			: "first-primary";
	} catch {
		return "first-primary";
	}
}

/** Canonical request-auth discriminator after edge authentication succeeds. */
export type ApiAuthType =
	| "user"
	| "m2m"
	| "apikey"
	| "tedi"
	| "service-binding";

/**
 * Base context available to all procedures
 * Includes Cloudflare bindings and request metadata
 */
export interface BaseContext {
	tediConsoleWorkspaceIds?: string[];
	/** Cloudflare Worker environment bindings */
	env: CloudflareEnv;
	/** Database client (created lazily) */
	db: ReturnType<typeof createDbClient>;
	/** Set from matched contract metadata before the first database access. */
	dbReadOnly?: boolean;
	/** The matched procedure's dotted path, set by the HTTP handlers; never from input. */
	procedurePath?: string;
	/** Set in-process only after the shared workspace resource checks, never from input or headers. */
	workspaceConnectionRead?: {
		actor: import("@tedix/api-contract/schemas/workspace-connection-read").WorkspaceConnectionActor;
		toolRowId: string;
	};
	/**
	 * The D1 bookmark for this request's session, or null before any query ran.
	 * Echo it on the response in `x-d1-bookmark` so a caller can chain sequential
	 * consistency across requests once read replication is enabled.
	 */
	dbBookmark?: () => string | null;
	dbMetrics?: DbSession["metrics"];
	/** `Server-Timing` entries a procedure adds, e.g. `app-runtime;dur=812`. */
	serverTiming?: string[];
	/**
	 * Authenticated user (Descope JWT payload)
	 * Present when authenticated via Descope SSO (Tedix OS and user-facing endpoints)
	 */
	user?: JWTPayload;
	/** Set only after an exact saved human factory approval is verified server-side. */
	factoryOperatorApproval?: { requestId: string; userId: string };
	/** Stable Tedix user id resolved from the external identity mapping. */
	userId?: string;
	/** Active membership kind read during this request's JWT authentication. */
	userMembershipKind?: "human" | "external_agent" | "browser_agent";
	/** Live policy row fetched in the same D1 batch as this request's identity. */
	agentReviewProject?: {
		id: string;
		project: import("@tedix/db/schema/projects").Project | undefined;
	};
	/** Browser-login agent identity resolved from the current organization membership. */
	browserAgentSeat?: import("@tedix/api-contract/schemas/browser-agent-seat").BrowserAgentSeat;
	/** Bounded external-provider API scopes; absent on the default Descope path. */
	oidcScopes?: string[];
	/** Organization ID (D1 UUID) resolved from Descope tenant id */
	organizationId?: string;
	/** Membership loaded by authentication, bound to this organization and subject. */
	organizationMembership?: {
		organizationId: string;
		subject: string;
		status: string | null;
		role: string;
		id?: string;
		userId?: string | null;
		/** The persisted provider subject can differ from the authenticated subject. */
		descopeUserId?: string;
		kind?: "human" | "external_agent" | "browser_agent";
		customPermissions?:
			| import("@tedix/api-contract/schemas/user-settings").OrganizationPermission[]
			| null;
	};
	/** User role within the organization */
	userRole?: string;
	/** Gateway-verified approver, restricted to this exact tool dispatch. */
	approvedToolUserId?: string;
	/**
	 * Additive permission grants stored on this member's D1 row, on top of what
	 * `userRole` implies (`organization_members.custom_permissions`).
	 *
	 * Loaded from the SAME member row that resolves `userRole`, so it costs no
	 * extra read. Additive only — an override can never remove authority a role
	 * grants — and bounded by `TENANT_GRANTABLE_PERMISSIONS`, so it can never
	 * carry `platform:admin`. Valid under a cross-tenant override for the same
	 * reason `userRole` is: both come from the resolved-org membership, not from
	 * token claims.
	 */
	userPermissionOverrides?: readonly string[];
	/**
	 * True when this request's org context came from a cross-tenant override
	 * (`X-Tedix-Tenant-Id` addressing a tenant other than the token's own `dct`).
	 * The token's `roles`/`permissions` claims are scoped to `dct`, so they are
	 * NOT valid here: authorization must rely solely on the resolved-org
	 * membership role (`userRole`). `assertUserPermissions` ignores token claims
	 * when this is set. Org context is only granted at all when a real D1
	 * membership in the resolved org was found.
	 */
	crossTenantOverrideActive?: boolean;
	/**
	 * Authentication type for audit logging
	 * - "user": User JWT authentication
	 * - "m2m": Machine-to-machine JWT authentication
	 * - "apikey": API key authentication
	 * - "tedi": Tedi access key authentication
	 * - "service-binding": Authenticated Worker service binding
	 */
	authType?: ApiAuthType;
	/** Set by named service ingress, never by request headers. */
	serviceBindingPrincipal?: "mcp-edge";
	/** Tedi ID when authenticated via tedi access key */
	tediId?: string;
	/** Descope user ID when authenticated via tedi access key (V2 identity) */
	descopeUserId?: string;
	/** Explicit scopes carried by a direct tedi JWT. */
	tediScopes?: string[];
	/**
	 * A verified internal exchanged token (token exchange pilot). When set it
	 * is the only scope authority for this service-binding call.
	 */
	exchangedToken?: {
		jti: string;
		subject: string;
		actorChain: string[];
		scopes: string[];
	};
	/** Delegated MCP-edge authorization for one concrete tool execution. */
	serviceBindingAuthorization?: {
		source: "mcp-tool";
		toolId: string;
	};
	/**
	 * Descope user id of the human whose OAuth session drove a gateway
	 * service-binding call (95dff537). Provenance for admission records, not
	 * an authority grant — deliberately separate from `user`.
	 */
	gatewayEndUserId?: string;
	/** Gateway-verified non-tedi execution identity on a service-binding call. */
	externalAgentPrincipalId?: string;
	externalAgentSessionId?: string;
	externalAgentClientRecordId?: string;
	/**
	 * Owner-host Agent-Session the MCP edge attached to a forwarded human user
	 * call (Code Mode `agentSessionId`). Set only after `withAuth` resolved it as
	 * an active `owner_user` session of this exact user and organization; Work
	 * admission re-validates it before attributing anything to it.
	 */
	ownerHostSessionId?: string;
	/**
	 * Service account authentication (M2M tokens)
	 * Used for machine-to-machine communication (e.g., MCP -> API internal calls)
	 * Present when authenticated via service binding
	 */
	serviceAccount?: {
		/** Service client identifier (e.g., "mcp-service", "workflow-runner") */
		clientId: string;
		/** Stable Tedix service principal when this provider subject is mapped. */
		canonicalPrincipalId?: string;
		/** Optional scope for permission boundaries (e.g., "apps:read", "tools:write") */
		scope?: string;
	};
	/**
	 * API key authentication
	 * Used for organization-scoped programmatic access (future: public API, integrations)
	 * Present when authenticated via API key (X-API-Key header)
	 */
	apiKey?: {
		/** API key ID (D1 UUID) */
		id: string;
		/** Organization ID owning this key */
		organizationId: string;
		/** Human-readable key name */
		name: string;
		purpose?: ApiKeyPurpose;
		/** Optional permission scopes (e.g., ["apps:read", "analytics:read"]) */
		scopes?: string[];
	};

	/** Request headers */
	headers: Headers;
	/** Request URL */
	url: URL;
	/** Rate limiter binding */
	rateLimiter: RateLimit;
	/** Schedule background work that outlives the response */
	waitUntil?: (promise: Promise<unknown>) => void;
}
/**
 * Create context from Cloudflare Worker request
 */
export function createContext(
	request: Request,
	env: CloudflareEnv,
	waitUntil?: (promise: Promise<unknown>) => void,
): BaseContext {
	// Wait for the matched procedure's metadata before choosing the first query
	// target. Non-HTTP callers retain the conservative path-based default.
	let session: DbSession | undefined;
	const getSession = () => {
		if (!session) {
			session = createDbSession(
				env.DB,
				request.headers.get(D1_BOOKMARK_HEADER),
				context.dbReadOnly
					? "first-unconstrained"
					: d1SessionConstraintFor(request),
			);
			configureLogStore(session.db, env);
		}
		return session;
	};
	const context: BaseContext = {
		env,
		get db() {
			return getSession().db;
		},
		dbBookmark: () => session?.getBookmark() ?? null,
		get dbMetrics() {
			return getSession().metrics;
		},
		serverTiming: [],
		headers: request.headers,
		serviceBindingPrincipal: getServiceBindingPrincipal(request),
		url: new URL(request.url),
		rateLimiter: env.API_RATE_LIMITER,
		waitUntil,
	};
	return context;
}
