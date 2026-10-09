import { isUserToken } from "./jwt.ts";
import type { JWTPayload } from "./types";
import { DESCOPE_DEFAULT_BASE_URL, DESCOPE_MANAGEMENT_BASE_URL } from "./types";
import { trimTrailingSlashes } from "./utils.ts";

export interface ExternalPrincipalIdentity {
	provider: string;
	issuer: string;
	subject: string;
}

export interface CloudflareAccessIdentityLike {
	account_id?: string;
	service_token_id?: string;
	user_uuid?: string;
}

export interface VerifiedCloudflareAccessContext {
	readonly aud: string;
	getIdentity(): Promise<CloudflareAccessIdentityLike | undefined>;
}

export function normalizeIdentityIssuer(issuer: string): string {
	const normalized = trimTrailingSlashes(issuer.trim());
	if (!normalized) throw new Error("Identity issuer is required");
	return normalized;
}

export function descopeIssuer(
	projectId: string,
	baseUrl = DESCOPE_DEFAULT_BASE_URL,
): string {
	const project = projectId.trim();
	if (!project) throw new Error("Descope project id is required");
	return `${normalizeIdentityIssuer(baseUrl)}/${project}`;
}

export function descopePrincipalIdentity(
	payload: Pick<JWTPayload, "iss">,
	subject: string,
): ExternalPrincipalIdentity {
	const normalizedSubject = subject.trim();
	if (!normalizedSubject) throw new Error("Identity subject is required");
	return {
		provider: "descope",
		issuer: normalizeIdentityIssuer(payload.iss),
		subject: normalizedSubject,
	};
}

export function descopeUserIdentity(
	payload: Pick<JWTPayload, "iss" | "sub">,
): ExternalPrincipalIdentity {
	if (!payload.sub) throw new Error("Descope user token is missing sub");
	return descopePrincipalIdentity(payload, payload.sub);
}

/** Descope user ids; AIH client-credentials subjects are `TPA…` client ids. */
const DESCOPE_USER_SUBJECT_RE = /^U[A-Za-z0-9]+$/;
const DESCOPE_AGENTIC_APP_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * A Descope agentic app (AIH MCP server) signs its OAuth tokens with
 * `https://api.descope.com/v1/apps/agentic/<project>/<app>`, while Tedix binds
 * human users under the project issuer. Return the project issuer when `iss`
 * is exactly an agentic-app issuer of the configured project and the token is
 * a human user token; otherwise null. Signature and expiry are the caller's
 * responsibility; this only decides which issuer names the same user.
 */
export function descopeAgenticAppUserIssuer(
	payload: JWTPayload,
	options: { projectId: string; baseUrl?: string },
): string | null {
	const projectId = options.projectId.trim();
	if (!projectId) return null;
	let issuer: URL;
	try {
		issuer = new URL(payload.iss);
	} catch {
		return null;
	}
	if (
		issuer.origin !== DESCOPE_MANAGEMENT_BASE_URL ||
		issuer.search ||
		issuer.hash ||
		issuer.username ||
		issuer.password
	) {
		return null;
	}
	const path = issuer.pathname.split("/");
	if (
		path.length !== 6 ||
		path[0] !== "" ||
		path[1] !== "v1" ||
		path[2] !== "apps" ||
		path[3] !== "agentic" ||
		path[4] !== projectId ||
		!DESCOPE_AGENTIC_APP_SEGMENT_RE.test(path[5] ?? "")
	) {
		return null;
	}
	const subject = payload.sub?.trim();
	if (!subject || !DESCOPE_USER_SUBJECT_RE.test(subject)) return null;
	// Machine, tedi, external-agent and delegated (RFC 8693 `act`) tokens keep
	// their own issuer, so they can never resolve to a human user binding.
	if (!isUserToken(payload)) return null;
	if (payload.act !== undefined) return null;
	if (subject === payload.client_id || subject === payload.azp) return null;
	return descopeIssuer(projectId, options.baseUrl);
}

/**
 * The user identity for a Descope token, naming agentic-app user tokens of the
 * configured project by the project issuer they are bound under.
 */
export function descopeProjectUserIdentity(
	payload: JWTPayload,
	options: { projectId: string; baseUrl?: string },
): ExternalPrincipalIdentity {
	const identity = descopeUserIdentity(payload);
	const projectIssuer = descopeAgenticAppUserIssuer(payload, options);
	return projectIssuer ? { ...identity, issuer: projectIssuer } : identity;
}

export function descopeServiceIdentity(
	payload: Pick<JWTPayload, "iss" | "client_id">,
): ExternalPrincipalIdentity {
	if (!payload.client_id) {
		throw new Error("Descope service token is missing client_id");
	}
	return descopePrincipalIdentity(payload, payload.client_id);
}

export function descopeTenantIdentity(
	payload: Pick<JWTPayload, "iss">,
	tenantId: string,
): ExternalPrincipalIdentity {
	return descopePrincipalIdentity(payload, tenantId);
}

/**
 * Adapt a Cloudflare-runtime-verified Access identity to Tedix's provider-neutral
 * principal key. Callers must pass `ctx.access`; request headers are deliberately
 * not accepted because they are spoofable whenever Access is absent or bypassed.
 *
 * This authenticates an ingress identity only. The returned tuple must still be
 * resolved through `principal_identities`, and ordinary Tedix authorization
 * (tenant membership, FGA, procedure scopes) continues to apply.
 */
export async function cloudflareAccessPrincipalIdentity(
	access: VerifiedCloudflareAccessContext | undefined,
	options: {
		expectedAccountId: string;
		expectedAudience: string;
		issuer: string;
	},
): Promise<ExternalPrincipalIdentity> {
	if (!access) throw new Error("Cloudflare Access context is required");

	const expectedAudience = options.expectedAudience.trim();
	if (!expectedAudience || access.aud !== expectedAudience) {
		throw new Error("Cloudflare Access audience mismatch");
	}

	const identity = await access.getIdentity();
	if (!identity) throw new Error("Cloudflare Access identity is required");

	const expectedAccountId = options.expectedAccountId.trim();
	if (!expectedAccountId || identity.account_id !== expectedAccountId) {
		throw new Error("Cloudflare Access account mismatch");
	}

	const userId = identity.user_uuid?.trim();
	const serviceTokenId = identity.service_token_id?.trim();
	if (Boolean(userId) === Boolean(serviceTokenId)) {
		throw new Error(
			"Cloudflare Access identity must contain exactly one stable subject",
		);
	}

	return {
		provider: "cloudflare-access",
		issuer: normalizeIdentityIssuer(options.issuer),
		subject: userId ? `user:${userId}` : `service-token:${serviceTokenId}`,
	};
}
