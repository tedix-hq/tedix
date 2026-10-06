import type { JWTPayload } from "./types";
import { DESCOPE_DEFAULT_BASE_URL } from "./types";

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
	const normalized = issuer.trim().replace(/\/+$/, "");
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
