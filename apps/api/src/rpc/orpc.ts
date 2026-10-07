/**
 * oRPC Base Setup
 * Core oRPC configuration with context, error handling, and middleware
 */

/// <reference path="../../worker-configuration.d.ts" />

import {
	D1ReadTimeoutError,
	isTransientD1ReadError,
	withTransientD1ReadRetry,
} from "@tedix/db/utils/d1-retry";
import { ORPCError, os } from "@orpc/server";
import { tracing } from "cloudflare:workers";
import {
	EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER,
	EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER,
} from "@tedix/api-contract/contracts/external-agent-identity";
import {
	decodeTokenUnsafe,
	isM2MToken,
	isUserToken,
	validateToken,
} from "@tedix/auth/jwt";
import { resolveLocalDemoUser } from "@tedix/auth/local-demo";
import {
	descopeServiceIdentity,
	descopeTenantIdentity,
	descopeUserIdentity,
} from "@tedix/auth/principal-identity";
import {
	hasPermission,
	isTenantGrantablePermission,
	type Permission,
	roleImpliesPermission,
} from "@tedix/auth/rbac";
import { extractTediRuntimeApiScopes } from "@tedix/auth/tedi-identity";
import {
	extractTediJwtClaims,
	getTenantId,
	getTenantRoles,
	isPlatformPrincipal,
	resolveTenantOverride,
} from "@tedix/auth/types";
import { extractTokenFromCookie } from "@tedix/auth/utils";
import {
	getApiKeyByHash,
	getApiKeyByPreviousHash,
	recordUsage,
} from "@tedix/db/queries/api-keys";
import { hashApiKey, matchesIpOrCidr } from "@tedix/db/schema/api-keys";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getOrganizationByDescopeId,
	getOrganizationByExternalIdentity,
	getOrganizationById,
	getPersonalOrganization,
} from "@tedix/db/queries/organizations";
import {
	resolvePrincipalIdentity,
	resolveUserTenantIdentityContext,
} from "@tedix/db/queries/principal-identities";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import {
	extractBearerToken,
	isServiceBinding,
} from "@tedix/worker-kit/request-auth";
import { requestCorrelation } from "./request-correlation";
import { safeErrorMetadata } from "../lib/safe-log-metadata";
import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
import { measureMiningPhase } from "../lib/mining-phase-timing";
import {
	assertFleetAuthorityAvailable,
	FleetAuthorityUnavailableError,
} from "../lib/fleet-authority";

// `BaseContext` + `createContext` moved to ./context so the kernel Durable
// Objects can build a request context without dragging this module's auth
// graph (jose, @descope/node-sdk, node-fetch) into their startup-evaluated
// import set. Re-exported so existing `from "../rpc/orpc"` sites are unaffected.
import {
	type BaseContext,
	createContext,
	requireCustodyInspectionScope,
} from "./context";

export type { BaseContext } from "./context";
export { createContext };

// =============================================================================
// CONTEXT
// =============================================================================

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Error codes for API responses.
 *
 * Every value MUST be a key of oRPC's `COMMON_ORPC_ERROR_DEFS`. oRPC resolves
 * the HTTP status as `status ?? COMMON_ORPC_ERROR_DEFS[code]?.status ?? 500`,
 * so a code outside that table silently becomes a 500 no matter what the
 * contract's `.errors()` map declares — and the declared/actual status
 * mismatch also makes `isDefinedError()` return false for it.
 *
 * Do not invent codes here. If a new one is needed, pick the matching oRPC
 * standard code (`METHOD_NOT_SUPPORTED`, `TIMEOUT`, `PRECONDITION_FAILED`,
 * `PAYLOAD_TOO_LARGE`, `NOT_IMPLEMENTED`, `GATEWAY_TIMEOUT`, …).
 */
export const ErrorCodes = {
	// Client errors (4xx)
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	UNPROCESSABLE_CONTENT: "UNPROCESSABLE_CONTENT",
	TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",

	// Server errors (5xx)
	INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
	BAD_GATEWAY: "BAD_GATEWAY",
	SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Which of the above are the caller's fault (4xx) rather than ours (5xx).
 *
 * Used only to pick a log level. This is a code set rather than a status
 * comparison because oRPC v2's `ORPCError` no longer carries a `status` field —
 * the HTTP status is resolved by the handler codec from the code, and neither
 * `COMMON_ORPC_ERROR_DEFS` nor `fallbackORPCErrorStatus` is exported any more.
 * Classifying by code needs no internals and is exact, since `ErrorCodes` is a
 * closed set.
 */
export const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
	ErrorCodes.BAD_REQUEST,
	ErrorCodes.UNAUTHORIZED,
	ErrorCodes.FORBIDDEN,
	ErrorCodes.NOT_FOUND,
	ErrorCodes.CONFLICT,
	ErrorCodes.UNPROCESSABLE_CONTENT,
	ErrorCodes.TOO_MANY_REQUESTS,
]);

/**
 * Create a typed oRPC error
 */
export function createError(
	code: ErrorCode,
	message: string,
	cause?: unknown,
): ORPCError<ErrorCode, undefined> {
	return new ORPCError(code, { message, cause });
}

export function isAuthInfrastructureError(
	error: unknown,
): error is ORPCError<"SERVICE_UNAVAILABLE", undefined> {
	return (
		error instanceof ORPCError && error.code === ErrorCodes.SERVICE_UNAVAILABLE
	);
}

// =============================================================================
// BASE PROCEDURES
// =============================================================================

/**
 * Base builder for this app's shared middlewares.
 *
 * Nothing is implemented from `base` — every live procedure comes from
 * `implement(contract)`, and contracts carry their own `.errors(baseErrors)`
 * from `@tedix/api-contract/errors`. `base` exists only so the middlewares
 * below share one typed `BaseContext`, so it deliberately declares no error map
 * of its own: a second, divergent map here reached no procedure and only
 * invited drift from the contract-side one.
 */
export const base = os.$context<BaseContext>();

/** Fail before a fleet-commercial handler can read provider secrets or tables. */
export const withFleetAuthority = base.middleware(async ({ context, next }) => {
	try {
		assertFleetAuthorityAvailable(context.env);
	} catch (error) {
		if (error instanceof FleetAuthorityUnavailableError) {
			throw createError(
				error.reason === "disabled"
					? ErrorCodes.NOT_FOUND
					: ErrorCodes.SERVICE_UNAVAILABLE,
				error.message,
			);
		}
		throw error;
	}
	return next({ context });
});

/**
 * Service binding authentication (Worker-to-Worker only).
 *
 * Used for internal endpoints that should NOT be publicly accessible:
 * - syncFromDescope (MCP service calls via binding)
 * - analytics tracking (MCP internal calls via binding)
 *
 * No token fallback — service binding is the only accepted path.
 * Callers must use wrangler service bindings (API_SERVICE) to reach these endpoints.
 */
export const withServiceAuth = base.middleware(async ({ context, next }) => {
	if (isServiceBinding(context.headers)) {
		context.authType = "service-binding";
		return next({ context });
	}

	// No token fallback — service binding is the only accepted path
	throw createError(
		ErrorCodes.UNAUTHORIZED,
		"Service binding required. Direct HTTP with service tokens is no longer supported. Ensure API_SERVICE binding is configured in wrangler.jsonc.",
	);
});

/**
 * Tedi authentication middleware (V2).
 *
 * Validates Descope JWT from tedi containers and extracts identity:
 * - tediId: from top-level JWT claim
 * - descopeUserId: from JWT template ({{user.userId}})
 * - entityType: "tedi"
 *
 * Also accepts service binding passthrough from apps/tedi Worker.
 *
 * Used by: mcpCredentials.resolve, connections (tedi endpoints)
 */
export const withTediAuth = base.middleware(async ({ context, next }) => {
	// Service Binding detection
	if (isServiceBinding(context.headers)) {
		context.authType = "service-binding";
		return next({ context });
	}

	const authHeader =
		context.headers.get("Authorization") ??
		context.headers.get("authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Missing Authorization header");
	}

	const token = authHeader.slice("Bearer ".length);
	if (!token.startsWith("eyJ")) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Invalid token format — expected JWT",
		);
	}

	try {
		const payload = await validateToken(token, {
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
			allowTediJwt: true,
		});

		const { claims: tediClaims, error: tediClaimError } =
			extractTediJwtClaims(payload);
		if (!tediClaims) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				tediClaimError ?? "Not a tedi JWT — missing first-class tedi claims",
			);
		}

		context.authType = "tedi";
		context.tediId = tediClaims.tediId;
		context.descopeUserId = tediClaims.descopeUserId;
		context.tediScopes = extractTediRuntimeApiScopes(payload);

		const tenantId = getTenantId(payload);
		if (tenantId && !context.organizationId) {
			try {
				const org = await resolveOrganizationForIdentityToken(
					context,
					payload,
					tenantId,
				);
				if (org) {
					context.organizationId = org.id;
				}
			} catch (error) {
				console.warn(
					"[Auth] Tedi JWT middleware: failed to resolve org from tenant claim:",
					error,
				);
			}
		}

		// Cross-tedi guard
		const tediIdHeader =
			context.headers.get("X-Tedix-Tedi-Id") ??
			context.headers.get("x-tedix-tedi-id");
		if (tediIdHeader && tediIdHeader !== tediClaims.tediId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"X-Tedix-Tedi-Id header does not match JWT tediId claim",
			);
		}

		return next({ context });
	} catch (error) {
		if (error instanceof ORPCError) throw error;
		const message =
			error instanceof Error ? error.message : "Token validation failed";
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			`Tedi JWT validation failed: ${message}`,
		);
	}
});

export const FORWARDED_AUTH_HEADER = "X-Forwarded-Authorization";
const MCP_EDGE_USER_CALLER_TYPE = "mcp-edge-user";
const MCP_EDGE_CALLER_SCOPES_HEADER = "X-Tedix-Mcp-Caller-Scopes";

async function resolveOrganizationForIdentityToken(
	context: BaseContext,
	payload: { iss: string },
	tenantId: string,
) {
	return (
		(await authRead(context, () =>
			getOrganizationByExternalIdentity(
				context.db,
				descopeTenantIdentity(payload, tenantId),
			),
		)) ??
		(await authRead(context, () =>
			getOrganizationByDescopeId(context.db, tenantId),
		))
	);
}

async function resolveCanonicalUserId(
	context: BaseContext,
	payload: { iss: string; sub?: string },
): Promise<string | undefined> {
	if (!payload.sub) return undefined;
	const mapping = await authRead(context, () =>
		resolvePrincipalIdentity(context.db, descopeUserIdentity(payload), {
			principalType: "user",
		}),
	);
	return mapping?.principalId;
}

function getServiceBindingOrganizationHeader(headers: Headers): string | null {
	return headers.get("X-Tedix-Org-Id") ?? headers.get("x-tedix-org-id");
}

function isDescopeTenantId(value: string): boolean {
	return /^(org_|personal_|T\d)/.test(value);
}

function isForwardedMcpUserCall(headers: Headers): boolean {
	const callerType =
		headers.get("X-Tedix-Caller-Type") ?? headers.get("x-tedix-caller-type");
	return callerType === MCP_EDGE_USER_CALLER_TYPE;
}

const EXTERNAL_AGENT_SESSION_EXCHANGE_PATHS = new Set([
	"/rpc/externalAgentIdentity/openSession",
	"/rpc/externalAgentIdentity/issueMcpCredential",
]);

const EXTERNAL_AGENT_WORKLOAD_EXCHANGE_PATHS = new Set([
	"/rpc/externalAgentIdentity/authorizeWorkloadSession",
	"/rpc/externalAgentIdentity/issueMcpCredential",
]);

export function isExternalAgentSessionExchangeCall(
	headers: Headers,
	url: URL,
): boolean {
	return (
		headers.get("X-Tedix-Caller-Type") ===
			EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER &&
		EXTERNAL_AGENT_SESSION_EXCHANGE_PATHS.has(url.pathname)
	);
}

export function isExternalAgentWorkloadExchangeCall(
	headers: Headers,
	url: URL,
): boolean {
	return (
		headers.get("X-Tedix-Caller-Type") ===
			EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER &&
		EXTERNAL_AGENT_WORKLOAD_EXCHANGE_PATHS.has(url.pathname)
	);
}

async function resolveServiceBindingOrganizationId(
	context: BaseContext,
): Promise<string | undefined> {
	const serviceOrgId = getServiceBindingOrganizationHeader(context.headers);
	if (!serviceOrgId) return undefined;

	try {
		const org = isDescopeTenantId(serviceOrgId)
			? await authRead(context, () =>
					getOrganizationByDescopeId(context.db, serviceOrgId),
				)
			: await authRead(context, () =>
					getOrganizationById(context.db, serviceOrgId),
				);
		return org?.id ?? serviceOrgId;
	} catch (err) {
		console.warn(
			"[withAuth] Service-binding org lookup failed, using header value verbatim:",
			err instanceof Error ? err.message : err,
		);
		return serviceOrgId;
	}
}

async function resolveForwardedMcpUserOrganization(
	context: BaseContext,
): Promise<{ id: string; descopeTenantId: string | null } | null> {
	const serviceOrgId = getServiceBindingOrganizationHeader(context.headers);
	if (!serviceOrgId) return null;

	const org = isDescopeTenantId(serviceOrgId)
		? await authRead(context, () =>
				getOrganizationByDescopeId(context.db, serviceOrgId),
			)
		: await authRead(context, () =>
				getOrganizationById(context.db, serviceOrgId),
			);
	if (!org) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Forwarded MCP user organization not found",
		);
	}

	return {
		id: org.id,
		descopeTenantId: org.descopeTenantId ?? null,
	};
}

async function authenticateForwardedMcpUserJwt(
	context: BaseContext,
): Promise<void> {
	const token = extractBearerToken(
		context.headers.get(FORWARDED_AUTH_HEADER) ??
			context.headers.get(FORWARDED_AUTH_HEADER.toLowerCase()),
	);
	if (!token) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Missing forwarded MCP user token",
		);
	}

	// Forwarded calls arrive only over the service-binding InternalEntrypoint
	// (public ingress strips the marker) from the MCP edge, which has ALREADY
	// cryptographically validated this token (signature, audience, issuer,
	// expiry) before forwarding. Re-validating it
	// via Descope validateSession here added a per-forwarded-call round-trip whose
	// transient failures poisoned whole Code Mode executions as 401s on the
	// forwarded path (tedis/memory). Trust the edge's validation — decode the
	// token for its claims, with local safety checks (decodable, not expired,
	// user token / not a tedi). This matches the trust model of plain
	// service-binding tool calls, which re-validate nothing.
	// Local MCP validates the demo credential at loopback ingress. Its binding
	// uses an internal URL, so retain the explicit local-runner flag here.
	const payload =
		resolveLocalDemoUser({
			environment: context.env.ENVIRONMENT,
			projectId: context.env.DESCOPE_PROJECT_ID,
			token,
			url: context.url,
			enabled:
				(context.env as CloudflareEnv & { TEDIX_LOCAL_DEMO_ENABLED?: string })
					.TEDIX_LOCAL_DEMO_ENABLED === "true",
		}) ?? decodeTokenUnsafe(token);
	if (!payload) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Forwarded MCP user token is not decodable",
		);
	}
	if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Forwarded MCP user token is expired",
		);
	}
	if (!isUserToken(payload)) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Forwarded MCP user token is not a user token",
		);
	}
	context.user = payload;
	// This header is produced only by the MCP Worker after it validates the
	// user's OAuth grant, and arrives over a trusted service binding. Preserve
	// the normal user principal while augmenting its capability scopes; do not
	// place these scopes in tediScopes, which would misattribute the action to a
	// worker. This lets a human platform operator use explicit cross-tenant
	// control-plane tools through Code Mode.
	const edgeScopes = (context.headers.get(MCP_EDGE_CALLER_SCOPES_HEADER) ?? "")
		.split(/\s+/)
		.filter(Boolean);
	if (edgeScopes.length > 0) {
		const tokenScopes = Array.isArray(context.user.scopes)
			? context.user.scopes.filter(
					(scope): scope is string => typeof scope === "string",
				)
			: [];
		context.user.scopes = [...new Set([...tokenScopes, ...edgeScopes])];
	}
	context.authType = "user";
	context.userId = await authRead(context, () =>
		measureMiningPhase(context, "auth.user", () =>
			resolveCanonicalUserId(context, payload),
		),
	);

	const targetOrg = await authRead(context, () =>
		measureMiningPhase(context, "auth.organization", () =>
			resolveForwardedMcpUserOrganization(context),
		),
	);
	if (!targetOrg) return;
	if (!context.user.sub) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Forwarded MCP user token is missing a subject",
		);
	}

	const userSubject = context.user.sub;
	const member = await authRead(context, () =>
		measureMiningPhase(context, "auth.membership", () =>
			getMemberByUserId(context.db, targetOrg.id, userSubject),
		),
	);
	const forwardedContext = resolveForwardedMcpUserTenantContext({
		targetOrg,
		memberRole: member?.role,
	});
	if (!forwardedContext) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Forwarded MCP user does not belong to this organization",
		);
	}

	context.organizationId = forwardedContext.organizationId;
	if (forwardedContext.userRole) {
		context.userRole = forwardedContext.userRole;
	}
	if (forwardedContext.activeTenantId) {
		context.user.dct = forwardedContext.activeTenantId;
	}
}

/**
 * Resolve the forwarded MCP user's role/tenant context for the target org.
 *
 * Membership is decided entirely by `memberRole` (a live D1 lookup the caller
 * already performed via `getMemberByUserId`) — Tedix JWTs only carry the
 * current tenant's claims, so the forwarded token cannot itself confirm
 * membership in a different target org.
 */
export function resolveForwardedMcpUserTenantContext({
	targetOrg,
	memberRole,
}: {
	targetOrg: { id: string; descopeTenantId: string | null };
	memberRole?: string;
}): {
	organizationId: string;
	userRole?: string;
	activeTenantId?: string;
} | null {
	if (!memberRole) return null;

	return {
		organizationId: targetOrg.id,
		userRole: memberRole,
		activeTenantId: targetOrg.descopeTenantId ?? undefined,
	};
}

/**
 * Authentication middleware with dedupe pattern
 *
 * This middleware implements the oRPC dedupe pattern:
 * - If auth context is already populated (user, serviceAccount, or apiKey), skip validation
 * - If not authenticated, try all auth strategies in order
 * - On success, populates context fields; on failure, throws UNAUTHORIZED
 *
 * Supports 3 authentication strategies (tried in order):
 * 1. User JWT (Tedix OS and other human-facing surfaces)
 * 2. M2M JWT (service accounts via client_credentials)
 * 3. API Key (testing, automation)
 *
 * Note: scope enforcement is applied per-procedure via createScopeMiddleware().
 *
 * Usage in routers:
 * ```typescript
 * import { withAuth } from "../orpc";
 * const os = implement(contract).$context<BaseContext>();
 * export const router = os.router({
 *   myProcedure: os.myProcedure
 *     .use(withAuth)
 *     .handler(async ({ context }) => { ... })
 * });
 * ```
 *
 * Both handlers authenticate here and only here: `/rpc/*` and `/v1/*` each build
 * a bare context via `createContext()` and run this middleware in the chain.
 * There is no Hono-level pre-authentication step for the REST surface — an
 * earlier `authenticateRequest()` helper described that design but was never
 * wired up, so it has been deleted. The early-return checks below are therefore
 * about service-binding transport and forwarded identities, not about deduping
 * against a prior pass.
 */
const authScope = new WeakMap<
	BaseContext,
	import("./context").CustodyInspectionScope
>();
function authRead<T>(
	context: BaseContext,
	read: () => PromiseLike<T>,
): Promise<T> {
	const scope = authScope.get(context);
	return scope ? scope.checked(read) : Promise.resolve(read());
}
export const withAuth = base.middleware(async (options, rawInput) => {
	const originalContext = options.context;
	const selected =
		options.path.join(".") === "tedis.operateRuntimeCutover" &&
		(
			options.procedure["~orpc"].meta["~openapi"] as
				| { path?: string }
				| undefined
		)?.path === "/{routeTediId}/runtime-cutover/operate" &&
		typeof rawInput === "object" &&
		rawInput !== null &&
		"command" in rawInput &&
		rawInput.command === "inspect_custody_coverage";
	// The cap belongs to this invocation. A reused router context must not
	// inherit it, and late selected auth continuations must keep their own cap.
	const context = selected ? { ...originalContext } : originalContext;
	const scope = selected ? requireCustodyInspectionScope(context) : null;
	if (scope) authScope.set(context, scope);
	const checked = <T>(read: () => PromiseLike<T>) =>
		scope ? scope.checked(read) : Promise.resolve(read());
	const next: typeof options.next = (...args) => {
		scope?.guard();
		return scope
			? scope.checked(() => Promise.resolve(options.next(...args)))
			: options.next(...args);
	};

	// Service binding detection: trusted Worker-to-Worker transport. When the
	// MCP edge forwards a human caller token, authenticate and authorize as that
	// user instead of treating the transport as the principal.
	if (isServiceBinding(context.headers)) {
		const callerType = context.headers.get("X-Tedix-Caller-Type");
		if (callerType === EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER) {
			if (!isExternalAgentWorkloadExchangeCall(context.headers, context.url)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"External-agent workload exchange is not valid for this procedure",
				);
			}
			context.authType = "service-binding";
			// The signed workload assertion is the tenant authority. The targeted
			// router resolves its canonical principal before establishing org scope;
			// never trust X-Tedix-Org-Id on this public bootstrap path.
			context.organizationId = undefined;
			return next({ context });
		}
		if (callerType === EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER) {
			if (!isExternalAgentSessionExchangeCall(context.headers, context.url)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"External-agent session exchange is not valid for this procedure",
				);
			}
			try {
				await checked(() => authenticateApiKey(context));
			} catch (error) {
				scope?.guard();
				if (
					error instanceof D1ReadTimeoutError ||
					isTransientD1ReadError(error)
				)
					throw createError(
						ErrorCodes.SERVICE_UNAVAILABLE,
						"Session database unavailable; retry shortly",
					);
				if (error instanceof ORPCError) throw error;
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"External-agent session exchange authentication failed",
				);
			}
			return next({ context });
		}
		if (isForwardedMcpUserCall(context.headers)) {
			try {
				await checked(() =>
					measureMiningPhase(context, "auth.forwarded", () =>
						authenticateForwardedMcpUserJwt(context),
					),
				);
			} catch (error) {
				scope?.guard();
				if (error instanceof ORPCError) throw error;
				// Token/permission failures above are explicit ORPCErrors. An
				// unexpected identity lookup failure is not an invalid credential:
				// preserve the cause without exposing SQL or triggering login loops.
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Forwarded MCP identity resolution is temporarily unavailable",
					error,
				);
			}
			return next({ context });
		}

		context.authType = "service-binding";
		if (!context.organizationId) {
			context.organizationId = await checked(() =>
				resolveServiceBindingOrganizationId(context),
			);
		}
		// Acting user (kernel direct reads): a forwarded user-id claim from
		// the trusted service-binding caller (apps/mcp home tools), so downstream
		// can resolve the user's own provider connection. NOT an auth grant —
		// service-binding scopes still apply; this only carries the identity.
		if (!context.descopeUserId) {
			const actingUser =
				context.headers.get("X-Tedix-Acting-User") ??
				context.headers.get("x-tedix-acting-user");
			if (actingUser) context.descopeUserId = actingUser;
		}
		// Tedi principal: the MCP edge forwards the calling tedi's id and the
		// capability scopes it resolved from D1 `tedis.mcp_capability_profile`.
		// This IS an authority grant — `isPlatformPrincipal()` honors `platform:admin`
		// in `tediScopes`, which is how a `platform_admin` tedi (e.g. the CTO)
		// exercises cross-org platform operations. It cannot be re-derived from the
		// tedi's JWT (tedi tokens carry no roles), and it cannot be spoofed from
		// outside: these headers are only readable on the trusted Worker-to-Worker
		// binding. Deliberately does NOT populate `context.user` — a tedi is not a
		// human principal, so `user.sub`-keyed paths (e.g. createOrganization's
		// creator branch, listOrganizations' `authType === "user"` gate) stay
		// closed to tedis and must name an explicit owner instead.
		if (!context.tediId) {
			const tediIdHeader =
				context.headers.get("X-Tedix-Tedi-Id") ??
				context.headers.get("x-tedix-tedi-id");
			if (tediIdHeader) context.tediId = tediIdHeader;
		}
		// Operator provenance forwarded by the MCP gateway (95dff537): the
		// Descope user id of the HUMAN whose OAuth session made the gateway
		// call. Only readable on the trusted binding; never populates
		// context.user (same doctrine as the tedi headers — provenance, not
		// authority).
		if (!context.gatewayEndUserId) {
			const endUser =
				context.headers.get("X-Tedix-End-User-Id") ??
				context.headers.get("x-tedix-end-user-id");
			if (endUser && /^[A-Za-z0-9_-]{4,128}$/.test(endUser)) {
				context.gatewayEndUserId = endUser;
			}
		}
		if (!context.tediScopes) {
			const tediScopesHeader =
				context.headers.get("X-Tedix-Tedi-Scopes") ??
				context.headers.get("x-tedix-tedi-scopes");
			if (tediScopesHeader) {
				context.tediScopes = tediScopesHeader.split(/\s+/).filter(Boolean);
			}
		}
		if (
			context.headers.get("X-Tedix-Caller-Type") === "mcp-edge-external-agent"
		) {
			const principalId = context.headers.get(
				"X-Tedix-External-Agent-Principal-Id",
			);
			const sessionId = context.headers.get(
				"X-Tedix-External-Agent-Session-Id",
			);
			const clientRecordId = context.headers.get(
				"X-Tedix-External-Agent-Client-Record-Id",
			);
			const uuid =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			if (
				!principalId ||
				!sessionId ||
				!clientRecordId ||
				!uuid.test(principalId) ||
				!uuid.test(sessionId) ||
				clientRecordId.length > 300 ||
				!/^[A-Za-z0-9._:-]+$/.test(clientRecordId)
			) {
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"Malformed external-agent service-binding identity",
				);
			}
			context.externalAgentPrincipalId = principalId;
			context.externalAgentSessionId = sessionId;
			context.externalAgentClientRecordId = clientRecordId;
		}
		context.serviceBindingAuthorization = resolveMcpServiceBindingAuthorization(
			context.headers,
			context,
		);
		return next({ context });
	}

	// DEDUPE PATTERN: Skip authentication if already done
	// This allows auth to run either at Hono level (REST) or in middleware (RPC)
	const alreadyAuthenticated =
		context.user !== undefined ||
		context.serviceAccount !== undefined ||
		context.apiKey !== undefined;

	if (!alreadyAuthenticated) {
		// Strategy 1: Try User JWT authentication
		try {
			await checked(() => authenticateUserJwt(context));
		} catch (userJwtError) {
			scope?.guard();
			if (isAuthInfrastructureError(userJwtError)) throw userJwtError;
			// Strategy 2: Try M2M JWT authentication
			try {
				await checked(() => authenticateM2MJwt(context));
			} catch (m2mJwtError) {
				scope?.guard();
				// Strategy 3: Try Tedi V2 JWT authentication
				try {
					await checked(() => authenticateTediJwt(context));
				} catch (tediJwtError) {
					scope?.guard();
					// Strategy 4: Try API Key authentication
					try {
						await checked(() => authenticateApiKey(context));
					} catch (apiKeyError) {
						scope?.guard();
						// All strategies failed
						const details = {
							userJwt:
								userJwtError instanceof Error
									? userJwtError.message
									: "Invalid user JWT",
							m2mJwt:
								m2mJwtError instanceof Error
									? m2mJwtError.message
									: "Invalid M2M JWT",
							tediJwt:
								tediJwtError instanceof Error
									? tediJwtError.message
									: "Invalid tedi JWT",
							apiKey:
								apiKeyError instanceof Error
									? apiKeyError.message
									: "Invalid API key",
						};
						console.warn(
							"[Auth] All auth strategies failed:",
							JSON.stringify(details),
						);
						throw createError(
							ErrorCodes.UNAUTHORIZED,
							"Authentication failed: No valid credentials provided",
							details,
						);
					}
				}
			}
		}
	}

	// Note: scope enforcement is handled via createScopeMiddleware(requiredScope)
	// on a per-procedure basis (see comment below).

	return next({ context });
});

export function resolveMcpServiceBindingAuthorization(
	headers: Headers,
	context: Pick<
		BaseContext,
		"externalAgentPrincipalId" | "tediId" | "tediScopes"
	>,
): BaseContext["serviceBindingAuthorization"] {
	const toolId = headers.get("X-Tedix-Mcp-Tool-Id");
	if (!toolId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(toolId)) {
		return undefined;
	}
	// apps/mcp has already authenticated the Worker-to-Worker transport and
	// resolved the declared tool before stamping this header. A skill-runtime
	// bridge carries the tedi identity but deliberately does not carry a
	// bearer-token-derived scope list; requiring that optional list here made
	// every declared MCP tool fail at the API hop. The identity is still required
	// so a bare service binding cannot turn an arbitrary header into authority.
	const hasTediAuthority = Boolean(context.tediId);
	if (!hasTediAuthority && !context.externalAgentPrincipalId) return undefined;
	return { source: "mcp-tool", toolId };
}

/**
 * Scope guard middleware (per-procedure).
 *
 * oRPC's "meta.requiredScope" wiring is currently unreliable with our implementer
 * types (see Known Issues: middleware type inference). Use explicit middleware
 * until we can migrate to per-procedure meta cleanly.
 */
export function createScopeMiddleware(requiredScope: string) {
	return base.middleware(async ({ context, next }) => {
		assertMachineScope(context, requiredScope);
		return next({ context });
	});
}

export function hasRequiredScope(
	context: Pick<
		BaseContext,
		| "apiKey"
		| "authType"
		| "serviceAccount"
		| "serviceBindingAuthorization"
		| "tediScopes"
	>,
	requiredScope: string,
): boolean {
	if (context.authType === "service-binding") {
		// A Cloudflare service binding authenticates the transport, not the
		// procedure. The trusted upstream must explicitly delegate the machine
		// capability in X-Tedix-Tedi-Scopes; external ingress cannot forge that
		// header because worker-kit strips internal trust markers before proxying.
		return (
			context.serviceBindingAuthorization?.source === "mcp-tool" ||
			hasScope(context.tediScopes ?? [], requiredScope)
		);
	}

	if (context.authType === "user") {
		return true;
	}

	if (context.authType === "apikey") {
		const scopes = context.apiKey?.scopes ?? [];
		return hasScope(scopes, requiredScope);
	}

	if (context.authType === "m2m") {
		const scopes =
			context.serviceAccount?.scope?.split(/\s+/).filter(Boolean) ?? [];
		return hasScope(scopes, requiredScope);
	}

	if (context.authType === "tedi") {
		// Direct tedi JWTs are intentionally exact-scope only. Platform-wide
		// authority belongs behind Descope AIH/FGA assignments at the MCP edge,
		// which reaches API through trusted service bindings.
		return context.tediScopes?.includes(requiredScope) === true;
	}

	return false;
}

/**
 * Raw provider credentials stay behind a narrower boundary than ordinary
 * service-binding RPC. Platform principals may resolve them directly. A
 * connected tool may resolve one only when the trusted MCP edge forwards all
 * three parts of the grant: one bounded tool execution, a verified actor, and
 * the connected-app read scope established at the MCP edge.
 */
export function hasConnectionCredentialResolutionAuthority(
	context: Pick<
		BaseContext,
		| "apiKey"
		| "authType"
		| "externalAgentPrincipalId"
		| "gatewayEndUserId"
		| "headers"
		| "serviceAccount"
		| "tediId"
		| "tediScopes"
		| "user"
	>,
): boolean {
	if (isPlatformPrincipal(context)) return true;
	if (context.authType !== "service-binding") return false;

	const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
	if (!toolId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(toolId)) {
		return false;
	}
	const hasVerifiedActor = Boolean(
		context.tediId ||
		context.externalAgentPrincipalId ||
		context.gatewayEndUserId,
	);
	return (
		hasVerifiedActor && hasScope(context.tediScopes ?? [], "connections.read")
	);
}

export const withConnectionCredentialResolutionAuthority = base.middleware(
	async ({ context, next }) => {
		if (!hasConnectionCredentialResolutionAuthority(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Connection credential resolution requires platform authority or a verified MCP tool actor with 'connections.read' or 'connections.execute'",
			);
		}
		return next({ context });
	},
);

/**
 * Permission guard middleware (per-procedure).
 *
 * Checks that the authenticated user has the required Descope permission(s).
 * Service bindings, M2M tokens, API keys, and tedi JWTs bypass user RBAC checks.
 * API keys, M2M tokens, and direct tedi JWTs still rely on per-procedure scope
 * middleware where the route declares one.
 *
 * @example
 * ```typescript
 * export const router = os.router({
 *   create: os.create
 *     .use(withAuth)
 *     .use(withPermission("apps:create"))
 *     .handler(async ({ context }) => { ... })
 * });
 * ```
 */
export function withPermission(...permissions: Permission[]) {
	return base.middleware(async ({ context, next }) => {
		// Service bindings, M2M, API keys, and tedi JWTs use scope guards
		// instead of Descope user RBAC permission checks.
		if (
			context.authType === "service-binding" ||
			context.authType === "m2m" ||
			context.authType === "apikey" ||
			context.authType === "tedi"
		) {
			return next({ context });
		}

		assertUserPermissions(context, permissions);
		return next({ context });
	});
}

/**
 * Composite two-plane guard for the common case where one procedure declares
 * both its human RBAC permission and its machine capability scope.
 *
 * This is semantically identical to chaining `withPermission` followed by
 * `createScopeMiddleware`, but allocates one middleware closure instead of two
 * for every procedure in the Worker graph. Principal-shaped handlers can still
 * use the individual guards or verified handler-body authorization.
 *
 * A non-empty array requires EVERY listed permission; `{ anyOf: [...] }`
 * accepts ANY one of them — the shape least-privilege verbs use to keep a
 * broader administrative permission sufficient during role migrations.
 *
 * A role-free or resource-identity-bound human path must use the explicit
 * `{ handlerOwnedUserAuthorization: "..." }` shape. The rationale makes the
 * opt-out reviewable at the call site while the handler owns the subject,
 * resource, or role check. `null` and empty permission sets are deliberately
 * not part of the type: neither may silently turn the human branch into a
 * vacuous pass.
 */
type NonEmptyPermissions = readonly [Permission, ...Permission[]];

type UserAuthorization =
	| Permission
	| NonEmptyPermissions
	| { readonly anyOf: NonEmptyPermissions }
	| { readonly handlerOwnedUserAuthorization: string };

export function withAuthorization(
	userAuthorization: UserAuthorization,
	requiredScope: string,
) {
	let allOf: readonly Permission[] = [];
	let anyOf: readonly Permission[] | null = null;
	let handlerOwnedUserAuthorization = false;
	if (typeof userAuthorization === "string") {
		allOf = [userAuthorization];
	} else if ("handlerOwnedUserAuthorization" in userAuthorization) {
		const rationale = userAuthorization.handlerOwnedUserAuthorization.trim();
		if (rationale.length < 12) {
			throw new Error(
				"Handler-owned user authorization requires a specific rationale",
			);
		}
		handlerOwnedUserAuthorization = true;
	} else if ("anyOf" in userAuthorization) {
		if (userAuthorization.anyOf.length === 0) {
			throw new Error("withAuthorization requires a non-empty anyOf set");
		}
		anyOf = userAuthorization.anyOf;
	} else {
		if (userAuthorization.length === 0) {
			throw new Error("withAuthorization requires a non-empty permission set");
		}
		allOf = userAuthorization;
	}
	return base.middleware(async ({ context, next }) => {
		if (context.authType === "user") {
			if (handlerOwnedUserAuthorization) {
				return next({ context });
			}
			if (anyOf) {
				assertUserAnyPermission(context, anyOf);
			} else {
				assertUserPermissions(context, allOf);
			}
		} else {
			assertMachineScope(context, requiredScope);
		}
		return next({ context });
	});
}

/** The same authority as AUTHZ.tedisRead, for optional links into Home execution reads. */
export function hasTedisReadAuthorization(context: BaseContext): boolean {
	try {
		if (context.authType === "user")
			assertUserPermissions(context, ["tedis:read"]);
		else assertMachineScope(context, "tedis:read");
		return true;
	} catch {
		return false;
	}
}

/** Optional document context uses the same authority as AUTHZ.osRead. */
export function hasOsReadAuthorization(context: BaseContext): boolean {
	try {
		if (context.authType === "user")
			assertUserAnyPermission(context, ["os:read", "settings:manage"]);
		else assertMachineScope(context, "apps:read");
		return true;
	} catch {
		return false;
	}
}

function withPlatformAdminAuthorization() {
	return base.middleware(async ({ context, next }) => {
		if (context.authType === "user") {
			if (isPlatformPrincipal(context)) {
				return next({ context });
			}
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Insufficient permissions. Required: platform:admin",
			);
		}
		assertMachineScope(context, "platform:admin");
		return next({ context });
	});
}

/**
 * Exact API-key boundary for an irreversible machine workflow. Unlike ordinary
 * scope middleware, this deliberately rejects users, service bindings, M2M,
 * tedi identities, wildcard keys, and platform-admin keys.
 */
export function withExactApiKeyScope(requiredScope: string) {
	return base.middleware(async ({ context, next }) => {
		if (
			context.authType !== "apikey" ||
			!context.apiKey?.id ||
			!context.apiKey.scopes?.includes(requiredScope) ||
			context.apiKey.scopes.includes("*") ||
			context.apiKey.scopes.includes("platform:admin")
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`Exact API-key scope required: ${requiredScope}`,
			);
		}
		return next({ context });
	});
}

/**
 * Interned common authorization pairs. Besides making call sites legible, this
 * keeps hundreds of repeated permission/scope string literals and middleware
 * allocations out of the Worker bundle.
 */
export const AUTHZ = {
	adaptersWrite: withAuthorization("integrations:manage", "adapters:write"),
	analyticsRead: withAuthorization("analytics:read", "analytics:read"),
	apiKeysAdmin: withAuthorization("api_keys:manage", "platform:admin"),
	appsCreate: withAuthorization("apps:create", "apps:write"),
	appsRead: withAuthorization("apps:read", "apps:read"),
	appsWrite: withAuthorization("apps:update", "apps:write"),
	billingRead: withAuthorization("billing:read", "billing:read"),
	catalogWrite: withAuthorization("apps:update", "catalog:manage"),
	delegationGovern: withAuthorization(
		"settings:manage",
		"earned-delegation:govern",
	),
	integrationAppsWrite: withAuthorization("integrations:manage", "apps:write"),
	memoryRead: withAuthorization("tedis:read", "mcp:memory.read"),
	memoryWrite: withAuthorization("tedis:update", "mcp:memory.write"),
	messagingRead: withAuthorization("tedis:read", "mcp:messaging.read"),
	objectiveRead: withAuthorization("tedis:read", "mcp:memory.read"),
	objectiveWrite: withAuthorization("tedis:update", "mcp:memory.write"),
	// Tedix OS verb taxonomy (least privilege). Every guard accepts EITHER the
	// specific os:* permission OR settings:manage, so settings administrators
	// keep working before Descope roles carry the os:* grants. Machine scopes
	// stay on the surfaces' existing planes: apps:read/apps:write — except
	// osApprove, which rides the approval domain's mcp:memory.admin because the
	// rules sweep invokes tediApprovals.resolve per match and MUST carry exactly
	// the resolve guard.
	osAdmin: withAuthorization(
		{ anyOf: ["os:admin", "settings:manage"] },
		"apps:write",
	),
	osApprove: withAuthorization(
		{ anyOf: ["os:approve", "settings:manage"] },
		"mcp:memory.admin",
	),
	osAuthor: withAuthorization(
		{ anyOf: ["os:author", "settings:manage"] },
		"apps:write",
	),
	osPublish: withAuthorization(
		{ anyOf: ["os:publish", "settings:manage"] },
		"apps:write",
	),
	osRead: withAuthorization(
		{ anyOf: ["os:read", "settings:manage"] },
		"apps:read",
	),
	osRun: withAuthorization(
		{ anyOf: ["os:run", "settings:manage"] },
		"apps:write",
	),
	platformAdmin: withPlatformAdminAuthorization(),
	secretsRead: withAuthorization("secrets:manage", "tools:read"),
	secretsWrite: withAuthorization("secrets:manage", "tools:write"),
	settingsRead: withAuthorization("settings:manage", "apps:read"),
	settingsWrite: withAuthorization("settings:manage", "apps:write"),
	tedisAppsRead: withAuthorization("tedis:read", "apps:read"),
	tedisAppsWrite: withAuthorization("tedis:update", "apps:write"),
	tedisRead: withAuthorization("tedis:read", "tedis:read"),
	tedisWrite: withAuthorization("tedis:update", "tedis:write"),
	toolsRead: withAuthorization("apps:read", "tools:read"),
	toolsWrite: withAuthorization("apps:update", "tools:write"),
} as const;

/**
 * The single predicate behind every user-plane authorization decision.
 *
 * Both assert helpers below and any read-only projection of the caller's
 * effective authority MUST go through this. When the projection re-derived the
 * rule itself it could disagree with the guard, and an operator surface that
 * says "you may" while the guard says "you may not" is worse than no surface.
 *
 * Check JWT tenant permissions first, then fall back to the D1 member role:
 * new users may not have tenant roles in their JWT yet (before session
 * refresh), but authenticateUserJwt resolves `userRole` from the D1 member
 * record. Under a cross-tenant override the token's `roles`/`permissions`
 * claims are scoped to a DIFFERENT tenant (`dct`), so they must not authorize
 * anything here — trust only the resolved-org membership role that
 * authenticateUserJwt set (and only ever sets when a real membership in the
 * resolved org exists).
 */
/**
 * Read a member's stored permission overrides, discarding anything a tenant
 * administrator was never allowed to grant.
 *
 * Filtering on READ as well as on write is deliberate: a row written before
 * this boundary existed, or edited by any path that bypasses the API, must not
 * become authority. `platform:admin` in this column has to be inert.
 */
function readMemberOverrides(member: unknown): readonly string[] {
	const raw = (member as { customPermissions?: unknown } | undefined)
		?.customPermissions;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is string =>
			typeof entry === "string" && isTenantGrantablePermission(entry),
	);
}

export function userHoldsPermission(
	context: Pick<
		BaseContext,
		| "user"
		| "userRole"
		| "crossTenantOverrideActive"
		| "userPermissionOverrides"
	>,
	permission: Permission,
): boolean {
	if (!context.user) return false;
	// A role change is effective on the next request even while the browser keeps
	// an older JWT. Keep Descope's custom-role permissions when there is no
	// conflicting built-in role in the token.
	const tokenRole = resolveTedixRbacRoleFromDescopeRoles(
		getTenantRoles(context.user),
	);
	const tokenRoleIsCurrent =
		!context.userRole || !tokenRole || tokenRole === context.userRole;
	if (
		!context.crossTenantOverrideActive &&
		tokenRoleIsCurrent &&
		hasPermission(context.user, permission)
	) {
		return true;
	}
	if (
		context.userRole &&
		roleImpliesPermission([context.userRole], permission)
	) {
		return true;
	}
	// Additive per-member grants. Bounded by `TENANT_GRANTABLE_PERMISSIONS` on
	// both write and read, so this can never be an escalation path to
	// `platform:admin`; `isPlatformPrincipal` is unaffected either way.
	return (
		isTenantGrantablePermission(permission) &&
		context.userPermissionOverrides?.includes(permission) === true
	);
}

/**
 * Authenticate a human recipient opening a governed OS Gadget/workspace share.
 *
 * Share secrets narrow presentation and runtime access; they never manufacture
 * tenant membership or bypass the canonical OS permission model. This helper is
 * deliberately user-JWT-only because the shared page executes widgets through
 * that recipient's own browser session. Public output revisions bypass this
 * boundary; source-derived revisions require it and recheck every recorded
 * tenant connection.
 */
export async function authorizeOsShareRecipient(
	request: Request,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		role: "viewer" | "use" | "build";
		accessEnvelope?: OsDerivedAccessEnvelope;
	},
): Promise<boolean> {
	const context = createContext(request, env);
	try {
		await authenticateUserJwt(context);
	} catch {
		return false;
	}
	if (
		context.authType !== "user" ||
		context.organizationId !== input.organizationId
	) {
		return false;
	}
	const permissions =
		input.role === "build"
			? (["os:author", "settings:manage"] as const)
			: (["os:read", "settings:manage"] as const);
	if (
		!permissions.some((permission) => userHoldsPermission(context, permission))
	)
		return false;
	// Gadget and workspace shares have no derived-output envelope. Their
	// existing recipient boundary is the authenticated tenant permission check
	// above. Output callers parse and require an envelope before reaching here.
	if (!input.accessEnvelope) return true;
	const { authorizeDerivedOutputSources } =
		await import("../services/os-derived-resource-access");
	return authorizeDerivedOutputSources(context, {
		organizationId: input.organizationId,
		accessEnvelope: input.accessEnvelope,
	});
}

/**
 * Revalidate source access for the existing authenticated output-export route.
 * That route historically required a user JWT plus organization membership,
 * but not an OS role; keep that contract distinct from governed share roles.
 */
export async function authorizeOsOutputExportRecipient(
	request: Request,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		accessEnvelope: OsDerivedAccessEnvelope;
	},
): Promise<boolean> {
	const context = createContext(request, env);
	try {
		await authenticateUserJwt(context);
	} catch {
		return false;
	}
	if (
		context.authType !== "user" ||
		context.organizationId !== input.organizationId
	) {
		return false;
	}
	const { authorizeDerivedOutputSources } =
		await import("../services/os-derived-resource-access");
	return authorizeDerivedOutputSources(context, input);
}

function assertUserPermissions(
	context: BaseContext,
	permissions: readonly Permission[],
): void {
	if (!context.user) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Authentication required");
	}

	const missing = permissions.filter(
		(permission) => !userHoldsPermission(context, permission),
	);
	if (missing.length > 0) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Insufficient permissions. Required: ${missing.join(", ")}`,
		);
	}
}

/**
 * ANY-of variant of {@link assertUserPermissions} for `{ anyOf }` guards. It
 * applies the same cross-tenant trust rule: under an override the token's
 * `roles`/`permissions` claims belong to a different tenant, so only the
 * resolved-org membership role may satisfy a permission.
 */
function assertUserAnyPermission(
	context: BaseContext,
	permissions: readonly Permission[],
): void {
	if (!context.user) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Authentication required");
	}

	const satisfied = permissions.some((permission) =>
		userHoldsPermission(context, permission),
	);
	if (!satisfied) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Insufficient permissions. Required one of: ${permissions.join(", ")}`,
		);
	}
}

function assertMachineScope(context: BaseContext, requiredScope: string): void {
	if (hasRequiredScope(context, requiredScope)) return;

	if (context.authType === "apikey" || context.authType === "m2m") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Scope '${requiredScope}' required`,
		);
	}
	if (context.authType === "tedi") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Direct tedi JWT scope '${requiredScope}' required`,
		);
	}
	if (context.authType === "service-binding") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Delegated service-binding scope '${requiredScope}' required`,
		);
	}
	throw createError(ErrorCodes.UNAUTHORIZED, "Authentication required");
}

const TEDIX_RBAC_ROLE_PRIORITY = ["owner", "admin"] as const;
const TEDIX_RBAC_FALLBACK_ROLE_PRIORITY = ["member", "viewer"] as const;
const DESCOPE_TENANT_ADMIN_ROLES = new Set(["Admin", "admin"]);

function resolveTedixRbacRoleFromDescopeRoles(
	roles: readonly string[],
): string | undefined {
	for (const preferredRole of TEDIX_RBAC_ROLE_PRIORITY) {
		if (roles.includes(preferredRole)) return preferredRole;
	}

	if (roles.some((role) => DESCOPE_TENANT_ADMIN_ROLES.has(role))) {
		return "admin";
	}

	for (const fallbackRole of TEDIX_RBAC_FALLBACK_ROLE_PRIORITY) {
		if (roles.includes(fallbackRole)) return fallbackRole;
	}

	return undefined;
}

/**
 * Strategy 1: User JWT Authentication
 * Validates Descope JWT (has user identity claims) and maps tenant ID to D1 organization ID.
 */
async function authenticateUserJwt(
	context: BaseContext,
	tokenOverride?: string,
): Promise<void> {
	const token =
		tokenOverride ||
		extractBearerToken(context.headers.get("Authorization")) ||
		extractTokenFromCookie(context.headers.get("Cookie"), "DS") ||
		extractTokenFromCookie(context.headers.get("Cookie"), "id_token");

	if (!token) {
		throw new Error("Missing authorization token");
	}

	const payload =
		resolveLocalDemoUser({
			environment: context.env.ENVIRONMENT,
			projectId: context.env.DESCOPE_PROJECT_ID,
			token,
			url: context.url,
			hostname: context.headers.get("Host")?.replace(/:\d+$/, ""),
			enabled:
				(context.env as CloudflareEnv & { TEDIX_LOCAL_DEMO_ENABLED?: string })
					.TEDIX_LOCAL_DEMO_ENABLED === "true",
		}) ??
		(await authRead(context, () =>
			validateToken(token, {
				projectId: context.env.DESCOPE_PROJECT_ID,
				baseUrl: context.env.DESCOPE_BASE_URL,
			}),
		));

	// Verify this is a user token (not M2M)
	if (!isUserToken(payload)) {
		throw new Error("Token is not a user token");
	}

	context.user = payload;
	context.authType = "user";

	// Read-only context enrichment: map Descope tenant claim -> D1 org/member context.
	// Provisioning side effects (user/org/member upserts) must happen in explicit
	// bootstrap flows like organizations.getMyOrganization, not in auth middleware.
	const requestedTenantId = context.headers.get("X-Tedix-Tenant-Id");
	const { tenantId, isCrossTenantOverride } = resolveTenantOverride(
		payload,
		requestedTenantId,
	);
	// A cross-tenant override addresses a tenant whose roles/permissions this
	// token does NOT carry. Record it so `assertUserPermissions` refuses to trust
	// the token's own claims here and authorizes only against the resolved-org
	// membership role (set below, and only when a real membership exists).
	context.crossTenantOverrideActive = isCrossTenantOverride;
	if (tenantId && payload.sub) {
		try {
			const identity = await authRead(context, () =>
				withTransientD1ReadRetry(
					"auth.user_tenant_context",
					() =>
						authRead(context, () =>
							resolveUserTenantIdentityContext(context.db, {
								organizationIdentity: descopeTenantIdentity(payload, tenantId),
								userIdentity: descopeUserIdentity(payload),
							}),
						),
					{ timeoutMs: 5_000 },
				),
			);
			context.userId = identity?.canonicalUserId ?? undefined;
			if (identity) {
				// Fail closed on a cross-tenant override to an org the caller is not
				// a member of: never grant org context off a bare tenant id (an
				// identifier, not a credential). Same-tenant resolution still grants
				// context and falls back to token roles below.
				if (isCrossTenantOverride && !identity.memberRole) {
					console.warn(
						`[Auth] Rejected cross-tenant override to org ${identity.organizationId}: user ${payload.sub} is not a member.`,
					);
				} else {
					context.organizationId = identity.organizationId;
					if (identity.memberRole) {
						context.userRole = identity.memberRole;
					}
					context.userPermissionOverrides = readMemberOverrides({
						customPermissions: identity.memberPermissionOverrides,
					});
				}
			}
		} catch (error) {
			console.error(
				"[Auth] Failed to resolve org context from tenant claim:",
				error,
			);
			// A transient identity-store failure must not silently downgrade a
			// tenant-selected user into an unscoped principal. That turns an
			// infrastructure fault into misleading FORBIDDEN responses across the
			// whole OS. Surface a retryable 503 and preserve the tenant boundary.
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Organization identity is temporarily unavailable",
				error,
			);
		}
	} else if (payload.sub) {
		context.userId = await authRead(context, () =>
			resolveCanonicalUserId(context, payload),
		);
		// No tenant claim (new user before Descope tenant assignment).
		// Fall back to D1 membership — use personal org if it exists.
		try {
			const personalOrg = await authRead(context, () =>
				getPersonalOrganization(context.db, payload.sub!),
			);
			if (personalOrg) {
				context.organizationId = personalOrg.id;
				const member = await authRead(context, () =>
					getMemberByUserId(context.db, personalOrg.id, payload.sub!),
				);
				if (member?.role) {
					context.userRole = member.role;
				}
				context.userPermissionOverrides = readMemberOverrides(member);
			}
		} catch (error) {
			console.warn(
				"[Auth] Failed to resolve org context from D1 membership:",
				error,
			);
		}
	}

	// Descope tenant-scoped roles apply ONLY to the token's own tenant (`dct`),
	// so never let them stand in for a role in a cross-tenant override target.
	if (!context.userRole && !isCrossTenantOverride) {
		const roles = getTenantRoles(payload);
		const userRole = resolveTedixRbacRoleFromDescopeRoles(roles);
		if (userRole) {
			context.userRole = userRole;
		}
	}
}

/**
 * Strategy 2: M2M JWT Authentication
 * Validates service account tokens (Descope access keys / client_credentials)
 */
async function authenticateM2MJwt(context: BaseContext): Promise<void> {
	const token = extractBearerToken(context.headers.get("Authorization"));

	if (!token) {
		throw new Error("Missing M2M token");
	}

	const payload = await authRead(context, () =>
		validateToken(token, {
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
		}),
	);

	// Verify this is an M2M token (not user)
	if (!isM2MToken(payload)) {
		throw new Error("Token is not an M2M token");
	}

	// Store service account info in context
	context.serviceAccount = {
		clientId: payload.client_id as string,
		scope: typeof payload.scope === "string" ? payload.scope : undefined,
	};
	context.authType = "m2m";

	// Extract organization (tenant) ID from Descope tenants claim. An M2M access
	// key is scoped to its own tenant (`dct`) and carries no other tenant's
	// claims, so an `X-Tedix-Tenant-Id` pointing elsewhere can never be
	// authorized — reject it rather than silently addressing a foreign org.
	const requestedTenantId = context.headers.get("X-Tedix-Tenant-Id");
	const { tenantId, isCrossTenantOverride } = resolveTenantOverride(
		payload,
		requestedTenantId,
	);
	if (isCrossTenantOverride) {
		console.error(
			`[Auth] M2M token for tenant ${getTenantId(payload) ?? "?"} attempted cross-tenant override to ${requestedTenantId}. Client: ${context.serviceAccount.clientId} - Request denied`,
		);
		throw new Error(
			"M2M token is not authorized for the requested tenant. Use a token scoped to that org.",
		);
	}

	// Require organization context in M2M tokens (org-scoped clients)
	if (!tenantId) {
		console.error(
			`[Auth] M2M token missing organization context. Client: ${context.serviceAccount.clientId} - Request denied`,
		);
		throw new Error(
			"M2M token missing organization context. Use an org-scoped M2M token with tenants claim.",
		);
	}

	// Resolve organization from D1 using Descope tenant ID
	const org = await authRead(context, () =>
		resolveOrganizationForIdentityToken(context, payload, tenantId),
	);

	if (!org) {
		console.error(
			`[Auth] M2M token references non-existent organization: ${tenantId}. Client: ${context.serviceAccount.clientId}`,
		);
		throw new Error(
			`Organization not found: ${tenantId}. Verify M2M token configuration.`,
		);
	}

	// Set organization context
	context.organizationId = org.id;
	const serviceMapping = await authRead(context, () =>
		resolvePrincipalIdentity(context.db, descopeServiceIdentity(payload), {
			principalType: "service",
			organizationId: org.id,
		}),
	);
	if (serviceMapping) {
		context.serviceAccount.canonicalPrincipalId = serviceMapping.principalId;
	}

	console.log(
		`[Auth] M2M authentication successful - Client: ${context.serviceAccount.clientId}, Organization: ${org.name} (${org.id})`,
	);
}

/**
 * Strategy 3: Tedi V2 JWT Authentication
 * Validates Descope JWT from tedi containers with first-class tedi claims
 * (tediId, descopeUserId, entityType: "tedi").
 *
 * This allows tedi containers to call any withAuth-protected endpoint
 * (e.g. memoryGraph, rationaleRecords) using their Descope access key JWT.
 */
async function authenticateTediJwt(context: BaseContext): Promise<void> {
	const token = extractBearerToken(context.headers.get("Authorization"));

	if (!token) {
		throw new Error("Missing tedi token");
	}

	const payload = await authRead(context, () =>
		validateToken(token, {
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
			allowTediJwt: true,
		}),
	);

	const { claims, error: claimError } = extractTediJwtClaims(payload);
	if (!claims) {
		throw new Error(claimError ?? "Not a tedi JWT");
	}

	context.authType = "tedi";
	context.tediId = claims.tediId;
	context.descopeUserId = claims.descopeUserId;
	context.tediScopes = extractTediRuntimeApiScopes(payload);

	// Cross-tedi guard: ensure X-Tedix-Tedi-Id header matches JWT claim
	const tediIdHeader =
		context.headers.get("X-Tedix-Tedi-Id") ??
		context.headers.get("x-tedix-tedi-id");
	if (tediIdHeader && tediIdHeader !== claims.tediId) {
		throw new Error("X-Tedix-Tedi-Id header does not match JWT tediId claim");
	}

	// Resolve organization from tenant claim
	const tenantId = getTenantId(payload);
	if (tenantId && !context.organizationId) {
		try {
			const org = await authRead(context, () =>
				resolveOrganizationForIdentityToken(context, payload, tenantId),
			);
			if (org) {
				context.organizationId = org.id;
			}
		} catch (error) {
			console.warn(
				"[Auth] Tedi JWT: failed to resolve org from tenant claim:",
				error,
			);
		}
	}
}

/**
 * Strategy 4: API Key Authentication
 * Validates API key from X-API-Key header
 */
async function authenticateApiKey(context: BaseContext): Promise<void> {
	let apiKeyHeader =
		context.headers.get("X-API-Key") || context.headers.get("x-api-key");

	// Allow API keys via Authorization: Bearer sk_...
	if (!apiKeyHeader) {
		const authHeader =
			context.headers.get("Authorization") ||
			context.headers.get("authorization");
		if (authHeader?.toLowerCase().startsWith("bearer ")) {
			const token = authHeader.slice("bearer ".length).trim();
			if (token.startsWith("sk_")) {
				apiKeyHeader = token;
			}
		}
	}

	if (!apiKeyHeader) {
		throw new Error("Missing API key");
	}

	// Hash the API key to look it up
	const keyHash = await authRead(context, () => hashApiKey(apiKeyHeader));
	let apiKey = await authRead(context, () =>
		withTransientD1ReadRetry(
			"auth.api_key",
			() => authRead(context, () => getApiKeyByHash(context.db, keyHash)),
			{ timeoutMs: 5_000 },
		),
	);

	// If primary hash doesn't match, check if this is a previous (rotated) key
	// within its grace period
	if (!apiKey) {
		apiKey = await authRead(context, () =>
			withTransientD1ReadRetry(
				"auth.previous_api_key",
				() =>
					authRead(context, () => getApiKeyByPreviousHash(context.db, keyHash)),
				{ timeoutMs: 5_000 },
			),
		);
	}

	if (!apiKey) {
		throw new Error("Invalid API key");
	}

	// Check status
	if (apiKey.status !== "active") {
		throw new Error(`API key is ${apiKey.status}`);
	}

	// Check expiration
	if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
		throw new Error("API key has expired");
	}

	// Check IP allowlist
	if (apiKey.ipAllowlist) {
		const allowedIps = Array.isArray(apiKey.ipAllowlist)
			? apiKey.ipAllowlist
			: (() => {
					try {
						return JSON.parse(
							apiKey.ipAllowlist as unknown as string,
						) as string[];
					} catch {
						return [];
					}
				})();

		if (allowedIps.length > 0) {
			const clientIp =
				context.headers.get("CF-Connecting-IP") ||
				context.headers.get("X-Forwarded-For");
			if (
				!clientIp ||
				!allowedIps.some((ip) => matchesIpOrCidr(clientIp, ip))
			) {
				throw createError(ErrorCodes.FORBIDDEN, "IP address not in allowlist");
			}
		}
	}

	// Store API key info in context
	context.apiKey = {
		id: apiKey.id,
		organizationId: apiKey.organizationId,
		name: apiKey.name,
		scopes: apiKey.scopes ?? undefined,
	};

	// Set organization ID from API key
	context.organizationId = apiKey.organizationId;
	context.authType = "apikey";

	// Record usage (fire and forget — use waitUntil to survive response)
	const ip = context.headers.get("CF-Connecting-IP") || undefined;
	const userAgent = context.headers.get("User-Agent") || undefined;
	const usagePromise = recordUsage(context.db, apiKey.id, {
		ipAddress: ip,
		userAgent,
	}).catch((error) => {
		console.warn("[Auth] Failed to record API key usage:", error);
	});
	if (context.waitUntil) {
		context.waitUntil(usagePromise);
	}
}

// =============================================================================
// AUTHENTICATION REQUEST HANDLER (FOR HONO-LEVEL PRE-AUTH)
// =============================================================================

/**
 * Shared logging middleware for contract procedures
 * Logs procedure calls with timing (development only for non-errors)
 * Use this in contract-based routers for consistent logging
 */
/**
 * Procedure call logging, as a handler client interceptor.
 *
 * This deliberately is NOT a middleware. As `` it had to be
 * applied per procedure — 725 call sites — and it silently missed whatever it
 * was ordered after: routers that chained `withPermission` before it never
 * logged a permission denial at all, while routers that chained it first did.
 * Registered once on the handler it covers every procedure uniformly, and it
 * also sees input-validation rejections, which happen in the procedure client
 * outside the middleware chain and so were previously never logged.
 *
 * Failure severity is split so that broader coverage does not mean noisier
 * production logs: an expected client error (4xx) warns, everything else —
 * 5xx and non-oRPC throws — is a real error and is logged in every
 * environment.
 */
export async function logProcedureCall(options: {
	context: BaseContext;
	path: readonly string[];
	next: () => Promise<unknown>;
}): Promise<unknown> {
	const { context, path, next } = options;
	const isDev = context.env.ENVIRONMENT === "development";
	const route = path.join(".");
	const start = Date.now();
	if (isDev) console.log(`[oRPC] ${route} - Started`);

	try {
		// Workers custom spans are beta: names and attributes are diagnostic only,
		// never an SLO gate or a proof artifact. The contract path is a fixed
		// procedure name; no input, token, or response body enters the span.
		const result = await tracing.enterSpan("tedix.api.orpc", async (span) => {
			span.setAttribute("tedix.orpc.procedure", route);
			return next();
		});
		if (isDev)
			console.log(`[oRPC] ${route} - Completed in ${Date.now() - start}ms`);
		return result;
	} catch (error) {
		const duration = Date.now() - start;
		const message = `[oRPC] ${route} - Failed in ${duration}ms:`;
		const isClientError =
			error instanceof ORPCError && CLIENT_ERROR_CODES.has(error.code);
		const metadata = {
			...(await safeErrorMetadata(error)),
			...requestCorrelation(context.headers),
		};
		if (isClientError) {
			console.warn(message, metadata);
		} else {
			console.error(message, metadata);
		}
		if (error instanceof D1ReadTimeoutError || isTransientD1ReadError(error))
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Database temporarily unavailable; retry shortly",
			);
		throw error;
	}
}

// Legacy procedures removed: publicProcedure, internalProcedure, mcpProcedure
// All routes now use contract-first design with implement() + middleware chains

// =============================================================================
// OUTPUT VALIDATION OPT-OUT
// =============================================================================

/**
 * Strip runtime Zod output validation from a procedure.
 *
 * oRPC runs each output schema's `["~standard"].validate(output)` on every
 * response. For high-volume read endpoints returning trusted D1 data, this is
 * unnecessary overhead. This helper flips the procedure's first-class
 * `disableOutputValidation` config flag so the executor's output-validation
 * loop is skipped entirely (`if (!procedure["~orpc"].disableOutputValidation)`
 * in @orpc/server's `executeProcedureInternal`).
 *
 * Type safety is preserved: the contract's `.output(schema)` still infers
 * the correct TypeScript return type for clients, and the schema is still used
 * for OpenAPI generation. Only the runtime Zod parse is skipped.
 *
 * Usage — wrap the procedure *before* passing it to `.router()`:
 * ```ts
 * export const myRouter = os.router({
 *   list: skipOutputValidation(listProcedure),
 *   get: skipOutputValidation(getProcedure),
 *   create: createProcedure, // keep validation on writes
 * });
 * ```
 *
 * ONLY use on read endpoints that return trusted data (D1 queries).
 * Keep output validation ON for write endpoints and any endpoint that
 * transforms or processes user input in the response.
 *
 * WARNING: This patches oRPC internals (`~orpc`). Verify after oRPC upgrades.
 * Tested with @orpc/server 2.0.0-beta.23. oRPC v2 renamed the singular
 * `outputSchema` internal to a plural `outputSchemas` array and gates
 * validation on the `disableOutputValidation` config flag (not on the schema's
 * presence), so setting a stale singular `outputSchema` key is a silent no-op —
 * clearing the array would also desync the middlewares' `outputSchemasLengthAtUse`
 * snapshots. Set the config flag instead.
 */
export function skipOutputValidation<T>(procedure: T): T {
	const proto = Object.getPrototypeOf(procedure);
	const patched = Object.create(proto);
	Object.assign(patched, procedure);
	const internal = (procedure as any)["~orpc"];
	if (internal) {
		patched["~orpc"] = { ...internal, disableOutputValidation: true };
	}
	return patched as T;
}
