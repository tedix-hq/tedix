import { decodeTokenUnsafe, isTokenExpired } from "@tedix/auth/jwt";
import {
	buildCimdAuthorizationUrl,
	generatePkceVerifier,
	sealOutboundMcpOAuthState,
} from "@tedix/auth/oauth-cimd-state";
import {
	TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
	TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
} from "@tedix/auth/oauth-client-registration";
import {
	AUTHZ,
	type BaseContext,
	ErrorCodes,
	createError,
	withAuthorization,
	withConnectionCredentialResolutionAuthority,
	userHoldsPermission,
} from "../../orpc";
import {
	buildConnectionProviderMaps,
	getConnectionProviderById,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";
import {
	deleteConnectionTokens,
	deleteTenantTokens,
	fetchConnectionToken,
	fetchPersonalConnectionToken,
	fetchNamedTenantConnectionToken,
	fetchConnectionTokenByScopes,
	fetchTenantConnectionToken,
	getAdaptiveConnectUrl,
	listUserConnectedAppIds,
} from "@tedix/auth/connections";
import {
	getOrganizationByDescopeId,
	getOrganizationById,
} from "@tedix/db/queries/organizations";
import { requireOrgId } from "../../org-scope";
import {
	getAppByIdForOrganization,
	getAppMetadataJson,
	updateAppMetadata,
} from "@tedix/db/queries/app-records";
import {
	createConnectionInstance as createConnectionInstanceRecord,
	getConnectionInstance,
	listConnectionInstances,
	renameConnectionInstance as renameConnectionInstanceRecord,
	clearConnectionGrants,
} from "@tedix/db/queries/connection-instances";
import {
	CredentialPreference,
	CredentialScope,
	auditOutboundAppRecord,
	authedOs,
	collectReferencedProviders,
	discoverOutboundAppMetadataForAudit,
	getDescopeManagement,
	getUrlParam,
	inferOAuthRegistrationMode,
	inferOutboundConnectionType,
	mapConnectionRecord,
	loadExistingStaticOAuthProvider,
	mcpOrAuthOs,
	requireUserId,
	resolveAdaptiveConnectUserToken,
	resolveConnectionConsentScopes,
	resolveCredentialChain,
	resolveProviderLogoUrl,
	stringOrNull,
	urlParamsArray,
} from "./policy-resolution";

// =============================================================================
// PROCEDURES
// =============================================================================

function connectionOwner(context: BaseContext, scope: "user" | "tenant") {
	const userId = requireUserId(context);
	const organizationId = requireOrgId(context);
	if (scope === "tenant") {
		if (!userHoldsPermission(context, "integrations:manage"))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Organization accounts require integrations:manage",
			);
		return { organizationId };
	}
	return { userId };
}

export const bindConnectionInstance = authedOs.bindConnectionInstance
	.use(AUTHZ.appsWrite)
	.handler(async ({ context, input }) => {
		const orgId = requireOrgId(context);
		const instance = await getConnectionInstance(
			context.db,
			connectionOwner(context, input.scope),
			input.connectionInstanceId,
			input.providerId,
		);
		if (!instance) throw createError(ErrorCodes.NOT_FOUND, "Account not found");
		const app = await getAppByIdForOrganization(context.db, input.appId, orgId);
		if (!app)
			throw createError(ErrorCodes.NOT_FOUND, "Installed app not found");
		const metadata = getAppMetadataJson(app);
		const mcpConfig = metadata?.mcpConfig;
		if (mcpConfig?.connectionProviderId !== input.providerId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Choose an app configured for this provider",
			);
		if (!context.env.MCP_SERVICE)
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Gateway activation is unavailable; account binding was not changed",
			);
		await updateAppMetadata(context.db, app.id, {
			mcpConfig: {
				...mcpConfig,
				connectionInstanceId: instance.id,
				connectionScope: input.scope,
			},
		});
		if (context.env.MCP_SERVICE) {
			const keys = [
				`mcp-subdomain:${app.slug}`,
				...[app.primaryDomain, app.customMcpDomain]
					.filter(Boolean)
					.map((domain) => `custom:${domain}`),
			];
			const response = await context.env.MCP_SERVICE.fetch(
				new Request("https://internal/__internal/purge-discovery-cache", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Service-Binding": "true",
					},
					body: JSON.stringify({ appId: app.id, appResolutionKeys: keys }),
				}),
			);
			if (
				!response.ok ||
				((await response.json()) as { ok?: boolean }).ok !== true
			)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Account binding saved; gateway refresh failed. Retry before using the app.",
				);
			const aggregateResponse = await context.env.MCP_SERVICE.fetch(
				new Request("https://internal/__internal/purge-aggregate-cache", {
					method: "POST",
					headers: { "X-Service-Binding": "true" },
				}),
			);
			if (
				!aggregateResponse.ok ||
				((await aggregateResponse.json()) as { ok?: boolean }).ok !== true
			)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Account binding saved; gateway refresh failed. Retry before using the app.",
				);
		}
		return { success: true as const };
	});

export const createConnectionInstance = authedOs.createConnectionInstance
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const orgId = requireOrgId(context);
		const userId = requireUserId(context);
		const owner = connectionOwner(context, input.scope);
		const references = await collectReferencedProviders(context.db, orgId);
		if (!references.ids.has(input.appId))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Provider is not installed in this workspace",
			);
		const provider = (await readConnectionProviders(context)).data.find(
			(p) => p.appId === input.appId,
		);
		if (
			provider?.connectionType !== "oauth" ||
			!provider.supportedScopes.includes(input.scope) ||
			provider.registrationMode === "cimd"
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Provider does not support named OAuth accounts",
			);
		if ((await listConnectionInstances(context.db, owner)).length >= 100)
			throw createError(ErrorCodes.BAD_REQUEST, "Account limit reached");
		const instance = await createConnectionInstanceRecord(context.db, {
			id: crypto.randomUUID(),
			ownerUserId: userId,
			...(input.scope === "tenant" ? { organizationId: orgId } : {}),
			providerId: input.appId,
			label: input.label,
		});
		return {
			id: instance.id,
			appId: instance.providerId,
			label: instance.label,
		};
	});

export const renameConnectionInstance = authedOs.renameConnectionInstance
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		requireOrgId(context);
		const rows = await renameConnectionInstanceRecord(
			context.db,
			connectionOwner(context, input.scope),
			input.id,
			input.label,
		);
		if (!rows.length)
			throw createError(ErrorCodes.NOT_FOUND, "Account not found");
		return { success: true as const };
	});

/** Called by the authenticated OS Worker before it creates an account-bound intent. */
export const preparePersonalConnection = authedOs.preparePersonalConnection
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const orgId = requireOrgId(context);
		const instance = await getConnectionInstance(
			context.db,
			connectionOwner(context, input.scope),
			input.connectionInstanceId,
			input.appId,
		);
		if (!instance) throw createError(ErrorCodes.NOT_FOUND, "Account not found");
		const references = await collectReferencedProviders(context.db, orgId);
		if (!references.ids.has(input.appId))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Provider is not installed in this workspace",
			);
		const provider = (await readConnectionProviders(context)).data.find(
			(p) => p.appId === input.appId,
		);
		if (
			provider?.connectionType !== "oauth" ||
			!provider.supportedScopes.includes(input.scope) ||
			provider.registrationMode === "cimd"
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Provider does not support named OAuth accounts",
			);
		const scopes = await resolveConnectionConsentScopes({
			db: context.db,
			orgId,
			providerId: input.appId,
			requestedScopes: input.scopes,
		});
		return {
			externalIdentifier: `tedix_${instance.id}`,
			userId: requireUserId(context),
			scopes: scopes ?? [],
		};
	});

/**
 * List available connection providers for the organization.
 *
 * Calls the Descope Management SDK loadAllApplications() to list
 * outbound apps configured for the project. Providers are configured
 * in the Descope console.
 */
export async function readConnectionProviders(context: BaseContext) {
	const orgId = requireOrgId(context);
	const client = getDescopeManagement(context.env);

	// Compute the set of provider IDs this org's apps actually reference,
	// and fetch every known provider template — both cheap to do in
	// parallel with the Descope outbound apps fetch below.
	try {
		const [response, referencedProviders, providers] = await Promise.all([
			client.management.outboundApplication.loadAllApplications(),
			collectReferencedProviders(context.db, orgId),
			listConnectionProviders(context.db),
		]);
		const { byDescopeAppId: providerMap } =
			buildConnectionProviderMaps(providers);
		if (!response.ok || !response.data) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Connection providers could not be verified",
			);
		}
		const apps = response.data;
		return {
			data: apps.map((app) => {
				// Don't trust Descope's `appType` field — every outbound app in the
				// project carries appType: "oauth" regardless of how it was created
				// (even pure API-key apps with no clientId,
				// no authorizationUrl, no tokenUrl have appType: "oauth"). Detect
				// real OAuth by the presence of OAuth-specific config instead.
				const a = app as typeof app & {
					useDcr?: boolean;
					dcrUrl?: string;
				};
				const isOAuth = !!(
					app.authorizationUrl ||
					app.discoveryUrl ||
					app.tokenUrl ||
					app.clientId ||
					a.useDcr
				);
				const connectionType = isOAuth
					? ("oauth" as const)
					: ("api_key" as const);
				const registrationMode = inferOAuthRegistrationMode(
					app as unknown as Record<string, unknown>,
					connectionType,
				);
				// The native CIMD callback settles directly into the tenant vault, so
				// it is organization-only. Descope-managed OAuth retains the provider
				// template's user/tenant policy; API keys default to shared org secrets.
				const defaultScopes: ("tenant" | "user")[] = isOAuth
					? ["tenant", "user"]
					: ["tenant"];
				const defaultRecommended: "tenant" | "user" = isOAuth
					? "user"
					: "tenant";
				const knownProvider = providerMap.get(app.id);
				const supportedScopes =
					registrationMode === "cimd"
						? (["tenant"] as ("tenant" | "user")[])
						: (knownProvider?.supportedScopes ?? defaultScopes);
				const recommendedScope =
					registrationMode === "cimd"
						? ("tenant" as const)
						: (knownProvider?.recommendedScope ?? defaultRecommended);
				const credentialProfile =
					knownProvider?.credentialProfile ??
					referencedProviders.credentialProfiles.get(app.id);
				const availableScopes =
					(app.defaultScopes?.length
						? app.defaultScopes
						: credentialProfile?.defaultScopes) ?? [];
				return {
					appId: app.id,
					name: app.name,
					description: app.description ?? null,
					enabled: true,
					availableScopes,
					logoUrl: resolveProviderLogoUrl({
						descopeLogo: app.logo,
						templateIcon: knownProvider?.icon,
					}),
					connectionType,
					registrationMode,
					tokenScope: recommendedScope,
					supportedScopes,
					recommendedScope,
					credentialProfile,
					referencedByOrg: referencedProviders.ids.has(app.id),
				};
			}),
		};
	} catch (error) {
		console.error("[Connections] Failed to list providers:", error);
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Connection providers could not be verified",
		);
	}
}

export const listProviders = authedOs.listProviders
	.use(AUTHZ.appsRead)
	.handler(({ context }) => readConnectionProviders(context));

export const auditProviderSettings = authedOs.auditProviderSettings
	.use(AUTHZ.platformAdmin)
	.handler(
		async ({
			context,
			input,
		}: {
			context: BaseContext;
			input?: {
				checkDiscovery?: boolean;
				includeUnreferenced?: boolean;
			};
		}) => {
			const orgId = requireOrgId(context);
			const client = getDescopeManagement(context.env);
			const [appsResponse, referencedProviders, providers] = await Promise.all([
				client.management.outboundApplication.loadAllApplications(),
				collectReferencedProviders(context.db, orgId),
				listConnectionProviders(context.db),
			]);
			const { byDescopeAppId: providerMap } =
				buildConnectionProviderMaps(providers);
			if (!appsResponse.ok || !appsResponse.data) {
				return {
					checkedAt: new Date().toISOString(),
					summary: {
						total: 0,
						oauth: 0,
						apiKey: 0,
						critical: 0,
						warning: 0,
						info: 0,
						ok: 0,
					},
					issues: [],
					apps: [],
				};
			}
			const checkDiscovery = input?.checkDiscovery ?? true;
			const includeUnreferenced = input?.includeUnreferenced ?? true;
			const audited = await Promise.all(
				appsResponse.data.map(async (rawApp) => {
					const app = rawApp as unknown as Record<string, unknown>;
					const appId = stringOrNull(app.id) ?? "";
					const providerTemplate = providerMap.get(appId);
					const referencedByOrg = referencedProviders.ids.has(appId);
					const isOAuth = inferOutboundConnectionType(app) === "oauth";
					const authResource = getUrlParam(
						urlParamsArray(app.authorizationUrlParams),
						"resource",
					);
					const tokenResource = getUrlParam(
						urlParamsArray(app.tokenUrlParams),
						"resource",
					);
					const templateResource = getUrlParam(
						providerTemplate?.oauthConfig?.authorizationUrlParams ?? [],
						"resource",
					);
					const resourceForDiscovery =
						authResource ?? tokenResource ?? templateResource;
					const discovery =
						checkDiscovery && isOAuth && resourceForDiscovery
							? await discoverOutboundAppMetadataForAudit(resourceForDiscovery)
							: null;
					return auditOutboundAppRecord({
						app,
						referencedByOrg,
						providerTemplate,
						discovery,
					});
				}),
			);
			const apps = includeUnreferenced
				? audited
				: audited.filter((app) => app.referencedByOrg);
			const issues = apps.flatMap((app) => app.issues);
			return {
				checkedAt: new Date().toISOString(),
				summary: {
					total: apps.length,
					oauth: apps.filter((app) => app.connectionType === "oauth").length,
					apiKey: apps.filter((app) => app.connectionType === "api_key").length,
					critical: issues.filter((issue) => issue.severity === "critical")
						.length,
					warning: issues.filter((issue) => issue.severity === "warning")
						.length,
					info: issues.filter((issue) => issue.severity === "info").length,
					ok: apps.filter((app) => app.issues.length === 0).length,
				},
				issues,
				apps,
			};
		},
	);

/**
 * Walk the org's apps + their tools (recursively through `aggregateApps`),
 * return the set of Descope outbound app IDs they reference. Sources:
 *
 *   1. App's `mcpConfig.connectionProviderId` (base/proxy provisioning default).
 *   2. App tools' `config.auth.connectionId` (tool-level auth).
 *   3. Same as (1) and (2) walked through every aggregated app, including
 *      platform base apps owned by other orgs (typically `org_tedix`).
 *
 * Recursion keeps aggregator bundles honest: if an app aggregates another
 * base app whose tools carry `auth.connectionId: "firecrawl"`,
 * the OS "Used by your apps" filter still shows Firecrawl.
 *
 * Bounded by a visited set to handle accidental cycles in `aggregateApps`.
 */

/**
 * List the authenticated user's active connections.
 *
 * Loads all Descope outbound apps and fans out tenant/user token checks.
 * API-key providers are stored in Descope Token Vault through the user/tenant
 * API-key upload endpoints; project-specific credentials are represented by
 * project-specific outbound app IDs.
 */
export const getUserConnections = authedOs.getUserConnections
	.use(AUTHZ.appsRead)
	.handler(async ({ context }: { context: BaseContext }) => {
		const orgId = requireOrgId(context);
		const userId = context.user?.sub;
		const client = getDescopeManagement(context.env);
		const [appsResponse, org, providers] = await Promise.all([
			client.management.outboundApplication.loadAllApplications(),
			getOrganizationById(context.db, orgId),
			listConnectionProviders(context.db),
		]);
		const { byDescopeAppId: providerMap } =
			buildConnectionProviderMaps(providers);
		if (!appsResponse.ok || !appsResponse.data) {
			return {
				data: [],
			};
		}
		const apps = appsResponse.data;
		const descopeTenantId = org?.descopeTenantId;
		const connections: ReturnType<typeof mapConnectionRecord>[] = [];

		// Fan out Descope token checks in parallel: tenant-scoped + user-scoped.
		// User-scope checks ONLY run for providers that actually support user
		// scope (OAuth, or registry-overridden) — otherwise we surface stale
		// API-key tokens that snuck in before scope validation tightened, which
		// then mislead Tedix OS into showing personal "connections" for
		// providers that should be tenant-only. Descope's connection-status list
		// lets us avoid probing every app for user tokens; when it cannot answer,
		// fall back to the legacy per-app probes to preserve visibility.
		if (apps.length > 0 && descopeTenantId) {
			const supportsUserScope = (app: (typeof apps)[number]) => {
				// Detect real OAuth by config (appType is unreliable — see comment
				// in `listProviders`). Registry override always wins when known.
				const a = app as typeof app & {
					useDcr?: boolean;
				};
				const isOAuth = !!(
					app.authorizationUrl ||
					app.discoveryUrl ||
					app.tokenUrl ||
					app.clientId ||
					a.useDcr
				);
				const known = providerMap.get(app.id);
				return known ? known.supportedScopes.includes("user") : isOAuth;
			};
			const [tenantChecks, connectedUserAppIds] = await Promise.all([
				Promise.resolve(
					apps.map((app) =>
						fetchTenantConnectionToken(client, app.id, descopeTenantId).catch(
							() => null,
						),
					),
				),
				userId
					? listUserConnectedAppIds(client, userId)
					: Promise.resolve(null),
			]);
			const userChecks = userId
				? apps.map((app) => {
						const shouldProbe =
							supportsUserScope(app) &&
							(connectedUserAppIds === null || connectedUserAppIds.has(app.id));
						return shouldProbe
							? fetchConnectionToken(client, app.id, userId).catch(() => null)
							: Promise.resolve(null);
					})
				: apps.map(() => Promise.resolve(null));
			const [tenantResults, userResults] = await Promise.all([
				Promise.all(tenantChecks),
				Promise.all(userChecks),
			]);
			const now = Math.floor(Date.now() / 1000);
			for (let i = 0; i < apps.length; i++) {
				const app = apps[i];
				if (!app) continue;
				const tenantToken = tenantResults[i];
				const userToken = userResults[i];
				if (tenantToken) {
					const expiresAt =
						typeof tenantToken.expiresAt === "number" &&
						tenantToken.expiresAt > 0
							? tenantToken.expiresAt
							: null;
					const isExpired = expiresAt != null && expiresAt < now;
					connections.push(
						mapConnectionRecord({
							appId: app.id,
							providerName: app.name,
							status: isExpired ? "expired" : "connected",
							connectedAt: null,
							tokenExpiresAt: expiresAt,
							scopes: Array.isArray(tenantToken.scopes)
								? tenantToken.scopes
								: [],
							tokenScope: "tenant",
						}),
					);
				}
				if (userToken) {
					const expiresAt =
						typeof userToken.expiresAt === "number" && userToken.expiresAt > 0
							? userToken.expiresAt
							: null;
					const isExpired = expiresAt != null && expiresAt < now;
					connections.push(
						mapConnectionRecord({
							appId: app.id,
							providerName: app.name,
							status: isExpired ? "expired" : "connected",
							connectedAt: null,
							tokenExpiresAt: expiresAt,
							scopes: Array.isArray(userToken.scopes) ? userToken.scopes : [],
							tokenScope: "user",
							connectedByUserId: userId,
							connectedByEmail: context.user?.email,
						}),
					);
				}
			}
		}
		return {
			data: connections,
		};
	});

/**
 * Initiate an OAuth connection flow.
 *
 * Legacy output shape retained for callers, but URL generation delegates to
 * Descope Adaptive Connect so provider-specific OAuth params are preserved.
 */

/**
 * Initiate an OAuth connection flow.
 *
 * Legacy output shape retained for callers, but URL generation delegates to
 * Descope Adaptive Connect so provider-specific OAuth params are preserved.
 */
export const initiateConnection = authedOs.initiateConnection
	// Adaptive Connect always writes the authenticated human's own credential.
	// It never creates or changes a tenant secret, so requiring
	// `integrations:manage` here would incorrectly make personal OAuth an
	// organization-administration action.
	.use(AUTHZ.appsRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
				scopes?: string | string[];
				redirectUri?: string;
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const userId = requireUserId(context);
			// The post-consent landing must be a route that actually exists. Tedix OS
			// owns /oauth/callback. This default only covers callers that
			// pass no redirectUri — i.e. non-browser callers: the OS client always
			// sends an explicit redirectUri built from window.location.origin,
			// because the callback's completion postMessage is filtered strictly
			// same-origin, so a tenant-host initiator ({slug}.os.tedix.dev) must
			// land back on its own host, not on this launcher-host default.
			const osBase = context.env.OS_URL || "https://os.tedix.dev";
			const redirectUrl = input.redirectUri ?? `${osBase}/oauth/callback`;
			const requestedScopes = await resolveConnectionConsentScopes({
				db: context.db,
				orgId,
				providerId: input.appId,
				requestedScopes: input.scopes,
			});
			const referencedProviders = await collectReferencedProviders(
				context.db,
				orgId,
			);
			if (!referencedProviders.ids.has(input.appId)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Connection provider is not installed for this organization",
				);
			}
			const provider = await loadExistingStaticOAuthProvider({
				env: context.env,
				providerId: input.appId,
			});
			if (provider?.clientId === TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID) {
				if (!userHoldsPermission(context, "integrations:manage")) {
					throw createError(
						ErrorCodes.FORBIDDEN,
						"CIMD consent creates an organization grant. Required: integrations:manage",
					);
				}
				const organization = await getOrganizationById(context.db, orgId);
				if (!organization?.descopeTenantId) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Organization has no Descope tenant binding",
					);
				}
				if (!provider.authorizationUrl || !provider.tokenUrl) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"CIMD provider is missing authorization or token endpoint",
					);
				}
				const pinned = await getConnectionProviderById(context.db, input.appId);
				if (!pinned?.pinnedIssuer) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"CIMD provider has no validated issuer pin",
					);
				}
				const resource = getUrlParam(
					provider.authorizationUrlParams ?? [],
					"resource",
				);
				if (!resource) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"CIMD provider has no RFC 8707 resource binding",
					);
				}
				const verifier = generatePkceVerifier();
				const state = await sealOutboundMcpOAuthState(
					{
						appId: input.appId,
						organizationId: orgId,
						tenantId: organization.descopeTenantId,
						grantedBy: userId,
						expectedIssuer: pinned.pinnedIssuer,
						issSupported: pinned.authorizationResponseIssSupported === true,
						tokenUrl: provider.tokenUrl,
						resource,
						redirectUrl,
						codeVerifier: verifier,
						scopes: requestedScopes ?? [],
					},
					context.env.SECRETS_MASTER_KEY,
				);
				return {
					redirectUrl: await buildCimdAuthorizationUrl({
						authorizationUrl: provider.authorizationUrl,
						clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
						redirectUri: TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
						state,
						codeVerifier: verifier,
						scopes: requestedScopes ?? [],
						additionalParams: provider.authorizationUrlParams,
					}),
					state,
				};
			}
			// Adaptive Connect calls Descope on the user's behalf and therefore needs
			// the original Descope session token. CIMD performs its own authorization
			// code + PKCE flow above, so requiring that raw token would break verified
			// user calls relayed through the MCP gateway, which intentionally forwards
			// identity and permissions rather than browser credentials.
			const userToken = resolveAdaptiveConnectUserToken(context.headers);
			if (!userToken) {
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"Initiating OAuth connections requires a Descope user session (Bearer JWT or DS cookie)",
				);
			}
			const state = crypto.randomUUID();
			// `getAdaptiveConnectUrl` throws a plain Error when Descope rejects the
			// connect call. Letting that escape produces an unshaped 500 that the
			// oRPC client cannot decode ("Malformed Orpc Error Response"), so the
			// operator sees no reason at all — only that Connect failed. Convert it
			// the way `requestAdaptiveConnect` already does, so the actual Descope
			// status and message reach the caller.
			let url: string;
			try {
				({ url } = await getAdaptiveConnectUrl(
					input.appId,
					redirectUrl,
					context.env,
					userToken,
					undefined,
					requestedScopes,
				));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Descope answers a rejected token with a generic
				// E061005 "Failed to find acceptable JWT token", which does not say
				// WHICH property it disliked. The forwarded credential passes this
				// API's own authentication, so the interesting question is how the
				// token Descope sees differs from one it would accept. Report the
				// deciding claims — never the token, and no user-identifying values.
				const claims = decodeTokenUnsafe(userToken);
				const tokenShape = claims
					? {
							iss: claims.iss || null,
							aud: Array.isArray(claims.aud)
								? claims.aud
								: claims.aud
									? [claims.aud]
									: [],
							expired: isTokenExpired(userToken),
							expiresInSeconds: claims.exp
								? claims.exp - Math.floor(Date.now() / 1000)
								: null,
						}
					: { undecodable: true };
				console.error("[Connections] Adaptive Connect failed", {
					appId: input.appId,
					scopeCount: requestedScopes?.length ?? 0,
					tokenShape,
					message,
				});
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					`Adaptive Connect failed for ${input.appId}: ${message} [token ${JSON.stringify(tokenShape)}]`,
				);
			}
			console.log(`[Connections] Initiated connection: appId=${input.appId}`);
			return {
				redirectUrl: url,
				state,
			};
		},
	);

/**
 * Disconnect a user's connection to a provider.
 *
 * Deletes stored OAuth tokens via the Descope management API.
 * Token deletion cannot be undone.
 */

/**
 * Disconnect a user's connection to a provider.
 *
 * Deletes stored OAuth tokens via the Descope management API.
 * Token deletion cannot be undone.
 */
export const disconnectProvider = authedOs.disconnectProvider
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler permits a signed-in member to remove only their own user-scoped OAuth credential and separately requires integration administration for tenant credentials.",
			},
			"apps:write",
		),
	)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
				tokenScope: "tenant" | "user";
				connectionInstanceId?: string;
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const userId = requireUserId(context);
			const requiredPermission =
				input.tokenScope === "user" ? "apps:read" : "integrations:manage";
			if (!userHoldsPermission(context, requiredPermission)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					`Insufficient permissions. Required: ${requiredPermission}`,
				);
			}
			const client = getDescopeManagement(context.env);
			const owner = connectionOwner(context, input.tokenScope);
			const org =
				input.tokenScope === "tenant"
					? await getOrganizationById(context.db, orgId)
					: null;
			if (
				input.connectionInstanceId &&
				input.tokenScope === "tenant" &&
				!org?.descopeTenantId
			)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Organization account verification is unavailable",
				);

			const fetchSelected = (id: string) =>
				input.tokenScope === "user"
					? fetchPersonalConnectionToken(context.env, {
							appId: input.appId,
							userId,
							externalIdentifier: `tedix_${id}`,
						})
					: org?.descopeTenantId
						? fetchNamedTenantConnectionToken(context.env, {
								appId: input.appId,
								tenantId: org.descopeTenantId,
								externalIdentifier: `tedix_${id}`,
							})
						: Promise.resolve(null);
			{
				if (input.connectionInstanceId) {
					const instance = await getConnectionInstance(
						context.db,
						owner,
						input.connectionInstanceId,
						input.appId,
					);
					if (!instance)
						throw createError(ErrorCodes.NOT_FOUND, "Account not found");
					// A wrong-account reconnect cannot be used, but its owner must
					// still be able to disconnect that exact slot and recover.
					const current = await fetchSelected(instance.id);
					for (const id of new Set([
						...instance.tokenIds,
						...(current?.id ? [current.id] : []),
					])) {
						const response =
							await client.management.outboundApplication.deleteTokenById(id);
						if (!response.ok && response.code !== 404)
							throw createError(
								ErrorCodes.SERVICE_UNAVAILABLE,
								"Account disconnect failed; retry to finish",
							);
					}
					// Different historical scope sets can have independent grants.
					// Drain the native selector, never a provider-wide user query.
					const seen = new Set(instance.tokenIds);
					if (current?.id) seen.add(current.id);
					for (;;) {
						const remaining = await fetchSelected(instance.id);
						if (!remaining) break;
						if (!remaining.id || seen.has(remaining.id) || seen.size >= 100)
							throw createError(
								ErrorCodes.SERVICE_UNAVAILABLE,
								"Account disconnect could not be fully verified; retry to finish",
							);
						seen.add(remaining.id);
						const response =
							await client.management.outboundApplication.deleteTokenById(
								remaining.id,
							);
						if (!response.ok && response.code !== 404)
							throw createError(
								ErrorCodes.SERVICE_UNAVAILABLE,
								"Account disconnect failed; retry to finish",
							);
					}
					await clearConnectionGrants(context.db, owner, instance.id);
				} else if (
					(await listConnectionInstances(context.db, owner)).some(
						(instance) => instance.providerId === input.appId,
					)
				) {
					// A provider-wide delete would also revoke every named account.
					const token =
						input.tokenScope === "user"
							? await fetchConnectionToken(client, input.appId, userId)
							: org?.descopeTenantId
								? await fetchTenantConnectionToken(
										client,
										input.appId,
										org.descopeTenantId,
									)
								: null;
					if (token?.id) {
						const response =
							await client.management.outboundApplication.deleteTokenById(
								token.id,
							);
						if (!response.ok && response.code !== 404)
							throw createError(
								ErrorCodes.SERVICE_UNAVAILABLE,
								"Account disconnect failed",
							);
					}
				} else if (input.tokenScope === "user")
					await deleteConnectionTokens(client, input.appId, userId);
				else {
					if (org?.descopeTenantId) {
						await deleteTenantTokens(client, input.appId, org.descopeTenantId);
					}
				}
			}
			console.log(
				`[Connections] Disconnected provider: appId=${input.appId} userId=${userId} scope=${input.tokenScope}`,
			);
			return {
				success: true as const,
				message: `Provider disconnected (${input.tokenScope} tokens deleted)`,
			};
		},
	);

/**
 * Fetch a fresh access token for a connected provider.
 *
 * Calls Descope's outboundApplication.fetchToken() (or fetchTokenByScopes()
 * when scopes are specified) to retrieve a current OAuth access token.
 * Descope handles refresh token rotation automatically.
 */

/**
 * Fetch a fresh access token for a connected provider.
 *
 * Calls Descope's outboundApplication.fetchToken() (or fetchTokenByScopes()
 * when scopes are specified) to retrieve a current OAuth access token.
 * Descope handles refresh token rotation automatically.
 */
export const fetchToken = authedOs.fetchToken.use(AUTHZ.platformAdmin).handler(
	async ({
		input,
		context,
	}: {
		input: {
			providerId: string;
			scopes?: string[];
		};
		context: BaseContext;
	}) => {
		requireOrgId(context);
		const userId = requireUserId(context);
		const client = getDescopeManagement(context.env);
		let token: Awaited<ReturnType<typeof fetchConnectionToken>> | null;
		if (input.scopes && input.scopes.length > 0) {
			// Use scope-filtered token retrieval
			token = await fetchConnectionTokenByScopes(
				client,
				input.providerId,
				userId,
				input.scopes,
			);
		} else {
			// Use standard token retrieval
			token = await fetchConnectionToken(client, input.providerId, userId);
		}
		if (!token) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`No active connection found for provider ${input.providerId}. User may need to connect first.`,
			);
		}
		if (!token.accessToken) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Token retrieval succeeded but access token is empty. The connection may need to be re-established.",
			);
		}
		console.log(
			`[Connections] Fetched token: providerId=${input.providerId} userId=${userId}`,
		);
		return {
			accessToken: token.accessToken,
			expiresAt: token.expiresAt ?? undefined,
			scopes: token.scopes ?? undefined,
		};
	},
);

// =============================================================================
// TEDI-SCOPED HELPERS
// =============================================================================

/**
 * Resolve the Descope tenant ID for a given tedi.
 * Looks up the tedi's organization, then returns the org's descopeTenantId.
 * Also verifies that the authenticated tedi matches the requested tediId (if auth type is "tedi").
 */

/**
 * Org/user credential lookup — no tedi required.
 *
 * Use when the caller is a human user (or any non-tedi context) and the
 * resolution doesn't need the tedi-owner-personal hop (Step 2 of the full
 * chain). Required for orgs that haven't created a tedi yet — the previous
 * "find any tedi to use as proxy" hop fails for tedi-less orgs.
 */
export const fetchOrgToken = mcpOrAuthOs.fetchOrgToken
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The credential-specific guard below preserves platform-only direct user access and validates MCP actor provenance.",
			},
			"connections.read",
		),
	)
	.use(withConnectionCredentialResolutionAuthority)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				organizationId: string;
				connectionInstanceId?: string;
				providerId: string;
				scopes?: string[];
				scope?: CredentialScope;
				preference?: CredentialPreference;
				userId?: string;
				label?: string;
			};
			context: BaseContext;
		}) => {
			// Accept either D1 UUID or Descope tenant id ("org_<slug>", "personal_<id>",
			// "T<id>") — the MCP edge passes the JWT's tenant claim verbatim from
			// callerIdentity, which is the Descope-id shape for human OAuth users.
			// Same translation pattern as `apps/api/src/rpc/orpc.ts` withAuth
			// service-binding header.
			const looksLikeDescopeTenantId = /^(org_|personal_|T\d)/.test(
				input.organizationId,
			);
			const org = looksLikeDescopeTenantId
				? await getOrganizationByDescopeId(context.db, input.organizationId)
				: await getOrganizationById(context.db, input.organizationId);
			if (!org) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Organization ${input.organizationId} not found`,
				);
			}

			// Org access check: caller's resolved orgId must match the target's
			// canonical D1 UUID, unless service-binding (trusted) or platform-admin.
			if (
				context.organizationId &&
				context.organizationId !== org.id &&
				context.authType !== "service-binding"
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Organization access denied for this resource",
				);
			}
			if (!org.descopeTenantId) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Organization does not have a Descope tenant configured",
				);
			}
			return resolveCredentialChain(context, {
				organizationId: org.id,
				descopeTenantId: org.descopeTenantId,
				providerId: input.providerId,
				scopes: input.scopes,
				connectionInstanceId: input.connectionInstanceId,
				scope: input.scope,
				preference: input.preference,
				callerUserId: input.userId,
				label: input.label,
				// no ownerUserId — this endpoint skips the tedi-owner step by design
			});
		},
	);
