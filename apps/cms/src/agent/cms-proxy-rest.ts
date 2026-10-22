import { calendarQuery, contentListQuery } from "emdash/api/schemas";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import { unwrapCmsToolResult } from "./tool-result";
import {
	buildCmsAuthHeaderCandidates,
	cmsAuthUnavailableToolResult,
	isJwt,
	type AuthHeaderCandidate,
} from "./cms-proxy-auth";
import {
	authorFallbackItems,
	contentItemsFromListResult,
	requestedBylineIds,
	shouldFallbackContentAuthors,
} from "./cms-proxy-bylines";
import {
	REST_ROUTES,
	type RestRoute,
	contentListQueryParams,
} from "./cms-proxy-rest-routes";
import {
	callCmsRestViaTenantMcp,
	callTenantMcpTool,
	hasTenantMcpCredential,
	shouldForwardCmsRestToTenantMcp,
	tenantMcpError,
} from "./cms-proxy-tenant-mcp";
import {
	apiData,
	cmsApiBaseUrl,
	cmsDoFetch,
	cmsRestSuccessToolResult,
	cmsContentCreateSuccessToolResult,
	restResultToToolResult,
	safeJsonParse,
	firstString,
	hasOwn,
	type CmsProxyContext,
	type ToolResult,
} from "./cms-proxy-runtime";

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
