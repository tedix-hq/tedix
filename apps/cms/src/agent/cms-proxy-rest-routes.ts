import {
	calendarQuery,
	createCollectionBody,
	updateCollectionBody,
} from "emdash/api/schemas";
import { BYLINE_REST_ROUTES } from "./cms-proxy-bylines";

export interface RestRoute {
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

export function contentListQueryParams(
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

export const REST_ROUTES: Record<string, RestRoute> = {
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
	...BYLINE_REST_ROUTES,
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
