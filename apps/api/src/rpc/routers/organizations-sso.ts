/** Organization SSO status, configuration and setup-link procedures. */
import { getDescopeManagement } from "../../lib/descope-management";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
import {
	requireOrganizationAccess,
	requireAdminOrOwner,
} from "./organizations-base";
import { authedOrganizationsOs } from "./organizations-base";

// =============================================================================
// SSO (DESCOPE S4) PROCEDURES
// =============================================================================

const SSO_AUTH_TYPES = new Set(["none", "saml", "oidc"]);

function normalizeAuthType(value: unknown): "none" | "saml" | "oidc" | null {
	if (typeof value === "string" && SSO_AUTH_TYPES.has(value)) {
		return value as "none" | "saml" | "oidc";
	}
	return null;
}

async function loadSsoStatus(
	context: BaseContext,
	descopeTenantId: string,
): Promise<{
	enabled: boolean;
	authType: "none" | "saml" | "oidc" | null;
	disabledFeatures: Record<string, boolean | undefined> | null;
	styleId: string | null;
}> {
	const mgmt = getDescopeManagement(context.env);
	if (!mgmt) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management API unavailable",
		);
	}
	const result = await mgmt.management.tenant.getSettings(descopeTenantId);
	if (!result.ok || !result.data) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			result.error?.errorMessage ?? "Failed to load Descope tenant settings",
		);
	}
	const settings = result.data as Record<string, unknown>;
	const sso = settings.ssoSetupSuiteSettings as
		| Record<string, unknown>
		| undefined;
	return {
		enabled: Boolean(sso?.enabled),
		authType: normalizeAuthType(settings.authType),
		disabledFeatures:
			(sso?.disabledFeatures as Record<string, boolean | undefined>) ?? null,
		styleId: typeof sso?.styleId === "string" ? sso.styleId : null,
	};
}

async function getOrgWithDescopeTenant(
	context: BaseContext,
	organizationId: string,
): Promise<{ tenantId: string }> {
	requireOrganizationAccess(context, organizationId);
	requireAdminOrOwner(context);

	const org = await getOrganizationById(context.db, organizationId);
	if (!org) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}
	if (!org.descopeTenantId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization has no Descope tenant — SSO requires a synced tenant",
		);
	}
	return { tenantId: org.descopeTenantId };
}

export const getSsoStatusContract = authedOrganizationsOs.getSsoStatus
	.use(withAuthorization("settings:manage", "platform:admin"))
	.handler(async ({ input, context }) => {
		const { tenantId } = await getOrgWithDescopeTenant(
			context,
			input.organizationId,
		);
		return loadSsoStatus(context, tenantId);
	});

export const configureSsoContract = authedOrganizationsOs.configureSso
	.use(withAuthorization("settings:manage", "platform:admin"))
	.handler(async ({ input, context }) => {
		const { tenantId } = await getOrgWithDescopeTenant(
			context,
			input.organizationId,
		);
		const mgmt = getDescopeManagement(context.env);
		if (!mgmt) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope management API unavailable",
			);
		}

		// Read current settings so we don't clobber unrelated TenantSettings
		// fields when writing the SSO subsection.
		const current = await mgmt.management.tenant.getSettings(tenantId);
		if (!current.ok || !current.data) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				current.error?.errorMessage ??
					"Failed to load existing tenant settings before SSO update",
			);
		}

		const currentRecord = current.data as Record<string, unknown>;
		const existingSso =
			(currentRecord.ssoSetupSuiteSettings as Record<string, unknown>) ?? {};
		const merged = {
			...currentRecord,
			ssoSetupSuiteSettings: {
				...existingSso,
				...input.settings,
			},
		};

		const update = await mgmt.management.tenant.configureSettings(
			tenantId,
			merged as Parameters<typeof mgmt.management.tenant.configureSettings>[1],
		);
		if (!update.ok) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				update.error?.errorMessage ?? "Failed to configure SSO settings",
			);
		}

		return loadSsoStatus(context, tenantId);
	});

export const generateSsoSetupLinkContract =
	authedOrganizationsOs.generateSsoSetupLink
		.use(withAuthorization("settings:manage", "platform:admin"))
		.handler(async ({ input, context }) => {
			const { tenantId } = await getOrgWithDescopeTenant(
				context,
				input.organizationId,
			);
			const mgmt = getDescopeManagement(context.env);
			if (!mgmt) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Descope management API unavailable",
				);
			}

			const result = await mgmt.management.tenant.generateSSOConfigurationLink(
				tenantId,
				input.expireDuration,
				undefined,
				input.email,
				undefined,
				// Attributes the link to the acting admin in Descope's audit trail.
				context.user?.sub,
			);
			if (!result.ok || !result.data?.adminSSOConfigurationLink) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					result.error?.errorMessage ?? "Failed to generate SSO setup link",
				);
			}
			return { url: result.data.adminSSOConfigurationLink };
		});
