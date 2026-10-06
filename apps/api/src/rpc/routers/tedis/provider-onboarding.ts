import { ProviderOnboardingSchema } from "@tedix/api-contract/schemas/organization";
import {
	getOrganizationById,
	setProviderOnboardingConfiguration,
} from "@tedix/db/queries/organizations";
import { requireOrgId } from "../../org-scope";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	type BaseContext,
} from "./helpers";
import {
	provisionInstallation,
	validateProviderInstallationIdentity,
} from "./provider-installations";

function requireConsoleUser(context: BaseContext) {
	if (context.authType !== "user" || !context.user?.sub)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Customer activation requires a provider console administrator",
		);
	return requireOrgId(context);
}

export const getProviderOnboardingStatus =
	authedTedisOs.getProviderOnboardingStatus
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => {
			const organizationId = requireConsoleUser(context);
			const provider = await getOrganizationById(context.db, organizationId);
			const config = ProviderOnboardingSchema.safeParse(
				provider?.metadata?.providerOnboarding,
			);
			return { configured: config.success && config.data.enabled };
		});

export const activateProviderCustomer = authedTedisOs.activateProviderCustomer
	.use(AUTHZ.settingsWrite)
	.handler(async ({ context, input }) => {
		const providerOrganizationId = requireConsoleUser(context);
		const provider = await getOrganizationById(
			context.db,
			providerOrganizationId,
		);
		const config = ProviderOnboardingSchema.safeParse(
			provider?.metadata?.providerOnboarding,
		);
		if (!config.success || !config.data.enabled)
			throw createError(
				ErrorCodes.CONFLICT,
				"Business setup is not available for this provider yet",
			);
		const {
			enabled: _enabled,
			billingPlanKey,
			ownerUserId,
			ownerEmail,
			sponsoredCapacity,
			language,
			timezone,
			personality,
			...integration
		} = config.data;
		const installation = await provisionInstallation(
			context,
			{
				...integration,
				providerOrganizationId,
				externalTenantId: input.externalTenantId,
				customer: {
					name: input.name,
					billingPlanKey,
					ownerUserId,
					ownerEmail,
					sponsoredCapacity,
					language,
					timezone,
					personality,
				},
				provenance: {
					widgetAccess: {
						revision: 1,
						policy: {
							version: 1,
							enabled: false,
							users: "selected",
							allowedUserIds: [],
							deniedUserIds: [],
						},
						updatedAt: new Date().toISOString(),
						updatedBy: context.user!.sub!,
					},
				},
			},
			true,
		);
		return { installationId: installation.id };
	});

export const configureProviderOnboarding =
	authedTedisOs.configureProviderOnboarding
		.use(AUTHZ.platformAdmin)
		.handler(async ({ context, input }) => {
			await validateProviderInstallationIdentity(context, {
				providerOrganizationId: input.providerOrganizationId,
				providerAppId: input.config.providerAppId,
				providerApiKeyId: input.config.providerApiKeyId,
			});
			const updated = await setProviderOnboardingConfiguration(
				context.db,
				input.providerOrganizationId,
				input.config,
			);
			if (!updated)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider organization not found",
				);
			return { configured: input.config.enabled };
		});
