import { DESCOPE_SESSION_COOKIE, readCookieHeader } from "@tedix/auth/web";
import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
	withTediAuth,
} from "../../orpc";
import {
	type ConnectionCredentialProfile,
	type ConnectionProviderTemplate,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import { ConnectionCredentialProfileSchema } from "@tedix/api-contract/schemas/connections";
import { validateUrl } from "@tedix/ssrf-guard";
import { DESCOPE_DEFAULT_BASE_URL } from "@tedix/auth/types";
import {
	IssuerPinDriftError,
	assertPinnedIssuerMatches,
} from "@tedix/auth/oauth-iss";
import {
	applyConnectionCredentialTemplate,
	buildConnectionProviderMaps,
	getConnectionProviderByDescopeAppId,
	getConnectionProviderById,
	getConnectionProviderIssuerPin,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";
import { connectionsContract } from "@tedix/api-contract/contracts/connections";
import {
	ConnectionTokenLookupError,
	fetchConnectionToken,
	fetchConnectionTokenByScopes,
	fetchPersonalConnectionToken,
	fetchNamedTenantConnectionToken,
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
	outboundAppExists,
} from "@tedix/auth/connections";
import { getManagementClient } from "@tedix/auth/client";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getConnectionInstance,
	recordConnectionGrant,
} from "@tedix/db/queries/connection-instances";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import { implement } from "@orpc/server";
import {
	listAppReferenceMetadataByOrganization,
	listAppReferenceMetadataByIds,
	listAppReferenceMetadataBySlugs,
} from "@tedix/db/queries/apps";
import { listToolConnectionReferencesByAppIds } from "@tedix/db/queries/tools";

export const connectionsOs =
	implement(connectionsContract).$context<BaseContext>();

export const authedOs = connectionsOs.use(withAuth);

export const mcpOrAuthOs = connectionsOs.use(withAuth);

export const tediOs = connectionsOs.use(withTediAuth);

// =============================================================================
// HELPERS
// =============================================================================

export // =============================================================================
// HELPERS
// =============================================================================

function requireUserId(context: BaseContext): string {
	const userId = context.user?.sub;
	if (!userId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "User identity required");
	}
	return userId;
}

export function getDescopeManagement(env: CloudflareEnv) {
	if (!env.DESCOPE_MANAGEMENT_KEY) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management key not configured",
		);
	}
	return getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	});
}

/**
 * True when a provider MCP endpoint / audit URL must not be fetched. Shared
 * guard: every private/loopback/link-local/metadata IP form, localhost and
 * local-resolution suffixes, unparseable and non-http(s) URLs. Tedix-served
 * endpoints (`{slug}.mcp.tedix.dev`) stay reachable, as before.
 */
export function isPrivateOrLoopbackUrl(url: string): boolean {
	return validateUrl(url, { allowHttp: true, allowTedixHosts: true }) !== null;
}

export function slugFromName(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "mcp-provider";
}

export function renderableLogoUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return trimmed;
	return null;
}

export function resolveProviderLogoUrl(input: {
	descopeLogo?: unknown;
	templateIcon?: unknown;
}): string | null {
	return (
		renderableLogoUrl(input.descopeLogo) ??
		renderableLogoUrl(input.templateIcon)
	);
}

export function parseScopesField(
	scopes: string[] | string | null | undefined,
): string[] {
	if (!scopes) return [];
	if (Array.isArray(scopes)) return scopes;
	try {
		const parsed = JSON.parse(scopes) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(scope): scope is string => typeof scope === "string",
			);
		}
	} catch {
		// Fall through to the legacy comma/whitespace format.
	}
	return scopes
		.split(/[,\s]+/)
		.map((scope) => scope.trim())
		.filter(Boolean);
}

export function normalizeRequestedScopes(
	scopes: string | string[] | null | undefined,
): string[] | undefined {
	const parsed = parseScopesField(scopes);
	if (parsed.length === 0) return undefined;
	return [...new Set(parsed.map((scope) => scope.trim()).filter(Boolean))];
}

export function chooseEffectiveConsentScopes(input: {
	requestedScopes?: string | string[] | null;
	connectionScopes?: string[];
	credentialProfile?: ConnectionCredentialProfile | null;
	provider?: ConnectionProviderTemplate | null;
}): string[] | undefined {
	return (
		normalizeRequestedScopes(input.requestedScopes) ??
		normalizeRequestedScopes(input.connectionScopes) ??
		normalizeRequestedScopes(input.credentialProfile?.defaultScopes) ??
		normalizeRequestedScopes(
			input.provider?.credentialProfile?.defaultScopes,
		) ??
		normalizeRequestedScopes(input.provider?.requiredScopes)
	);
}

export function mapConnectionRecord(input: {
	appId: string;
	providerName: string;
	status: "connected" | "expired" | "revoked";
	connectedAt: number | null;
	tokenExpiresAt: number | null;
	scopes: string[] | string | null | undefined;
	tokenScope?: "tenant" | "user";
	connectedByUserId?: string | null;
	connectedByEmail?: string | null;
}) {
	return {
		appId: input.appId,
		providerName: input.providerName,
		status: input.status,
		connectedAt: input.connectedAt,
		tokenExpiresAt: input.tokenExpiresAt,
		scopes: parseScopesField(input.scopes),
		tokenScope: input.tokenScope ?? ("tenant" as const),
		connectedByUserId: input.connectedByUserId ?? null,
		connectedByEmail: input.connectedByEmail ?? null,
	};
}

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
};

export function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

export function booleanOrNull(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function urlParamsArray(value: unknown): Array<{
	key: string;
	value: string;
}> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const candidate = item as {
			key?: unknown;
			value?: unknown;
		};
		if (
			typeof candidate.key !== "string" ||
			typeof candidate.value !== "string"
		) {
			return [];
		}
		return [
			{
				key: candidate.key,
				value: candidate.value,
			},
		];
	});
}

export function getUrlParam(
	params: Array<{
		key: string;
		value: string;
	}>,
	key: string,
): string | null {
	return params.find((param) => param.key === key)?.value ?? null;
}

export function inferOutboundConnectionType(
	app: Record<string, unknown>,
): "oauth" | "api_key" {
	const useDcr = booleanOrNull(app.useDcr);
	return app.appType === "oauth" ||
		stringOrNull(app.authorizationUrl) ||
		stringOrNull(app.discoveryUrl) ||
		stringOrNull(app.tokenUrl) ||
		stringOrNull(app.clientId) ||
		useDcr === true
		? "oauth"
		: "api_key";
}

export function inferOAuthRegistrationMode(
	app: Record<string, unknown>,
	connectionType = inferOutboundConnectionType(app),
): "cimd" | "dcr" | "pre_registered" | "invalid" | null {
	if (connectionType !== "oauth") return null;
	const clientId = stringOrNull(app.clientId);
	if (clientId === TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID) return "cimd";
	if (booleanOrNull(app.useDcr) === true) return "dcr";
	return clientId ? "pre_registered" : "invalid";
}

export function logoKind(
	value: unknown,
): "data" | "url" | "missing" | "invalid" {
	if (typeof value !== "string" || value.trim().length === 0) return "missing";
	const trimmed = value.trim();
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return "data";
	if (/^https?:\/\//i.test(trimmed)) return "url";
	return "invalid";
}

export function comparableUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
		return `${url.origin}${path}${url.search}${url.hash}`;
	} catch {
		return value.replace(/\/+$/, "");
	}
}

export function urlsEquivalent(a: string | null, b: string | null): boolean {
	return comparableUrl(a) === comparableUrl(b);
}

export const COMMON_IDENTITY_SCOPES = new Set([
	"openid",
	"email",
	"profile",
	"offline_access",
	"https://www.googleapis.com/auth/userinfo.profile",
]);

export function auditOutboundAppRecord(input: AuditOutboundAppInput) {
	const { app, referencedByOrg, providerTemplate, discovery } = input;
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

export const PROVIDER_DESCRIPTION_MAX_LENGTH = 254;
// Tedix-fallback DCR redirect. Must use the same Descope host as the providers'
// default callbackDomain (DESCOPE_DEFAULT_BASE_URL, the custom domain) so the
// registered redirect and the authorize redirect agree — otherwise OAuth fails
// with redirect_uri mismatch on the useDcr:false fallback path.
export const DESCOPE_OUTBOUND_CALLBACK_DOMAIN = new URL(
	DESCOPE_DEFAULT_BASE_URL,
).host;
const DESCOPE_OUTBOUND_CALLBACK_URL = `${DESCOPE_DEFAULT_BASE_URL}/v1/outbound/oauth/callback`;

export function normalizeProviderDescription(
	description?: string | null,
): string | undefined {
	const normalized = description?.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (normalized.length <= PROVIDER_DESCRIPTION_MAX_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, PROVIDER_DESCRIPTION_MAX_LENGTH - 3).trimEnd()}...`;
}

export function isDescopeDcrRegistrationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	return (
		message.includes("E152006") ||
		normalized.includes("dynamic client registration") ||
		normalized.includes("oauth metadata with url fetch failed")
	);
}

export async function registerMcpOAuthClientForDescope(input: {
	dcrUrl: string;
	name: string;
	tokenEndpointAuthMethodsSupported?: string[];
	fetchFn?: typeof fetch;
}): Promise<{
	clientId: string;
	clientSecret?: string;
	tokenEndpointAuthMethod: string;
	expiresAt?: number;
}> {
	const fetchFn = input.fetchFn ?? fetch;
	const supportedMethods = input.tokenEndpointAuthMethodsSupported ?? [];
	const tokenEndpointAuthMethod = supportedMethods.includes(
		"client_secret_post",
	)
		? "client_secret_post"
		: supportedMethods.includes("none")
			? "none"
			: "client_secret_post";
	const response = await fetchFn(input.dcrUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			client_name: `Tedix ${input.name} AIH`,
			redirect_uris: [DESCOPE_OUTBOUND_CALLBACK_URL],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: tokenEndpointAuthMethod,
		}),
	});
	const bodyText = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Upstream MCP DCR registration failed (${response.status}): ${bodyText.slice(0, 300) || "(no body)"}`,
		);
	}
	const clientId = typeof body.client_id === "string" ? body.client_id : null;
	const clientSecret =
		typeof body.client_secret === "string" ? body.client_secret : undefined;
	if (!clientId) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Upstream MCP DCR response missing client_id",
		);
	}
	if (tokenEndpointAuthMethod !== "none" && !clientSecret) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Upstream MCP DCR response missing client_secret",
		);
	}
	const expiresAt =
		typeof body.client_secret_expires_at === "number"
			? body.client_secret_expires_at
			: undefined;
	return {
		clientId,
		clientSecret,
		tokenEndpointAuthMethod,
		expiresAt,
	};
}

export function hasStaticOAuthOutboundAppShape(app: unknown): boolean {
	if (!app || typeof app !== "object") return false;
	const candidate = app as {
		authorizationUrl?: unknown;
		clientId?: unknown;
		tokenUrl?: unknown;
		useDcr?: unknown;
	};
	return (
		candidate.useDcr === false &&
		typeof candidate.clientId === "string" &&
		candidate.clientId.length > 0 &&
		(typeof candidate.authorizationUrl === "string" ||
			typeof candidate.tokenUrl === "string")
	);
}

export async function loadExistingStaticOAuthProvider(input: {
	env: CloudflareEnv;
	providerId: string;
}) {
	const client = getDescopeManagement(input.env);
	const response =
		await client.management.outboundApplication.loadAllApplications();
	if (!response.ok || !response.data) return null;
	const rawExisting = response.data.find((app) => app.id === input.providerId);
	if (!hasStaticOAuthOutboundAppShape(rawExisting)) return null;
	const existing = rawExisting as {
		id: string;
		name: string;
		description?: string;
		logo?: string;
		clientId?: string;
		authorizationUrl?: string;
		authorizationUrlParams?: Array<{
			key: string;
			value: string;
		}>;
		tokenUrl?: string;
		tokenUrlParams?: Array<{
			key: string;
			value: string;
		}>;
		revocationUrl?: string;
		discoveryUrl?: string;
		pkce?: boolean;
		defaultScopes?: string[];
		defaultRedirectUrl?: string;
		callbackDomain?: string;
		accessType?: "offline" | "online";
		prompt?: Array<"none" | "login" | "consent" | "select_account">;
		dcrUrl?: string;
	};
	return {
		id: existing.id,
		name: existing.name,
		...(existing.description
			? {
					description: existing.description,
				}
			: {}),
		...(existing.logo
			? {
					logo: existing.logo,
				}
			: {}),
		type: "oauth" as const,
		...(existing.clientId
			? {
					clientId: existing.clientId,
				}
			: {}),
		...(existing.authorizationUrl
			? {
					authorizationUrl: existing.authorizationUrl,
				}
			: {}),
		...(existing.authorizationUrlParams?.length
			? {
					authorizationUrlParams: existing.authorizationUrlParams,
				}
			: {}),
		...(existing.tokenUrl
			? {
					tokenUrl: existing.tokenUrl,
				}
			: {}),
		...(existing.tokenUrlParams?.length
			? {
					tokenUrlParams: existing.tokenUrlParams,
				}
			: {}),
		...(existing.revocationUrl
			? {
					revocationUrl: existing.revocationUrl,
				}
			: {}),
		...(existing.discoveryUrl
			? {
					discoveryUrl: existing.discoveryUrl,
				}
			: {}),
		...(existing.pkce !== undefined
			? {
					pkce: existing.pkce,
				}
			: {}),
		...(existing.defaultScopes?.length
			? {
					defaultScopes: existing.defaultScopes,
				}
			: {}),
		...(existing.defaultRedirectUrl
			? {
					defaultRedirectUrl: existing.defaultRedirectUrl,
				}
			: {}),
		...(existing.callbackDomain
			? {
					callbackDomain: existing.callbackDomain,
				}
			: {}),
		...(existing.accessType
			? {
					accessType: existing.accessType,
				}
			: {}),
		...(existing.prompt?.length
			? {
					prompt: existing.prompt,
				}
			: {}),
		useDcr: false,
		...(existing.dcrUrl
			? {
					dcrUrl: existing.dcrUrl,
				}
			: {}),
	};
}

export function buildProviderProvisioning(input: {
	providerId: string;
	baseProviderId?: string;
	connectionType: "oauth" | "api_key";
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
	providerTemplate?: ConnectionProviderTemplate;
	credentialProfile?: ConnectionCredentialProfile;
}) {
	const supportedScopes = input.providerTemplate?.supportedScopes ?? [
		"tenant",
		"user",
	];
	const recommendedScope =
		input.providerTemplate?.recommendedScope ??
		(input.connectionType === "api_key" ? "tenant" : "user");
	const connectionScope = input.connectionScope ?? recommendedScope;
	if (
		connectionScope === "hybrid" &&
		(!supportedScopes.includes("user") || !supportedScopes.includes("tenant"))
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Provider "${input.providerId}" does not support hybrid credentials`,
		);
	}
	if (
		connectionScope !== "hybrid" &&
		!supportedScopes.includes(connectionScope)
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Provider "${input.providerId}" does not support ${connectionScope}-scoped credentials`,
		);
	}
	const connectionScopes = input.connectionScopes?.length
		? input.connectionScopes
		: undefined;
	return {
		connectionProviderId: input.providerId,
		baseProviderId: input.providerTemplate?.id ?? input.baseProviderId ?? null,
		connectionType: input.connectionType,
		supportedScopes,
		recommendedScope,
		connectionScope,
		...(connectionScopes
			? {
					connectionScopes,
				}
			: {}),
		credentialProfile: input.credentialProfile ?? null,
		mcpConfig: {
			connectionProviderId: input.providerId,
			connectionScope,
			...(connectionScopes
				? {
						connectionScopes,
					}
				: {}),
		},
	};
}

// =============================================================================
// PROCEDURES
// =============================================================================

/**
 * List available connection providers for the organization.
 *
 * Calls the Descope Management SDK loadAllApplications() to list
 * outbound apps configured for the project. Providers are configured
 * in the Descope console.
 */

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
type ReferencedProviders = {
	references: Map<
		string,
		Array<{
			appId: string;
			appSlug: string;
			source: "app" | "tool" | "aggregate";
		}>
	>;
	complete: boolean;
	ids: Set<string>;
	credentialProfiles: Map<string, ConnectionCredentialProfile>;
	connectionScopes: Map<string, string[]>;
};

export function readCredentialProfile(
	value: unknown,
): ConnectionCredentialProfile | null {
	const parsed = ConnectionCredentialProfileSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function rememberReferencedProvider(
	referenced: ReferencedProviders,
	providerId: unknown,
	profileValue?: unknown,
	scopesValue?: unknown,
): void {
	if (typeof providerId !== "string" || providerId.length === 0) return;
	referenced.ids.add(providerId);
	if (!referenced.credentialProfiles.has(providerId)) {
		const profile = readCredentialProfile(profileValue);
		if (profile) referenced.credentialProfiles.set(providerId, profile);
	}
	const scopes = Array.isArray(scopesValue)
		? normalizeRequestedScopes(
				scopesValue.filter(
					(scope): scope is string => typeof scope === "string",
				),
			)
		: undefined;
	if (scopes) {
		referenced.connectionScopes.set(providerId, [
			...new Set([
				...(referenced.connectionScopes.get(providerId) ?? []),
				...scopes,
			]),
		]);
	}
}

export async function collectReferencedProviders(
	db: BaseContext["db"],
	orgId: string,
	options: { includeToolReferences?: boolean } = {},
): Promise<ReferencedProviders> {
	const referenced: ReferencedProviders = {
		references: new Map(),
		complete: true,
		ids: new Set<string>(),
		credentialProfiles: new Map<string, ConnectionCredentialProfile>(),
		connectionScopes: new Map<string, string[]>(),
	};
	const visited = new Set<string>();
	try {
		let appWave: Array<{
			id: string;
			slug: string;
			metadata: unknown;
		}> = await listAppReferenceMetadataByOrganization(db, orgId);
		while (appWave.length > 0) {
			const currentApps: typeof appWave = [];
			for (const app of appWave) {
				if (visited.has(app.slug) || visited.has(app.id)) continue;
				visited.add(app.slug);
				visited.add(app.id);
				currentApps.push(app);
			}
			if (currentApps.length === 0) break;

			const aggregateSlugs: string[] = [];
			// Entries that carry a stable `appId` follow it; only older entries
			// without one are followed by slug.
			const aggregateIds: string[] = [];
			for (const app of currentApps) {
				const recordReference = (id: unknown, source: "app" | "aggregate") => {
					if (typeof id !== "string" || !id) return;
					const refs = referenced.references.get(id) ?? [];
					refs.push({ appId: app.id, appSlug: app.slug, source });
					referenced.references.set(id, refs);
				};
				const mcpConfig = (app.metadata as Record<string, unknown> | null)
					?.mcpConfig as Record<string, unknown> | undefined;
				const openApiSync = mcpConfig?.openApiSync as
					| Record<string, unknown>
					| undefined;
				recordReference(
					mcpConfig?.connectionProviderId ?? openApiSync?.connectionProviderId,
					"app",
				);
				rememberReferencedProvider(
					referenced,
					mcpConfig?.connectionProviderId ?? openApiSync?.connectionProviderId,
					mcpConfig?.credentialProfile ?? openApiSync?.credentialProfile,
					mcpConfig?.connectionScopes ?? openApiSync?.authScopes,
				);
				const aggregateApps = mcpConfig?.aggregateApps as
					| Array<{
							slug?: string;
							appId?: string;
							connectionProviderId?: string;
							connectionScopes?: string[];
							credentialProfile?: unknown;
					  }>
					| undefined;
				for (const entry of aggregateApps ?? []) {
					recordReference(entry.connectionProviderId, "aggregate");
					rememberReferencedProvider(
						referenced,
						entry.connectionProviderId,
						entry.credentialProfile,
						entry.connectionScopes,
					);
					if (typeof entry.appId === "string" && entry.appId) {
						if (!visited.has(entry.appId)) aggregateIds.push(entry.appId);
					} else if (entry.slug && !visited.has(entry.slug)) {
						aggregateSlugs.push(entry.slug);
					}
				}
			}

			if (options.includeToolReferences !== false) {
				const tools = await listToolConnectionReferencesByAppIds(
					db,
					currentApps.map((app) => app.id),
				);
				for (const tool of tools) {
					if (tool.connectionId) {
						const app = currentApps.find((a) => a.id === tool.appId);
						if (app) {
							const refs = referenced.references.get(tool.connectionId) ?? [];
							if (!refs.some((r) => r.appId === app.id && r.source === "tool"))
								refs.push({ appId: app.id, appSlug: app.slug, source: "tool" });
							referenced.references.set(tool.connectionId, refs);
						}
						rememberReferencedProvider(referenced, tool.connectionId);
					}
				}
			}

			appWave = [
				...(await listAppReferenceMetadataBySlugs(db, aggregateSlugs)),
				...(aggregateIds.length > 0
					? await listAppReferenceMetadataByIds(db, aggregateIds)
					: []),
			];
		}
	} catch (error) {
		referenced.complete = false;
		console.warn(
			"[Connections] Failed to collect referenced provider ids (non-fatal):",
			error,
		);
	}
	return referenced;
}

export async function resolveConnectionConsentScopes(input: {
	db: BaseContext["db"];
	orgId: string;
	providerId: string;
	requestedScopes?: string | string[];
}): Promise<string[] | undefined> {
	const requestedScopes = normalizeRequestedScopes(input.requestedScopes);
	if (requestedScopes) return requestedScopes;

	const [referenced, providers] = await Promise.all([
		collectReferencedProviders(input.db, input.orgId, {
			includeToolReferences: false,
		}),
		listConnectionProviders(input.db),
	]);
	const { byDescopeAppId } = buildConnectionProviderMaps(providers);
	return chooseEffectiveConsentScopes({
		connectionScopes: referenced.connectionScopes.get(input.providerId),
		credentialProfile: referenced.credentialProfiles.get(input.providerId),
		provider: byDescopeAppId.get(input.providerId),
	});
}

/**
 * List the authenticated user's active connections.
 *
 * Loads all Descope outbound apps and fans out tenant/user token checks.
 * API-key providers are stored in Descope Token Vault through the user/tenant
 * API-key upload endpoints; project-specific credentials are represented by
 * project-specific outbound app IDs.
 */

export // =============================================================================
// TEDI-SCOPED HELPERS
// =============================================================================

/**
 * Resolve the Descope tenant ID for a given tedi.
 * Looks up the tedi's organization, then returns the org's descopeTenantId.
 * Also verifies that the authenticated tedi matches the requested tediId (if auth type is "tedi").
 */
async function resolveTediTenantId(
	context: BaseContext,
	tediId: string,
): Promise<{
	organizationId: string;
	descopeTenantId: string;
}> {
	// Guard: if authenticated via tedi access key, verify the tedi matches
	if (
		context.authType === "tedi" &&
		context.tediId &&
		context.tediId !== tediId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi access key does not match the requested tediId",
		);
	}

	// Look up the tedi's organization
	const tediOrgId = await getTediOrganizationId(context.db, tediId);
	if (!tediOrgId) {
		throw createError(ErrorCodes.NOT_FOUND, `Tedi ${tediId} not found`);
	}

	// Verify org ownership: the authenticated org must match the tedi's org
	if (context.organizationId && context.organizationId !== tediOrgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi does not belong to the authenticated organization",
		);
	}

	// Get the organization to find its Descope tenant ID
	const org = await getOrganizationById(context.db, tediOrgId);
	if (!org) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Organization ${tediOrgId} not found for tedi`,
		);
	}
	if (!org.descopeTenantId) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Organization does not have a Descope tenant configured",
		);
	}
	return {
		organizationId: tediOrgId,
		descopeTenantId: org.descopeTenantId,
	};
}

// =============================================================================
// TEDI-SCOPED PROCEDURES
// =============================================================================

/**
 * Fetch a connection token on behalf of a tedi.
 *
 * Uses scope-aware token retrieval from Descope Token Vault.
 * Supports tk_ access keys, service tokens, and all standard auth methods.
 */

export // =============================================================================
// TEDI-SCOPED PROCEDURES
// =============================================================================

/**
 * Fetch a connection token on behalf of a tedi.
 *
 * Uses scope-aware token retrieval from Descope Token Vault.
 * Supports tk_ access keys, service tokens, and all standard auth methods.
 */
type CredentialScope = "tenant" | "user" | "hybrid";

/**
 * Resolve the raw Descope user JWT for an Adaptive Connect call.
 *
 * Descope's connect endpoint is called as `Bearer {projectId}:{userToken}` and
 * must act AS the user, so it needs that user's own session JWT — a management
 * key cannot stand in.
 *
 * Direct bearer callers send it in `Authorization`. Browser user-session
 * callers, including Tedix OS, arrive through a trusted Worker boundary that
 * canonicalizes the host-only product session to the `DS` cookie before
 * forwarding. `orpc.ts` authenticates that same cookie as the user, so reading
 * its JWT here grants no authority the caller did not already hold.
 *
 * Returns null when neither source yields something JWT-shaped, leaving the
 * caller to raise its own 401 rather than handing Descope a junk credential.
 */
export function resolveAdaptiveConnectUserToken(
	headers: Headers,
): string | null {
	const authHeader =
		headers.get("Authorization") ?? headers.get("authorization");
	const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
	if (bearer?.startsWith("eyJ")) return bearer;
	const cookieToken = readCookieHeader(
		headers.get("Cookie") ?? headers.get("cookie"),
		DESCOPE_SESSION_COOKIE,
	);
	return cookieToken?.startsWith("eyJ") ? cookieToken : null;
}

export type CredentialPreference = "user-first" | "tenant-first";

export type CredentialResolutionTarget =
	| {
			kind: "user";
			source: "caller" | "owner";
			userId: string;
	  }
	| {
			kind: "tenant";
			tenantId: string;
	  };

export function buildCredentialResolutionTargets(args: {
	descopeTenantId: string;
	scope?: CredentialScope;
	preference?: CredentialPreference;
	callerUserId?: string;
	ownerUserId?: string | null;
	/** Whether the acting human owns the target organization. */
	actingUserOwnsOrganization?: boolean;
}): CredentialResolutionTarget[] {
	const scope = args.scope ?? "tenant";
	const userTargets: CredentialResolutionTarget[] = [];
	// A user-scoped connection is always the authenticated human's personal
	// credential. In particular, never substitute a Tedi owner's credential for
	// another human: doing so would let a guest execute an external call as that
	// owner. Hybrid keeps its explicit user-first opt-in for visiting operators.
	const callerPersonalAllowed =
		scope === "user" ||
		args.actingUserOwnsOrganization === true ||
		(scope === "hybrid" && args.preference === "user-first");
	if (args.callerUserId && callerPersonalAllowed) {
		userTargets.push({
			kind: "user",
			source: "caller",
			userId: args.callerUserId,
		});
	}
	if (
		args.ownerUserId &&
		// A Tedi may use its owner credential when there is no authenticated
		// human caller. Once a human is present, user scope is strictly theirs.
		!(scope === "user" && args.callerUserId) &&
		!userTargets.some(
			(target) => target.kind === "user" && target.userId === args.ownerUserId,
		)
	) {
		userTargets.push({
			kind: "user",
			source: "owner",
			userId: args.ownerUserId,
		});
	}
	const tenantTarget: CredentialResolutionTarget = {
		kind: "tenant",
		tenantId: args.descopeTenantId,
	};
	if (scope === "user") return userTargets;
	if (scope === "hybrid") {
		const effectivePreference =
			args.preference ??
			(args.actingUserOwnsOrganization === true
				? "user-first"
				: "tenant-first");
		return effectivePreference === "tenant-first"
			? [tenantTarget, ...userTargets]
			: [...userTargets, tenantTarget];
	}
	return [tenantTarget];
}

/** Suffixes that distinguish a credential-vault outbound app id from its base
 * provider name (e.g. `promptwatch-api-key` → base `promptwatch`). */

export /** Suffixes that distinguish a credential-vault outbound app id from its base
 * provider name (e.g. `promptwatch-api-key` → base `promptwatch`). */
const PROVIDER_CREDENTIAL_SUFFIX_RE =
	/-(?:db-api-key|api-key|api-token|pat-key|key|token)$/;

/** Connection labels are operator-config slugs — reject anything else so a
 * forwarded header can't be abused to probe arbitrary outbound app ids. */

export /** Connection labels are operator-config slugs — reject anything else so a
 * forwarded header can't be abused to probe arbitrary outbound app ids. */
const CONNECTION_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Candidate label-scoped provider (Descope outbound app) ids for a
 * `providerId` + connection label pair, in preference order.
 *
 * Labeled credentials are stored as project-specific outbound apps (see
 * `uploadTenantApiKeyToken` doc in `@tedix/auth/connections`): e.g. the
 * `promptwatch` provider keeps its default key under `promptwatch-api-key`
 * and per-project keys under `promptwatch-{project}`, such as
 * `promptwatch-tedix`. Given (providerId="promptwatch-api-key", label="tedix")
 * this returns ["promptwatch-tedix", "promptwatch-api-key-tedix"].
 *
 * Returns [] when there is no label, the label is malformed, or the
 * providerId already targets the labeled app (ends with `-{label}`).
 */

export /**
 * Candidate label-scoped provider (Descope outbound app) ids for a
 * `providerId` + connection label pair, in preference order.
 *
 * Labeled credentials are stored as project-specific outbound apps (see
 * `uploadTenantApiKeyToken` doc in `@tedix/auth/connections`): e.g. the
 * `promptwatch` provider keeps its default key under `promptwatch-api-key`
 * and per-project keys under `promptwatch-{project}`, such as
 * `promptwatch-tedix`. Given (providerId="promptwatch-api-key", label="tedix")
 * this returns ["promptwatch-tedix", "promptwatch-api-key-tedix"].
 *
 * Returns [] when there is no label, the label is malformed, or the
 * providerId already targets the labeled app (ends with `-{label}`).
 */
function buildLabeledProviderCandidates(
	providerId: string,
	label?: string,
): string[] {
	const normalized = label?.trim();
	if (!normalized || !CONNECTION_LABEL_RE.test(normalized)) return [];
	if (providerId === normalized || providerId.endsWith(`-${normalized}`)) {
		return [];
	}
	const candidates: string[] = [];
	const base = providerId.replace(PROVIDER_CREDENTIAL_SUFFIX_RE, "");
	if (base && base !== providerId) candidates.push(`${base}-${normalized}`);
	candidates.push(`${providerId}-${normalized}`);
	return candidates;
}

/**
 * Resolve a token preferring the label-scoped credential when a connection
 * label is provided. Falls back to the default (unlabeled) provider id —
 * with a warn — when no labeled credential exists, so providers without
 * per-label tokens keep working unchanged.
 */

export /**
 * Resolve a token preferring the label-scoped credential when a connection
 * label is provided. Falls back to the default (unlabeled) provider id —
 * with a warn — when no labeled credential exists, so providers without
 * per-label tokens keep working unchanged.
 */
async function resolveTokenPreferringLabel<T>(args: {
	providerId: string;
	label?: string;
	fetchTokenForProvider: (providerId: string) => Promise<T | null>;
}): Promise<T | null> {
	const labeledCandidates = buildLabeledProviderCandidates(
		args.providerId,
		args.label,
	);
	for (const candidate of labeledCandidates) {
		const token = await args.fetchTokenForProvider(candidate);
		if (token) return token;
	}
	if (labeledCandidates.length > 0) {
		console.warn(
			`[Connections] No labeled credential for provider=${args.providerId} label=${args.label} (tried: ${labeledCandidates.join(", ")}); falling back to default credential resolution`,
		);
	}
	return args.fetchTokenForProvider(args.providerId);
}

/**
 * Shared credential-resolution chain. Used by both fetchTediToken (optionally
 * including owner-personal lookup) and fetchOrgToken (skips owner step — for
 * human callers and orgs without a tedi).
 *
 * Scope behavior:
 *   - tenant: only tenant-scoped Descope Token Vault entry
 *   - user: org-owner caller and/or tedi-owner personal tokens; visitors excluded
 *   - hybrid: org owners default user-first; visitors default tenant-first
 *
 * Throws NOT_FOUND when nothing resolves. Returns plaintext token when found.

 *
 * Retired providers fail closed — but the D1 registry cannot be the test: many
 * referenced providers have no `connection_providers` row while being
 * perfectly live, so requiring registration would sever them. The authority is
 * Descope: an unregistered provider is allowed only while its outbound app
 * still exists. That closes the retirement hole — Descope keeps serving a
 * deleted app's tenant API-key token forever, with no delete path — and costs
 * one probe on the unregistered minority only.
 */

/**
 * Shared credential-resolution chain. Used by both fetchTediToken (optionally
 * including owner-personal lookup) and fetchOrgToken (skips owner step — for
 * human callers and orgs without a tedi).
 *
 * Scope behavior:
 *   - tenant: only tenant-scoped Descope Token Vault entry
 *   - user: only caller/owner personal Descope tokens
 *   - hybrid: caller/owner personal tokens first, then tenant-scoped token
 *
 * Throws NOT_FOUND when nothing resolves. Returns plaintext token when found.

 *
 * Retired providers fail closed — but the D1 registry cannot be the test: many
 * referenced providers have no `connection_providers` row while being
 * perfectly live, so requiring registration would sever them. The authority is
 * Descope: an unregistered provider is allowed only while its outbound app
 * still exists. That closes the retirement hole — Descope keeps serving a
 * deleted app's tenant API-key token forever, with no delete path — and costs
 * one probe on the unregistered minority only.
 */
export async function fetchNamedConnection(
	context: BaseContext,
	owner: { userId: string } | { organizationId: string; tenantId: string },
	providerId: string,
	instanceId: string,
	scopes?: string[],
) {
	const instance = await getConnectionInstance(
		context.db,
		owner,
		instanceId,
		providerId,
	);
	if (!instance) return null;
	const selection = {
		appId: providerId,
		externalIdentifier: `tedix_${instance.id}`,
		scopes,
	};
	const token =
		"userId" in owner
			? await fetchPersonalConnectionToken(context.env, {
					...selection,
					userId: owner.userId,
				})
			: await fetchNamedTenantConnectionToken(context.env, {
					...selection,
					tenantId: owner.tenantId,
				});
	if (!token) return null;
	if (instance.tokenSub && token.tokenSub !== instance.tokenSub)
		throw createError(
			ErrorCodes.CONFLICT,
			"This account slot was reconnected as a different external identity. Reconnect the original account or add a new slot.",
		);
	if (
		!instance.tokenIds.includes(token.id!) ||
		(!instance.tokenSub && token.tokenSub)
	) {
		const recorded = await recordConnectionGrant(context.db, {
			owner,
			providerId,
			id: instance.id,
			tokenId: token.id!,
			tokenSub: token.tokenSub,
		});
		if (!recorded.length)
			throw createError(
				ErrorCodes.CONFLICT,
				"Account identity changed during verification",
			);
	}
	return token;
}

export async function resolveCredentialChain(
	context: BaseContext,
	args: {
		organizationId: string;
		descopeTenantId: string;
		providerId: string;
		scopes?: string[];
		scope?: CredentialScope;
		preference?: CredentialPreference;
		callerUserId?: string;
		ownerUserId?: string | null;
		/** Connection label — prefers the label-scoped credential when set. */
		label?: string;
		connectionInstanceId?: string;
	},
): Promise<{
	accessToken: string;
	expiresAt?: number;
	scopes?: string[];
}> {
	const registeredProvider = await getConnectionProviderByDescopeAppId(
		context.db,
		args.providerId,
	);
	if (!registeredProvider) {
		const stillLiveInDescope = await outboundAppExists(
			args.providerId,
			context.env,
		);
		if (!stillLiveInDescope) {
			console.warn(
				`[Connections] Refusing credentials for retired provider=${args.providerId} org=${args.organizationId} (no D1 registry row and no Descope outbound app)`,
			);
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Connection provider ${args.providerId} has been retired. Its credentials are no longer served.`,
			);
		}
	}
	const client = getDescopeManagement(context.env);
	let actingUserOwnsOrganization = false;
	const actingUserId = args.callerUserId ?? args.ownerUserId ?? undefined;
	if (actingUserId && (args.scope === "user" || args.scope === "hybrid")) {
		try {
			const membership = await getMemberByUserId(
				context.db,
				args.organizationId,
				actingUserId,
			);
			actingUserOwnsOrganization =
				membership?.status === "active" && membership.role === "owner";
		} catch (error) {
			console.error(
				`[Connections] Credential ownership lookup failed for org=${args.organizationId}; applying tenant-safe precedence`,
				error,
			);
		}
	}
	const targets = buildCredentialResolutionTargets({
		...args,
		actingUserOwnsOrganization,
	});
	if (args.connectionInstanceId) {
		if (args.scope !== "user" && args.scope !== "tenant")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Choose personal or organization scope for a named account",
			);
		for (const target of targets) {
			if (args.scope === "user" && target.kind !== "user") continue;
			if (args.scope === "tenant" && target.kind !== "tenant") continue;
			const owner =
				target.kind === "user"
					? { userId: target.userId }
					: {
							organizationId: args.organizationId,
							tenantId: args.descopeTenantId,
						};
			const selected = await fetchNamedConnection(
				context,
				owner,
				args.providerId,
				args.connectionInstanceId,
				args.scopes,
			);
			if (selected)
				return {
					accessToken: selected.accessToken,
					expiresAt: selected.expiresAt,
					scopes: selected.scopes,
				};
		}
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Selected account is not connected or does not belong to this scope. Choose or connect that exact account.",
		);
	}
	let lookupFailure: ConnectionTokenLookupError | undefined;
	const fetchTokenForProvider = async (
		providerId: string,
	): Promise<Awaited<ReturnType<typeof fetchConnectionToken>> | null> => {
		let token: Awaited<ReturnType<typeof fetchConnectionToken>> | null = null;
		for (const target of targets) {
			try {
				if (target.kind === "user") {
					token = args.scopes?.length
						? await fetchConnectionTokenByScopes(
								client,
								providerId,
								target.userId,
								args.scopes,
							)
						: await fetchConnectionToken(client, providerId, target.userId);
				} else {
					token = args.scopes?.length
						? await fetchTenantConnectionTokenByScopes(
								client,
								providerId,
								target.tenantId,
								args.scopes,
							)
						: await fetchTenantConnectionToken(
								client,
								providerId,
								target.tenantId,
							);
				}
			} catch (error) {
				lookupFailure =
					error instanceof ConnectionTokenLookupError
						? error
						: new ConnectionTokenLookupError();
			}
			if (token) break;
		}
		return token;
	};
	const token = await resolveTokenPreferringLabel({
		providerId: args.providerId,
		label: args.label,
		fetchTokenForProvider,
	});
	if (!token) {
		if (lookupFailure)
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, lookupFailure.message);
		throw createError(
			ErrorCodes.NOT_FOUND,
			`No connection found for provider ${args.providerId}. Connect via Settings > Connections.`,
		);
	}
	if (!token.accessToken) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Token retrieval succeeded but access token is empty. The connection may need to be re-established.",
		);
	}
	const expiresAt =
		typeof token.expiresAt === "number" && token.expiresAt > 0
			? token.expiresAt
			: typeof token.expiresAt === "string" && Number(token.expiresAt) > 0
				? Number(token.expiresAt)
				: undefined;
	return {
		accessToken: token.accessToken,
		expiresAt,
		scopes: token.scopes ?? undefined,
	};
}

/**
 * Org/user credential lookup — no tedi required.
 *
 * Use when the caller is a human user (or any non-tedi context) and the
 * resolution doesn't need the tedi-owner-personal hop (Step 2 of the full
 * chain). Required for orgs that haven't created a tedi yet — the previous
 * "find any tedi to use as proxy" hop fails for tedi-less orgs.
 */

export /**
 * ADR tedi-client-oauth-cimd phase 1a drift gate: compare the freshly
 * discovered authorization-server issuer against the issuer pinned on the
 * `connection_providers` row at first discovery. Drift → typed CONFLICT
 * refusal (fail closed, no re-provisioning). No row / NULL pin (legacy) →
 * pass-through; the caller pins after a successful provision.
 */
async function enforceConnectionProviderIssuerPin(input: {
	db: BaseContext["db"];
	providerId: string;
	discoveredIssuer: string;
}): Promise<void> {
	const pin = await getConnectionProviderIssuerPin(input.db, input.providerId);
	try {
		assertPinnedIssuerMatches({
			providerId: input.providerId,
			pinnedIssuer: pin?.pinnedIssuer ?? null,
			discoveredIssuer: input.discoveredIssuer,
		});
	} catch (error) {
		if (error instanceof IssuerPinDriftError) {
			console.error(
				`[Connections] issuer drift refused: provider=${error.providerId} pinned=${error.pinnedIssuer} discovered=${error.discoveredIssuer}`,
			);
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		throw error;
	}
}

/**
 * Create a Descope outbound app from an upstream MCP protected resource.
 *
 * This is the operator-friendly path for catalog MCP apps: callers provide the
 * upstream MCP URL or a catalog app selector.
 */
