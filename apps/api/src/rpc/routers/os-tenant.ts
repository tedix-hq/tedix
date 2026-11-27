import { coreDb } from "@tedix/db/core-store/scope";
import { createDbSession } from "@tedix/db/client";
import { resolveOrganizationHostname } from "@tedix/db/queries/organization-domains";
import { withTransientD1ReadRetry } from "@tedix/db/utils/d1-retry";
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
import { personalAgentInterfaces } from "../../services/personal-agent-interfaces";
import { personalAgentConversation } from "../../services/personal-agent-conversation";
import { osAudit, OS_TENANT_AUDIT } from "../os-audit";

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
const service = osTenantOs.use(withServiceAuth).use(osAudit(OS_TENANT_AUDIT));

/** D1 can refuse a read for a moment under load; the same read soon succeeds. */
function readTenant<T>(label: string, read: () => Promise<T>): Promise<T> {
	return withTransientD1ReadRetry(`os_tenant.${label}`, read, {
		attempts: 4,
		delayMs: 150 + Math.floor(Math.random() * 150),
		timeoutMs: 3000,
	});
}

const resolve = service.resolve.handler(async ({ input, context }) => {
	const organization = await readTenant("resolve", async () => {
		const row = await getOrganizationBySlug(context.db, input.slug);
		if (row?.features?.os !== true && context.env.DB) {
			// A just-provisioned tenant may not have reached the replica yet.
			const primary = createDbSession(context.env.DB, null, "first-primary");
			return getOrganizationBySlug(primary.db, input.slug);
		}
		return row;
	});
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
		const row = await readTenant("resolve_hostname", () =>
			resolveOrganizationHostname(
				context.env.DB ? coreDb(context.env) : context.db,
				input.hostname,
			),
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
			...(config.data.companyAgent
				? {
						agent: {
							protocols: [
								{
									type: "poppy" as const,
									endpoint: `${config.data.mcpUrl.replace(/\/$/, "")}/poppy/conversations`,
									description: config.data.companyAgent.description,
								},
							],
						},
					}
				: {}),
			...(config.data.interfaces
				? {
						tasks: {
							endpoint: `${config.data.mcpUrl.replace(/\/$/, "")}/poppy/tasks`,
						},
					}
				: {}),
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
	personalAgentConversation: service.personalAgentConversation.handler(
		({ input, context }) =>
			personalAgentConversation(context.db, context.env, input),
	),
	personalAgentInterfaces: service.personalAgentInterfaces.handler(
		({ input, context }) =>
			personalAgentInterfaces(context.db, context.env, input),
	),
	personalAgentSession: service.personalAgentSession.handler(
		({ input, context }) =>
			verifySignedOutPersonalAgentSession(context.db, input, context.env),
	),
	personalAgentDiscovery,
	resolve,
	resolveHostname,
});
