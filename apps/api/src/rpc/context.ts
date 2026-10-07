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

// Type-only: erased at compile time, so it costs the eager graph nothing.
import type { JWTPayload } from "@tedix/auth/types";
import {
	type createDbClient,
	createDbSession,
	D1_BOOKMARK_HEADER,
} from "@tedix/db/client";

/** Private request-local cap; its presence is not authentication or authority. */
export const CUSTODY_INSPECTION_SCOPE = Symbol("custody-inspection-scope");
export interface CustodyInspectionScope {
	readonly epochDeadline: number;
	readonly signal: AbortSignal;
	guard(): void;
	refuse(): never;
	checked<T>(read: () => PromiseLike<T>): Promise<T>;
}
export function issueCustodyInspectionScope(
	signal: AbortSignal,
): CustodyInspectionScope {
	const epochDeadline = Date.now() + 30_000;
	const monotonicDeadline = performance.now() + 30_000;
	const controller = new AbortController();
	let failure: unknown;
	let failed = false;
	const refuse = () => {
		if (!failed) {
			failed = true;
			failure = new Error("Custody inspection unavailable");
		}
		if (!controller.signal.aborted) controller.abort(failure);
		throw failure;
	};
	const guard = () => {
		if (
			failed ||
			signal.aborted ||
			performance.now() >= monotonicDeadline ||
			Date.now() >= epochDeadline
		)
			refuse();
	};
	const checked = async <T>(read: () => PromiseLike<T>): Promise<T> => {
		guard();
		const observed = Promise.resolve(read());
		void observed.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			guard();
			return await Promise.race([
				observed,
				new Promise<never>((_, reject) => {
					const stop = () => {
						try {
							refuse();
						} catch (e) {
							reject(e);
						}
					};
					onAbort = stop;
					signal.addEventListener("abort", stop, { once: true });
					timer = setTimeout(
						stop,
						Math.max(
							0,
							Math.min(
								monotonicDeadline - performance.now(),
								epochDeadline - Date.now(),
							),
						),
					);
					if (signal.aborted) stop();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort) signal.removeEventListener("abort", onAbort);
			guard();
		}
	};
	return Object.freeze({
		epochDeadline,
		signal: controller.signal,
		guard,
		checked,
		refuse,
	});
}
export function requireCustodyInspectionScope(
	context: BaseContext,
): CustodyInspectionScope {
	const scope = context[CUSTODY_INSPECTION_SCOPE];
	if (!scope) throw new Error("Custody inspection request scope unavailable");
	scope.guard();
	return scope;
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
	readonly [CUSTODY_INSPECTION_SCOPE]?: CustodyInspectionScope;
	/** Cloudflare Worker environment bindings */
	env: CloudflareEnv;
	/** Database client (created lazily) */
	db: ReturnType<typeof createDbClient>;
	/**
	 * The D1 bookmark for this request's session, or null before any query ran.
	 * Echo it on the response in `x-d1-bookmark` so a caller can chain sequential
	 * consistency across requests once read replication is enabled.
	 */
	dbBookmark?: () => string | null;
	/**
	 * Authenticated user (Descope JWT payload)
	 * Present when authenticated via Descope SSO (Tedix OS and user-facing endpoints)
	 */
	user?: JWTPayload;
	/** Stable Tedix user id resolved from the external identity mapping. */
	userId?: string;
	/** Organization ID (D1 UUID) resolved from Descope tenant id */
	organizationId?: string;
	/** User role within the organization */
	userRole?: string;
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
	/** Tedi ID when authenticated via tedi access key */
	tediId?: string;
	/** Descope user ID when authenticated via tedi access key (V2 identity) */
	descopeUserId?: string;
	/** Explicit scopes carried by a direct tedi JWT. */
	tediScopes?: string[];
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
	const inspectionScope = issueCustodyInspectionScope(request.signal);
	// One D1 session for the whole request, resumed from the caller's bookmark
	// when it sent one. Within a session D1 guarantees read-your-own-writes and
	// monotonic reads, so a procedure that writes and then reads is correct even
	// once reads may be served by a replica — the guarantee comes from the scope,
	// not from classifying individual queries.
	//
	// `first-unconstrained` globally, deliberately, rather than a per-path
	// allowlist. Replication is enabled (mode `auto`) and this is the setting that
	// actually routes reads to a nearby replica; the alternative was a path
	// allowlist, which trades real latency for a list nobody maintains.
	//
	// What this does NOT put at risk is correctness of the exclusive operations,
	// because they are enforced in the WRITE predicate and writes always execute
	// on the primary. Claiming a work item is one conditional
	// `UPDATE … WHERE … workItemIsUnclaimed()` with `.returning()`, so a stale
	// replica read cannot produce a double claim — the WHERE fails and the claim
	// returns null.
	//
	// What it does expose is visible staleness bounded by replication lag
	// (sub-second): a caller that wrote in a PREVIOUS request and sends no
	// bookmark can read a pre-write value. Read-then-decide gates are the ones to
	// watch — billing entitlement admission, for instance, could briefly gate on
	// a stale plan after an upgrade. Within a single request there is no exposure
	// at all: the session guarantees read-your-own-writes.
	//
	// Callers that need the cross-request guarantee should echo the bookmark from
	// `context.dbBookmark()` in `x-d1-bookmark` on their next call.
	const session = createDbSession(
		env.DB,
		request.headers.get(D1_BOOKMARK_HEADER),
		// first-primary: a caller sending no bookmark cannot read a stale row.
		// Enabling replica reads (first-unconstrained) made warm reads an order
		// of magnitude slower; read replication is beta, so do not switch
		// without a controlled measurement.
		"first-primary",
	);
	return {
		[CUSTODY_INSPECTION_SCOPE]: inspectionScope,
		env,
		db: session.db,
		dbBookmark: session.getBookmark,
		headers: request.headers,
		url: new URL(request.url),
		rateLimiter: env.API_RATE_LIMITER,
		waitUntil,
	};
}
