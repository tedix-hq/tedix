import { createDbClient } from "@tedix/db/client";
import { resolveOrganizationHostname } from "@tedix/db/queries/organization-domains";
import { implement } from "@orpc/server";
import { osTenantContract } from "@tedix/api-contract/contracts/os-tenant";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import { type BaseContext, withServiceAuth } from "../orpc";

/**
 * OS tenant resolution for the `tedix-os` edge router.
 *
 * Service-binding only: the endpoint answers routing context ("may this slug
 * be served the shell?"), never authorization — every data request re-derives
 * the caller's organization from its own identity. Provisioning is the
 * explicit `features.os` flag on the organization, so activating a
 * tenant OS is a data-plane action with no DNS, cert, route, or deploy step.
 */
const osTenantOs = implement(osTenantContract).$context<BaseContext>();
const service = osTenantOs.use(withServiceAuth);

const resolve = service.resolve.handler(async ({ input, context }) => {
	const organization = await getOrganizationBySlug(context.db, input.slug);
	const provisioned = organization?.features?.os === true;
	return {
		provisioned,
		...(provisioned && organization?.metadata?.identityProvider?.kind === "oidc"
			? { identityProvider: "oidc" as const }
			: {}),
		organizationId: provisioned && organization ? organization.id : null,
		descopeTenantId:
			provisioned && organization
				? (organization.descopeTenantId ?? null)
				: null,
	};
});

const resolveHostname = service.resolveHostname.handler(
	async ({ input, context }) => {
		const row = await resolveOrganizationHostname(
			context.env.DB ? createDbClient(context.env.DB) : context.db,
			input.hostname,
		);
		return {
			provisioned: Boolean(row),
			slug: row?.slug ?? null,
			organizationId: row?.organizationId ?? null,
			descopeTenantId: row?.descopeTenantId ?? null,
			...(row?.metadata?.identityProvider?.kind === "oidc"
				? { identityProvider: "oidc" as const }
				: {}),
		};
	},
);
export const osTenantContractRouter = osTenantOs.router({
	resolve,
	resolveHostname,
});
