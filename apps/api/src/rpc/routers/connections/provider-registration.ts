import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { getDescopeManagement } from "../../../lib/descope-management";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import {
	type ConnectionCredentialProfile,
	type ConnectionProviderTemplate,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import {
	ConnectionCredentialProfileSchema,
	type ConnectionProviderDcrException,
	type ConnectionProviderDcrExceptionRecord,
} from "@tedix/api-contract/schemas/connections";
import type { ConnectionToolCapability } from "@tedix/api-contract/schemas/connections";
import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { DESCOPE_DEFAULT_BASE_URL } from "@tedix/auth/types";
import {
	listAppReferenceMetadataByOrganization,
	listAppReferenceMetadataByIds,
	listAppReferenceMetadataBySlugs,
} from "@tedix/db/queries/apps";
import { listConnectionToolPoliciesByAppIds } from "@tedix/db/queries/tools";
import { normalizeRequestedScopes } from "./url-and-scopes";

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

const DCR_EXCEPTION_MAX_DAYS = 366;

/**
 * Dynamic Client Registration is deprecated (MCP 2026-07-28). Every path that
 * would register a new upstream OAuth client dynamically, whether Descope
 * registers it or Tedix does and stores it as a static client, needs a
 * recorded reason and a review date no more than a year out.
 */
export function requireDcrException(input: {
	providerId: string;
	exception: ConnectionProviderDcrException | undefined;
	recordedBy: string | null;
	now?: Date;
}): ConnectionProviderDcrExceptionRecord {
	const now = input.now ?? new Date();
	if (!input.exception) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Provider ${input.providerId} would use Dynamic Client Registration, which is deprecated. Prefer an upstream with client ID metadata document support; otherwise pass dcrException { justification, reviewBy } to record why DCR is needed and when to review it.`,
		);
	}
	const today = now.toISOString().slice(0, 10);
	const latest = new Date(now.getTime() + DCR_EXCEPTION_MAX_DAYS * 86_400_000)
		.toISOString()
		.slice(0, 10);
	if (input.exception.reviewBy <= today || input.exception.reviewBy > latest) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`dcrException.reviewBy must be after ${today} and no later than ${latest}`,
		);
	}
	return {
		justification: input.exception.justification,
		reviewBy: input.exception.reviewBy,
		recordedAt: now.toISOString(),
		recordedBy: input.recordedBy,
	};
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
	const client = getDescopeManagement(input.env, true);
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
			appName: string;
			source: "app" | "tool" | "aggregate";
		}>
	>;
	complete: boolean;
	ids: Set<string>;
	credentialProfiles: Map<string, ConnectionCredentialProfile>;
	connectionScopes: Map<string, string[]>;
	toolCapabilities: Map<string, ConnectionToolCapability[]>;
	toolCapabilitiesComplete: Map<string, boolean>;
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
		toolCapabilities: new Map<string, ConnectionToolCapability[]>(),
		toolCapabilitiesComplete: new Map<string, boolean>(),
	};
	const visited = new Set<string>();
	try {
		let appWave: Array<{
			id: string;
			slug: string;
			name: string;
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
					refs.push({
						appId: app.id,
						appSlug: app.slug,
						appName: app.name,
						source,
					});
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
				const tools = await listConnectionToolPoliciesByAppIds(
					db,
					currentApps.map((app) => app.id),
				);
				for (const tool of tools) {
					const app = currentApps.find(
						(candidate) => candidate.id === tool.appId,
					);
					if (!app) continue;
					const mcpConfig = (app.metadata as Record<string, unknown> | null)
						?.mcpConfig as Record<string, unknown> | undefined;
					const openApiSync = mcpConfig?.openApiSync as
						| Record<string, unknown>
						| undefined;
					const providerId =
						tool.authType === "connection"
							? tool.connectionId
							: tool.authType
								? undefined
								: (mcpConfig?.connectionProviderId ??
									openApiSync?.connectionProviderId);
					if (typeof providerId === "string" && providerId) {
						if (tool.authType === "connection") {
							const refs = referenced.references.get(providerId) ?? [];
							if (!refs.some((r) => r.appId === app.id && r.source === "tool"))
								refs.push({
									appId: app.id,
									appSlug: app.slug,
									appName: app.name,
									source: "tool",
								});
							referenced.references.set(providerId, refs);
						}
						rememberReferencedProvider(referenced, providerId);
						const policy = parseToolPolicyMetadata(tool.meta);
						if (!policy?.riskTier) {
							referenced.toolCapabilitiesComplete.set(providerId, false);
							continue;
						}
						const capabilities =
							referenced.toolCapabilities.get(providerId) ?? [];
						if (
							!capabilities.some(
								(capability) => capability.id === `${app.id}:${tool.toolId}`,
							)
						)
							capabilities.push({
								id: `${app.id}:${tool.toolId}`,
								label: tool.title,
								riskTier: policy.riskTier,
							});
						referenced.toolCapabilities.set(providerId, capabilities);
						if (!referenced.toolCapabilitiesComplete.has(providerId))
							referenced.toolCapabilitiesComplete.set(providerId, true);
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
			"[Connections] Failed to collect referenced provider ids (non-fatal)",
			{ exception: safeExceptionTopology(error) },
		);
	}
	return referenced;
}
