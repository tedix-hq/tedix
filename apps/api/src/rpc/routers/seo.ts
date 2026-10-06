/**
 * oRPC SEO Router
 *
 * Implements tenant-scoped provider-neutral SEO research plus Google Search
 * Console discovery and per-app `metadata.seoConfig` storage.
 *
 * Auth model:
 * - Caller is org-scoped (apps:read / apps:write).
 * - Per-procedure `requireAppForOrg` guards cross-org leakage.
 * - GSC OAuth access tokens come from the org's tenant-scoped token in
 *   Descope Token Vault, fetched via @tedix/auth/connections. Provider id
 *   defaults to `"google"` and can be overridden via env var
 *   GSC_PROVIDER_ID (e.g. a Descope outbound app id like "google-drive").
 * - Managed DataForSEO uses the hidden Worker credential plus an atomic
 *   Tedix service-credit reservation. Tenant BYOK is an operator fallback.
 */

import { implement, ORPCError } from "@orpc/server";
import { seoContract } from "@tedix/api-contract/contracts/seo";
import { getManagementClient } from "@tedix/auth/client";
import { fetchTenantConnectionToken } from "@tedix/auth/connections";
import { DESCOPE_DEFAULT_BASE_URL } from "@tedix/auth/types";
import type { DbClient } from "@tedix/db/client";
import { getAppById, updateApp } from "@tedix/db/queries/app-records";
import { recordBillingProviderUsage } from "@tedix/db/queries/billing/provider-usage";
import {
	getBillingServiceCreditSnapshot,
	releaseBillingServiceCreditReservation,
	reserveBillingServiceCredits,
	settleBillingServiceCreditUsage,
} from "@tedix/db/queries/billing-service-credits";
import { getOrgSecret } from "@tedix/db/queries/organization-secrets";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { decryptSecret } from "@tedix/db/utils/secrets-encryption";
import {
	createDataForSeoClient,
	type DataForSeoClient,
	DataForSeoError,
	type DataForSeoReceipt,
} from "../../integrations/dataforseo/client";
import {
	getBacklinksOverview as fetchBacklinksOverview,
	getDomainOverview as fetchDomainOverview,
	researchKeywords as fetchKeywordResearch,
	getSerpResults as fetchSerpResults,
	type SeoResearchResult,
} from "../../integrations/dataforseo/research";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const seoOs = implement(seoContract).$context<BaseContext>();
const authedOs = seoOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

const GSC_BASE = "https://searchconsole.googleapis.com";
const WMT_BASE = "https://www.googleapis.com/webmasters/v3";

async function requireAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

function getAppMetadata(app: { metadata: unknown }): AppMetadata {
	const raw = app.metadata;
	if (!raw || typeof raw !== "object") return {} as AppMetadata;
	return raw as AppMetadata;
}

function getDescopeManagement(env: CloudflareEnv) {
	if (!env.DESCOPE_MANAGEMENT_KEY) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management key not configured",
		);
	}
	return getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL,
	});
}

function resolveSiteUrl(
	app: { primaryDomain: string | null },
	metadata: AppMetadata,
	override: string | undefined,
): string {
	const fromConfig = metadata.seoConfig?.gscPropertyUrl;
	const fromDomain = app.primaryDomain ? `https://${app.primaryDomain}/` : null;
	const siteUrl = override || fromConfig || fromDomain;
	if (!siteUrl) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"No GSC property URL configured. Pass siteUrl, set seoConfig.gscPropertyUrl, or set the app's primaryDomain.",
		);
	}
	return siteUrl;
}

interface GscEnv extends CloudflareEnv {
	GSC_PROVIDER_ID?: string;
}

const GOOGLE_SA_SCOPES =
	"https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification";

function base64url(data: ArrayBuffer | Uint8Array | string): string {
	const bytes =
		typeof data === "string"
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

interface CachedToken {
	token: string;
	expiresAt: number;
}
let saTokenCache: CachedToken | null = null;

async function getGoogleAccessTokenViaServiceAccount(
	serviceAccountKeyJson: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (saTokenCache && saTokenCache.expiresAt - 60 > now) {
		return saTokenCache.token;
	}

	const sa = JSON.parse(serviceAccountKeyJson) as {
		client_email: string;
		private_key: string;
	};

	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iss: sa.client_email,
			scope: GOOGLE_SA_SCOPES,
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3600,
		}),
	);

	const pemContents = sa.private_key.replace(
		/-----(?:BEGIN|END) PRIVATE KEY-----|\n/g,
		"",
	);
	const keyBuffer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

	const key = await crypto.subtle.importKey(
		"pkcs8",
		keyBuffer,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);

	const unsigned = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);
	const jwt = `${unsigned}.${base64url(signature)}`;

	const resp = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
	});
	const body = (await resp.json()) as {
		access_token?: string;
		expires_in?: number;
		error?: string;
	};
	if (!body.access_token) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			`Google service-account auth failed: ${body.error || JSON.stringify(body)}`,
		);
	}
	saTokenCache = {
		token: body.access_token,
		expiresAt: now + (body.expires_in ?? 3600),
	};
	return body.access_token;
}

async function getGscAccessToken(
	context: BaseContext,
	organizationId: string,
): Promise<string> {
	const env = context.env as GscEnv;

	// Prefer service account: org-agnostic, no expiring user tokens, no reconnect dance.
	if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
		return getGoogleAccessTokenViaServiceAccount(
			env.GOOGLE_SERVICE_ACCOUNT_KEY,
		);
	}

	const providerId = env.GSC_PROVIDER_ID || "google";
	const org = await getOrganizationById(context.db, organizationId);
	if (!org?.descopeTenantId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization has no Descope tenant; cannot fetch Google connection token.",
		);
	}
	const client = getDescopeManagement(context.env);
	const token = await fetchTenantConnectionToken(
		client,
		providerId,
		org.descopeTenantId,
	).catch(() => null);
	if (!token?.accessToken) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`No Google connection found for provider "${providerId}". Connect via Settings > Connections (tenant scope), or set GOOGLE_SERVICE_ACCOUNT_KEY.`,
		);
	}
	return token.accessToken;
}

interface GscFetchOpts {
	method?: "GET" | "POST" | "PUT" | "DELETE";
	body?: unknown;
	expectJson?: boolean;
}

// =============================================================================
// SITE VERIFICATION HELPERS — Google's siteVerification API (separate from GSC)
//
// Used to programmatically register the service account as Owner of a property.
// =============================================================================

const SV_BASE = "https://www.googleapis.com/siteVerification/v1";

interface VerificationTokenResponse {
	token?: string;
	method?: string;
	error?: { message?: string; code?: number };
}

interface VerificationClaimResponse {
	id?: string;
	site?: { type: string; identifier: string };
	owners?: string[];
	error?: { message?: string; code?: number };
}

type GoogleVerificationMethod = "META" | "DNS_TXT";
type GoogleVerificationSiteType = "SITE" | "INET_DOMAIN";

interface VerificationSite {
	type: GoogleVerificationSiteType;
	identifier: string;
	gscSiteUrl: string;
}

function inferVerificationMethod(
	siteUrl: string,
	override?: GoogleVerificationMethod,
): GoogleVerificationMethod {
	if (override) return override;
	return siteUrl.startsWith("sc-domain:") ? "DNS_TXT" : "META";
}

function resolveVerificationSite(
	siteUrl: string,
	method: GoogleVerificationMethod,
	override?: GoogleVerificationSiteType,
): VerificationSite {
	const type =
		override ??
		(method === "DNS_TXT" || siteUrl.startsWith("sc-domain:")
			? "INET_DOMAIN"
			: "SITE");

	if (type === "SITE") {
		return { type, identifier: siteUrl, gscSiteUrl: siteUrl };
	}

	const identifier = siteUrl
		.replace(/^sc-domain:/, "")
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/\.$/, "");
	return { type, identifier, gscSiteUrl: `sc-domain:${identifier}` };
}

/**
 * Request a verification token from Google. META returns just the bare token
 * string (Google sometimes wraps it as a full `<meta>` tag). DNS_TXT returns
 * the full TXT content to publish at the zone apex.
 */
async function requestSiteVerificationToken(
	site: VerificationSite,
	method: GoogleVerificationMethod,
	accessToken: string,
): Promise<string> {
	const resp = await fetch(`${SV_BASE}/token`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			verificationMethod: method,
			site: { type: site.type, identifier: site.identifier },
		}),
	});
	const body = (await resp.json()) as VerificationTokenResponse;
	if (!resp.ok || !body.token) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`siteVerification token request failed: ${body.error?.message ?? `HTTP ${resp.status}`}`,
		);
	}
	if (method === "META") {
		const match = body.token.match(/content="([^"]+)"/);
		return match?.[1] ?? body.token;
	}
	return body.token;
}

/**
 * Claim verification of a property. For META, the verification meta tag must
 * already be live on the public site. For DNS_TXT, the TXT record must be live
 * for the domain identifier.
 */
async function claimSiteVerification(
	site: VerificationSite,
	method: GoogleVerificationMethod,
	accessToken: string,
): Promise<{ ok: boolean; owners?: string[]; error?: string }> {
	const resp = await fetch(
		`${SV_BASE}/webResource?verificationMethod=${method}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				site: { type: site.type, identifier: site.identifier },
			}),
		},
	);
	const body = (await resp
		.json()
		.catch(() => ({}))) as VerificationClaimResponse;
	if (resp.ok) {
		return { ok: true, owners: body.owners };
	}
	return {
		ok: false,
		error: body.error?.message ?? `HTTP ${resp.status}`,
	};
}

async function gscFetch(
	url: string,
	accessToken: string,
	opts: GscFetchOpts = {},
): Promise<unknown> {
	const method = opts.method ?? "GET";
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	let body: BodyInit | undefined;
	if (opts.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(opts.body);
	}
	const response = await fetch(url, { method, headers, body });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw createError(
			response.status === 401 || response.status === 403
				? ErrorCodes.FORBIDDEN
				: ErrorCodes.INTERNAL_SERVER_ERROR,
			`GSC API ${method} ${url} failed: ${response.status} ${text.slice(0, 500)}`,
		);
	}
	if (opts.expectJson === false || response.status === 204) {
		return null;
	}
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function getDataForSeoCredential(
	context: BaseContext,
	organizationId: string,
): Promise<{ credential: string; mode: "managed" | "byok" }> {
	if (
		context.env.DATAFORSEO_MANAGED_ENABLED === "true" &&
		context.env.DATAFORSEO_API_KEY
	) {
		return {
			credential: context.env.DATAFORSEO_API_KEY,
			mode: "managed",
		};
	}

	const organizationSecret = await getOrgSecret(
		context.db,
		organizationId,
		"DATAFORSEO_API_KEY",
	);
	if (organizationSecret) {
		if (!context.env.SECRETS_MASTER_KEY) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Organization secrets encryption is not configured",
			);
		}
		try {
			return {
				credential: await decryptSecret(
					context.env.SECRETS_MASTER_KEY,
					organizationId,
					organizationSecret.encryptedValue,
				),
				mode: "byok",
			};
		} catch (error) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to decrypt the organization's DataForSEO credential",
				error,
			);
		}
	}

	throw createError(
		ErrorCodes.SERVICE_UNAVAILABLE,
		"Tedix-managed SEO research is temporarily unavailable.",
	);
}

async function recordSeoProviderReceipt(
	context: BaseContext,
	organizationId: string,
	appId: string,
	receipt: DataForSeoReceipt,
	credentialMode: "managed" | "byok",
): Promise<void> {
	const now = new Date().toISOString();
	await recordBillingProviderUsage(context.db, {
		id: crypto.randomUUID(),
		organizationId,
		tediId: context.tediId ?? null,
		providerUsageId: `dataforseo:${receipt.providerTaskId}`,
		provider: "dataforseo",
		model: receipt.endpoint,
		usageKind: "seo_data",
		unit: "units",
		quantity: 1,
		providerCostMicros: receipt.costMicros,
		providerCostQuality: "provider_reported",
		occurredAt: now,
		metadata: {
			appId,
			endpoint: receipt.endpoint,
			path: receipt.path,
			statusCode: receipt.statusCode,
			statusMessage: receipt.statusMessage,
			credentialMode,
			authType: context.authType ?? null,
		},
		now,
	});
}

function providerSucceeded(receipt: DataForSeoReceipt): boolean {
	return (
		receipt.statusCode === 20000 ||
		(receipt.statusMessage?.toLowerCase().includes("no search results") ??
			false)
	);
}

type SeoOperationKey =
	| "research_keywords"
	| "get_serp_results"
	| "get_domain_overview"
	| "get_backlinks_overview";

interface SeoCreditReceipt {
	credentialMode: "managed" | "byok";
	rateCardId: string | null;
	creditsDebited: number;
	creditsRemaining: number | null;
}

function seoReservationIdempotencyKey(
	context: BaseContext,
	organizationId: string,
	operationKey: SeoOperationKey,
): string {
	const callerKey =
		context.headers.get("idempotency-key") ??
		context.headers.get("x-idempotency-key") ??
		context.headers.get("x-tedix-workflow-call-id");
	return [
		"seo",
		organizationId,
		operationKey,
		callerKey?.trim() || crypto.randomUUID(),
	].join(":");
}

function mapCreditDenial(
	code:
		| "billing_not_configured"
		| "subscription_inactive"
		| "billing_period_inactive"
		| "service_disabled"
		| "rate_card_unavailable"
		| "request_already_reserved"
		| "request_already_settled"
		| "credit_allowance_exhausted"
		| "monthly_credit_limit"
		| "tedi_credit_limit"
		| "provider_cost_limit",
): never {
	const messages = {
		billing_not_configured: "SEO credits are not configured for this tenant.",
		subscription_inactive:
			"SEO research is unavailable because the tenant subscription is inactive.",
		billing_period_inactive:
			"SEO research is unavailable outside the active billing period.",
		service_disabled: "SEO research is disabled for this tenant.",
		rate_card_unavailable: "SEO research pricing is temporarily unavailable.",
		request_already_reserved:
			"This SEO request is already in progress. Reuse the original result instead of submitting it again.",
		request_already_settled:
			"This SEO request was already completed. Reuse the original result instead of submitting it again.",
		credit_allowance_exhausted:
			"The tenant's SEO credit allowance is exhausted.",
		monthly_credit_limit: "The tenant's monthly SEO credit limit was reached.",
		tedi_credit_limit: "This tedi's monthly SEO credit limit was reached.",
		provider_cost_limit:
			"The tenant's managed SEO provider-spend safety limit was reached.",
	} as const;
	throw createError(
		code === "rate_card_unavailable"
			? ErrorCodes.SERVICE_UNAVAILABLE
			: code === "request_already_reserved" ||
				  code === "request_already_settled"
				? ErrorCodes.CONFLICT
				: ErrorCodes.FORBIDDEN,
		messages[code],
	);
}

async function runSeoResearch<T>(
	context: BaseContext,
	organizationId: string,
	appId: string,
	operationKey: SeoOperationKey,
	execute: (client: DataForSeoClient) => Promise<SeoResearchResult<T>>,
): Promise<{ result: SeoResearchResult<T>; billing: SeoCreditReceipt }> {
	const resolved = await getDataForSeoCredential(context, organizationId);
	if (resolved.mode === "byok") {
		const client = createDataForSeoClient({
			credential: resolved.credential,
			recordReceipt: (receipt) =>
				recordSeoProviderReceipt(
					context,
					organizationId,
					appId,
					receipt,
					"byok",
				),
		});
		return {
			result: await execute(client),
			billing: {
				credentialMode: "byok",
				rateCardId: null,
				creditsDebited: 0,
				creditsRemaining: null,
			},
		};
	}

	const nowMs = Date.now();
	const decision = await reserveBillingServiceCredits(context.db, {
		id: crypto.randomUUID(),
		organizationId,
		tediId: context.tediId ?? null,
		serviceKey: "seo",
		operationKey,
		idempotencyKey: seoReservationIdempotencyKey(
			context,
			organizationId,
			operationKey,
		),
		expiresAt: new Date(nowMs + 10 * 60 * 1_000).toISOString(),
		metadata: {
			appId,
			authType: context.authType ?? null,
			externalAgentSessionId: context.externalAgentSessionId ?? null,
		},
		now: new Date(nowMs).toISOString(),
	});
	if (!decision.allowed) return mapCreditDenial(decision.code);
	if (decision.replayed) return mapCreditDenial("request_already_reserved");

	const { reservation } = decision;
	const client = createDataForSeoClient({
		credential: resolved.credential,
		recordReceipt: async (receipt) => {
			await settleBillingServiceCreditUsage(context.db, {
				id: crypto.randomUUID(),
				reservationId: reservation.id,
				organizationId,
				tediId: context.tediId ?? null,
				providerUsageId: `dataforseo:${receipt.providerTaskId}`,
				provider: "dataforseo",
				model: receipt.endpoint,
				providerCostMicros: receipt.costMicros,
				providerCostQuality: "provider_reported",
				providerSucceeded: providerSucceeded(receipt),
				occurredAt: new Date().toISOString(),
				metadata: {
					appId,
					endpoint: receipt.endpoint,
					path: receipt.path,
					statusCode: receipt.statusCode,
					statusMessage: receipt.statusMessage,
					authType: context.authType ?? null,
				},
				now: new Date().toISOString(),
			});
		},
	});

	try {
		const result = await execute(client);
		const snapshot = await getBillingServiceCreditSnapshot(
			context.db,
			organizationId,
			"seo",
			new Date().toISOString(),
		);
		return {
			result,
			billing: {
				credentialMode: "managed",
				rateCardId: reservation.rateCardId,
				creditsDebited: reservation.creditsReserved,
				creditsRemaining: snapshot?.availableCredits ?? null,
			},
		};
	} catch (error) {
		await releaseBillingServiceCreditReservation(context.db, {
			reservationId: reservation.id,
			organizationId,
			reason: "provider_call_failed",
			now: new Date().toISOString(),
		});
		throw error;
	}
}

function providerReceipt(
	receipt: DataForSeoReceipt,
	billing: SeoCreditReceipt,
) {
	return {
		provider: "dataforseo" as const,
		providerTaskId: receipt.providerTaskId,
		endpoint: receipt.endpoint,
		costMicros: receipt.costMicros,
		statusCode: receipt.statusCode,
		statusMessage: receipt.statusMessage,
		billing,
	};
}

function normalizeDomain(value: string): string {
	try {
		const url = new URL(
			value.includes("://") ? value : `https://${value.trim()}`,
		);
		if (!url.hostname || url.username || url.password) throw new Error();
		return url.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Expected a valid domain such as example.com",
		);
	}
}

function normalizeBacklinksTarget(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.includes("://")) return normalizeDomain(trimmed);
	try {
		const url = new URL(trimmed);
		if (!["http:", "https:"].includes(url.protocol)) throw new Error();
		url.hash = "";
		return url.toString();
	} catch {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Expected a valid domain or HTTP(S) page URL",
		);
	}
}

function mapDataForSeoError(error: unknown): never {
	if (error instanceof DataForSeoError) {
		throw new ORPCError(ErrorCodes.BAD_GATEWAY, {
			message: error.message,
			data: {
				provider: "dataforseo",
				providerStatusCode: error.providerStatusCode,
				recoveryAction: error.recoveryAction,
				receipt: error.receipt,
			},
		});
	}
	throw error;
}

// =============================================================================
// PROCEDURES
// =============================================================================

export const researchKeywords = authedOs.researchKeywords
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireAppForOrg(context.db, orgId, input.appId);
		try {
			const { result, billing } = await runSeoResearch(
				context,
				orgId,
				input.appId,
				"research_keywords",
				(client) => fetchKeywordResearch(client, input),
			);
			return {
				keyword: input.keyword,
				locationCode: input.locationCode,
				languageCode: input.languageCode,
				items: result.data,
				receipt: providerReceipt(result.receipt, billing),
			};
		} catch (error) {
			return mapDataForSeoError(error);
		}
	});

export const getSerpResults = authedOs.getSerpResults
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireAppForOrg(context.db, orgId, input.appId);
		try {
			const { result, billing } = await runSeoResearch(
				context,
				orgId,
				input.appId,
				"get_serp_results",
				(client) => fetchSerpResults(client, input),
			);
			return {
				keyword: input.keyword,
				locationCode: input.locationCode,
				languageCode: input.languageCode,
				device: input.device,
				items: result.data,
				receipt: providerReceipt(result.receipt, billing),
			};
		} catch (error) {
			return mapDataForSeoError(error);
		}
	});

export const getDomainOverview = authedOs.getDomainOverview
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireAppForOrg(context.db, orgId, input.appId);
		const domain = normalizeDomain(input.domain);
		try {
			const { result, billing } = await runSeoResearch(
				context,
				orgId,
				input.appId,
				"get_domain_overview",
				(client) =>
					fetchDomainOverview(client, {
						...input,
						domain,
					}),
			);
			return {
				domain,
				locationCode: input.locationCode,
				languageCode: input.languageCode,
				organicTraffic: result.data.organicTraffic,
				organicKeywords: result.data.organicKeywords,
				receipt: providerReceipt(result.receipt, billing),
			};
		} catch (error) {
			return mapDataForSeoError(error);
		}
	});

export const getBacklinksOverview = authedOs.getBacklinksOverview
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireAppForOrg(context.db, orgId, input.appId);
		const target = normalizeBacklinksTarget(input.target);
		try {
			const { result, billing } = await runSeoResearch(
				context,
				orgId,
				input.appId,
				"get_backlinks_overview",
				(client) =>
					fetchBacklinksOverview(client, {
						target,
						includeSubdomains: input.includeSubdomains,
					}),
			);
			return {
				...result.data,
				receipt: providerReceipt(result.receipt, billing),
			};
		} catch (error) {
			return mapDataForSeoError(error);
		}
	});

export const querySearchAnalytics = authedOs.querySearchAnalytics
	.use(AUTHZ.appsRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
				siteUrl?: string;
				startDate: string;
				endDate: string;
				dimensions?: ("page" | "query" | "date" | "country" | "device")[];
				rowLimit?: number;
				startRow?: number;
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const siteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const accessToken = await getGscAccessToken(context, orgId);

			const url = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
			const result = (await gscFetch(url, accessToken, {
				method: "POST",
				body: {
					startDate: input.startDate,
					endDate: input.endDate,
					dimensions: input.dimensions ?? [],
					rowLimit: input.rowLimit ?? 1000,
					startRow: input.startRow ?? 0,
				},
			})) as {
				rows?: Array<{
					keys?: string[];
					clicks?: number;
					impressions?: number;
					ctr?: number;
					position?: number;
				}>;
				responseAggregationType?: string;
			} | null;

			return {
				siteUrl,
				rows: result?.rows ?? [],
				responseAggregationType: result?.responseAggregationType,
			};
		},
	);

export const getIndexingStatus = authedOs.getIndexingStatus
	.use(AUTHZ.appsRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string; urlInspect: string; siteUrl?: string };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const siteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const accessToken = await getGscAccessToken(context, orgId);

			const url = `${GSC_BASE}/v1/urlInspection/index:inspect`;
			const result = (await gscFetch(url, accessToken, {
				method: "POST",
				body: {
					inspectionUrl: input.urlInspect,
					siteUrl,
				},
			})) as {
				inspectionResult?: {
					indexStatusResult?: {
						verdict?: string;
						coverageState?: string;
						lastCrawlTime?: string;
						pageFetchState?: string;
						robotsTxtState?: string;
					};
				};
			} | null;

			const idx = result?.inspectionResult?.indexStatusResult;
			const verdict = nullableString(idx?.verdict);
			return {
				indexed: verdict === "PASS",
				indexabilityVerdict: verdict,
				coverageState: nullableString(idx?.coverageState),
				lastCrawled: nullableString(idx?.lastCrawlTime),
				pageFetchState: nullableString(idx?.pageFetchState),
				robotsTxtState: nullableString(idx?.robotsTxtState),
				raw: (result ?? null) as never,
			};
		},
	);

export const listSitemaps = authedOs.listSitemaps
	.use(AUTHZ.appsRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string; siteUrl?: string };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const siteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const accessToken = await getGscAccessToken(context, orgId);

			const url = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
			const result = (await gscFetch(url, accessToken)) as {
				sitemap?: Array<{
					path?: string;
					lastSubmitted?: string;
					isPending?: boolean;
					isSitemapsIndex?: boolean;
					type?: string;
					lastDownloaded?: string;
					warnings?: string;
					errors?: string;
					contents?: unknown[];
				}>;
			} | null;

			const sitemaps =
				result?.sitemap?.map((s) => ({
					path: s.path ?? "",
					lastSubmitted: s.lastSubmitted ?? null,
					isPending: s.isPending,
					isSitemapsIndex: s.isSitemapsIndex,
					type: s.type,
					lastDownloaded: s.lastDownloaded ?? null,
					warnings: s.warnings != null ? Number(s.warnings) : undefined,
					errors: s.errors != null ? Number(s.errors) : undefined,
					contents: (s.contents ?? []) as never[],
				})) ?? [];

			return { siteUrl, sitemaps };
		},
	);

export const submitSitemap = authedOs.submitSitemap
	.use(AUTHZ.appsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string; siteUrl?: string; sitemapUrl?: string };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const siteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const sitemapUrl =
				input.sitemapUrl ||
				(app.primaryDomain
					? `https://${app.primaryDomain}/sitemap-index.xml`
					: null);
			if (!sitemapUrl) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"sitemapUrl required (app has no primaryDomain).",
				);
			}
			const accessToken = await getGscAccessToken(context, orgId);

			// Register the site in Search Console first (idempotent — no-ops if
			// already added). The /sitemaps PUT below 403s if the site isn't
			// yet a property, even when the SA is a verified owner.
			await fetch(`${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${accessToken}` },
			}).catch(() => {
				/* tolerate — sitemap PUT below will surface any real auth issue */
			});

			const url = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
			await gscFetch(url, accessToken, { method: "PUT", expectJson: false });

			return { success: true as const, siteUrl, sitemapUrl };
		},
	);

export const verifyGoogle = authedOs.verifyGoogle.use(AUTHZ.appsWrite).handler(
	async ({
		input,
		context,
	}: {
		input: {
			appId: string;
			siteUrl?: string;
			verificationMethod?: GoogleVerificationMethod;
			siteType?: GoogleVerificationSiteType;
		};
		context: BaseContext;
	}) => {
		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(context.db, orgId, input.appId);
		const metadata = getAppMetadata(app);
		const resolvedSiteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
		const method = inferVerificationMethod(
			resolvedSiteUrl,
			input.verificationMethod,
		);
		const site = resolveVerificationSite(
			resolvedSiteUrl,
			method,
			input.siteType,
		);
		const accessToken = await getGscAccessToken(context, orgId);

		// First, try the actual claim — POST to siteVerification/webResource
		// with the chosen verification method. This is the real ownership
		// grant. Idempotent — calling again on an already-owned property
		// returns 200.
		const claim = await claimSiteVerification(site, method, accessToken);
		if (claim.ok) {
			return {
				verified: true,
				method,
				siteType: site.type,
				siteUrl: site.gscSiteUrl,
			};
		}

		// Fall back to a sites.get probe — covers the case where ownership
		// was granted out-of-band (e.g. someone added the SA email as Owner
		// in the GSC UI, no claim POST needed).
		const url = `${WMT_BASE}/sites/${encodeURIComponent(site.gscSiteUrl)}`;
		let verified = false;
		try {
			const result = (await gscFetch(url, accessToken)) as {
				permissionLevel?: string;
				siteUrl?: string;
			} | null;
			const perm = result?.permissionLevel ?? "";
			verified = perm === "siteOwner" || perm === "siteFullUser";
		} catch {
			verified = false;
		}

		return {
			verified,
			method,
			siteType: site.type,
			siteUrl: site.gscSiteUrl,
		};
	},
);

/**
 * Request a verification token from Google for the given siteUrl and persist
 * it to `app.metadata.seoConfig.googleVerifications[siteUrl]`. The caller is
 * responsible for ensuring the meta tag is rendered on the public site
 * before invoking `verifyGoogle` to claim ownership.
 */
export const registerGoogleProperty = authedOs.registerGoogleProperty
	.use(AUTHZ.appsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: {
				appId: string;
				siteUrl?: string;
				verificationMethod?: GoogleVerificationMethod;
				siteType?: GoogleVerificationSiteType;
			};
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const resolvedSiteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const method = inferVerificationMethod(
				resolvedSiteUrl,
				input.verificationMethod,
			);
			const site = resolveVerificationSite(
				resolvedSiteUrl,
				method,
				input.siteType,
			);
			const accessToken = await getGscAccessToken(context, orgId);

			const token = await requestSiteVerificationToken(
				site,
				method,
				accessToken,
			);

			// Persist per-site so apex + blog can each have their own token
			// without overwriting each other (apex tedix.dev vs blog.tedix.dev).
			// Legacy single-string field stays the primary apex token; the new
			// keyed map covers any subdomain.
			const prevSeo = (metadata.seoConfig ?? {}) as {
				googleVerification?: string;
				googleVerifications?: Record<string, string>;
				indexNowKey?: string;
				gscPropertyUrl?: string;
			};
			const apexUrl = app.primaryDomain
				? `https://${app.primaryDomain}/`
				: null;

			const nextVerifications = {
				...prevSeo.googleVerifications,
				[site.gscSiteUrl]: token,
			};
			const nextApexToken =
				method === "META" && apexUrl && apexUrl === site.gscSiteUrl
					? token
					: (prevSeo.googleVerification ?? undefined);

			const updatedMetadata: AppMetadata = {
				...metadata,
				seoConfig: {
					...prevSeo,
					googleVerification: nextApexToken,
					googleVerifications: nextVerifications,
				},
			};
			const updated = await updateApp(context.db, input.appId, {
				metadata: updatedMetadata,
			});
			if (!updated) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Failed to persist verification token to app seoConfig",
				);
			}

			return {
				success: true as const,
				siteUrl: site.gscSiteUrl,
				siteType: site.type,
				verificationMethod: method,
				token,
				metaTag:
					method === "META"
						? `<meta name="google-site-verification" content="${token}">`
						: null,
				dnsTxtRecord: method === "DNS_TXT" ? token : null,
				message:
					method === "META"
						? "Token persisted. Render this meta tag on the public site, then call verify_google_property to claim ownership."
						: "DNS TXT token issued. Publish this TXT record, then call verify_google_property with verificationMethod=DNS_TXT.",
			};
		},
	);

export const getStatus = authedOs.getStatus
	.use(AUTHZ.appsRead)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const seoConfig = metadata.seoConfig ?? {};

			let siteUrl: string | null = null;
			try {
				siteUrl = resolveSiteUrl(app, metadata, undefined);
			} catch {
				// No property configured yet — return a partial status.
				return {
					verified: false,
					propertyUrl: null,
					lastSubmittedSitemap: null,
					indexedPageCount: null,
					seoConfig: {
						googleVerification: seoConfig.googleVerification ?? null,
						indexNowKey: seoConfig.indexNowKey ?? null,
						gscPropertyUrl: seoConfig.gscPropertyUrl ?? null,
					},
				};
			}

			let accessToken: string;
			try {
				accessToken = await getGscAccessToken(context, orgId);
			} catch {
				return {
					verified: false,
					propertyUrl: siteUrl,
					lastSubmittedSitemap: null,
					indexedPageCount: null,
					seoConfig: {
						googleVerification: seoConfig.googleVerification ?? null,
						indexNowKey: seoConfig.indexNowKey ?? null,
						gscPropertyUrl: seoConfig.gscPropertyUrl ?? null,
					},
				};
			}

			// Fan out: site permission check, sitemap list, 28-day analytics page count
			const sitesUrl = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}`;
			const sitemapsUrl = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
			const analyticsUrl = `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

			const today = new Date();
			const end = today.toISOString().slice(0, 10);
			const startDt = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);
			const start = startDt.toISOString().slice(0, 10);

			const [siteRes, sitemapsRes, analyticsRes] = await Promise.allSettled([
				gscFetch(sitesUrl, accessToken),
				gscFetch(sitemapsUrl, accessToken),
				gscFetch(analyticsUrl, accessToken, {
					method: "POST",
					body: {
						startDate: start,
						endDate: end,
						dimensions: ["page"],
						rowLimit: 25000,
					},
				}),
			]);

			let verified = false;
			if (siteRes.status === "fulfilled") {
				const r = siteRes.value as { permissionLevel?: string } | null;
				const perm = r?.permissionLevel ?? "";
				verified = perm === "siteOwner" || perm === "siteFullUser";
			}

			let lastSubmittedSitemap: {
				path: string;
				lastSubmitted: string | null;
			} | null = null;
			if (sitemapsRes.status === "fulfilled") {
				const r = sitemapsRes.value as {
					sitemap?: Array<{ path?: string; lastSubmitted?: string }>;
				} | null;
				const list = r?.sitemap ?? [];
				if (list.length > 0) {
					const sorted = [...list].sort((a, b) => {
						const at = a.lastSubmitted ? Date.parse(a.lastSubmitted) : 0;
						const bt = b.lastSubmitted ? Date.parse(b.lastSubmitted) : 0;
						return bt - at;
					});
					const top = sorted[0];
					if (top) {
						lastSubmittedSitemap = {
							path: top.path ?? "",
							lastSubmitted: top.lastSubmitted ?? null,
						};
					}
				}
			}

			let indexedPageCount: number | null = null;
			if (analyticsRes.status === "fulfilled") {
				const r = analyticsRes.value as { rows?: unknown[] } | null;
				indexedPageCount = r?.rows?.length ?? 0;
			}

			return {
				verified,
				propertyUrl: siteUrl,
				lastSubmittedSitemap,
				indexedPageCount,
				seoConfig: {
					googleVerification: seoConfig.googleVerification ?? null,
					indexNowKey: seoConfig.indexNowKey ?? null,
					gscPropertyUrl: seoConfig.gscPropertyUrl ?? null,
				},
			};
		},
	);

export const configure = authedOs.configure.use(AUTHZ.appsWrite).handler(
	async ({
		input,
		context,
	}: {
		input: {
			appId: string;
			googleVerification?: string | null;
			indexNowKey?: string | null;
			gscPropertyUrl?: string | null;
		};
		context: BaseContext;
	}) => {
		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(context.db, orgId, input.appId);
		const existing = getAppMetadata(app);
		const prevSeo = existing.seoConfig ?? {};

		const next = {
			...prevSeo,
			googleVerification:
				input.googleVerification === undefined
					? prevSeo.googleVerification
					: (input.googleVerification ?? undefined),
			indexNowKey:
				input.indexNowKey === undefined
					? prevSeo.indexNowKey
					: (input.indexNowKey ?? undefined),
			gscPropertyUrl:
				input.gscPropertyUrl === undefined
					? prevSeo.gscPropertyUrl
					: (input.gscPropertyUrl ?? undefined),
		};

		const updatedMetadata: AppMetadata = {
			...existing,
			seoConfig: next,
		};

		const updated = await updateApp(context.db, input.appId, {
			metadata: updatedMetadata,
		});
		if (!updated) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update app seoConfig",
			);
		}

		return {
			success: true as const,
			seoConfig: {
				googleVerification: next.googleVerification ?? null,
				indexNowKey: next.indexNowKey ?? null,
				gscPropertyUrl: next.gscPropertyUrl ?? null,
			},
		};
	},
);

// =============================================================================
// ROUTER
// =============================================================================

/**
 * Remove a property from Google Search Console. Idempotent — returns
 * `removed: false` (with reason) when the property doesn't exist or the
 * SA isn't an owner. Useful when retiring customer subdomains so Google
 * stops reporting analytics/coverage for dead URLs.
 *
 * Two API calls (best-effort — both surface as 404 once the property is gone):
 * 1. webmasters/v3/sites/{siteUrl}  DELETE  — removes the property
 * 2. siteVerification/v1/webResource/{id} DELETE — relinquishes verification
 *    (only attempted if the property existed; we look up the resource id first)
 */
export const deleteGoogleProperty = authedOs.deleteGoogleProperty
	.use(AUTHZ.appsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string; siteUrl?: string; releaseVerification?: boolean };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const app = await requireAppForOrg(context.db, orgId, input.appId);
			const metadata = getAppMetadata(app);
			const siteUrl = resolveSiteUrl(app, metadata, input.siteUrl);
			const verificationSite = resolveVerificationSite(
				siteUrl,
				inferVerificationMethod(siteUrl),
			);
			const accessToken = await getGscAccessToken(context, orgId);

			// 1) Remove the GSC property
			const gscResp = await fetch(
				`${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${accessToken}` },
				},
			);
			const gscRemoved = gscResp.ok || gscResp.status === 204;
			const gscStatus = gscResp.status;

			// 2) Optionally relinquish siteVerification ownership too. We need
			//    to look up the webResource id first via webResource.list.
			let verificationReleased = false;
			let verificationStatus: number | null = null;
			if (input.releaseVerification ?? true) {
				try {
					const listResp = await fetch(`${SV_BASE}/webResource`, {
						headers: { Authorization: `Bearer ${accessToken}` },
					});
					if (listResp.ok) {
						const listBody = (await listResp.json()) as {
							items?: Array<{ id?: string; site?: { identifier?: string } }>;
						};
						const match = listBody.items?.find(
							(it) =>
								it.site?.identifier === siteUrl ||
								it.site?.identifier === verificationSite.identifier,
						);
						if (match?.id) {
							const delResp = await fetch(
								`${SV_BASE}/webResource/${encodeURIComponent(match.id)}`,
								{
									method: "DELETE",
									headers: { Authorization: `Bearer ${accessToken}` },
								},
							);
							verificationStatus = delResp.status;
							verificationReleased = delResp.ok || delResp.status === 204;
						}
					}
				} catch {
					/* tolerate — primary GSC removal is what matters */
				}
			}

			// 3) Clean up persisted token for this site so future register calls
			//    request a fresh one.
			const prevSeo = (metadata.seoConfig ?? {}) as {
				googleVerification?: string;
				googleVerifications?: Record<string, string>;
				indexNowKey?: string;
				gscPropertyUrl?: string;
			};
			if (prevSeo.googleVerifications?.[siteUrl]) {
				const next = { ...prevSeo.googleVerifications };
				delete next[siteUrl];
				await updateApp(context.db, input.appId, {
					metadata: {
						...metadata,
						seoConfig: { ...prevSeo, googleVerifications: next },
					},
				});
			}

			return {
				success: true as const,
				siteUrl,
				gscRemoved,
				gscStatus,
				verificationReleased,
				verificationStatus,
			};
		},
	);

export const seoContractRouter = seoOs.router({
	researchKeywords,
	getSerpResults,
	getDomainOverview,
	getBacklinksOverview,
	querySearchAnalytics,
	getIndexingStatus,
	listSitemaps,
	submitSitemap,
	verifyGoogle,
	registerGoogleProperty,
	deleteGoogleProperty,
	getStatus,
	configure,
});
