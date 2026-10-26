import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import { type ConnectionProviderTemplate } from "@tedix/api-contract/schemas/connection-provider-templates";
import {
	applyConnectionCredentialTemplate,
	getConnectionProviderByDescopeAppId,
	getConnectionProviderById,
} from "@tedix/db/queries/connection-providers";
import { collectReferencedProviders } from "./provider-registration";
import {
	COMMON_IDENTITY_SCOPES,
	booleanOrNull,
	getUrlParam,
	inferOAuthRegistrationMode,
	inferOutboundConnectionType,
	isPrivateOrLoopbackUrl,
	logoKind,
	stringArray,
	stringOrNull,
	urlParamsArray,
	urlsEquivalent,
} from "./url-and-scopes";

export type ProviderAuditSeverity = "critical" | "warning" | "info";

export type ProviderAuditIssue = {
	severity: ProviderAuditSeverity;
	code: string;
	appId: string;
	message: string;
	details?: Record<string, unknown>;
};

export type ProviderAuditDiscovery = {
	protectedResourceMetadataUrl: string | null;
	authorizationServerMetadataUrl: string | null;
	resource: string | null;
	authorizationServer: string | null;
	authorizationUrl: string | null;
	tokenUrl: string | null;
	revocationUrl: string | null;
	dcrUrl: string | null;
	clientIdMetadataDocumentSupported: boolean;
	scopesSupported: string[];
	authorizationServerScopesSupported: string[];
	codeChallengeMethodsSupported: string[];
	tokenEndpointAuthMethodsSupported: string[];
	error: string | null;
};

export type AuditOutboundAppInput = {
	app: Record<string, unknown>;
	referencedByOrg: boolean;
	providerTemplate?: ConnectionProviderTemplate;
	discovery?: ProviderAuditDiscovery | null;
	/** Today as YYYY-MM-DD (UTC); a DCR exception is overdue once reviewBy is before it. */
	today?: string;
};

export function auditOutboundAppRecord(input: AuditOutboundAppInput) {
	const { app, referencedByOrg, providerTemplate, discovery } = input;
	const today = input.today ?? new Date().toISOString().slice(0, 10);
	const appId = stringOrNull(app.id) ?? "unknown";
	const name = stringOrNull(app.name) ?? appId;
	const appType = stringOrNull(app.appType);
	const connectionType = inferOutboundConnectionType(app);
	const supportedScopes =
		providerTemplate?.supportedScopes ??
		(connectionType === "oauth"
			? (["tenant", "user"] as const)
			: (["tenant"] as const));
	const recommendedScope =
		providerTemplate?.recommendedScope ??
		(connectionType === "oauth" ? "user" : "tenant");
	const authorizationUrlParams = urlParamsArray(app.authorizationUrlParams);
	const tokenUrlParams = urlParamsArray(app.tokenUrlParams);
	const clientId = stringOrNull(app.clientId);
	const settings = {
		registrationMode: inferOAuthRegistrationMode(app),
		useDcr: booleanOrNull(app.useDcr),
		dcrUrl: stringOrNull(app.dcrUrl),
		hasClientId: !!clientId,
		authorizationUrl: stringOrNull(app.authorizationUrl),
		tokenUrl: stringOrNull(app.tokenUrl),
		revocationUrl: stringOrNull(app.revocationUrl),
		pkce: booleanOrNull(app.pkce),
		defaultScopes: stringArray(app.defaultScopes),
		resourceParameter: getUrlParam(authorizationUrlParams, "resource"),
		tokenResourceParameter: getUrlParam(tokenUrlParams, "resource"),
		registrationProvenance: providerTemplate?.registrationProvenance ?? null,
		dcrReviewBy: providerTemplate?.dcrException?.reviewBy ?? null,
	};
	const issues: ProviderAuditIssue[] = [];
	const addIssue = (
		severity: ProviderAuditSeverity,
		code: string,
		message: string,
		details?: Record<string, unknown>,
	) =>
		issues.push({
			severity,
			code,
			appId,
			message,
			details,
		});
	if (logoKind(app.logo) === "missing" || logoKind(app.logo) === "invalid") {
		addIssue(
			"warning",
			"logo_not_renderable",
			"Outbound app has no renderable logo.",
			{
				logoKind: logoKind(app.logo),
			},
		);
	}
	if (connectionType === "api_key") {
		if (appType && appType !== "apikey") {
			addIssue(
				"warning",
				"api_key_app_type_mismatch",
				"API-key provider is not tagged as appType=apikey in Descope.",
				{
					appType,
				},
			);
		}
		if (
			settings.authorizationUrl ||
			settings.tokenUrl ||
			settings.hasClientId ||
			settings.useDcr === true ||
			settings.dcrUrl
		) {
			addIssue(
				"critical",
				"api_key_has_oauth_fields",
				"API-key provider contains OAuth/DCR fields and may be misclassified.",
			);
		}
		if (!providerTemplate?.credentialProfile) {
			addIssue(
				"warning",
				"api_key_missing_credential_profile",
				"API-key provider has no Tedix credential profile for safe Token Vault input handling.",
			);
		}
	} else {
		if (appType && appType !== "oauth") {
			addIssue(
				"warning",
				"oauth_app_type_mismatch",
				"OAuth provider is not tagged as appType=oauth in Descope.",
				{
					appType,
				},
			);
		}
		if (!settings.useDcr && !settings.hasClientId) {
			addIssue(
				"critical",
				"oauth_missing_client",
				"OAuth provider has neither DCR enabled nor a stored client ID.",
			);
		}
		// MCP 2026-07-28 deprecates DCR: every dynamically registered client
		// needs a recorded exception, reviewed by its date.
		const dcrRegistered =
			settings.registrationMode === "dcr" ||
			settings.registrationProvenance === "dcr_managed" ||
			settings.registrationProvenance === "dcr_direct";
		if (dcrRegistered && !providerTemplate?.dcrException) {
			addIssue(
				"warning",
				"dcr_exception_missing",
				"This connection uses Dynamic Client Registration without a recorded exception. Record why and a review date, or move it to a client ID metadata document.",
				{ registrationProvenance: settings.registrationProvenance },
			);
		} else if (
			dcrRegistered &&
			providerTemplate?.dcrException &&
			providerTemplate.dcrException.reviewBy < today
		) {
			addIssue(
				"warning",
				"dcr_exception_review_overdue",
				"The Dynamic Client Registration exception for this connection is past its review date.",
				{ reviewBy: providerTemplate.dcrException.reviewBy },
			);
		}
		if (settings.resourceParameter !== settings.tokenResourceParameter) {
			addIssue(
				"warning",
				"resource_parameter_mismatch",
				"Authorization and token resource parameters differ.",
				{
					authorizationResource: settings.resourceParameter,
					tokenResource: settings.tokenResourceParameter,
				},
			);
		}
		if (discovery?.error) {
			addIssue(
				"info",
				"oauth_metadata_discovery_failed",
				"Could not verify upstream MCP/OAuth metadata for this provider.",
				{
					error: discovery.error,
				},
			);
		} else if (discovery) {
			if (
				discovery.resource &&
				settings.resourceParameter &&
				!urlsEquivalent(settings.resourceParameter, discovery.resource)
			) {
				addIssue(
					"warning",
					"resource_parameter_drift",
					"Descope resource parameter differs from upstream protected-resource metadata.",
					{
						actual: settings.resourceParameter,
						expected: discovery.resource,
					},
				);
			}
			if (
				discovery.authorizationUrl &&
				settings.authorizationUrl &&
				!urlsEquivalent(settings.authorizationUrl, discovery.authorizationUrl)
			) {
				addIssue(
					"warning",
					"authorization_url_drift",
					"Descope authorization URL differs from upstream authorization-server metadata.",
					{
						actual: settings.authorizationUrl,
						expected: discovery.authorizationUrl,
					},
				);
			}
			if (
				discovery.tokenUrl &&
				settings.tokenUrl &&
				!urlsEquivalent(settings.tokenUrl, discovery.tokenUrl)
			) {
				addIssue(
					"warning",
					"token_url_drift",
					"Descope token URL differs from upstream authorization-server metadata.",
					{
						actual: settings.tokenUrl,
						expected: discovery.tokenUrl,
					},
				);
			}
			if (
				discovery.dcrUrl &&
				settings.useDcr !== true &&
				settings.registrationMode !== "cimd"
			) {
				addIssue(
					settings.hasClientId ? "warning" : "critical",
					"dcr_capable_static_client",
					"Upstream MCP authorization server advertises DCR, but Descope is storing a static OAuth client.",
					{
						dcrUrl: discovery.dcrUrl,
					},
				);
			}
			// MCP 2026-07-28 deprecates DCR: a provider that offers CIMD should
			// be migrated off its registered or static client.
			if (
				discovery.clientIdMetadataDocumentSupported &&
				settings.registrationMode !== "cimd"
			) {
				addIssue(
					"warning",
					"cimd_available_legacy_client",
					"Upstream authorization server supports client ID metadata documents, but this connection still uses a registered or static OAuth client.",
					{ registrationMode: settings.registrationMode },
				);
			}
			if (!discovery.dcrUrl && settings.useDcr === true) {
				addIssue(
					"critical",
					"dcr_enabled_without_registration_endpoint",
					"Descope has DCR enabled but upstream metadata does not advertise a registration endpoint.",
				);
			}
			if (
				discovery.codeChallengeMethodsSupported.includes("S256") &&
				settings.pkce !== true
			) {
				addIssue(
					"warning",
					"pkce_disabled",
					"Upstream authorization server supports S256 PKCE, but Descope has PKCE disabled.",
				);
			}
			if (
				discovery.scopesSupported.length === 0 &&
				settings.defaultScopes.length === 0
			) {
				addIssue(
					"info",
					"no_scopes_advertised",
					"Upstream protected resource does not advertise scopes and Descope has no default scopes.",
				);
			}
			if (discovery.scopesSupported.length > 0) {
				const advertised = new Set(discovery.scopesSupported);
				const unadvertised = settings.defaultScopes.filter(
					(scope) =>
						!advertised.has(scope) && !COMMON_IDENTITY_SCOPES.has(scope),
				);
				if (unadvertised.length > 0) {
					addIssue(
						"info",
						"scopes_not_advertised_by_resource",
						"Descope default scopes include scopes not advertised by the MCP protected resource.",
						{
							scopes: unadvertised,
						},
					);
				}
			}
		}
	}
	return {
		appId,
		name,
		appType,
		connectionType,
		referencedByOrg,
		logoKind: logoKind(app.logo),
		tokenScope: recommendedScope,
		supportedScopes,
		recommendedScope,
		settings,
		discovery: discovery ?? null,
		issues,
	};
}

export function auditProtectedResourceMetadataCandidates(
	resourceUrl: string,
): string[] {
	const parsed = new URL(resourceUrl);
	const path = parsed.pathname.replace(/\/+$/, "");
	return [
		`${parsed.origin}/.well-known/oauth-protected-resource${path && path !== "/" ? path : ""}`,
		`${parsed.origin}/.well-known/oauth-protected-resource`,
	].filter((value, index, values) => values.indexOf(value) === index);
}

export function auditAuthorizationServerMetadataCandidates(
	issuerUrl: string,
): string[] {
	const parsed = new URL(issuerUrl);
	const path = parsed.pathname.replace(/\/+$/, "");
	return [
		`${parsed.origin}/.well-known/oauth-authorization-server${path && path !== "/" ? path : ""}`,
		`${parsed.origin}/.well-known/oauth-authorization-server`,
	].filter((value, index, values) => values.indexOf(value) === index);
}

export async function fetchAuditJsonFromCandidates(
	candidates: string[],
	fetchFn: typeof fetch,
	label: string,
): Promise<{
	url: string;
	json: Record<string, unknown>;
}> {
	const errors: string[] = [];
	for (const url of candidates) {
		if (isPrivateOrLoopbackUrl(url)) {
			errors.push(`${url} -> blocked private/loopback URL`);
			continue;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const response = await fetchFn(url, {
				headers: {
					Accept: "application/json",
					"User-Agent": "Tedix Descope Outbound Audit/1.0 (+https://tedix.dev)",
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				errors.push(`${url} -> ${response.status}`);
				continue;
			}
			const json = (await response.json()) as unknown;
			if (!json || typeof json !== "object" || Array.isArray(json)) {
				errors.push(`${url} -> non-object JSON`);
				continue;
			}
			return {
				url,
				json: json as Record<string, unknown>,
			};
		} catch (error) {
			errors.push(
				`${url} -> ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error(`Unable to fetch ${label}: ${errors.join("; ")}`);
}

export function optionalUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		return new URL(value).toString();
	} catch {
		return null;
	}
}

/** Validate an issuer identifier without canonicalizing its exact spelling. */
function optionalIssuerUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		new URL(value);
		return value;
	} catch {
		return null;
	}
}

export async function discoverOutboundAppMetadataForAudit(
	resourceUrl: string,
	fetchFn: typeof fetch = fetch,
): Promise<ProviderAuditDiscovery> {
	try {
		const protectedResource = await fetchAuditJsonFromCandidates(
			auditProtectedResourceMetadataCandidates(resourceUrl),
			fetchFn,
			"OAuth protected-resource metadata",
		);
		const resource = optionalUrl(protectedResource.json.resource);
		const authorizationServers = stringArray(
			protectedResource.json.authorization_servers,
		);
		const authorizationServer = optionalIssuerUrl(authorizationServers[0]);
		if (!authorizationServer) {
			throw new Error(
				`${protectedResource.url} is missing authorization_servers[0]`,
			);
		}
		const authorizationMetadata = await fetchAuditJsonFromCandidates(
			auditAuthorizationServerMetadataCandidates(authorizationServer),
			fetchFn,
			"OAuth authorization-server metadata",
		);
		return {
			protectedResourceMetadataUrl: protectedResource.url,
			authorizationServerMetadataUrl: authorizationMetadata.url,
			resource,
			authorizationServer,
			authorizationUrl: optionalUrl(
				authorizationMetadata.json.authorization_endpoint,
			),
			tokenUrl: optionalUrl(authorizationMetadata.json.token_endpoint),
			revocationUrl: optionalUrl(
				authorizationMetadata.json.revocation_endpoint,
			),
			dcrUrl: optionalUrl(authorizationMetadata.json.registration_endpoint),
			clientIdMetadataDocumentSupported:
				authorizationMetadata.json.client_id_metadata_document_supported ===
				true,
			scopesSupported: stringArray(protectedResource.json.scopes_supported),
			authorizationServerScopesSupported: stringArray(
				authorizationMetadata.json.scopes_supported,
			),
			codeChallengeMethodsSupported: stringArray(
				authorizationMetadata.json.code_challenge_methods_supported,
			),
			tokenEndpointAuthMethodsSupported: stringArray(
				authorizationMetadata.json.token_endpoint_auth_methods_supported,
			),
			error: null,
		};
	} catch (error) {
		return {
			protectedResourceMetadataUrl: null,
			authorizationServerMetadataUrl: null,
			resource: null,
			authorizationServer: null,
			authorizationUrl: null,
			tokenUrl: null,
			revocationUrl: null,
			dcrUrl: null,
			clientIdMetadataDocumentSupported: false,
			scopesSupported: [],
			authorizationServerScopesSupported: [],
			codeChallengeMethodsSupported: [],
			tokenEndpointAuthMethodsSupported: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function composeApiKeyCredential(input: {
	db: BaseContext["db"];
	organizationId?: string;
	providerId: string;
	apiKey?: string;
	credentialFields?: Record<string, string>;
	env: CloudflareEnv;
}): Promise<string> {
	const provider = await getConnectionProviderByDescopeAppId(
		input.db,
		input.providerId,
	);
	const profile =
		provider?.credentialProfile ??
		(input.organizationId
			? (
					await collectReferencedProviders(input.db, input.organizationId, {
						includeToolReferences: false,
					})
				).credentialProfiles.get(input.providerId)
			: undefined);
	const fields = Object.fromEntries(
		Object.entries(input.credentialFields ?? {}).map(([key, value]) => [
			key,
			value.trim(),
		]),
	);
	if (profile?.inputFields) {
		for (const field of profile.inputFields) {
			if (field.defaultValue && !fields[field.name]) {
				fields[field.name] = field.defaultValue;
			}
			if (field.required !== false && !fields[field.name]) {
				if (input.apiKey?.trim() && profile.tokenTemplate === "{apiKey}") {
					continue;
				}
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Missing required credential field "${field.label}" for ${input.providerId}`,
				);
			}
		}
	}
	if (profile?.tokenTemplate && Object.keys(fields).length > 0) {
		try {
			return applyConnectionCredentialTemplate(profile.tokenTemplate, fields);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				error instanceof Error ? error.message : "Invalid credential fields",
			);
		}
	}
	const apiKey = input.apiKey?.trim();
	if (apiKey) return apiKey;
	throw createError(ErrorCodes.BAD_REQUEST, "API key credential is required");
}

export async function resolveConnectionProviderTemplate(input: {
	db: BaseContext["db"];
	providerId: string;
	baseProviderId?: string;
}): Promise<ConnectionProviderTemplate | undefined> {
	if (input.baseProviderId) {
		const baseProvider =
			(await getConnectionProviderById(input.db, input.baseProviderId)) ??
			(await getConnectionProviderByDescopeAppId(
				input.db,
				input.baseProviderId,
			));
		if (!baseProvider) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Unknown baseProviderId "${input.baseProviderId}"`,
			);
		}
		return baseProvider;
	}
	return (
		(await getConnectionProviderById(input.db, input.providerId)) ??
		(await getConnectionProviderByDescopeAppId(input.db, input.providerId))
	);
}
