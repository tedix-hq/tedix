import { providerWidgetAllowsTedi } from "@tedix/api-contract/schemas/embedded-widget-access";
import { getConnectionProviderByDescopeAppId } from "@tedix/db/queries/connection-providers";
import { verifyGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import { getAppById, getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getProviderInstallationById } from "@tedix/db/queries/provider-installations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { tedisOs, withServiceAuth, createError, ErrorCodes } from "./helpers";

/** Secret-bearing internal response. Never exposed as a user or model tool. */
export const resolveEmbeddedHostDelegationProcedure =
	tedisOs.resolveEmbeddedHostDelegation
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const denied = () =>
				createError(
					ErrorCodes.FORBIDDEN,
					"Embedded provider delegation is not authorized",
				);
			if (
				context.authType !== "service-binding" ||
				context.headers.get("X-Tedix-Org-Id") !== input.organizationId ||
				context.headers.get("X-Tedix-Tedi-Id") !== input.tediId
			)
				throw denied();
			const [organization, tedi, app] = await Promise.all([
				getOrganizationById(context.db, input.organizationId),
				getTediByIdForOrganization(
					context.db,
					input.tediId,
					input.organizationId,
				),
				getAppById(context.db, input.sourceAppId),
			]);
			if (
				!organization?.descopeTenantId ||
				!tedi ||
				tedi.status !== "active" ||
				tedi.retiredAt ||
				!app?.organizationId ||
				app.visibility === "disabled"
			)
				throw denied();
			let claims;
			try {
				claims = await verifyGatewayBrowserToken(input.token, {
					secret: context.env.SECRETS_MASTER_KEY,
					expectedTediId: tedi.id,
					expectedTenantId: organization.descopeTenantId,
				});
			} catch {
				throw denied();
			}
			const delegation = claims.hostDelegation;
			const sourceConfig = getAppMetadataJson(app)?.mcpConfig;
			const sourceProviderId =
				sourceConfig?.openApiSync?.connectionProviderId ??
				sourceConfig?.connectionProviderId;
			const sourceScopes =
				sourceConfig?.openApiSync?.authScopes ??
				sourceConfig?.connectionScopes ??
				[];
			const config = sourceConfig?.embeddedHostDelegation as
				| { audience?: unknown }
				| undefined;
			if (
				!sourceProviderId ||
				!delegation ||
				!config ||
				config.audience !== input.audience ||
				delegation.audience !== input.audience ||
				claims.providerAppId !== app.id ||
				!claims.providerInstallationId ||
				!claims.hostUserId ||
				!claims.hostOrganizationId ||
				!claims.embeddedAssistantCallables?.includes(input.callable)
			)
				throw denied();
			const installation = await getProviderInstallationById(context.db, {
				organizationId: app.organizationId,
				installationId: claims.providerInstallationId,
			});
			if (
				!installation ||
				installation.status !== "active" ||
				installation.customerOrganizationId !== organization.id ||
				!providerWidgetAllowsTedi(installation, tedi.id) ||
				installation.providerAppId !== app.id ||
				installation.externalTenantId !== claims.hostOrganizationId ||
				installation.allowedOrigin !== claims.allowedOrigin ||
				installation.hostTenantNamespace !== claims.hostTenantNamespace ||
				!input.callable.startsWith(`${installation.hostTenantNamespace}.`)
			)
				throw denied();
			const sourceAuth = sourceConfig?.openApiSync;
			// OpenAPI projection owns its transport settings. A partial explicit
			// configuration must fail closed rather than switch credential formats.
			const hasSourceAuth =
				sourceAuth &&
				(sourceAuth.authHeader !== undefined ||
					sourceAuth.authTemplate !== undefined ||
					sourceAuth.authEncoding !== undefined);
			const profile = hasSourceAuth
				? sourceAuth
				: (
						await getConnectionProviderByDescopeAppId(
							context.db,
							sourceProviderId,
						)
					)?.credentialProfile;
			if (
				!profile?.authHeader ||
				!/^[A-Za-z0-9-]{1,100}$/.test(profile.authHeader) ||
				!profile.authTemplate ||
				/[\r\n]/.test(profile.authTemplate) ||
				!profile.authTemplate.includes("{token}")
			)
				throw denied();
			return {
				token: delegation.token,
				audience: delegation.audience,
				expiresAt: Math.min(delegation.expiresAt, claims.exp),
				providerOrganizationId: app.organizationId,
				connectionProviderId: sourceProviderId,
				connectionScopes: sourceScopes,
				authHeader: profile.authHeader,
				authTemplate: profile.authTemplate,
				...(profile.authEncoding ? { authEncoding: profile.authEncoding } : {}),
			};
		});
