import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";

/**
 * Where an operator finishes a tenant install that still needs a provider
 * connection: Tedix OS `/admin/connections` on the org's own tenant host,
 * with `?connect=<providerId>` auto-starting the flow on arrival.
 *
 * OS tenancy is hostname-based (`{slug}.os.tedix.dev` resolves the
 * organization), so unlike the retired Dashboard URL there is no slug path
 * segment and no `/login?organization_id=…` wrapper: an unauthenticated visit
 * to the tenant host routes through the session broker and returns to this
 * URL under the session boundary's redirect semantics.
 */
export function tenantConnectionHandoffUrl(input: {
	environment: string | undefined;
	organizationSlug: string;
	providerId: string;
}): string {
	const origin = buildSurfaceUrl("os", input.organizationSlug, {
		platformDomain: platformDomainForEnvironment(
			input.environment || "production",
		),
	});
	if (!origin) {
		throw new Error("Tenant connection handoff requires an organization slug");
	}
	const url = new URL("/admin/connections", origin);
	url.searchParams.set("connect", input.providerId);
	return url.toString();
}
