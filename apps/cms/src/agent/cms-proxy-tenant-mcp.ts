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
import { unwrapCmsToolResult } from "./tool-result";
import { isJwt } from "./cms-proxy-auth";
import {
	cmsApiBaseUrl,
	cmsRestSuccessToolResult,
	type CmsProxyContext,
	type ToolResult,
} from "./cms-proxy-runtime";

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
// Content writes were re-verified against the PATCHED Emdash 1.3.0 build
// (root patches/emdash@1.3.0.patch): each native tool resolves the entry with
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
export async function callCmsRestViaTenantMcp(
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
