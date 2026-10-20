import { resolveUntrustedContentOrigin } from "../lib/untrusted-origin";

/**
 * Resolve the org a media/artifact request addresses from its Descope token,
 * honoring the `X-Tedix-Tenant-Id` override ONLY when the caller actually
 * belongs to the target org. A bare tenant id is an identifier, not a
 * credential: without this membership gate any valid Descope subject could
 * address another org and read its artifacts by id. Same-tenant requests (the
 * common case) skip the membership lookup. Returns undefined to fail closed.
 */
export async function resolveMediaRouteOrgId(
	db: import("@tedix/db/client").DbClient,
	payload: import("@tedix/auth/types").JWTPayload,
	headerTenantId: string | undefined,
): Promise<string | undefined> {
	const { resolveTenantOverride } = await import("@tedix/auth/types");
	const { tenantId, isCrossTenantOverride } = resolveTenantOverride(
		payload,
		headerTenantId,
	);
	if (!tenantId) return undefined;
	const { getOrganizationByDescopeId } =
		await import("@tedix/db/queries/organizations");
	const org = await getOrganizationByDescopeId(db, tenantId);
	if (!org) return undefined;
	if (isCrossTenantOverride) {
		if (!payload.sub) return undefined;
		const { getMemberByUserId } =
			await import("@tedix/db/queries/organization-members");
		const member = await getMemberByUserId(db, org.id, payload.sub);
		if (!member) return undefined;
	}
	return org.id;
}

/**
 * Move an ALREADY-SIGNED byte request onto the untrusted-content origin.
 *
 * The signature covers only the resource identity and expiry, never the host
 * (`lib/artifact-url.ts:tokenMessage`, `lib/skill-media-url.ts:tokenMessage`),
 * so path + query transplant verbatim. Returns null when the origin is unset
 * (status quo: serve here) or when the request already arrived on it.
 */
export function untrustedContentRedirect(
	env: CloudflareEnv,
	requestUrl: string,
): Response | null {
	const resolution = resolveUntrustedContentOrigin(env);
	if (resolution.state !== "configured") return null;
	const url = new URL(requestUrl);
	if (url.origin === resolution.origin) return null;
	return new Response(null, {
		status: 302,
		headers: {
			Location: new URL(url.pathname + url.search, resolution.origin).href,
			"Cache-Control": "private, no-store",
		},
	});
}
