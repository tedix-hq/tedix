import { asRecord } from "@tedix/api-contract/utils/is-record";
import { firstString } from "./cms-proxy-runtime";
import type { RestCallResult } from "./cms-proxy-rest";
import type { RestRoute } from "./cms-proxy-rest-routes";

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

export const BYLINE_REST_ROUTES: Record<string, RestRoute> = {
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
};

function restFailureText(result: RestCallResult): string {
	return result.ok ? "" : result.text;
}

export function shouldFallbackContentAuthors(result: RestCallResult): boolean {
	if (result.ok) return false;
	if (result.status === 404) return true;
	const text = restFailureText(result);
	return (
		result.status >= 500 &&
		(text.includes('"code":"NOT_CONFIGURED"') ||
			text.includes("EmDash is not initialized"))
	);
}

export function contentItemsFromListResult(
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

export function authorFallbackItems(
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

export function requestedBylineIds(args: Record<string, unknown>): string[] {
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
