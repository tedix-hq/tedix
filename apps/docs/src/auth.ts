import { checkUserTenantMembership } from "@tedix/auth/descope";
import { isUserToken, validateToken } from "@tedix/auth/jwt";
import { isPlatformPrincipal, type JWTPayload } from "@tedix/auth/types";
import {
	extractBearerToken,
	secureEqual,
} from "@tedix/worker-kit/request-auth";
import type { AppBindings, DocsActor } from "./types";

export interface DocsAuthorization {
	orgSlug: string;
	platformAdmin: boolean;
	scopes: string[];
	actor: DocsActor;
}

/** An authorization refusal whose message is safe to return to the caller. */
export class DocsAuthError extends Error {
	override name = "DocsAuthError";
}

export type DelegatedDocsScope =
	| "mcp:content.read"
	| "mcp:content.write"
	| "mcp:content.admin";

const DELEGATED_DOCS_SCOPES = new Set<DelegatedDocsScope>([
	"mcp:content.read",
	"mcp:content.write",
	"mcp:content.admin",
]);

export function delegatedDocsScope(
	request: Request,
): DelegatedDocsScope | null {
	const raw = request.headers.get("X-Tedix-Delegated-Scope")?.trim();
	if (!raw) return null;
	if (!DELEGATED_DOCS_SCOPES.has(raw as DelegatedDocsScope)) {
		throw new DocsAuthError("Invalid delegated Docs scope");
	}
	return raw as DelegatedDocsScope;
}

function forwardedBearerToken(request: Request): string | null {
	return extractBearerToken(request.headers.get("X-Forwarded-Authorization"));
}

export function requestedOrg(request: Request): string | null {
	const url = new URL(request.url);
	const value =
		request.headers.get("X-Tedix-Connection-Label") ??
		url.searchParams.get("org");
	if (!value || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) return null;
	return value;
}

function scopes(payload: JWTPayload): string[] {
	const raw = payload.scope ?? payload.scopes ?? payload.scp;
	if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
	if (Array.isArray(raw)) {
		return raw.filter((item): item is string => typeof item === "string");
	}
	return [];
}

function platformAdmin(payload: JWTPayload): boolean {
	const values = scopes(payload);
	return isPlatformPrincipal({
		user: payload,
		apiKey: { scopes: values },
		serviceAccount: { scope: values.join(" ") },
	});
}

function actorFromPayload(payload: JWTPayload): DocsActor {
	if (payload.entityType === "tedi" && typeof payload.tediId === "string") {
		return {
			type: "tedi",
			id: payload.tediId,
			sessionId: null,
		};
	}
	if (!isUserToken(payload) && typeof payload.client_id === "string") {
		return { type: "m2m", id: payload.client_id, sessionId: null };
	}
	return {
		type: "user",
		id:
			typeof payload.descopeUserId === "string"
				? payload.descopeUserId
				: (payload.sub ?? "unknown-user"),
		sessionId: null,
	};
}

function trustedForwardedActor(request: Request): DocsActor | null {
	const type = request.headers.get("X-Tedix-Actor-Type");
	const id = request.headers.get("X-Tedix-Actor-Id");
	if (
		!id ||
		!["user", "service", "tedi", "m2m", "external_agent", "kernel"].includes(
			type ?? "",
		)
	) {
		return null;
	}
	return {
		type: type as DocsActor["type"],
		id,
		sessionId: request.headers.get("X-Tedix-Agent-Session-Id"),
	};
}

function tokenHasTenant(payload: JWTPayload, orgSlug: string): boolean {
	const expected = `org_${orgSlug}`;
	const tenants = payload.tenants;
	if (Array.isArray(tenants)) {
		return tenants.some((tenant) =>
			typeof tenant === "string"
				? tenant === expected
				: tenant &&
					typeof tenant === "object" &&
					"id" in tenant &&
					tenant.id === expected,
		);
	}
	return false;
}

async function userHasTenant(
	env: AppBindings,
	payload: JWTPayload,
	orgSlug: string,
): Promise<boolean> {
	if (tokenHasTenant(payload, orgSlug)) return true;
	const userId =
		typeof payload.descopeUserId === "string"
			? payload.descopeUserId
			: payload.sub;
	if (!userId) return false;
	return (
		(await checkUserTenantMembership(env, userId, `org_${orgSlug}`)) === true
	);
}

export async function authorizeDocsRequest(
	request: Request,
	env: AppBindings,
): Promise<DocsAuthorization> {
	const orgSlug = requestedOrg(request);
	if (!orgSlug) throw new DocsAuthError("Missing org; pass ?org=slug");
	const token = extractBearerToken(request.headers.get("Authorization"));
	if (!token) throw new DocsAuthError("Missing authorization");

	if (
		env.PLATFORM_SERVICE_TOKEN &&
		(await secureEqual(token, env.PLATFORM_SERVICE_TOKEN))
	) {
		const delegatedScope = delegatedDocsScope(request);
		const forwardedToken = forwardedBearerToken(request);
		const forwardedPayload = forwardedToken
			? await validateToken(forwardedToken, {
					projectId: env.DESCOPE_PROJECT_ID,
					baseUrl: env.DESCOPE_BASE_URL,
					allowTediJwt: true,
				})
			: null;
		if (delegatedScope) {
			// Authority in this branch is the delegated scope alone: apps/api
			// resolved it from the tool and already enforced that the caller holds
			// the matching permission. The forwarded JWT never contributed to
			// `platformAdmin` or `scopes` here — it only names the actor, and
			// apps/api stamps that identity itself in X-Tedix-Actor-*, derived from
			// its own authenticated context rather than from anything the caller
			// sent. Requiring a JWT on top locked out every principal the platform
			// deliberately identifies by header instead of by token: a tedi carries
			// its authority in D1-resolved scopes, not in its JWT, so no token to
			// forward exists.
			const actor =
				trustedForwardedActor(request) ??
				(forwardedPayload ? actorFromPayload(forwardedPayload) : null);
			if (!actor) {
				throw new DocsAuthError(
					"Delegated Docs scope requires forwarded authorization or trusted actor headers",
				);
			}
			return {
				orgSlug,
				platformAdmin: delegatedScope === "mcp:content.admin",
				scopes: [delegatedScope],
				actor,
			};
		}
		throw new DocsAuthError(
			"Platform service token requires a delegated Docs scope",
		);
	}

	const payload = await validateToken(token, {
		projectId: env.DESCOPE_PROJECT_ID,
		baseUrl: env.DESCOPE_BASE_URL,
		allowTediJwt: true,
	});
	const isAdmin = platformAdmin(payload);
	if (!isAdmin && !(await userHasTenant(env, payload, orgSlug))) {
		throw new DocsAuthError(`Organization access denied for org "${orgSlug}"`);
	}
	return {
		orgSlug,
		platformAdmin: isAdmin,
		scopes: scopes(payload),
		actor: actorFromPayload(payload),
	};
}
