import {
	calendarQuery,
	contentListQuery,
	createCollectionBody,
	updateCollectionBody,
} from "emdash/api/schemas";
import {
	Client,
	type PriorDiscovery,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
	UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/client";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { unwrapCmsToolResult } from "./tool-result";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import {
	describeCmsHumanAuthDenial,
	encodeCmsHumanIdentity,
	type CmsHumanAuthDenial,
	type CmsHumanIdentity,
} from "./cms-human-auth";

export interface CmsProxyContext {
	orgSlug: string;
	/** Verified platform administrator; required for whole-site transfer tools. */
	isPlatformAdmin?: boolean;
	/** Verified Site Builder authority for native CMS maintenance. */
	mediaMaintenanceAuthorized?: boolean;
	/** User's Descope JWT forwarded from the MCP Worker via X-Forwarded-Authorization. */
	forwardedAuth: string | undefined;
	/** A validated human OAuth caller must never silently use site credentials. */
	humanAuthRequired?: boolean;
	humanIdentity?: CmsHumanIdentity | null;
	/** Why `humanIdentity` is null for a human caller; surfaced verbatim in tool errors. */
	humanAuthDenial?: CmsHumanAuthDenial | null;
	/** Emdash PAT for REST fallback and bearer-only native tenant MCP forwarding. */
	serviceApiKey: string | undefined;
	/** Shared internal secret for Site Builder -> CMS Runtime service-binding calls. */
	internalAuthToken: string | undefined;
	environment: string;
	/** Service binding to the CMS dispatch worker (avoids public DNS 522s). */
	cmsDispatch?: Fetcher;
	/** Platform bindings for get_site_overview; other proxy calls do not need them. */
	db?: D1Database;
	bundlesBucket?: R2Bucket;
	/** Server-only lookup; transfer tools invoke this after admin and ownership checks. */
	loadTransferServiceKey?: (slug: string) => Promise<string | undefined>;
	/** Resolve the same human against each transfer site; assertions are site-bound. */
	loadTransferHumanIdentity?: (
		slug: string,
	) => Promise<CmsHumanIdentity | null>;
}

/** True when the token looks like a JWT (3 base64url segments). */
export function isJwt(token: string): boolean {
	const parts = token.split(".");
	return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

export type AuthHeaderCandidate = {
	source: "jwt" | "pat" | "internal";
	headers: Record<string, string>;
};

/**
 * Build the ordered auth header candidates for an Emdash REST call.
 *
 * Emdash middleware (handleBearerAuth) only accepts ec_pat_* / ec_oat_* as
 * Authorization: Bearer — any other bearer token returns "invalid" (401)
 * immediately, before handleExternalAuth / the Descope adapter ever runs.
 *
 * Routing:
 *   Descope JWT             → Cookie: DS=<jwt>           (handleExternalAuth / Descope adapter path)
 *   PAT (ec_pat_*|ec_oat_*) → Authorization: Bearer     (handleBearerAuth path)
 *   Site Builder service binding  → X-Tedix-CMS-Internal-Auth (Descope adapter service principal path)
 */
export function buildCmsAuthHeaderCandidates(
	ctx: CmsProxyContext,
): AuthHeaderCandidate[] {
	const candidates: AuthHeaderCandidate[] = [];
	if (ctx.humanAuthRequired) {
		if (!ctx.humanIdentity || !ctx.internalAuthToken) return candidates;
		return [
			{
				source: "jwt",
				headers: {
					Accept: "application/json",
					"X-EmDash-Request": "1",
					"X-Tedix-CMS-Forwarded-User-Auth": ctx.internalAuthToken,
					"X-Tedix-CMS-Human-Identity": encodeCmsHumanIdentity(
						ctx.humanIdentity,
					),
				},
			},
		];
	}
	// Descope JWT — human session forwarded from MCP Worker.
	// Must not use Authorization: Bearer (handleBearerAuth rejects unknown formats).
	if (ctx.forwardedAuth && isJwt(ctx.forwardedAuth)) {
		candidates.push({
			source: "jwt",
			headers: {
				Accept: "application/json",
				Cookie: `DS=${ctx.forwardedAuth}`,
				...(ctx.internalAuthToken
					? { "X-Tedix-CMS-Forwarded-User-Auth": ctx.internalAuthToken }
					: {}),
				"X-EmDash-Request": "1",
			},
		});
		// A human session keeps its own Emdash permissions and attribution.
		// The platform admin is already authorized for every site and may recover
		// from a CMS cookie 401 through the trusted site credential below.
		if (!ctx.isPlatformAdmin) return candidates;
	}
	// PAT fallback — service context (tedi / automation).
	if (
		ctx.serviceApiKey?.startsWith("ec_pat_") ||
		ctx.serviceApiKey?.startsWith("ec_oat_")
	) {
		candidates.push({
			source: "pat",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${ctx.serviceApiKey}`,
				"X-EmDash-Request": "1",
			},
		});
	}
	// Trusted Site Builder Worker -> CMS Runtime service-binding path. Do not send
	// non-Emdash bearer tokens; Emdash's bearer middleware rejects unknown
	// token formats before the external auth provider can run.
	if (ctx.internalAuthToken) {
		candidates.push({
			source: "internal",
			headers: {
				Accept: "application/json",
				"X-Tedix-CMS-Internal-Auth": ctx.internalAuthToken,
				"X-EmDash-Request": "1",
			},
		});
	}
	return candidates;
}

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
	_meta?: { code?: string; details?: any };
};

/**
 * The reason no auth candidate exists for this call, so an operator can act on
 * the actual cause (a stale marker after a theme deploy, a missing role, an
 * unverified bearer, or no credential at all) instead of guessing at token
 * expiry. Never includes a token or key value.
 */
export function describeCmsAuthUnavailable(ctx: CmsProxyContext): string {
	if (ctx.humanAuthRequired) {
		if (ctx.humanIdentity && !ctx.internalAuthToken)
			return "Human CMS auth resolved but the Site Builder has no CMS_INTERNAL_AUTH_TOKEN to carry the assertion.";
		if (ctx.humanAuthDenial)
			return describeCmsHumanAuthDenial(ctx.humanAuthDenial);
		return describeCmsHumanAuthDenial({ reason: "unverified_bearer" });
	}
	return "No credential at all: no Emdash service PAT for this org (CMS_SERVICE_KEYS or cms_provision_service_key) and no CMS_INTERNAL_AUTH_TOKEN configured.";
}

export function cmsAuthUnavailableToolResult(ctx: CmsProxyContext): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: `[UNAUTHORIZED] ${describeCmsAuthUnavailable(ctx)}`,
			},
		],
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// Native tenant MCP forwarding
//
// Emdash serves a stateless MCP server at {slug}.cms.{domain}/_emdash/api/mcp.
// Upstream middleware makes that endpoint bearer-token-only: session and
// external auth are never consulted for it (emdash core
// astro/middleware/auth.ts, MCP_ENDPOINT_PATH branch), so the only credential
// that works is an Emdash PAT/OAuth token. cms_provision_service_key
// bootstraps and stores that PAT per org.
// ---------------------------------------------------------------------------

export const EMDASH_DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const TENANT_MCP_TIMEOUT_MS = 30_000;
const TENANT_MCP_CLIENT_INFO = {
	name: "tedix-cms-site-builder",
	version: "1.0.0",
};

// Released Emdash serves MCP through the 2025-era SDK transport only, so an
// unseeded `versionNegotiation: 'auto'` connect pays a `server/discover` probe
// (answered with a 400 "Unsupported protocol version": a legacy signal) before
// the `initialize` handshake. The verdict is a property of the tenant's
// deployed Emdash, so it is remembered per endpoint URL (one tenant in one
// environment) for a bounded TTL: an Emdash upgrade to the 2026 revision is
// picked up within one TTL, and any failed call evicts the entry so the next
// call re-probes. Only verdicts from a successful connect are stored.
const TENANT_MCP_ERA_TTL_MS = 10 * 60_000;
const MAX_TENANT_MCP_ERA_ENTRIES = 256;
const tenantMcpEras = new Map<
	string,
	{ prior: PriorDiscovery; expiresAt: number }
>();

function rememberedTenantMcpEra(url: string): PriorDiscovery | undefined {
	const entry = tenantMcpEras.get(url);
	if (!entry) return undefined;
	if (entry.expiresAt > Date.now()) return entry.prior;
	tenantMcpEras.delete(url);
	return undefined;
}

function rememberTenantMcpEra(url: string, client: Client): void {
	const era = client.getProtocolEra();
	const discover = client.getDiscoverResult();
	const prior: PriorDiscovery | undefined =
		era === "legacy"
			? { kind: "legacy" }
			: era === "modern" && discover
				? { kind: "modern", discover }
				: undefined;
	if (!prior) return;
	tenantMcpEras.delete(url);
	if (tenantMcpEras.size >= MAX_TENANT_MCP_ERA_ENTRIES) {
		// Map iteration is insertion order: evict the oldest verdict.
		const oldest = tenantMcpEras.keys().next().value;
		if (oldest !== undefined) tenantMcpEras.delete(oldest);
	}
	tenantMcpEras.set(url, {
		prior,
		expiresAt: Date.now() + TENANT_MCP_ERA_TTL_MS,
	});
}

/** Test seam: forget every remembered tenant MCP protocol era. */
export function clearTenantMcpEras(): void {
	tenantMcpEras.clear();
}

const observedEmdashMcpTenants = new Set<string>();
const MAX_OBSERVED_EMDASH_MCP_TENANTS = 128;

function recordEmdashMcpProtocolUse(orgSlug: string, client: Client): void {
	if (observedEmdashMcpTenants.has(orgSlug)) return;
	if (observedEmdashMcpTenants.size >= MAX_OBSERVED_EMDASH_MCP_TENANTS) return;
	observedEmdashMcpTenants.add(orgSlug);
	console.info(
		JSON.stringify({
			event: "cms_emdash_mcp_protocol_use",
			provider: "emdash",
			protocolVersion: client.getNegotiatedProtocolVersion(),
			protocolEra: client.getProtocolEra(),
			organizationSlug: orgSlug,
			adapter: "tenant_native_mcp",
		}),
	);
}

export function cmsApiBaseUrl(ctx: CmsProxyContext): string {
	const origin = buildSurfaceUrl("cms", ctx.orgSlug, {
		platformDomain: platformDomainForEnvironment(ctx.environment),
	});
	if (!origin) throw new Error("CMS organization slug is required");
	return `${origin}/_emdash/api`;
}

export function cmsDoFetch(
	ctx: CmsProxyContext,
): (url: string, init: RequestInit) => Promise<Response> {
	return ctx.cmsDispatch
		? (url, init) => ctx.cmsDispatch!.fetch(new Request(url, init))
		: (url, init) => fetch(url, init);
}

export function tenantMcpError(code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${code}] ${message}` }],
		isError: true,
		_meta: { code },
	};
}

/** True when the context carries a credential the bearer-only tenant MCP endpoint accepts. */
export function hasTenantMcpCredential(ctx: CmsProxyContext): boolean {
	// The native endpoint is PAT-only. Human OAuth requests must keep their own
	// role and attribution through the assertion-aware REST adapter.
	if (ctx.humanAuthRequired) return false;
	return (
		ctx.serviceApiKey?.startsWith("ec_pat_") === true ||
		ctx.serviceApiKey?.startsWith("ec_oat_") === true
	);
}

/**
 * Forward one tool call to the tenant's native, stateless Emdash MCP server.
 *
 * The Site Builder request is already tenant-authorized. The inner hop must use a
 * stored Emdash PAT because the native MCP endpoint is bearer-only upstream.
 * CMS_DISPATCH remains the network trust path.
 *
 * One SDK v2 client negotiates the era (`server/discover`, falling back to the
 * 2025 `initialize` handshake), seeded with the tenant's remembered verdict.
 * `tools/call` is sent exactly once: input_required auto-fulfilment is off, and
 * the explicit tool definition disables the SDK's `-32020` list-and-resend.
 * A failure before `tools/call` is reported as CMS_MCP_DISCOVERY_FAILED, which
 * lets read callers recover through REST after a 401.
 */
type TenantMcpRequestOptions = { signal: AbortSignal; timeout: number };

async function withTenantMcpSession(
	ctx: CmsProxyContext,
	operation: (
		client: Client,
		options: TenantMcpRequestOptions,
	) => Promise<ToolResult>,
): Promise<ToolResult> {
	if (!hasTenantMcpCredential(ctx)) {
		return tenantMcpError(
			"UNAUTHORIZED",
			"Native tenant MCP forwarding requires an Emdash service PAT; run cms_provision_service_key first",
		);
	}

	const url = `${cmsApiBaseUrl(ctx)}/mcp`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TENANT_MCP_TIMEOUT_MS);
	const client = new Client(TENANT_MCP_CLIENT_INFO, {
		versionNegotiation: { mode: "auto" },
		inputRequired: { autoFulfill: false },
	});
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers: { Authorization: `Bearer ${ctx.serviceApiKey}` },
		},
		fetch: (input, init) => {
			// Emdash's endpoint is stateless and answers the standalone SSE GET
			// with 405 after a full auth pass; answer it locally instead.
			if (init?.method === "GET") {
				return Promise.resolve(new Response(null, { status: 405 }));
			}
			const request = new Request(input, {
				...init,
				signal: controller.signal,
			});
			return ctx.cmsDispatch ? ctx.cmsDispatch.fetch(request) : fetch(request);
		},
	});
	const requestOptions = {
		signal: controller.signal,
		timeout: TENANT_MCP_TIMEOUT_MS,
	};
	const prior = rememberedTenantMcpEra(url);
	let stage: "connect" | "call" = "connect";
	try {
		await client.connect(transport, {
			...requestOptions,
			...(prior ? { prior } : {}),
		});
		rememberTenantMcpEra(url, client);
		recordEmdashMcpProtocolUse(ctx.orgSlug, client);
		stage = "call";
		const result = await operation(client, requestOptions);
		if (!Array.isArray(result.content)) {
			return tenantMcpError(
				"CMS_MCP_INVALID_RESPONSE",
				"Tenant MCP returned no tool result",
			);
		}
		return result as ToolResult;
	} catch (error) {
		// A JSON-RPC error answering tools/call says nothing about the era.
		if (stage === "connect" || !(error instanceof ProtocolError)) {
			tenantMcpEras.delete(url);
		}
		return tenantMcpFailure(stage, error, controller.signal.aborted);
	} finally {
		clearTimeout(timer);
		await client.close().catch(() => {});
	}
}

export async function callTenantMcpTool(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	return withTenantMcpSession(
		ctx,
		(client, options) =>
			client.callTool(
				{ name: toolName, arguments: args },
				{
					...options,
					toolDefinition: { name: toolName, inputSchema: { type: "object" } },
				},
			) as Promise<ToolResult>,
	);
}

/** Native onboarding completion retains the actor and native administrator authorization. */
export async function completeExistingCmsSetup(
	ctx: CmsProxyContext,
): Promise<ToolResult> {
	if (!ctx.mediaMaintenanceAuthorized) {
		return tenantMcpError(
			"FORBIDDEN",
			"Content admin required for existing-site onboarding",
		);
	}
	return callCmsRest(ctx, "complete_existing_setup", {});
}

/** Fixed native plugin REST operations retain the actor; native handlers authorize and validate. */
export async function callCmsFormsTool(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	if (!NATIVE_FORM_TOOL_NAMES.has(toolName))
		return tenantMcpError(
			"FORBIDDEN",
			"This native plugin operation is not exposed",
		);
	if (!ctx.mediaMaintenanceAuthorized)
		return tenantMcpError(
			"FORBIDDEN",
			"Content admin required for private Forms operations",
		);
	return callCmsRest(ctx, toolName, args);
}

export const NATIVE_FORM_TOOL_NAMES: ReadonlySet<string> = new Set([
	"list_forms",
	"create_form",
	"update_form",
	"list_form_submissions",
	"get_form_submission",
]);

/** Inspect installed tools without replacing a human's identity with site credentials. */
export async function listTenantMcpTools(
	ctx: CmsProxyContext,
): Promise<ToolResult> {
	if (
		ctx.humanAuthRequired ||
		(ctx.forwardedAuth && isJwt(ctx.forwardedAuth))
	) {
		return tenantMcpError(
			"CMS_MCP_HUMAN_METADATA_UNAVAILABLE",
			"Native tool metadata was not inspected: this human session cannot use the tenant service PAT",
		);
	}
	return withTenantMcpSession(ctx, async (client, options) => {
		const result = await client.listTools(undefined, options);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			...{ structuredContent: result },
		};
	});
}

function tenantMcpFailure(
	stage: "connect" | "call",
	error: unknown,
	aborted: boolean,
): ToolResult {
	if (
		aborted ||
		(error instanceof Error && error.name === "AbortError") ||
		(error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
	) {
		return tenantMcpError(
			"CMS_MCP_REQUEST_FAILED",
			"Tenant MCP request timed out",
		);
	}
	if (error instanceof UnsupportedProtocolVersionError) {
		return tenantMcpError(
			"CMS_MCP_PROTOCOL_UNSUPPORTED",
			`Tenant MCP offers no protocol revision this client supports: ${error.message}`,
		);
	}
	if (error instanceof SdkHttpError) {
		const text = error.data.text;
		const detail = typeof text === "string" ? text.slice(0, 400) : "";
		return stage === "connect"
			? tenantMcpError(
					"CMS_MCP_DISCOVERY_FAILED",
					`Tenant MCP discovery failed (${error.status})${detail ? `: ${detail}` : ""}`,
				)
			: tenantMcpError(
					"CMS_MCP_HTTP_ERROR",
					`Tenant MCP returned ${error.status}${detail ? `: ${detail}` : ""}`,
				);
	}
	if (error instanceof ProtocolError) {
		return tenantMcpError(
			stage === "connect"
				? "CMS_MCP_DISCOVERY_FAILED"
				: "CMS_MCP_PROTOCOL_ERROR",
			`${error.message} (JSON-RPC ${error.code})`,
		);
	}
	return tenantMcpError(
		"CMS_MCP_REQUEST_FAILED",
		error instanceof Error ? error.message : String(error),
	);
}

export const SANDBOX_FREE_CMS_PROXY_TOOLS = new Set([
	"configure_search",
	"get_site_overview",
	"content_list",
	"list_content_byline_entries",
	"list_calendar_entries",
	"list_content_authors",
]);

export type RestCallResult =
	| {
			ok: true;
			status: number;
			text: string;
			json: unknown;
			authSource: AuthHeaderCandidate["source"];
	  }
	| {
			ok: false;
			status: number;
			text: string;
			authSource: AuthHeaderCandidate["source"];
	  };

const CMS_REST_REQUEST_TIMEOUT_MS = 15_000;
// Native transfer steps checkpoint under a five-minute lease and can exceed
// ordinary REST latency. Aborting early strands that lease until expiry.
const CMS_TRANSFER_REQUEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// REST API proxy — calls Emdash REST endpoints with Descope cookie auth
// ---------------------------------------------------------------------------

interface RestRoute {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: (args: Record<string, unknown>) => string;
	body?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
	query?: (args: Record<string, unknown>) => Record<string, string>;
}

function localeQuery(args: Record<string, unknown>): Record<string, string> {
	const locale = args.locale;
	return typeof locale === "string" && locale.length > 0 ? { locale } : {};
}

// Entry locking (Emdash 0.38): a write against a locked entry 409s unless the
// caller opts in per-call. DELETE has no body, so it rides the query string.
function lockQuery(args: Record<string, unknown>): Record<string, string> {
	const q = localeQuery(args);
	if (args.overrideLock === true) q.overrideLock = "true";
	return q;
}

function inferAllowedMimeTypes(
	args: Record<string, unknown>,
): string[] | undefined {
	const type = typeof args.type === "string" ? args.type : "";
	const slug = typeof args.slug === "string" ? args.slug.toLowerCase() : "";
	const label = typeof args.label === "string" ? args.label.toLowerCase() : "";
	const name = `${slug} ${label}`;

	if (Array.isArray(args.allowedTypes)) {
		const values = args.allowedTypes.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		return values.length > 0 ? values : undefined;
	}

	if (type === "image") return ["image/"];
	if (type !== "file") return undefined;
	if (/\b(pdf|document|whitepaper|brochure|guide)\b/.test(name))
		return ["application/pdf"];
	if (/\b(logo|avatar|image|photo|og|favicon)\b/.test(name)) return ["image/"];
	return undefined;
}

function schemaFieldBody(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const validation =
		args.validation &&
		typeof args.validation === "object" &&
		!Array.isArray(args.validation)
			? { ...(args.validation as Record<string, unknown>) }
			: {};
	const allowedMimeTypes = inferAllowedMimeTypes(args);
	if (allowedMimeTypes && !validation.allowedMimeTypes) {
		validation.allowedMimeTypes = allowedMimeTypes;
	}

	return {
		slug: args.slug,
		label: args.label,
		type: args.type,
		required: args.required,
		unique: args.unique,
		defaultValue: args.defaultValue,
		validation:
			Object.keys(validation).length > 0 ? validation : args.validation,
		widget: args.widget,
		options: args.options,
		sortOrder: args.sortOrder,
		searchable: args.searchable,
		indexed: args.indexed,
		translatable: args.translatable,
	};
}

function bylineFieldBody(
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		slug: args.slug,
		label: args.label,
		type: args.type,
		required: args.required,
		translatable: args.translatable,
		validation: args.validation,
		sortOrder: args.sortOrder,
	};
}

function bylineFieldUpdateBody(
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		label: args.label,
		required: args.required,
		translatable: args.translatable,
		validation: args.validation,
		sortOrder: args.sortOrder,
	};
}

function contentListQueryParams(
	a: Record<string, unknown>,
): Record<string, string> {
	const q: Record<string, string> = {};
	if (a.q) q.q = String(a.q);
	if (a.status) q.status = String(a.status);
	if (a.limit) q.limit = String(a.limit);
	if (a.cursor) q.cursor = String(a.cursor);
	if (a.orderBy) q.orderBy = String(a.orderBy);
	if (a.order) q.order = String(a.order);
	if (a.locale) q.locale = String(a.locale);
	if (a.authorId) q.authorId = String(a.authorId);
	if (a.dateField && (a.dateFrom || a.dateTo)) {
		q.dateField = String(a.dateField);
		if (a.dateFrom) q.dateFrom = String(a.dateFrom);
		if (a.dateTo) q.dateTo = String(a.dateTo);
	}
	return q;
}

const REST_ROUTES: Record<string, RestRoute> = {
	list_calendar_entries: {
		method: "GET",
		path: () => "/calendar",
		query: (a) => {
			const parsed = calendarQuery.parse(a);
			return {
				from: parsed.from,
				to: parsed.to,
				limit: String(parsed.limit),
				...(parsed.cursor ? { cursor: parsed.cursor } : {}),
			};
		},
	},
	// Content (17)
	content_list: {
		method: "GET",
		path: (a) => `/content/${a.collection}`,
		query: contentListQueryParams,
	},
	list_content_byline_entries: {
		method: "GET",
		path: (a) => `/content/${a.collection}`,
		query: contentListQueryParams,
	},
	list_content_authors: {
		method: "GET",
		path: (a) => `/content/${a.collection}/authors`,
	},
	content_get: {
		method: "GET",
		path: (a) => `/content/${a.collection}/${a.id}`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.locale) q.locale = String(a.locale);
			return q;
		},
	},
	content_preview_url: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/preview-url`,
		body: (a) => ({
			expiresIn: a.expiresIn,
			pathPattern: a.pathPattern,
		}),
	},
	content_create: {
		method: "POST",
		path: (a) => `/content/${a.collection}`,
		body: (a) => ({
			data: a.data,
			slug: a.slug,
			status: a.status,
			locale: a.locale,
			translationOf: a.translationOf,
			references: a.references,
		}),
	},
	// content_update accepts seo / bylines / publishedAt directly — no SQL fallback needed.
	content_update: {
		method: "PUT",
		path: (a) => `/content/${a.collection}/${a.id}`,
		body: (a) => ({
			data: a.data,
			slug: a.slug,
			status: a.status,
			seo: a.seo,
			bylines: a.bylines,
			publishedAt: a.publishedAt,
			references: a.references,
			migrateBlocks: a.migrateBlocks,
			replaceBlocks: a.replaceBlocks,
			_rev: a._rev,
			overrideLock: a.overrideLock === true ? true : undefined,
		}),
	},
	content_delete: {
		method: "DELETE",
		path: (a) => `/content/${a.collection}/${a.id}`,
		query: lockQuery,
	},
	content_restore: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/restore`,
	},
	content_permanent_delete: {
		method: "DELETE",
		path: (a) => `/content/${a.collection}/${a.id}/permanent`,
		query: lockQuery,
	},
	// Optional publishedAt ISO timestamp override (gated by content:publish_any scope).
	content_publish: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/publish`,
		query: localeQuery,
		body: (a) =>
			a.publishedAt || a._rev !== undefined || a.overrideLock === true
				? {
						publishedAt: a.publishedAt,
						_rev: a._rev,
						overrideLock: a.overrideLock === true ? true : undefined,
					}
				: undefined,
	},
	content_unpublish: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/unpublish`,
		query: localeQuery,
		body: (a) => ({
			_rev: a._rev,
			overrideLock: a.overrideLock === true ? true : undefined,
		}),
	},
	content_schedule: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/schedule`,
		query: localeQuery,
		body: (a) => ({
			scheduledAt: a.scheduledAt,
			_rev: a._rev,
			overrideLock: a.overrideLock === true ? true : undefined,
		}),
	},
	content_unschedule: {
		method: "DELETE",
		path: (a) => `/content/${a.collection}/${a.id}/schedule`,
		query: localeQuery,
	},
	content_compare: {
		method: "GET",
		path: (a) => `/content/${a.collection}/${a.id}/compare`,
		query: localeQuery,
	},
	content_discard_draft: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/discard-draft`,
		query: localeQuery,
		body: (a) => ({
			_rev: a._rev,
			overrideLock: a.overrideLock === true ? true : undefined,
		}),
	},
	content_list_trashed: {
		method: "GET",
		path: (a) => `/content/${a.collection}/trash`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	content_duplicate: {
		method: "POST",
		path: (a) => `/content/${a.collection}/${a.id}/duplicate`,
	},
	content_translations: {
		method: "GET",
		path: (a) => `/content/${a.collection}/${a.id}/translations`,
	},
	content_get_terms: {
		method: "GET",
		path: (a) =>
			`/content/${a.collection}/${a.id}/terms/${encodeURIComponent(String(a.taxonomy))}`,
	},
	content_set_terms: {
		method: "POST",
		path: (a) =>
			`/content/${a.collection}/${a.id}/terms/${encodeURIComponent(String(a.taxonomy))}`,
		body: (a) => ({ termIds: a.termIds }),
	},
	// Collection, field, and versioned block schema
	schema_list_collections: { method: "GET", path: () => "/schema/collections" },
	schema_get_collection: {
		method: "GET",
		path: (a) => `/schema/collections/${a.slug}`,
		query: () => ({ includeFields: "true" }),
	},
	schema_list_block_types: { method: "GET", path: () => "/schema/block-types" },
	schema_get_block_type: {
		method: "GET",
		path: (a) => `/schema/block-types/${encodeURIComponent(String(a.slug))}`,
	},
	schema_create_block_type: {
		method: "POST",
		path: () => "/schema/block-types",
		body: (a) => ({
			slug: a.slug,
			label: a.label,
			description: a.description,
			icon: a.icon,
			category: a.category,
			fields: a.fields,
		}),
	},
	schema_update_block_type: {
		method: "PUT",
		path: (a) => `/schema/block-types/${encodeURIComponent(String(a.slug))}`,
		body: (a) => ({
			expectedFingerprint: a.expectedFingerprint,
			label: a.label,
			description: a.description,
			icon: a.icon,
			category: a.category,
			fields: a.fields,
			breaking: a.breaking,
		}),
	},
	schema_activate_block_type_version: {
		method: "POST",
		path: (a) =>
			`/schema/block-types/${encodeURIComponent(String(a.slug))}/versions/${a.version}/activate`,
		body: (a) => ({ expectedFingerprint: a.expectedFingerprint }),
	},
	schema_create_collection: {
		method: "POST",
		path: () => "/schema/collections",
		body: (a) => createCollectionBody.omit({ source: true }).parse(a),
	},
	schema_update_collection: {
		method: "PUT",
		path: (a) => `/schema/collections/${a.slug}`,
		body: (a) => updateCollectionBody.parse(a),
	},
	schema_delete_collection: {
		method: "DELETE",
		path: (a) => `/schema/collections/${a.slug}`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.force) q.force = "true";
			return q;
		},
	},
	schema_create_field: {
		method: "POST",
		path: (a) => `/schema/collections/${a.collection}/fields`,
		body: schemaFieldBody,
	},
	schema_update_field: {
		method: "PUT",
		path: (a) => `/schema/collections/${a.collection}/fields/${a.fieldSlug}`,
		body: schemaFieldBody,
	},
	schema_delete_field: {
		method: "DELETE",
		path: (a) => `/schema/collections/${a.collection}/fields/${a.fieldSlug}`,
	},
	relation_list: {
		method: "GET",
		path: () => "/relations",
		query: (a) => {
			const query: Record<string, string> = {};
			if (a.collection) query.collection = String(a.collection);
			return query;
		},
	},
	relation_get: {
		method: "GET",
		path: (a) => `/relations/${encodeURIComponent(String(a.id))}`,
	},
	relation_create: {
		method: "POST",
		path: () => "/relations",
		body: (a) => ({
			slug: a.slug,
			parentCollection: a.parentCollection,
			childCollection: a.childCollection,
			parentLabel: a.parentLabel,
			parentLabelSingular: a.parentLabelSingular,
			childLabel: a.childLabel,
			childLabelSingular: a.childLabelSingular,
			maxChildrenPerParent: a.maxChildrenPerParent,
			maxParentsPerChild: a.maxParentsPerChild,
		}),
	},
	relation_update: {
		method: "PATCH",
		path: (a) => `/relations/${encodeURIComponent(String(a.id))}`,
		body: (a) => ({
			parentLabel: a.parentLabel,
			parentLabelSingular: a.parentLabelSingular,
			childLabel: a.childLabel,
			childLabelSingular: a.childLabelSingular,
			maxChildrenPerParent: a.maxChildrenPerParent,
			maxParentsPerChild: a.maxParentsPerChild,
		}),
	},
	relation_delete: {
		method: "DELETE",
		path: (a) => `/relations/${encodeURIComponent(String(a.id))}`,
	},
	// Media
	media_list: {
		method: "GET",
		path: () => "/media",
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.mimeType) q.mimeType = String(a.mimeType);
			if (a.folderId) q.folderId = String(a.folderId);
			if (a.includeUsage === true) q.includeUsage = "1";
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	media_create: {
		method: "POST",
		path: () => "/media",
		body: (a) => ({
			filename: a.filename,
			mimeType: a.mimeType,
			storageKey: a.storageKey,
			size: a.size,
			width: a.width,
			height: a.height,
			contentHash: a.contentHash,
			blurhash: a.blurhash,
			dominantColor: a.dominantColor,
		}),
	},
	media_get: {
		method: "GET",
		path: (a) => `/media/${encodeURIComponent(String(a.id))}`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.includeUsage === true) q.includeUsage = "1";
			return q;
		},
	},
	media_usage_details: {
		method: "GET",
		path: (a) => `/media/${encodeURIComponent(String(a.id))}/usage`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	media_update: {
		method: "PUT",
		path: (a) => `/media/${a.id}`,
		body: (a) => ({
			alt: a.alt,
			caption: a.caption,
			width: a.width,
			height: a.height,
			folderId: a.folderId,
		}),
	},
	media_delete: { method: "DELETE", path: (a) => `/media/${a.id}` },
	list_media_folders: {
		method: "GET",
		path: () => "/media/folders",
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			if (a.q) q.q = String(a.q);
			return q;
		},
	},
	get_media_folder: {
		method: "GET",
		path: (a) => `/media/folders/${encodeURIComponent(String(a.id))}`,
	},
	create_media_folder: {
		method: "POST",
		path: () => "/media/folders",
		body: (a) => ({ name: a.name }),
	},
	rename_media_folder: {
		method: "PUT",
		path: (a) => `/media/folders/${encodeURIComponent(String(a.id))}`,
		body: (a) => ({ name: a.name }),
	},
	delete_media_folder: {
		method: "DELETE",
		path: (a) => `/media/folders/${encodeURIComponent(String(a.id))}`,
	},
	media_usage_progress: {
		method: "GET",
		path: () => "/admin/media-usage/progress",
	},
	media_usage_collection_deletions: {
		method: "GET",
		path: () => "/admin/media-usage/collection-deletions",
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.state) q.state = String(a.state);
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	media_usage_activation: {
		method: "GET",
		path: () => "/admin/media-usage/activation",
	},
	media_usage_activate: {
		method: "POST",
		path: () => "/admin/media-usage/activation",
		body: (a) => ({ writersDrained: a.writersDrained }),
	},
	media_usage_progress_advance: {
		method: "POST",
		path: () => "/admin/media-usage/progress",
	},
	media_usage_repair: {
		method: "POST",
		path: () => "/admin/media-usage/repair",
		body: (a) =>
			a.scope === "collection"
				? { scope: "collection", collection: a.collection }
				: { scope: "all" },
	},
	// External provider browsing (Unsplash/Mux/Cloudinary/etc).
	media_providers_list: { method: "GET", path: () => "/media/providers" },
	media_providers_browse: {
		method: "GET",
		path: (a) => `/media/providers/${a.providerId}`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.query) q.q = String(a.query);
			if (a.mimeType) q.mimeType = String(a.mimeType);
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	media_search: {
		method: "GET",
		path: () => "/media",
		query: (a) => {
			const q: Record<string, string> = {};
			const query = a.q ?? a.query;
			if (query) q.q = String(query);
			if (a.mimeType) q.mimeType = String(a.mimeType);
			if (a.limit) q.limit = String(a.limit);
			if (a.cursor) q.cursor = String(a.cursor);
			return q;
		},
	},
	// media_upload forwards to the native tenant MCP tool (multipart REST
	// fallback without a PAT) — see mediaUpload() below.
	// media_to_field_value is a pure transform with no REST call.
	// Search
	search: {
		method: "GET",
		path: () => "/search",
		query: (a) => {
			const q: Record<string, string> = { q: String(a.query) };
			if (a.collections) q.collections = (a.collections as string[]).join(",");
			if (a.locale) q.locale = String(a.locale);
			if (a.limit) q.limit = String(a.limit);
			return q;
		},
	},
	configure_search: {
		method: "POST",
		path: () => "/search/enable",
		body: (a) => ({
			collection: a.collection,
			enabled: a.enabled,
			weights: a.weights,
			tokenize: a.tokenize,
		}),
	},

	// Taxonomy definitions and locale-aware terms
	taxonomy_list: {
		method: "GET",
		path: () => "/taxonomies",
		query: localeQuery,
	},
	taxonomy_get: {
		method: "GET",
		path: (a) => `/taxonomies/${encodeURIComponent(String(a.name))}`,
		query: localeQuery,
	},
	taxonomy_translations: {
		method: "GET",
		path: (a) =>
			`/taxonomies/${encodeURIComponent(String(a.name))}/translations`,
		query: localeQuery,
	},
	taxonomy_create: {
		method: "POST",
		path: () => "/taxonomies",
		body: (a) => ({
			name: a.name,
			label: a.label,
			labelSingular: a.labelSingular,
			hierarchical: a.hierarchical,
			collections: a.collections,
			locale: a.locale,
			translationOf: a.translationOf,
		}),
	},
	taxonomy_update: {
		method: "PUT",
		path: (a) => `/taxonomies/${encodeURIComponent(String(a.name))}`,
		query: localeQuery,
		body: (a) => ({
			label: a.label,
			labelSingular: a.labelSingular,
			hierarchical: a.hierarchical,
			collections: a.collections,
		}),
	},
	taxonomy_delete: {
		method: "DELETE",
		path: (a) => `/taxonomies/${encodeURIComponent(String(a.name))}`,
	},
	taxonomy_list_terms: {
		method: "GET",
		path: (a) => `/taxonomies/${encodeURIComponent(String(a.taxonomy))}/terms`,
		query: (a) => {
			const q = localeQuery(a);
			if (a.includeCounts !== undefined)
				q.includeCounts = String(a.includeCounts);
			if (a.resolveFallback !== undefined)
				q.resolveFallback = String(a.resolveFallback);
			return q;
		},
	},
	taxonomy_term_translations: {
		method: "GET",
		path: (a) =>
			`/taxonomies/${encodeURIComponent(String(a.taxonomy))}/terms/${encodeURIComponent(String(a.termSlug))}/translations`,
		query: localeQuery,
	},
	taxonomy_create_term: {
		method: "POST",
		path: (a) => `/taxonomies/${encodeURIComponent(String(a.taxonomy))}/terms`,
		body: (a) => ({
			slug: a.slug,
			label: a.label,
			parentId: a.parentId,
			description: a.description,
			locale: a.locale,
			translationOf: a.translationOf,
		}),
	},
	taxonomy_update_term: {
		method: "PUT",
		path: (a) =>
			`/taxonomies/${encodeURIComponent(String(a.taxonomy))}/terms/${encodeURIComponent(String(a.termSlug))}`,
		query: localeQuery,
		body: (a) => ({
			slug: a.slug,
			label: a.label,
			parentId: a.parentId,
			description: a.description,
		}),
	},
	taxonomy_delete_term: {
		method: "DELETE",
		path: (a) =>
			`/taxonomies/${encodeURIComponent(String(a.taxonomy))}/terms/${encodeURIComponent(String(a.termSlug))}`,
		query: localeQuery,
	},
	// Bylines and byline custom-field schema
	byline_list: {
		method: "GET",
		path: () => "/admin/bylines",
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.search) q.search = String(a.search);
			if (a.isGuest !== undefined) q.isGuest = String(a.isGuest);
			if (a.userId) q.userId = String(a.userId);
			if (a.locale) q.locale = String(a.locale);
			if (a.cursor) q.cursor = String(a.cursor);
			if (a.limit) q.limit = String(a.limit);
			return q;
		},
	},
	byline_get: {
		method: "GET",
		path: (a) => `/admin/bylines/${a.id}`,
	},
	byline_create: {
		method: "POST",
		path: () => "/admin/bylines",
		body: (a) => ({
			slug: a.slug,
			displayName: a.displayName,
			bio: a.bio,
			avatarMediaId: a.avatarMediaId,
			websiteUrl: a.websiteUrl,
			userId: a.userId,
			isGuest: a.isGuest,
			locale: a.locale,
			translationOf: a.translationOf,
			customFields: a.customFields,
		}),
	},
	byline_update: {
		method: "PUT",
		path: (a) => `/admin/bylines/${a.id}`,
		body: (a) => ({
			slug: a.slug,
			displayName: a.displayName,
			bio: a.bio,
			avatarMediaId: a.avatarMediaId,
			websiteUrl: a.websiteUrl,
			userId: a.userId,
			isGuest: a.isGuest,
			customFields: a.customFields,
		}),
	},
	byline_delete: {
		method: "DELETE",
		path: (a) => `/admin/bylines/${encodeURIComponent(String(a.id))}`,
	},
	byline_translations: {
		method: "GET",
		path: (a) => `/admin/bylines/${a.id}/translations`,
	},
	byline_create_translation: {
		method: "POST",
		path: (a) => `/admin/bylines/${a.id}/translations`,
		body: (a) => ({
			locale: a.locale,
			slug: a.slug,
			displayName: a.displayName,
			bio: a.bio,
			avatarMediaId: a.avatarMediaId,
			websiteUrl: a.websiteUrl,
		}),
	},
	// Native Emdash 0.17 byline custom-field schema (7)
	list_byline_fields: {
		method: "GET",
		path: () => "/admin/byline-fields",
	},
	get_byline_field: {
		method: "GET",
		path: (a) => `/admin/byline-fields/${encodeURIComponent(String(a.slug))}`,
	},
	create_byline_field: {
		method: "POST",
		path: () => "/admin/byline-fields",
		body: bylineFieldBody,
	},
	update_byline_field: {
		method: "PATCH",
		path: (a) => `/admin/byline-fields/${encodeURIComponent(String(a.slug))}`,
		body: bylineFieldUpdateBody,
	},
	delete_byline_field: {
		method: "DELETE",
		path: (a) => `/admin/byline-fields/${encodeURIComponent(String(a.slug))}`,
	},
	get_byline_field_usage: {
		method: "GET",
		path: (a) =>
			`/admin/byline-fields/${encodeURIComponent(String(a.slug))}/usage`,
	},
	reorder_byline_fields: {
		method: "POST",
		path: () => "/admin/byline-fields/reorder",
		body: (a) => ({ slugs: a.slugs }),
	},
	// Menu (6)
	menu_list: { method: "GET", path: () => "/menus", query: localeQuery },
	menu_get: {
		method: "GET",
		path: (a) => `/menus/${a.name}`,
		query: localeQuery,
	},
	menu_translations: {
		method: "GET",
		path: (a) => `/menus/${encodeURIComponent(String(a.name))}/translations`,
		query: localeQuery,
	},
	menu_create: {
		method: "POST",
		path: () => "/menus",
		body: (a) => ({
			name: a.name,
			label: a.label,
			locale: a.locale,
			translationOf: a.translationOf,
		}),
	},
	menu_update: {
		method: "PUT",
		path: (a) => `/menus/${a.name}`,
		query: localeQuery,
		body: (a) => ({ label: a.label }),
	},
	menu_delete: {
		method: "DELETE",
		path: (a) => `/menus/${a.name}`,
		query: localeQuery,
	},
	// menu_set_items forwards to the native atomic MCP tool (decomposed REST
	// fallback without a PAT) — see menuSetItems(). No REST bulk-replace route
	// exists upstream.
	// Revision (2)
	revision_list: {
		method: "GET",
		path: (a) => `/content/${a.collection}/${a.id}/revisions`,
		query: (a) => {
			const q: Record<string, string> = {};
			if (a.limit) q.limit = String(a.limit);
			return q;
		},
	},
	revision_restore: {
		method: "POST",
		path: (a) => `/revisions/${a.revisionId}/restore`,
		body: (a) => ({ overrideLock: a.overrideLock === true ? true : undefined }),
	},
	// Settings (2)
	complete_existing_setup: {
		method: "POST",
		path: () => "/tedix/complete-existing-setup",
		body: () => ({}),
	},
	settings_get: { method: "GET", path: () => "/settings" },
	settings_update: { method: "POST", path: () => "/settings", body: (a) => a },
	// Manifest / plugins
	manifest_get: { method: "GET", path: () => "/manifest" },
	plugin_list: { method: "GET", path: () => "/admin/plugins" },
	plugin_get: {
		method: "GET",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}`,
	},
	plugin_enable: {
		method: "POST",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}/enable`,
	},
	plugin_disable: {
		method: "POST",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}/disable`,
	},
	list_forms: {
		method: "POST",
		path: () => "/plugins/emdash-forms/forms/list",
		body: (a) => a,
	},
	create_form: {
		method: "POST",
		path: () => "/plugins/emdash-forms/forms/create",
		body: (a) => a,
	},
	update_form: {
		method: "POST",
		path: () => "/plugins/emdash-forms/forms/update",
		body: (a) => a,
	},
	list_form_submissions: {
		method: "POST",
		path: () => "/plugins/emdash-forms/submissions/list",
		body: (a) => a,
	},
	get_form_submission: {
		method: "POST",
		path: () => "/plugins/emdash-forms/submissions/get",
		body: (a) => a,
	},
	set_plugin_mcp: {
		method: "PUT",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}/mcp`,
		body: (a) => ({ enabled: a.enabled }),
	},
	plugin_settings_get: {
		method: "GET",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}/settings`,
	},
	plugin_settings_update: {
		method: "PUT",
		path: (a) => `/admin/plugins/${encodeURIComponent(String(a.id))}/settings`,
		body: (a) => ({ values: a.values }),
	},
	plugin_updates: { method: "GET", path: () => "/admin/plugins/updates" },
	plugin_verify: {
		method: "POST",
		path: () => "/admin/plugins/registry/verify",
		body: (a) => ({ did: a.did, slug: a.slug, version: a.version }),
	},
	plugin_install: {
		method: "POST",
		path: () => "/admin/plugins/registry/install",
		body: (a) => ({
			did: a.did,
			slug: a.slug,
			version: a.version,
			acknowledgedDeclaredAccess: a.acknowledgedDeclaredAccess,
			acknowledgedMcpTools: a.acknowledgedMcpTools,
			acknowledgedPublicRoutes: a.acknowledgedPublicRoutes,
			acknowledgedProfileCid: a.acknowledgedProfileCid,
			acknowledgedReleaseCid: a.acknowledgedReleaseCid,
		}),
	},
	plugin_update: {
		method: "POST",
		path: (a) => {
			const encoded = encodeURIComponent(String(a.id));
			return a.source === "marketplace"
				? `/admin/plugins/${encoded}/update`
				: `/admin/plugins/registry/${encoded}/update`;
		},
		body: (a) => ({
			version: a.version,
			confirmCapabilityChanges: a.confirmCapabilityChanges,
			confirmRouteVisibilityChanges: a.confirmRouteVisibilityChanges,
		}),
	},
	plugin_uninstall: {
		method: "POST",
		path: (a) => {
			const encoded = encodeURIComponent(String(a.id));
			return a.source === "marketplace"
				? `/admin/plugins/${encoded}/uninstall`
				: `/admin/plugins/registry/${encoded}/uninstall`;
		},
		body: (a) => ({
			deleteData: a.deleteData,
		}),
	},
};

export function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function findContentId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["id", "contentId"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const key of ["data", "item", "content"]) {
		const nested = findContentId(record[key]);
		if (nested) return nested;
	}
	return undefined;
}

function findContentItem(value: unknown): Record<string, unknown> | null {
	const record = asRecord(value);
	if (!record) return null;
	const data = asRecord(record.data);
	const candidates = [data?.item, record.item, data, record];
	for (const candidate of candidates) {
		const item = asRecord(candidate);
		if (item && findContentId(item)) return item;
	}
	return null;
}

function findRevision(value: unknown): string | undefined {
	const record = asRecord(value);
	const data = asRecord(record?.data);
	const item = asRecord(data?.item) ?? asRecord(record?.item);
	return firstString(record?._rev, data?._rev, item?._rev) ?? undefined;
}

function shouldRetryAuthCandidate(
	resp: Response,
	hasNextCandidate: boolean,
): boolean {
	if (!hasNextCandidate) return false;
	// A 403 is an authorization decision by Emdash. Never change identity to
	// evade it; only recover from an invalid/unrecognized credential (401).
	return resp.status === 401;
}

async function fetchCmsRestWithTimeout(
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await doFetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function cmsRestFetchErrorMessage(err: unknown, timeoutMs: number): string {
	const message = err instanceof Error ? err.message : String(err);
	const abortName =
		err && typeof err === "object" && "name" in err
			? String((err as { name?: unknown }).name)
			: "";
	if (abortName === "AbortError" || message.toLowerCase().includes("abort")) {
		return `CMS REST request timed out after ${timeoutMs}ms`;
	}
	return message;
}

export async function executeCmsRestRequest(
	authCandidates: AuthHeaderCandidate[],
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	method: RestRoute["method"],
	url: string,
	body: Record<string, unknown> | FormData | undefined,
	timeoutMs = CMS_REST_REQUEST_TIMEOUT_MS,
): Promise<RestCallResult> {
	let lastFailure: {
		status: number;
		text: string;
		authSource: AuthHeaderCandidate["source"];
	} | null = null;

	// Tenant workers cold-start in ~13-15s, racing the per-attempt timeout —
	// the aborted first attempt still warms the isolate, so one retry for
	// idempotent reads turns a spurious first-call failure into a ~2-3s
	// success. Writes never retry (the aborted request may have applied).
	const maxPasses = method === "GET" ? 2 : 1;
	for (let pass = 0; pass < maxPasses; pass++) {
		if (pass > 0 && !isCmsRestTimeoutFailure(lastFailure)) break;
		const result = await executeCmsRestPass(
			authCandidates,
			doFetch,
			method,
			url,
			body,
			timeoutMs,
		);
		if (result.outcome) return result.outcome;
		lastFailure = result.lastFailure;
	}
	return {
		ok: false,
		status: lastFailure?.status ?? 0,
		text: lastFailure?.text ?? "No auth candidate attempted",
		authSource: lastFailure?.authSource ?? "jwt",
	};
}

function isCmsRestTimeoutFailure(
	failure: { status: number; text: string } | null,
): boolean {
	return failure?.status === 0 && /timed out after/.test(failure.text);
}

async function executeCmsRestPass(
	authCandidates: AuthHeaderCandidate[],
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	method: RestRoute["method"],
	url: string,
	body: Record<string, unknown> | FormData | undefined,
	timeoutMs: number,
): Promise<{
	outcome?: RestCallResult;
	lastFailure: {
		status: number;
		text: string;
		authSource: AuthHeaderCandidate["source"];
	} | null;
}> {
	let lastFailure: {
		status: number;
		text: string;
		authSource: AuthHeaderCandidate["source"];
	} | null = null;

	for (let i = 0; i < authCandidates.length; i++) {
		const candidate = authCandidates[i]!;
		const headers: Record<string, string> = { ...candidate.headers };
		const isMultipart = body instanceof FormData;
		if (body && method !== "GET" && !isMultipart) {
			headers["Content-Type"] = "application/json";
		}

		let resp: Response;
		try {
			resp = await fetchCmsRestWithTimeout(
				doFetch,
				url,
				{
					method,
					headers,
					body:
						body && method !== "GET"
							? isMultipart
								? body
								: JSON.stringify(body)
							: undefined,
				},
				timeoutMs,
			);
		} catch (err) {
			lastFailure = {
				status: 0,
				text: cmsRestFetchErrorMessage(err, timeoutMs),
				authSource: candidate.source,
			};
			if (i < authCandidates.length - 1) continue;
			break;
		}

		const text = await resp.text();
		if (!resp.ok) {
			lastFailure = {
				status: resp.status,
				text,
				authSource: candidate.source,
			};
			if (shouldRetryAuthCandidate(resp, i < authCandidates.length - 1)) {
				continue;
			}
			break;
		}

		return {
			outcome: {
				ok: true,
				status: resp.status,
				text,
				json: safeJsonParse(text),
				authSource: candidate.source,
			},
			lastFailure,
		};
	}

	// A non-retryable NON-timeout failure (e.g. a 4xx) is terminal — surface
	// it as the outcome so the caller never re-runs the pass for it.
	if (lastFailure && !isCmsRestTimeoutFailure(lastFailure)) {
		return { outcome: { ok: false, ...lastFailure }, lastFailure };
	}
	return {
		lastFailure: lastFailure ?? {
			status: 0,
			text: "No auth candidate attempted",
			authSource: "jwt" as const,
		},
	};
}

/**
 * Shape a successful Emdash REST JSON body (`{ success: true, data }`) into
 * the proxy's tool envelope. Shared by the REST transport and the native
 * tenant MCP transport so both emit byte-identical envelopes.
 */
function cmsRestSuccessToolResult(json: unknown): ToolResult {
	const rawStructuredContent =
		json && typeof json === "object" && !Array.isArray(json)
			? (json as Record<string, unknown>)
			: undefined;
	const structuredContent =
		rawStructuredContent && Array.isArray(rawStructuredContent.data)
			? { ...rawStructuredContent, data: { items: rawStructuredContent.data } }
			: rawStructuredContent;

	return {
		content: [
			{
				type: "text",
				text:
					typeof json === "string"
						? json.slice(0, 2000)
						: JSON.stringify(structuredContent ?? json, null, 2),
			},
		],
		...(structuredContent ? { structuredContent } : {}),
	};
}

function cmsContentCreateSuccessToolResult(
	json: unknown,
	args: Record<string, unknown>,
): ToolResult {
	const id = findContentId(json);
	if (!id) {
		return {
			content: [
				{
					type: "text",
					text: "[CMS_ERROR] Content create succeeded but returned no canonical content id; reconcile the requested slug before retrying",
				},
			],
			isError: true,
		};
	}

	const returnedItem = findContentItem(json) ?? {};
	const requestedData = asRecord(args.data);
	const item = {
		...returnedItem,
		id,
		...(returnedItem.slug !== undefined || typeof args.slug !== "string"
			? {}
			: { slug: args.slug }),
		...(returnedItem.status !== undefined || typeof args.status !== "string"
			? {}
			: { status: args.status }),
		...(returnedItem.locale !== undefined || typeof args.locale !== "string"
			? {}
			: { locale: args.locale }),
		...(returnedItem.data !== undefined || !requestedData
			? {}
			: { data: requestedData }),
	};
	const revision = findRevision(json);
	return cmsRestSuccessToolResult({
		success: asRecord(json)?.success ?? true,
		id,
		data: item,
		item,
		...(revision ? { _rev: revision } : {}),
	});
}

function restResultToToolResult(
	method: RestRoute["method"],
	path: string,
	result: RestCallResult,
): ToolResult {
	if (result.ok) {
		return cmsRestSuccessToolResult(result.json);
	}

	let error: Record<string, unknown> | null = null;
	try {
		error = asRecord(asRecord(JSON.parse(result.text))?.error);
	} catch {}
	const code = typeof error?.code === "string" ? error.code : "CMS_ERROR";
	return {
		content: [
			{
				type: "text",
				text: `[${code}] ${method} ${path} failed (${result.status}, auth=${result.authSource}): ${result.text.slice(0, 500)}`,
			},
		],
		isError: true,
		_meta: {
			code,
			...(error?.details !== undefined ? { details: error.details } : {}),
		},
	};
}

export function apiData(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const data = record.data;
	return data && typeof data === "object" && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: record;
}

const hasOwn = (value: Record<string, unknown>, key: string) =>
	Object.hasOwn(value, key);

function restFailureText(result: RestCallResult): string {
	return result.ok ? "" : result.text;
}

function shouldFallbackContentAuthors(result: RestCallResult): boolean {
	if (result.ok) return false;
	if (result.status === 404) return true;
	const text = restFailureText(result);
	return (
		result.status >= 500 &&
		(text.includes('"code":"NOT_CONFIGURED"') ||
			text.includes("EmDash is not initialized"))
	);
}

function contentItemsFromListResult(
	value: unknown,
): Array<Record<string, unknown>> {
	const record = asRecord(value);
	const data = asRecord(record?.data);
	const candidates = [data?.items, record?.items];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate.filter(
				(item): item is Record<string, unknown> =>
					item !== null && typeof item === "object" && !Array.isArray(item),
			);
		}
	}
	return [];
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function bylineRecordsFromItem(
	item: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	const direct = item.byline;
	if (direct && typeof direct === "object" && !Array.isArray(direct)) {
		records.push(direct as Record<string, unknown>);
	}

	const bylines = item.bylines;
	if (Array.isArray(bylines)) {
		for (const credit of bylines) {
			if (!credit || typeof credit !== "object" || Array.isArray(credit))
				continue;
			const creditRecord = credit as Record<string, unknown>;
			const nested = creditRecord.byline;
			if (nested && typeof nested === "object" && !Array.isArray(nested)) {
				records.push(nested as Record<string, unknown>);
			}
		}
	}
	return records;
}

function bylineRecordFromItem(
	item: Record<string, unknown>,
): Record<string, unknown> | null {
	return bylineRecordsFromItem(item)[0] ?? null;
}

function bylineAvatarUrl(
	byline: Record<string, unknown> | null,
): string | null {
	if (!byline) return null;
	const direct = firstString(byline.avatarUrl, byline.image);
	if (direct) return direct;
	const storageKey = firstString(byline.avatarStorageKey);
	if (storageKey) return `/_emdash/api/media/file/${storageKey}`;
	const mediaId = firstString(byline.avatarMediaId);
	if (mediaId) return `/_emdash/api/media/file/${mediaId}`;
	return null;
}

function applyAuthorFallbackMetadata(
	target: Record<string, unknown>,
	byline: Record<string, unknown> | null,
): void {
	if (!byline) return;
	const name = firstString(
		byline.displayName,
		byline.name,
		byline.title,
		byline.slug,
	);
	if (name && !target.name) target.name = name;

	const email = firstString(byline.email);
	if (email && !target.email) target.email = email;

	const avatarUrl = bylineAvatarUrl(byline);
	if (avatarUrl && !target.avatarUrl) target.avatarUrl = avatarUrl;
}

function authorFallbackItems(
	items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const authors = new Map<string, Record<string, unknown>>();
	for (const item of items) {
		const byline = bylineRecordFromItem(item);
		const authorId = typeof item.authorId === "string" ? item.authorId : "";
		if (authorId) {
			const existing = authors.get(authorId);
			if (existing) {
				applyAuthorFallbackMetadata(existing, byline);
				continue;
			}
			const next = {
				id: authorId,
				name: null,
				email: null,
				avatarUrl: null,
				filterableByAuthorId: true,
				filterableBylineId: false,
				source: "content_list_authorId_fallback",
			};
			applyAuthorFallbackMetadata(next, byline);
			authors.set(authorId, next);
			continue;
		}

		const bylineId = firstString(byline?.id, byline?.translationGroup);
		if (!bylineId || authors.has(bylineId)) continue;
		const next = {
			id: bylineId,
			name: null,
			email: null,
			avatarUrl: null,
			filterableByAuthorId: false,
			filterableBylineId: true,
			bylineId,
			source: "content_list_byline_fallback",
		};
		applyAuthorFallbackMetadata(next, byline);
		authors.set(bylineId, next);
	}
	return [...authors.values()];
}

function requestedBylineIds(args: Record<string, unknown>): string[] {
	const values = [
		typeof args.bylineId === "string" ? args.bylineId : null,
		...(Array.isArray(args.bylineIds) ? args.bylineIds : []),
	];
	return Array.from(
		new Set(
			values
				.map((value) => (typeof value === "string" ? value.trim() : ""))
				.filter((value) => value.length > 0),
		),
	);
}

async function callCmsListContentBylineEntries(
	authCandidates: AuthHeaderCandidate[],
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	baseUrl: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const collection = String(args.collection ?? "");
	if (!collection) {
		return {
			content: [{ type: "text", text: "[CMS_ERROR] collection is required" }],
			isError: true,
		};
	}

	const bylineIds = requestedBylineIds(args);
	if (bylineIds.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: "[CMS_ERROR] bylineId or bylineIds[] is required",
				},
			],
			isError: true,
		};
	}

	const filter = contentListQuery.safeParse({ bylines: bylineIds.join(",") });
	if (!filter.success || filter.data.bylinesNone)
		return {
			content: [
				{
					type: "text",
					text: "[CMS_ERROR] Invalid native byline filter; select at most 25 byline IDs",
				},
			],
			isError: true,
		};

	// Native filtering compares translation groups stored in the credit junction.
	// Resolve translated row IDs with the native byline read; a missing row may
	// already be a group, so pass it through. All other failures remain errors.
	const groups: string[] = [];
	for (const id of bylineIds) {
		const path = `/admin/bylines/${encodeURIComponent(id)}`;
		const result = await executeCmsRestRequest(
			authCandidates,
			doFetch,
			"GET",
			`${baseUrl}${path}`,
			undefined,
		);
		if (!result.ok && result.status !== 404)
			return restResultToToolResult("GET", path, result);
		const row = result.ok ? asRecord(asRecord(result.json)?.data) : null;
		groups.push(firstString(row?.translationGroup) ?? id);
	}
	const path = `/content/${collection}`;
	const url = new URL(`${baseUrl}${path}`);
	const query = contentListQueryParams(args);
	query.bylines = [...new Set(groups)].join(",");
	if (args.includeInferredBylines === true) query.includeInferredBylines = "1";
	for (const [key, value] of Object.entries(query))
		url.searchParams.set(key, value);
	const result = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"GET",
		url.toString(),
		undefined,
	);
	return restResultToToolResult("GET", path, result);
}

async function callCmsListContentAuthors(
	authCandidates: AuthHeaderCandidate[],
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	baseUrl: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const collection = String(args.collection ?? "");
	if (!collection) {
		return {
			content: [{ type: "text", text: "[CMS_ERROR] collection is required" }],
			isError: true,
		};
	}

	const nativePath = `/content/${collection}/authors`;
	const native = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"GET",
		`${baseUrl}${nativePath}`,
		undefined,
	);
	if (native.ok || !shouldFallbackContentAuthors(native)) {
		return restResultToToolResult("GET", nativePath, native);
	}

	const fallbackPath = `/content/${collection}`;
	const fallbackUrl = new URL(`${baseUrl}${fallbackPath}`);
	fallbackUrl.searchParams.set("limit", "100");
	fallbackUrl.searchParams.set("orderBy", "updatedAt");
	fallbackUrl.searchParams.set("order", "desc");
	const fallback = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"GET",
		fallbackUrl.toString(),
		undefined,
	);
	if (!fallback.ok)
		return restResultToToolResult("GET", fallbackPath, fallback);

	const items = authorFallbackItems(contentItemsFromListResult(fallback.json));
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(
					{
						data: {
							items,
							_tedix: {
								source: "content_list_authorId_fallback",
								nativeStatus: native.status,
							},
						},
					},
					null,
					2,
				),
			},
		],
		structuredContent: {
			data: {
				items,
				_tedix: {
					source: "content_list_authorId_fallback",
					nativeStatus: native.status,
				},
			},
		},
	} as ToolResult;
}

async function callCmsBylineUpdateWithMerge(
	authCandidates: AuthHeaderCandidate[],
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
	baseUrl: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const id = typeof args.id === "string" ? args.id : "";
	if (!id) {
		return {
			content: [{ type: "text", text: "[CMS_ERROR] id is required" }],
			isError: true,
		};
	}

	const path = `/admin/bylines/${id}`;
	const current = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"GET",
		`${baseUrl}${path}`,
		undefined,
	);
	if (!current.ok) return restResultToToolResult("GET", path, current);

	const existing = apiData(current.json);
	if (!existing) {
		return {
			content: [
				{ type: "text", text: "[CMS_ERROR] Could not read existing byline" },
			],
			isError: true,
		};
	}

	const body = {
		slug: hasOwn(args, "slug") ? args.slug : existing.slug,
		displayName: hasOwn(args, "displayName")
			? args.displayName
			: existing.displayName,
		bio: hasOwn(args, "bio") ? args.bio : existing.bio,
		avatarMediaId: hasOwn(args, "avatarMediaId")
			? args.avatarMediaId
			: existing.avatarMediaId,
		websiteUrl: hasOwn(args, "websiteUrl")
			? args.websiteUrl
			: existing.websiteUrl,
		userId: hasOwn(args, "userId") ? args.userId : existing.userId,
		isGuest: hasOwn(args, "isGuest") ? args.isGuest : existing.isGuest,
		...(hasOwn(args, "customFields")
			? { customFields: args.customFields }
			: {}),
	};

	const updated = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"PUT",
		`${baseUrl}${path}`,
		body,
	);
	return restResultToToolResult("PUT", path, updated);
}

// ---------------------------------------------------------------------------
// Generic native tenant MCP dispatch for REST_ROUTES rows
//
// Emdash registers a native MCP tool for most of the Site Builder proxy's
// REST routes. Rows listed here are VERIFIED transport-equivalent against
// emdash core (packages/core/src/mcp/server.ts vs the REST routes): the
// native tool calls the same underlying handler with mechanically
// translatable args, and its bare handler payload re-wraps into the exact
// Emdash REST `{ success: true, data }` envelope with zero semantic loss.
//
// Content writes were re-verified against the PATCHED Emdash 1.1.0 build
// (root patches/emdash@1.1.0.patch): each native tool resolves the entry with
// the same handleContentGet call, applies the same ownership permission,
// claims the entry lock the same way (emdash #3059), invalidates the same
// route-cache tags through `unwrapAndInvalidate` (emdash #3127), and returns
// the same handler payload. Native additionally checks the token scope and a
// minimum role, so moving a row never widens access. Covered by the real
// Emdash harness in tenant-mcp-emdash.test.ts.
//
// Rows deliberately not listed (REST-only) in the installed runtime:
// - content_create: ordered `references` and the canonical-id response
//   projection use the native REST create contract.
// - content_get_terms / content_set_terms, media_providers_*, media_search,
//   byline_create_translation, byline-field tools, manifest_get, plugin_*:
//   no native counterpart.
// - media_list / media_create: the REST route augments items with a resolved
//   `url` (and dedupe handling on create) that the native tool omits.
// - schema_get_collection / schema_create_collection / schema_delete_* /
//   schema_create_field / schema_update_field: response-shape or argument gaps
//   (bare object vs `{ item }`, no urlPattern/hasSeo/widget support upstream).
// - taxonomy_list_terms: native keyset pagination differs from the REST
//   locale-aware tree and count response.
// - taxonomy_term_translations / menu_translations: native takes a row id or
//   translation group; the Site Builder contract addresses taxonomy+termSlug
//   and menu name.
// - byline_*: every REST byline route sits under /_emdash/api/admin, so a
//   token needs the `admin` scope; the native byline tools only check
//   `content:read` / `content:write`, which would let a content-scoped PAT
//   read and write bylines. byline_update additionally keeps its Site Builder
//   read-merge-update wrapper.
//
// Every other forwarded row's native scope matches the REST middleware's
// SCOPE_RULES for its route (content, media, schema, search, taxonomies,
// menus, revisions, settings). Re-check that pairing before adding a row.
// - media_usage_repair: platform-admin maintenance; the REST adapter
//   normalizes `collection` away for scope=all, which the strict native
//   schema would reject instead.
// ---------------------------------------------------------------------------

interface NativeToolForward {
	/** Native Emdash MCP tool name (emdash core mcp/server.ts). */
	tool: string;
	/** Site Builder args copied through to the native tool (undefined values dropped). */
	args: readonly string[];
	/**
	 * Args the native tool cannot express. When any is present the call stays
	 * on the REST path so no filter or behavior is silently dropped.
	 */
	restOnlyArgs?: readonly string[];
	/**
	 * Args the native tool requires but the Site Builder contract leaves
	 * optional. When any is absent the call stays on the REST path, which keeps
	 * the optional semantics.
	 */
	requiredArgs?: readonly string[];
}

const NATIVE_TOOL_FORWARDS: Record<string, NativeToolForward> = {
	// Content reads
	content_list: {
		tool: "content_list",
		args: [
			"collection",
			"status",
			"limit",
			"cursor",
			"orderBy",
			"order",
			"locale",
		],
		// Native content_list does not accept these filters; REST contentListQuery does.
		restOnlyArgs: ["q", "authorId", "dateField", "dateFrom", "dateTo"],
	},
	content_get: { tool: "content_get", args: ["collection", "id", "locale"] },
	content_list_trashed: {
		tool: "content_list_trashed",
		args: ["collection", "limit", "cursor"],
	},
	// Neither transport honors locale today (the REST /compare route ignores
	// ?locale), but the Site Builder contract advertises it for slug lookups — keep
	// locale-scoped calls on REST so they pick up upstream support first.
	content_compare: {
		tool: "content_compare",
		args: ["collection", "id"],
		restOnlyArgs: ["locale"],
	},
	content_translations: {
		tool: "content_translations",
		args: ["collection", "id"],
	},
	// Content writes. Native tools take no `locale`; locale-scoped slug lookups
	// stay on REST, which resolves the slug in that locale.
	content_update: {
		tool: "content_update",
		args: [
			"collection",
			"id",
			"data",
			"slug",
			"seo",
			"bylines",
			"publishedAt",
			"migrateBlocks",
			"replaceBlocks",
			"_rev",
			"overrideLock",
		],
		// Native `status` routes through publish/unpublish with publish
		// permission instead of the REST in-place status write; `references`
		// has no native arg.
		restOnlyArgs: ["status", "references"],
		requiredArgs: ["_rev"],
	},
	content_publish: {
		tool: "content_publish",
		args: ["collection", "id", "publishedAt", "_rev", "overrideLock"],
		restOnlyArgs: ["locale"],
		requiredArgs: ["_rev"],
	},
	content_unpublish: {
		tool: "content_unpublish",
		args: ["collection", "id", "_rev", "overrideLock"],
		restOnlyArgs: ["locale"],
		requiredArgs: ["_rev"],
	},
	content_schedule: {
		tool: "content_schedule",
		args: ["collection", "id", "_rev", "overrideLock", "scheduledAt"],
		restOnlyArgs: ["locale"],
		requiredArgs: ["_rev"],
	},
	content_discard_draft: {
		tool: "content_discard_draft",
		args: ["collection", "id", "_rev", "overrideLock"],
		restOnlyArgs: ["locale"],
		requiredArgs: ["_rev"],
	},
	content_delete: {
		tool: "content_delete",
		args: ["collection", "id", "overrideLock"],
		restOnlyArgs: ["locale"],
	},
	content_restore: { tool: "content_restore", args: ["collection", "id"] },
	// Neither transport claims the entry lock for a permanent delete (the REST
	// route ignores ?overrideLock), so dropping overrideLock loses nothing.
	content_permanent_delete: {
		tool: "content_permanent_delete",
		args: ["collection", "id"],
	},
	content_unschedule: {
		tool: "content_unschedule",
		args: ["collection", "id"],
		restOnlyArgs: ["locale"],
	},
	content_duplicate: { tool: "content_duplicate", args: ["collection", "id"] },
	// Schema
	schema_list_collections: { tool: "schema_list_collections", args: [] },
	// Same handleSchemaCollectionUpdate handler (emdash #2354/#3440); the native
	// schema has no `admin` or `hidden`, and the REST path merges partial admin
	// settings before writing.
	schema_update_collection: {
		tool: "schema_update_collection",
		args: [
			"slug",
			"label",
			"labelSingular",
			"description",
			"icon",
			"editLocking",
			"supports",
			"urlPattern",
			"hasSeo",
			"routable",
			"group",
			"titleField",
			"dateField",
			"commentsEnabled",
			"commentsModeration",
			"commentsClosedAfterDays",
			"commentsAutoApproveUsers",
		],
		restOnlyArgs: ["admin", "hidden", "sortOrder"],
	},
	// Block types: same handleBlockType* handlers and expectedFingerprint
	// concurrency checks on both transports.
	schema_list_block_types: { tool: "schema_list_block_types", args: [] },
	schema_get_block_type: { tool: "schema_get_block_type", args: ["slug"] },
	schema_create_block_type: {
		tool: "schema_create_block_type",
		args: ["slug", "label", "description", "icon", "category", "fields"],
	},
	schema_update_block_type: {
		tool: "schema_update_block_type",
		args: [
			"slug",
			"expectedFingerprint",
			"label",
			"description",
			"icon",
			"category",
			"fields",
			"breaking",
		],
	},
	schema_activate_block_type_version: {
		tool: "schema_activate_block_type_version",
		args: ["slug", "version", "expectedFingerprint"],
	},
	// Media metadata (list/create stay REST-only — see block comment)
	media_get: {
		tool: "media_get",
		args: ["id"],
		restOnlyArgs: ["includeUsage"],
	},
	media_update: {
		tool: "media_update",
		args: ["id", "alt", "caption", "width", "height"],
		restOnlyArgs: ["folderId"],
	},
	media_delete: { tool: "media_delete", args: ["id"] },
	// Search (searchWithDb defaults status to "published" on both transports)
	search: { tool: "search", args: ["query", "collections", "locale", "limit"] },
	// Taxonomy (definition/term translation reads and term lists stay REST-only)
	taxonomy_list: { tool: "taxonomy_list", args: ["locale"] },
	taxonomy_get: { tool: "taxonomy_get", args: ["name", "locale"] },
	taxonomy_create: {
		tool: "taxonomy_create",
		args: [
			"name",
			"label",
			"labelSingular",
			"hierarchical",
			"collections",
			"locale",
			"translationOf",
		],
	},
	taxonomy_update: {
		tool: "taxonomy_update",
		args: [
			"name",
			"label",
			"labelSingular",
			"hierarchical",
			"collections",
			"locale",
		],
	},
	taxonomy_delete: { tool: "taxonomy_delete", args: ["name"] },
	taxonomy_create_term: {
		tool: "taxonomy_create_term",
		args: [
			"taxonomy",
			"slug",
			"label",
			"parentId",
			"description",
			"locale",
			"translationOf",
		],
	},
	taxonomy_update_term: {
		tool: "taxonomy_update_term",
		args: [
			"taxonomy",
			"termSlug",
			"slug",
			"label",
			"parentId",
			"description",
			"locale",
		],
	},
	taxonomy_delete_term: {
		tool: "taxonomy_delete_term",
		args: ["taxonomy", "termSlug", "locale"],
	},
	// Menus (menu_set_items has its own dedicated forward — menuSetItems())
	menu_list: { tool: "menu_list", args: ["locale"] },
	menu_get: { tool: "menu_get", args: ["name", "locale"] },
	menu_create: {
		tool: "menu_create",
		args: ["name", "label", "locale", "translationOf"],
	},
	menu_update: { tool: "menu_update", args: ["name", "label", "locale"] },
	menu_delete: { tool: "menu_delete", args: ["name", "locale"] },
	// Revisions
	revision_list: { tool: "revision_list", args: ["collection", "id", "limit"] },
	revision_restore: {
		tool: "revision_restore",
		args: ["revisionId", "overrideLock"],
	},
	// Settings
	settings_get: { tool: "settings_get", args: [] },
	settings_update: {
		tool: "settings_update",
		args: [
			"title",
			"tagline",
			"logo",
			"favicon",
			"url",
			"postsPerPage",
			"dateFormat",
			"timezone",
			"social",
			"seo",
		],
	},
};

/**
 * Whether a callCmsRest invocation should ride the native tenant MCP
 * transport instead of the Emdash REST API.
 *
 * The native endpoint is bearer-only (Emdash PAT), so a forwarded human JWT
 * keeps the call on the REST cookie path — that is the only transport that
 * preserves per-user Descope attribution. Forwarding a human session through
 * the org's service PAT would silently re-attribute the operation to the
 * service identity.
 */
export function shouldForwardCmsRestToTenantMcp(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): boolean {
	const forward = NATIVE_TOOL_FORWARDS[toolName];
	if (!forward) return false;
	if (!hasTenantMcpCredential(ctx)) return false;
	if (ctx.humanAuthRequired || (ctx.forwardedAuth && isJwt(ctx.forwardedAuth)))
		return false;
	if (forward.restOnlyArgs?.some((key) => args[key] !== undefined)) {
		return false;
	}
	if (forward.requiredArgs?.some((key) => args[key] === undefined)) {
		return false;
	}
	return true;
}

/**
 * Execute one mapped REST_ROUTES row through the tenant's native MCP tool and
 * project the result into the exact envelope the REST path emits.
 */
async function callCmsRestViaTenantMcp(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const forward = NATIVE_TOOL_FORWARDS[toolName]!;
	const nativeArgs: Record<string, unknown> = {};
	for (const key of forward.args) {
		if (args[key] !== undefined) nativeArgs[key] = args[key];
	}

	const result = await callTenantMcpTool(ctx, forward.tool, nativeArgs);
	if (result.isError) return result;

	const parsed = unwrapCmsToolResult(result, `CMS native ${forward.tool}`);
	if (typeof parsed === "string") {
		return tenantMcpError(
			"CMS_MCP_INVALID_RESPONSE",
			`Native ${forward.tool} returned a non-JSON result`,
		);
	}
	// Native tools return the handler data bare; the Emdash REST routes wrap
	// the same payload as { success: true, data }. Re-wrap so callers see one
	// envelope regardless of transport.
	return cmsRestSuccessToolResult({ success: true, data: parsed });
}

/** Native transfer REST preserves a human caller's role, scopes and attribution. */
export async function callCmsTransferRest(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const auth = buildCmsAuthHeaderCandidates(ctx);
	if (auth.length === 0) return cmsAuthUnavailableToolResult(ctx);
	const id = encodeURIComponent(String(args.operationId ?? ""));
	let method: "GET" | "POST" = "GET";
	let path: string;
	let body: Record<string, unknown> | undefined;
	switch (toolName) {
		case "site_transfer_capabilities":
			path = "/capabilities";
			break;
		case "site_export_start":
			method = "POST";
			path = "/exports";
			body = args.comments === undefined ? {} : { comments: args.comments };
			break;
		case "site_export_status":
			method = args.advance === false ? "GET" : "POST";
			path = `/exports/${id}${args.advance === false ? "" : "/advance"}`;
			break;
		case "site_import_analyze":
			method = "POST";
			path = `/imports/${id}/analyze`;
			body = args.decisions === undefined ? {} : { decisions: args.decisions };
			break;
		case "site_import_start":
			method = "POST";
			path = `/imports/${id}/execute`;
			body = { packageDigest: args.packageDigest, planDigest: args.planDigest };
			break;
		case "site_import_status":
			path = `/imports/${id}`;
			break;
		case "site_import_resume":
			method = "POST";
			path = `/imports/${id}/advance`;
			break;
		case "site_import_receipt":
			path = `/imports/${id}/receipt`;
			break;
		default:
			return tenantMcpError("CMS_ERROR", `Unknown transfer tool: ${toolName}`);
	}
	const result = await executeCmsRestRequest(
		auth,
		cmsDoFetch(ctx),
		method,
		`${cmsApiBaseUrl(ctx)}/admin/transfer${path}`,
		body,
		CMS_TRANSFER_REQUEST_TIMEOUT_MS,
	);
	return restResultToToolResult(method, path, result);
}

export async function callCmsRest(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const authCandidates = buildCmsAuthHeaderCandidates(ctx);
	if (authCandidates.length === 0) return cmsAuthUnavailableToolResult(ctx);

	const route = REST_ROUTES[toolName];
	if (!route) {
		return {
			content: [
				{ type: "text", text: `[CMS_ERROR] Unknown tool: ${toolName}` },
			],
			isError: true,
		};
	}

	if (shouldForwardCmsRestToTenantMcp(ctx, toolName, args)) {
		const nativeResult = await callCmsRestViaTenantMcp(ctx, toolName, args);
		const discoveryUnauthorized =
			nativeResult.isError === true &&
			nativeResult.content[0]?.text.startsWith(
				"[CMS_MCP_DISCOVERY_FAILED] Tenant MCP discovery failed (401)",
			) === true;
		// Discovery happens before tools/call. For reads only, the trusted
		// service-binding REST path can recover when the tenant MCP bearer path
		// is unavailable. Never replay a mutation after an auth error.
		if (
			discoveryUnauthorized &&
			route.method === "GET" &&
			ctx.internalAuthToken
		) {
			return callCmsRest({ ...ctx, serviceApiKey: undefined }, toolName, args);
		}
		return nativeResult;
	}

	const baseUrl = cmsApiBaseUrl(ctx);

	const doFetch = ctx.cmsDispatch
		? (url: string, init: RequestInit) =>
				ctx.cmsDispatch!.fetch(new Request(url, init))
		: (url: string, init: RequestInit) => fetch(url, init);

	if (toolName === "list_calendar_entries") {
		const parsed = calendarQuery.safeParse(args);
		if (!parsed.success)
			return {
				content: [
					{ type: "text", text: `[CMS_ERROR] ${parsed.error.message}` },
				],
				isError: true,
			};
	}

	const path = route.path(args);
	const queryParams = route.query?.(args) ?? {};
	const qs = new URLSearchParams(queryParams).toString();
	const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;

	const body = route.body?.(args);

	try {
		if (toolName === "list_content_byline_entries") {
			return await callCmsListContentBylineEntries(
				authCandidates,
				doFetch,
				baseUrl,
				args,
			);
		}
		if (toolName === "list_content_authors") {
			return await callCmsListContentAuthors(
				authCandidates,
				doFetch,
				baseUrl,
				args,
			);
		}
		if (toolName === "byline_update") {
			return await callCmsBylineUpdateWithMerge(
				authCandidates,
				doFetch,
				baseUrl,
				args,
			);
		}
		if (toolName === "schema_update_collection" && asRecord(args.admin)) {
			const admin = asRecord(args.admin)!;
			if (!hasOwn(admin, "listColumns") || !hasOwn(admin, "quickCreate")) {
				const current = await executeCmsRestRequest(
					authCandidates,
					doFetch,
					"GET",
					url,
					undefined,
				);
				if (!current.ok) return restResultToToolResult("GET", path, current);
				const data = apiData(current.json);
				const existing = asRecord(
					data?.item ?? (data?.slug === args.slug ? data : null),
				);
				if (!existing)
					return tenantMcpError(
						"CMS_ERROR",
						"Could not read existing collection admin settings",
					);
				const existingAdmin = asRecord(existing.admin) ?? {};
				body!.admin = {
					...(hasOwn(existingAdmin, "listColumns")
						? { listColumns: existingAdmin.listColumns }
						: {}),
					...(hasOwn(existingAdmin, "quickCreate")
						? { quickCreate: existingAdmin.quickCreate }
						: {}),
					...admin,
				};
			}
		}

		const result = await executeCmsRestRequest(
			authCandidates,
			doFetch,
			route.method,
			url,
			body,
		);
		if (toolName === "content_create" && result.ok) {
			return cmsContentCreateSuccessToolResult(result.json, args);
		}
		return restResultToToolResult(route.method, path, result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `[CMS_ERROR] ${msg}` }],
			isError: true,
		};
	}
}

// ---------------------------------------------------------------------------
// menu_set_items uses the same atomic native handler on MCP and authenticated REST.
// Human callers keep their own actor; a tenant PAT must never replace that actor.
// ---------------------------------------------------------------------------

export async function menuSetItems(
	ctx: CmsProxyContext,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const name = args.name as string;
	const items = args.items as Array<Record<string, unknown>>;
	if (!name || !Array.isArray(items)) {
		return {
			content: [
				{ type: "text", text: "[CMS_ERROR] name and items[] are required" },
			],
			isError: true,
		};
	}

	const locale =
		typeof args.locale === "string" && args.locale.length > 0
			? args.locale
			: undefined;

	if (
		hasTenantMcpCredential(ctx) &&
		!ctx.humanAuthRequired &&
		!(ctx.forwardedAuth && isJwt(ctx.forwardedAuth))
	) {
		const result = await callTenantMcpTool(ctx, "menu_set_items", {
			name,
			...(locale ? { locale } : {}),
			items,
		});
		if (result.isError) return result;
		return cmsRestSuccessToolResult({
			success: true,
			data: unwrapCmsToolResult(result, "CMS native menu_set_items"),
		});
	}

	const authCandidates = buildCmsAuthHeaderCandidates(ctx);
	if (authCandidates.length === 0) return cmsAuthUnavailableToolResult(ctx);
	const path = `/menus/${encodeURIComponent(name)}/items`;
	const url = new URL(`${cmsApiBaseUrl(ctx)}${path}`);
	if (locale) url.searchParams.set("locale", locale);
	const result = await executeCmsRestRequest(
		authCandidates,
		cmsDoFetch(ctx),
		"PUT",
		url.toString(),
		{ items },
	);
	if (!result.ok) return restResultToToolResult("PUT", path, result);
	return cmsRestSuccessToolResult(result.json);
}
