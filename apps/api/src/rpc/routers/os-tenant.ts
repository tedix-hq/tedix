import { createDbClient } from "@tedix/db/client";
import { resolveOrganizationHostname } from "@tedix/db/queries/organization-domains";
import { implement } from "@orpc/server";
import { osTenantContract } from "@tedix/api-contract/contracts/os-tenant";
import {
	getOrganizationById,
	getOrganizationBySlug,
	isOrganizationOffboarding,
} from "@tedix/db/queries/organizations";
import { PersonalAgentDiscoveryConfigSchema } from "@tedix/api-contract/schemas/organization";
import { type BaseContext, withServiceAuth } from "../orpc";
import { verifySignedOutPersonalAgentSession } from "../../services/personal-agent-session";

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
const personalAgentDiscovery = service.personalAgentDiscovery.handler(
	async ({ input, context }) => {
		const organization = await getOrganizationById(
			context.db,
			input.organizationId,
		);
		if (
			!organization?.features?.os ||
			isOrganizationOffboarding(organization.metadata)
		)
			return null;
		const config = PersonalAgentDiscoveryConfigSchema.safeParse(
			organization.metadata?.personalAgentProtocol,
		);
		if (
			!config.success ||
			config.data.domain.toLowerCase() !== input.hostname.toLowerCase()
		)
			return null;
		return {
			protocol_version: "1.0" as const,
			organization: { name: organization.name, domain: config.data.domain },
			auth: { disabled: true as const },
			apis: [
				{
					type: "mcp" as const,
					url: config.data.mcpUrl,
					description: config.data.description,
				},
			],
		};
	},
);

export const osTenantContractRouter = osTenantOs.router({
	personalAgentSession: service.personalAgentSession.handler(
		({ input, context }) =>
			verifySignedOutPersonalAgentSession(context.db, input),
	),
	personalAgentDiscovery,
	resolve,
	resolveHostname,
});
