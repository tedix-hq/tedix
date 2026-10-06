import {
	AUTHZ,
	type BaseContext,
	ErrorCodes,
	createError,
	createScopeMiddleware,
} from "../../orpc";
import { type ConnectionCredentialProfile } from "@tedix/api-contract/schemas/connection-provider-templates";
import { ORPCError } from "@orpc/server";
import {
	createConnectionProvider,
	createConnectionProviderWithId,
	deleteConnectionProvider,
	deleteTenantTokens,
	discoverMcpConnectionProvider,
	getAdaptiveConnectUrl,
	updateConnectionProviderMetadataWithId,
	uploadTenantApiKeyToken,
	upsertConnectionProviderWithId,
} from "@tedix/auth/connections";
import {
	getCatalogAppById,
	getCatalogAppBySlug,
} from "@tedix/db/queries/catalog/get-app";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { pinConnectionProviderIssuer } from "@tedix/db/queries/connection-providers";
import { requireOrgId } from "../../org-scope";
import {
	authedOs,
	buildProviderProvisioning,
	composeApiKeyCredential,
	DESCOPE_OUTBOUND_CALLBACK_DOMAIN,
	enforceConnectionProviderIssuerPin,
	getDescopeManagement,
	isDescopeDcrRegistrationError,
	isPrivateOrLoopbackUrl,
	loadExistingStaticOAuthProvider,
	normalizeProviderDescription,
	registerMcpOAuthClientForDescope,
	renderableLogoUrl,
	resolveAdaptiveConnectUserToken,
	resolveConnectionConsentScopes,
	resolveConnectionProviderTemplate,
	resolveTediTenantId,
	slugFromName,
	tediOs,
} from "./policy-resolution";

/**
 * Create a Descope outbound app from an upstream MCP protected resource.
 *
 * This is the operator-friendly path for catalog MCP apps: callers provide the
 * upstream MCP URL or a catalog app selector.
 */
export const createProviderFromMcp = authedOs.createProviderFromMcp
	.use(AUTHZ.integrationAppsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const catalogApp = input.catalogAppId
			? await getCatalogAppById(context.db, input.catalogAppId)
			: input.catalogAppSlug
				? await getCatalogAppBySlug(context.db, input.catalogAppSlug)
				: null;
		if ((input.catalogAppId || input.catalogAppSlug) && !catalogApp) {
			throw createError(ErrorCodes.NOT_FOUND, "Catalog app not found");
		}
		const mcpEndpointUrl =
			input.mcpEndpointUrl ??
			catalogApp?.mcpEndpointNormalized ??
			catalogApp?.baseUrl ??
			null;
		if (!mcpEndpointUrl) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"mcpEndpointUrl is required when the catalog app has no MCP endpoint",
			);
		}
		if (isPrivateOrLoopbackUrl(mcpEndpointUrl)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Private or loopback MCP URLs are not allowed",
			);
		}
		const name =
			input.name ??
			catalogApp?.name ??
			new URL(mcpEndpointUrl).hostname.replace(/^www\./, "");
		const providerId = input.id ?? catalogApp?.slug ?? slugFromName(name);
		const description = normalizeProviderDescription(
			input.description ?? catalogApp?.description,
		);
		const providerTemplate = await resolveConnectionProviderTemplate({
			db: context.db,
			providerId,
			baseProviderId: input.baseProviderId,
		});
		const logo =
			renderableLogoUrl(input.logo) ??
			renderableLogoUrl(providerTemplate?.icon) ??
			renderableLogoUrl(catalogApp?.logoUrl) ??
			undefined;
		const baseConfig = {
			name,
			...(description
				? {
						description,
					}
				: {}),
			...(logo
				? {
						logo,
					}
				: {}),
		};
		const catalogAuthTypes = new Set(catalogApp?.authTypes ?? []);
		const connectionType =
			input.connectionType === "oauth" || input.connectionType === "api_key"
				? input.connectionType
				: catalogAuthTypes.has("API_KEY") && !catalogAuthTypes.has("OAUTH")
					? "api_key"
					: (providerTemplate?.type ?? "oauth");
		const connectionScopes =
			input.connectionScopes ??
			input.defaultScopes ??
			providerTemplate?.credentialProfile?.defaultScopes;
		if (connectionType === "api_key") {
			const credentialProfile = providerTemplate?.credentialProfile;
			const outputConfig = {
				id: providerId,
				type: "api_key" as const,
				...baseConfig,
				...(credentialProfile
					? {
							credentialProfile,
						}
					: {}),
			};
			const provisioning = buildProviderProvisioning({
				providerId,
				baseProviderId: input.baseProviderId,
				connectionType,
				connectionScope: input.connectionScope,
				connectionScopes,
				providerTemplate,
				credentialProfile,
			});
			if (input.dryRun ?? false) {
				return {
					dryRun: true,
					created: false,
					status: "dry_run" as const,
					appId: providerId,
					name,
					config: outputConfig,
					provisioning,
					discovery: null,
					warnings: [
						"API-key provider created only; upload the actual tenant or user credential with connections.storeApiKey so Descope Token Vault becomes the runtime source of truth.",
					],
				};
			}
			const result =
				(input.upsertExisting ?? true)
					? await upsertConnectionProviderWithId(
							providerId,
							outputConfig,
							context.env,
						)
					: {
							...(await createConnectionProviderWithId(
								providerId,
								outputConfig,
								context.env,
							)),
							status: "created" as const,
						};
			console.log(
				`[Connections] ${result.status} API-key MCP provider: appId=${result.id} name=${name}`,
			);
			return {
				dryRun: false,
				created: result.status === "created",
				status: result.status,
				appId: result.id,
				name,
				config: outputConfig,
				provisioning,
				discovery: null,
				warnings: [
					"API-key provider created only; upload the actual tenant or user credential with connections.storeApiKey so Descope Token Vault becomes the runtime source of truth.",
				],
			};
		}
		const oauthCredentialProfile = providerTemplate?.credentialProfile;
		// Discovery talks to an untrusted upstream: its metadata can be missing,
		// unfetchable, or non-compliant (e.g. an RFC 8414 §3.3 issuer mismatch,
		// which `assertDiscoveredIssuerMatches` refuses on purpose). Those are
		// caller-actionable input problems, not server faults — surfacing them as
		// a bare 500 tells the operator nothing and hides the one line that
		// explains what to do (pin the endpoints explicitly via
		// `connections.createProvider`). Re-throw ORPCErrors untouched so real
		// internal failures keep their own status.
		let discovered: Awaited<ReturnType<typeof discoverMcpConnectionProvider>>;
		try {
			discovered = await discoverMcpConnectionProvider({
				mcpEndpointUrl,
				id: providerId,
				name,
				description,
				logo,
				defaultScopes: connectionScopes,
				includeResourceParameter: input.includeResourceParameter ?? true,
			});
		} catch (error) {
			if (error instanceof ORPCError) throw error;
			const detail =
				error instanceof Error ? error.message : "unknown discovery failure";
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`OAuth discovery failed for ${mcpEndpointUrl}: ${detail} — ` +
					"if the upstream metadata is non-compliant but the server is trusted, " +
					"create the provider with explicit endpoints via connections.createProvider " +
					"(authorizationUrl, tokenUrl, useDcr + dcrUrl) instead of auto-discovery.",
			);
		}

		// ADR tedi-client-oauth-cimd phase 1a: issuer pinning. The first
		// successful discovery pinned the validated authorization-server issuer
		// on the provider row; a rescan/reconnect that resolves this provider to
		// a DIFFERENT issuer is refused fail-closed (authorization-server-binding
		// rule) instead of silently re-provisioning credentials against the new
		// AS. Legacy rows (or no row) have no pin and behave as before; they get
		// pinned on this discovery's success.
		await enforceConnectionProviderIssuerPin({
			db: context.db,
			providerId,
			discoveredIssuer: discovered.discovery.authorizationServer,
		});
		// Persisted only on the non-dry-run success paths below, after Descope
		// provisioning succeeds — a failed provision leaves no pin behind.
		const persistIssuerPin = () =>
			pinConnectionProviderIssuer(context.db, {
				id: providerId,
				issuer: discovered.discovery.authorizationServer,
				authorizationResponseIssSupported:
					discovered.discovery.authorizationResponseIssParameterSupported,
				name,
				description: description ?? null,
				icon: logo ?? null,
			});
		const outputConfig = {
			id: providerId,
			type: "oauth" as const,
			name: discovered.config.name,
			...(discovered.config.description
				? {
						description: discovered.config.description,
					}
				: {}),
			...(discovered.config.logo
				? {
						logo: discovered.config.logo,
					}
				: {}),
			...(discovered.config.clientId
				? {
						clientId: discovered.config.clientId,
					}
				: {}),
			...(discovered.config.clientSecret
				? {
						clientSecret: discovered.config.clientSecret,
					}
				: {}),
			...(discovered.config.authorizationUrl
				? {
						authorizationUrl: discovered.config.authorizationUrl,
					}
				: {}),
			...(discovered.config.authorizationUrlParams
				? {
						authorizationUrlParams: discovered.config.authorizationUrlParams,
					}
				: {}),
			...(discovered.config.tokenUrl
				? {
						tokenUrl: discovered.config.tokenUrl,
					}
				: {}),
			...(discovered.config.tokenUrlParams
				? {
						tokenUrlParams: discovered.config.tokenUrlParams,
					}
				: {}),
			...(discovered.config.revocationUrl
				? {
						revocationUrl: discovered.config.revocationUrl,
					}
				: {}),
			...(discovered.config.discoveryUrl
				? {
						discoveryUrl: discovered.config.discoveryUrl,
					}
				: {}),
			...(discovered.config.pkce !== undefined
				? {
						pkce: discovered.config.pkce,
					}
				: {}),
			...(discovered.config.defaultScopes
				? {
						defaultScopes: discovered.config.defaultScopes,
					}
				: {}),
			...(discovered.config.defaultRedirectUrl
				? {
						defaultRedirectUrl: discovered.config.defaultRedirectUrl,
					}
				: {}),
			...(discovered.config.callbackDomain
				? {
						callbackDomain: discovered.config.callbackDomain,
					}
				: {}),
			...(discovered.config.accessType
				? {
						accessType: discovered.config.accessType,
					}
				: {}),
			...(discovered.config.prompt
				? {
						prompt: discovered.config.prompt,
					}
				: {}),
			...(discovered.config.useDcr !== undefined
				? {
						useDcr: discovered.config.useDcr,
					}
				: {}),
			...(discovered.config.dcrUrl
				? {
						dcrUrl: discovered.config.dcrUrl,
					}
				: {}),
			...(oauthCredentialProfile
				? {
						credentialProfile: oauthCredentialProfile,
					}
				: {}),
		};
		const staticOAuthClientPolicy = input.staticOAuthClientPolicy ?? "preserve";
		const provisioning = buildProviderProvisioning({
			providerId,
			baseProviderId: input.baseProviderId,
			connectionType,
			connectionScope: input.connectionScope,
			connectionScopes: discovered.config.defaultScopes ?? connectionScopes,
			providerTemplate,
			credentialProfile: oauthCredentialProfile,
		});
		if (input.dryRun ?? false) {
			return {
				dryRun: true,
				created: false,
				status: "dry_run" as const,
				appId: providerId,
				name,
				config: outputConfig,
				provisioning,
				discovery: discovered.discovery,
				warnings: discovered.warnings,
			};
		}
		const existingStaticProvider =
			input.upsertExisting === false
				? null
				: await loadExistingStaticOAuthProvider({
						env: context.env,
						providerId,
					});
		if (
			existingStaticProvider &&
			discovered.config.useDcr &&
			discovered.config.dcrUrl &&
			staticOAuthClientPolicy === "preserve"
		) {
			const effectiveExistingConfig = {
				...existingStaticProvider,
				...(oauthCredentialProfile
					? {
							credentialProfile: oauthCredentialProfile,
						}
					: {}),
			};
			discovered.warnings.push(
				"Existing static OAuth client found in Descope; Tedix left the stored client secret untouched and treated the MCP provider as reconciled.",
			);
			console.log(
				`[Connections] reconciled existing MCP-derived provider: appId=${providerId} name=${name}`,
			);
			await persistIssuerPin();
			return {
				dryRun: false,
				created: false,
				status: "updated" as const,
				appId: providerId,
				name,
				config: effectiveExistingConfig,
				provisioning,
				discovery: discovered.discovery,
				warnings: discovered.warnings,
			};
		}
		if (
			existingStaticProvider &&
			discovered.config.useDcr &&
			discovered.config.dcrUrl &&
			staticOAuthClientPolicy === "migrate_to_dcr"
		) {
			discovered.warnings.push(
				"Existing static OAuth client found in Descope; attempting operator-requested DCR migration and leaving the existing client untouched if Descope DCR fails.",
			);
		}
		let effectiveOutputConfig = outputConfig;
		let result: {
			id: string;
			status: "created" | "updated";
		};
		if (staticOAuthClientPolicy === "re_register_static") {
			if (!discovered.config.useDcr || !discovered.config.dcrUrl) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Provider ${providerId} does not advertise Dynamic Client Registration, so Tedix cannot re-register its OAuth client`,
				);
			}
			const dcrClient = await registerMcpOAuthClientForDescope({
				dcrUrl: discovered.config.dcrUrl,
				name,
				tokenEndpointAuthMethodsSupported:
					discovered.discovery.tokenEndpointAuthMethodsSupported,
			});
			const replacementConfig = {
				...outputConfig,
				clientId: dcrClient.clientId,
				...(dcrClient.clientSecret
					? {
							clientSecret: dcrClient.clientSecret,
						}
					: {}),
				callbackDomain: DESCOPE_OUTBOUND_CALLBACK_DOMAIN,
				useDcr: false,
			};
			result =
				(input.upsertExisting ?? true)
					? await upsertConnectionProviderWithId(
							providerId,
							replacementConfig,
							context.env,
						)
					: {
							...(await createConnectionProviderWithId(
								providerId,
								replacementConfig,
								context.env,
							)),
							status: "created" as const,
						};
			const { clientSecret: _clientSecret, ...redactedReplacementConfig } =
				replacementConfig;
			effectiveOutputConfig = redactedReplacementConfig;
			discovered.warnings.push(
				"Tedix intentionally re-registered the upstream OAuth client with the canonical custom-domain callback and stored the replacement client without exposing its secret.",
			);
		} else {
			try {
				result =
					(input.upsertExisting ?? true)
						? await upsertConnectionProviderWithId(
								providerId,
								outputConfig,
								context.env,
							)
						: {
								...(await createConnectionProviderWithId(
									providerId,
									outputConfig,
									context.env,
								)),
								status: "created" as const,
							};
			} catch (error) {
				if (
					!isDescopeDcrRegistrationError(error) ||
					!discovered.config.useDcr ||
					!discovered.config.dcrUrl
				) {
					throw error;
				}
				if (staticOAuthClientPolicy === "migrate_to_dcr") {
					throw createError(
						ErrorCodes.BAD_GATEWAY,
						`Descope DCR migration failed for ${providerId}; existing static OAuth client was left unchanged: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const dcrClient = await registerMcpOAuthClientForDescope({
					dcrUrl: discovered.config.dcrUrl,
					name,
					tokenEndpointAuthMethodsSupported:
						discovered.discovery.tokenEndpointAuthMethodsSupported,
				});
				const fallbackConfig = {
					...outputConfig,
					clientId: dcrClient.clientId,
					...(dcrClient.clientSecret
						? {
								clientSecret: dcrClient.clientSecret,
							}
						: {}),
					callbackDomain: DESCOPE_OUTBOUND_CALLBACK_DOMAIN,
					useDcr: false,
				};
				result =
					(input.upsertExisting ?? true)
						? await upsertConnectionProviderWithId(
								providerId,
								fallbackConfig,
								context.env,
							)
						: {
								...(await createConnectionProviderWithId(
									providerId,
									fallbackConfig,
									context.env,
								)),
								status: "created" as const,
							};
				const { clientSecret: _clientSecret, ...redactedFallbackConfig } =
					fallbackConfig;
				effectiveOutputConfig = redactedFallbackConfig;
				discovered.warnings.push(
					"Descope DCR failed for this MCP server, so Tedix registered the upstream OAuth client directly and stored the resulting client in Descope without exposing the client secret.",
				);
			}
		}
		console.log(
			`[Connections] ${result.status} MCP-derived provider: appId=${result.id} name=${name}`,
		);
		await persistIssuerPin();
		return {
			dryRun: false,
			created: result.status === "created",
			status: result.status,
			appId: result.id,
			name,
			config: effectiveOutputConfig,
			provisioning,
			discovery: discovered.discovery,
			warnings: discovered.warnings,
		};
	});

/**
 * Update non-secret display metadata for an existing Descope outbound app.
 *
 * This intentionally does not recreate providers and does not touch OAuth
 * client settings or token-vault credentials. Use it for logo/name/description
 * drift between catalog apps and Descope's connection surface.
 */

/**
 * Update non-secret display metadata for an existing Descope outbound app.
 *
 * This intentionally does not recreate providers and does not touch OAuth
 * client settings or token-vault credentials. Use it for logo/name/description
 * drift between catalog apps and Descope's connection surface.
 */
export const updateProviderMetadata = authedOs.updateProviderMetadata
	.use(AUTHZ.integrationAppsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		// Connection providers are project-global Descope outbound apps with no
		// org-ownership ledger yet, so update-by-appId has no org boundary to
		// enforce. Until per-org ownership lands, only platform principals may
		// mutate a provider — otherwise a tenant admin could rename another
		// tenant's provider. See audit finding #13 (hybrid remediation).
		if (!isPlatformPrincipal(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Updating connection providers is restricted to platform administrators until per-org provider ownership ships.",
			);
		}
		const result = await updateConnectionProviderMetadataWithId(
			input.appId,
			{
				name: input.name,
				description: input.description,
				logo: input.logo,
				defaultScopes: input.defaultScopes,
			},
			context.env,
		);
		console.log(`[Connections] Updated provider metadata: appId=${result.id}`);
		return {
			appId: result.id,
			success: true as const,
		};
	});

/**
 * Delete a connection provider (Descope Outbound Application).
 *
 * Irreversible — removes the provider and all associated token storage.
 */

/**
 * Delete a connection provider (Descope Outbound Application).
 *
 * Irreversible — removes the provider and all associated token storage.
 */
export const deleteProvider = authedOs.deleteProvider
	.use(AUTHZ.integrationAppsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
			};
			context: BaseContext;
		}) => {
			requireOrgId(context);
			// Irreversible and project-global: deleting a provider removes the
			// Descope outbound app and all associated token storage for EVERY
			// tenant. With no org-ownership ledger yet, a tenant admin could
			// delete another tenant's provider. Restrict to platform principals
			// until per-org ownership ships. See audit finding #2 (hybrid).
			if (!isPlatformPrincipal(context)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Deleting connection providers is restricted to platform administrators until per-org provider ownership ships.",
				);
			}
			const client = getDescopeManagement(context.env);
			await deleteConnectionProvider(client, input.appId);
			console.log(`[Connections] Deleted provider: appId=${input.appId}`);
			return {
				success: true as const,
				message: "Provider deleted",
			};
		},
	);

// =============================================================================
// TEDI-SCOPED PROVIDER MANAGEMENT
// =============================================================================

/**
 * Create a connection provider scoped to a specific tedi.
 *
 * Uses tedi JWT authentication. Registers a new Descope Outbound Application
 * that the tedi can later connect to and store tokens for.
 */

// =============================================================================
// TEDI-SCOPED PROVIDER MANAGEMENT
// =============================================================================

/**
 * Create a connection provider scoped to a specific tedi.
 *
 * Uses tedi JWT authentication. Registers a new Descope Outbound Application
 * that the tedi can later connect to and store tokens for.
 */
export const createTediProvider = tediOs.createTediProvider
	.use(createScopeMiddleware("apps:write"))
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				tediId: string;
				name: string;
				description?: string;
				logo?: string;
				type: "oauth" | "api_key";
				clientId?: string;
				clientSecret?: string;
				authorizationUrl?: string;
				tokenUrl?: string;
				discoveryUrl?: string;
				pkce?: boolean;
				defaultScopes?: string[];
				credentialProfile?: ConnectionCredentialProfile;
			};
			context: BaseContext;
		}) => {
			await resolveTediTenantId(context, input.tediId);
			const result = await createConnectionProvider(context.env, {
				name: input.name,
				type: input.type,
				description: input.description,
				logo: input.logo,
				clientId: input.clientId,
				clientSecret: input.clientSecret,
				authorizationUrl: input.authorizationUrl,
				tokenUrl: input.tokenUrl,
				discoveryUrl: input.discoveryUrl,
				pkce: input.pkce,
				defaultScopes: input.defaultScopes,
				credentialProfile: input.credentialProfile,
			});
			console.log(
				`[Connections] Created tedi provider: appId=${result.id} name=${input.name} tediId=${input.tediId}`,
			);
			return {
				appId: result.id,
				name: input.name,
			};
		},
	);

/**
 * Store an API key for a tedi-scoped connection provider.
 */

/**
 * Store an API key for a tedi-scoped connection provider.
 */
export const storeTediApiKey = tediOs.storeTediApiKey
	.use(createScopeMiddleware("apps:write"))
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				tediId: string;
				providerId: string;
				apiKey?: string;
				credentialFields?: Record<string, string>;
			};
			context: BaseContext;
		}) => {
			const { organizationId, descopeTenantId } = await resolveTediTenantId(
				context,
				input.tediId,
			);
			const apiKey = await composeApiKeyCredential({
				db: context.db,
				organizationId,
				providerId: input.providerId,
				apiKey: input.apiKey,
				credentialFields: input.credentialFields,
				env: context.env,
			});
			await uploadTenantApiKeyToken(getDescopeManagement(context.env), {
				appId: input.providerId,
				tenantId: descopeTenantId,
				apiKey,
			});
			return {
				success: true as const,
				message: "API key stored in Descope Token Vault",
			};
		},
	);

/**
 * Disconnect a tedi from a connection provider.
 *
 * Uses tedi JWT authentication. Deletes stored tokens for the given provider
 * within the tedi's organization tenant scope.
 */

/**
 * Disconnect a tedi from a connection provider.
 *
 * Uses tedi JWT authentication. Deletes stored tokens for the given provider
 * within the tedi's organization tenant scope.
 */
export const disconnectTediProvider = tediOs.disconnectTediProvider
	.use(createScopeMiddleware("apps:write"))
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				tediId: string;
				appId: string;
			};
			context: BaseContext;
		}) => {
			const { descopeTenantId } = await resolveTediTenantId(
				context,
				input.tediId,
			);
			const client = getDescopeManagement(context.env);
			await deleteTenantTokens(client, input.appId, descopeTenantId);
			console.log(
				`[Connections] Disconnected tedi provider: appId=${input.appId} tediId=${input.tediId}`,
			);
			return {
				success: true as const,
				message: "Provider disconnected and tokens deleted",
			};
		},
	);

// =============================================================================
// SCOPE ESCALATION
// =============================================================================

/**
 * Adaptive Connect — get an OAuth authorization URL for a connection.
 *
 * Forwards the user's raw JWT to Descope's Adaptive Connect endpoint
 * (`POST /v1/mgmt/outbound/app/connect`). Returns a URL to redirect the user
 * through the provider's OAuth flow. Only works with Bearer JWT auth.
 */

// =============================================================================
// SCOPE ESCALATION
// =============================================================================

/**
 * Adaptive Connect — get an OAuth authorization URL for a connection.
 *
 * Forwards the user's raw JWT to Descope's Adaptive Connect endpoint
 * (`POST /v1/mgmt/outbound/app/connect`). Returns a URL to redirect the user
 * through the provider's OAuth flow. Only works with Bearer JWT auth.
 */
export const adaptiveConnect = authedOs.adaptiveConnect
	.use(AUTHZ.integrationAppsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
				redirectUrl: string;
				tenantId?: string;
				scopes?: string[];
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			if (input.tenantId && !isPlatformPrincipal(context)) {
				const organization = await getOrganizationById(context.db, orgId);
				if (organization?.descopeTenantId !== input.tenantId) {
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Adaptive Connect tenant does not belong to the caller organization",
					);
				}
			}

			// Adaptive Connect requires the raw user JWT, forwarded as-is. A bearer
			// header carries it for explicit bearer callers; the broker-backed OS
			// browser path sends none, so the `DS` cookie — the same JWT verbatim —
			// is the fallback.
			const userToken = resolveAdaptiveConnectUserToken(context.headers);
			if (!userToken) {
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"Adaptive Connect requires a Descope user session (Bearer JWT or DS cookie)",
				);
			}
			const requestedScopes = await resolveConnectionConsentScopes({
				db: context.db,
				orgId,
				providerId: input.appId,
				requestedScopes: input.scopes,
			});
			let url: string;
			try {
				({ url } = await getAdaptiveConnectUrl(
					input.appId,
					input.redirectUrl,
					context.env,
					userToken,
					input.tenantId,
					requestedScopes,
				));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[Connections] Adaptive Connect failed", {
					appId: input.appId,
					hasTenantId: Boolean(input.tenantId),
					message,
				});
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					`Adaptive Connect failed for ${input.appId}: ${message}`,
				);
			}
			console.log(
				`[Connections] Adaptive Connect URL requested: appId=${input.appId}`,
			);
			return {
				url,
			};
		},
	);

// =============================================================================
// ROUTER
// =============================================================================
