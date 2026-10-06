import { ZodError } from "zod";
import {
	getEmbeddedContactCompany,
	getEmbeddedContactUser,
	identifyEmbeddedContact,
	listEmbeddedContacts,
	resolveProviderContactInstallation,
} from "@tedix/db/queries/embedded-contacts";
import { requireOrgId } from "../../org-scope";
import { withExactApiKeyScope } from "../../orpc";
import { AUTHZ, authedTedisOs, createError, ErrorCodes } from "./helpers";
function companyDto(
	row: NonNullable<Awaited<ReturnType<typeof getEmbeddedContactCompany>>>,
) {
	return {
		installationId: row.installationId,
		externalTenantId: row.externalTenantId,
		name: row.companyProfile ? row.companyProfile.name : row.fallbackName,
		customAttributes: row.companyProfile?.customAttributes ?? {},
		firstSeenAt: row.companyProfile?.firstSeenAt ?? null,
		lastSeenAt: row.companyProfile?.lastSeenAt ?? null,
	};
}
export const identifyEmbeddedProviderContact =
	authedTedisOs.identifyEmbeddedProviderContact
		.use(withExactApiKeyScope("embedded:session"))
		.handler(async ({ context, input }) => {
			const organizationId = requireOrgId(context);
			if (!context.apiKey?.id)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Provider host credential is required",
				);
			const installation = await resolveProviderContactInstallation(
				context.db,
				{
					providerOrganizationId: organizationId,
					providerApiKeyId: context.apiKey.id,
					externalTenantId: input.externalTenantId,
				},
			);
			if (!installation)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider business is not installed",
				);
			try {
				const result = await identifyEmbeddedContact(context.db, {
					providerOrganizationId: organizationId,
					installationId: installation.id,
					hostUserId: input.hostUserId,
					hostRole: input.hostRole,
					profile: input.profile,
					now: new Date().toISOString(),
				});
				if (!result.user || !result.company)
					throw createError(
						ErrorCodes.CONFLICT,
						"Contact identification did not finish; retry",
					);
				return {
					installationId: installation.id,
					user: result.user,
					company: companyDto(result.company),
				};
			} catch (error) {
				if (error instanceof ZodError)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Stored attributes would exceed the supported profile bounds",
					);
				throw error;
			}
		});
export const listWidgetContacts = authedTedisOs.listWidgetContacts
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const result = await listEmbeddedContacts(context.db, {
			...input,
			providerOrganizationId: requireOrgId(context),
		});
		return {
			...result,
			companies: result.companies.map(companyDto),
			nextOffset:
				input.offset + input.limit < result.total
					? input.offset + input.limit
					: null,
		};
	});
export const getWidgetContact = authedTedisOs.getWidgetContact
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const organizationId = requireOrgId(context);
		const company = await getEmbeddedContactCompany(
			context.db,
			organizationId,
			input.installationId,
		);
		if (!company) throw createError(ErrorCodes.NOT_FOUND, "Business not found");
		const user = input.hostUserId
			? await getEmbeddedContactUser(
					context.db,
					organizationId,
					input.installationId,
					input.hostUserId,
				)
			: null;
		if (input.hostUserId && !user)
			throw createError(ErrorCodes.NOT_FOUND, "Person not found");
		return { company: companyDto(company), user: user ?? null };
	});
