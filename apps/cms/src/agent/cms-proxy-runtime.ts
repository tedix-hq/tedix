import { asRecord } from "@tedix/api-contract/utils/is-record";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import type { CmsHumanAuthDenial, CmsHumanIdentity } from "./cms-human-auth";
import type { RestRoute } from "./cms-proxy-rest-routes";
import type { RestCallResult } from "./cms-proxy-rest";

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

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
	_meta?: { code?: string; details?: any };
};

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

/**
 * Shape a successful Emdash REST JSON body (`{ success: true, data }`) into
 * the proxy's tool envelope. Shared by the REST transport and the native
 * tenant MCP transport so both emit byte-identical envelopes.
 */
export function cmsRestSuccessToolResult(json: unknown): ToolResult {
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

export function cmsContentCreateSuccessToolResult(
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

export function restResultToToolResult(
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

export const hasOwn = (value: Record<string, unknown>, key: string) =>
	Object.hasOwn(value, key);

export function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}
