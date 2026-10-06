import {
	getTedisByOrganization,
	getTediByIdForOrganization,
} from "@tedix/db/queries/tedis";
import { validateEmbeddedTediSelection } from "../../../services/embedded-tedi-selection";
import { ensureProviderInstallationGateway } from "../../../services/provider-installation-gateway";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	evaluateEmbeddedWidgetAccess,
	readEmbeddedWidgetAccess,
} from "@tedix/api-contract/schemas/embedded-widget-access";
import {
	getProviderInstallationById,
	listProviderWidgetInstallations,
	updateProviderWidgetAccess,
	resolveActiveProviderInstallationForOutcome,
} from "@tedix/db/queries/provider-installations";
import { requireOrgId } from "../../org-scope";
import {
	AUTHZ,
	authedTedisOs,
	tedisOs,
	withServiceAuth,
	withAuthorization,
	createError,
	ErrorCodes,
} from "./helpers";

type ProviderInstallation = NonNullable<
	Awaited<ReturnType<typeof getProviderInstallationById>>
>;

function configuration(row: ProviderInstallation) {
	return {
		installationId: row.id,
		externalTenantId: row.externalTenantId,
		allowedOrigin: row.allowedOrigin,
		status: row.status,
		...readEmbeddedWidgetAccess(row.provenance),
		tediSelection: readEmbeddedWidgetAccess(row.provenance).policy
			.tediSelection ?? {
			defaultTediId: row.primaryTediId,
			allowedTediIds: [row.primaryTediId],
		},
	};
}
export const listWidgetAccessConfigurations =
	authedTedisOs.listWidgetAccessConfigurations
		.use(AUTHZ.appsRead)
		.handler(async ({ context }) => {
			const rows = await listProviderWidgetInstallations(
				context.db,
				requireOrgId(context),
			);
			return {
				data: await Promise.all(
					rows.map(async (row) => {
						const organization = await getOrganizationById(
							context.db,
							row.customerOrganizationId,
						);
						return {
							...configuration(row),
							availableTedis: (
								await getTedisByOrganization(
									context.db,
									row.customerOrganizationId,
								)
							)
								.filter((t) => t.status === "active" && !t.retiredAt)
								.map((t) => ({ id: t.id, name: t.displayName || t.name })),
							...(organization ? { businessName: organization.name } : {}),
						};
					}),
				),
			};
		});
export const updateWidgetAccessConfiguration =
	authedTedisOs.updateWidgetAccessConfiguration
		.use(withAuthorization("settings:manage", "apps:write"))
		.handler(async ({ input, context }) => {
			const installation = await getProviderInstallationById(context.db, {
				organizationId: requireOrgId(context),
				installationId: input.installationId,
			});
			if (!installation)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);
			if (input.policy.tediSelection)
				await validateEmbeddedTediSelection(
					context,
					installation.customerOrganizationId,
					input.policy.tediSelection,
				);
			// Prepare gateway identities under this authorized settings request before
			// publishing the policy. Until CAS succeeds, runtime membership stays unchanged.
			if (input.policy.tediSelection) {
				const proposed = {
					...installation,
					provenance: {
						...installation.provenance,
						widgetAccess: {
							revision: input.expectedRevision + 1,
							policy: { ...input.policy, enabled: true },
							updatedAt: new Date().toISOString(),
							updatedBy: context.user?.sub ?? context.apiKey?.id ?? "service",
						},
					},
				};
				for (const tediId of input.policy.tediSelection.allowedTediIds)
					await ensureProviderInstallationGateway(context, proposed, tediId);
			}
			const row = await updateProviderWidgetAccess(context.db, {
				...input,
				organizationId: requireOrgId(context),
				updatedBy: context.user?.sub ?? context.apiKey?.id ?? "service",
			});
			if (row === "conflict")
				throw createError(
					ErrorCodes.CONFLICT,
					"Access settings changed. Reload and try again.",
				);
			if (!row)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Provider installation not found",
				);

			return configuration(row);
		});
export const previewWidgetAccess = authedTedisOs.previewWidgetAccess
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const row = await getProviderInstallationById(context.db, {
			organizationId: requireOrgId(context),
			installationId: input.installationId,
		});
		if (!row)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Provider installation not found",
			);
		return evaluateEmbeddedWidgetAccess(configuration(row), input.hostUserId);
	});
export const authorizeEmbeddedWidgetAccess =
	tedisOs.authorizeEmbeddedWidgetAccess
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const organizationId = context.headers.get("X-Tedix-Org-Id");
			const tediId = context.headers.get("X-Tedix-Tedi-Id");
			if (!organizationId || !tediId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded authority is required",
				);
			const row = await resolveActiveProviderInstallationForOutcome(
				context.db,
				{
					...input,
					customerOrganizationId: organizationId,
					primaryTediId: tediId,
				},
			);
			if (!row)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded installation is unavailable",
				);
			const tedi = await getTediByIdForOrganization(
				context.db,
				tediId,
				organizationId,
			);
			if (!tedi || tedi.status !== "active" || tedi.retiredAt)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded worker is unavailable",
				);
			return evaluateEmbeddedWidgetAccess(configuration(row), input.hostUserId);
		});
