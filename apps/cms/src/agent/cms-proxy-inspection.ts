import {
	apiData,
	buildCmsAuthHeaderCandidates,
	callCmsRest,
	cmsApiBaseUrl,
	listTenantMcpTools,
	type CmsProxyContext,
	type ToolResult,
} from "./cms-proxy-runtime";
import { readHotThemeManifest } from "./hot-theme";
import { getCmsSiteDeployment } from "./storage";
import { unwrapCmsToolResult } from "./tool-result";
import { asRecord } from "@tedix/api-contract/utils/is-record";

// ---------------------------------------------------------------------------
// Tool proxy factory — wraps callCmsRest for a specific tool
// ---------------------------------------------------------------------------

const unwrapInspectionResult = (result: ToolResult): unknown =>
	unwrapCmsToolResult(result, "CMS proxy inspection");

function recordsFromEnvelope(
	value: unknown,
	key = "items",
): Array<Record<string, unknown>> {
	const items = asRecord(asRecord(value)?.data)?.[key];
	return Array.isArray(items)
		? items.filter(
				(item): item is Record<string, unknown> =>
					item !== null && typeof item === "object" && !Array.isArray(item),
			)
		: [];
}

function pickString(
	value: Record<string, unknown> | null | undefined,
	...keys: string[]
): string | undefined {
	if (!value) return undefined;
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function summarizeCollection(
	collection: Record<string, unknown>,
	maxFields: number,
): Record<string, unknown> {
	const fields = Array.isArray(collection.fields)
		? collection.fields
				.filter(
					(field): field is Record<string, unknown> =>
						field !== null &&
						typeof field === "object" &&
						!Array.isArray(field),
				)
				.slice(0, maxFields)
				.map((field) => ({
					slug: field.slug,
					label: field.label,
					type: field.type,
					required: field.required,
					translatable: field.translatable,
					searchable: field.searchable,
				}))
		: null;
	return {
		slug: collection.slug,
		label: collection.label,
		description: collection.description,
		supports: collection.supports,
		hasSeo: collection.hasSeo,
		urlPattern: collection.urlPattern,
		fieldCount: Array.isArray(collection.fields)
			? collection.fields.length
			: null,
		fields,
	};
}

function summarizeMenu(menu: Record<string, unknown>): Record<string, unknown> {
	return {
		name: menu.name,
		label: menu.label,
		locale: menu.locale,
		itemCount: Array.isArray(menu.items) ? menu.items.length : menu.itemCount,
		items: Array.isArray(menu.items)
			? menu.items.slice(0, 12).map((item) => {
					const record = asRecord(item);
					return {
						label: record?.label,
						type: record?.type,
						url: record?.customUrl ?? record?.url,
						children: Array.isArray(record?.children)
							? record.children.length
							: undefined,
					};
				})
			: undefined,
	};
}

function summarizeContentItem(
	item: Record<string, unknown>,
): Record<string, unknown> {
	const data = asRecord(item.data);
	return {
		id: item.id,
		slug: item.slug,
		status: item.status,
		locale: item.locale,
		title: pickString(data, "title", "name"),
		publishedAt: item.publishedAt,
		scheduledAt: item.scheduledAt,
		updatedAt: item.updatedAt,
		version: item.version,
		liveRevisionId: item.liveRevisionId,
		draftRevisionId: item.draftRevisionId,
	};
}

function summarizeSettings(value: unknown): Record<string, unknown> {
	const settings = apiData(value) ?? asRecord(value) ?? {};
	const social = asRecord(settings.social);
	return {
		title: settings.title,
		tagline: settings.tagline,
		description: settings.description,
		siteUrl: settings.siteUrl ?? settings.url,
		logo: settings.logo,
		social:
			social && Object.keys(social).length > 0
				? Object.fromEntries(
						Object.entries(social).filter(
							([, v]) => typeof v === "string" && v.length > 0,
						),
					)
				: undefined,
	};
}

function cmsMediaRuntimeSummary(): Record<string, unknown> {
	return {
		emdashResponsiveMedia: "source_supported",
		imageService: "unverified",
		responsiveSrcsetStatus: "unverified",
		activeBundleInspection: "not_performed",
		validator: "bun run cms:responsive-media:validate -- --json",
		reason:
			"The source validator checks the starter, snapshot, and parent Images route. This overview does not inspect the immutable active tenant bundle or prove transformed image variants; inspect the compiled bundle and live image responses before claiming responsive media is active.",
	};
}

function cmsDatabaseRuntimeSummary(): Record<string, unknown> {
	return {
		emdashDurableObjects: "source_configured",
		currentBackend: "durableObjects",
		tenantAdapter:
			'durableObjects({ binding: "DB_DO", name: process.env.ORG_SLUG, session: "auto" })',
		parentRuntimeBinding:
			"Serializable EmDashDB Durable Object SQLite query/batch RPC stub injected into each Worker Loader isolate as DB_DO",
		durableObjectsStatus: "not_inspected",
		validator: "bun run cms:database-architecture:validate -- --json",
		reason:
			"The current Tedix template and parent runtime configure durableObjects() SQLite. This overview does not inspect the active tenant bundle or validate its database adapter; source configuration alone is not live execution proof.",
	};
}

function errorText(result: ToolResult): string | undefined {
	return result.isError
		? (result.content[0]?.text ?? "unknown error")
		: undefined;
}

export async function getCmsSiteOverview(
	ctx: CmsProxyContext,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const locale =
		typeof args.locale === "string" && args.locale.length > 0
			? args.locale
			: undefined;
	const includeMenus = args.includeMenus !== false;
	const includeTaxonomies = args.includeTaxonomies !== false;
	const includePlugins = args.includePlugins !== false;
	const includeRecentContent = args.includeRecentContent === true;
	const maxFieldsPerCollection =
		typeof args.maxFieldsPerCollection === "number"
			? Math.max(0, Math.min(50, Math.trunc(args.maxFieldsPerCollection)))
			: 16;
	const recentLimit =
		typeof args.recentLimit === "number"
			? Math.max(1, Math.min(20, Math.trunc(args.recentLimit)))
			: 5;

	const [
		schemaResult,
		settingsResult,
		menusResult,
		taxonomiesResult,
		pluginsResult,
		siteDeploymentResult,
		hotThemeResult,
		blockTypesResult,
		nativeToolsResult,
	] = await Promise.all([
		callCmsRest(ctx, "schema_list_collections", {}),
		callCmsRest(ctx, "settings_get", {}),
		includeMenus ? callCmsRest(ctx, "menu_list", { locale }) : null,
		includeTaxonomies ? callCmsRest(ctx, "taxonomy_list", {}) : null,
		includePlugins ? pluginList(ctx, {}) : null,
		ctx.db && ctx.bundlesBucket
			? getCmsSiteDeployment(ctx.db, ctx.bundlesBucket, ctx.orgSlug).then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				)
			: { value: null },
		ctx.bundlesBucket
			? readHotThemeManifest(ctx.bundlesBucket, ctx.orgSlug).then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				)
			: { value: null },
		callCmsRest(ctx, "schema_list_block_types", {}),
		listTenantMcpTools(ctx),
	]);

	if (schemaResult.isError) return schemaResult;

	const collections = recordsFromEnvelope(unwrapInspectionResult(schemaResult));
	const schemaErrors: Record<string, string> = {};
	if (maxFieldsPerCollection > 0) {
		await Promise.all(
			collections.map(async (collection) => {
				if (
					Array.isArray(collection.fields) ||
					typeof collection.slug !== "string"
				)
					return;
				const result = await callCmsRest(ctx, "schema_get_collection", {
					slug: collection.slug,
				});
				const schema = result.isError
					? null
					: asRecord(apiData(unwrapInspectionResult(result))?.item);
				if (!Array.isArray(schema?.fields)) {
					schemaErrors[collection.slug] =
						errorText(result) ?? "Collection schema did not return fields";
					return;
				}
				collection.fields = schema.fields;
			}),
		);
	}
	const selectedCollections = Array.isArray(args.collections)
		? args.collections.filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			)
		: collections
				.map((collection) => String(collection.slug ?? ""))
				.filter((slug) => slug === "posts" || slug === "pages")
				.slice(0, 2);

	const recentContent: Record<string, unknown[]> = {};
	const recentErrors: Record<string, string> = {};
	if (includeRecentContent) {
		await Promise.all(
			selectedCollections.map(async (collection) => {
				const result = await callCmsRest(ctx, "content_list", {
					collection,
					locale,
					limit: recentLimit,
					orderBy: "updatedAt",
					order: "desc",
				});
				if (result.isError) {
					recentErrors[collection] =
						result.content[0]?.text ?? "content_list failed";
					return;
				}
				recentContent[collection] = recordsFromEnvelope(
					unwrapInspectionResult(result),
				).map(summarizeContentItem);
			}),
		);
	}

	const pluginSummary = pluginsResult?.isError
		? undefined
		: apiData(unwrapInspectionResult(pluginsResult ?? { content: [] }))
				?.summary;
	const siteDeployment =
		"value" in siteDeploymentResult ? siteDeploymentResult.value : null;
	const hotTheme = "value" in hotThemeResult ? hotThemeResult.value : null;

	const payload = {
		orgSlug: ctx.orgSlug,
		environment: ctx.environment,
		site: {
			templateSlug: siteDeployment?.templateSlug ?? null,
			publicUrl: siteDeployment?.publicUrl ?? null,
			activeBundleVersion: siteDeployment?.activeBundleVersion ?? null,
			sourceRevision: siteDeployment?.sourceRevision ?? null,
			hotCssRevision:
				hotTheme?.orgSlug === ctx.orgSlug ? hotTheme.revision : null,
		},
		urls: {
			tenant: cmsApiBaseUrl(ctx).replace(/\/_emdash\/api$/, ""),
			admin: cmsApiBaseUrl(ctx).replace(/\/api$/, "/admin"),
			nativeMcp: `${cmsApiBaseUrl(ctx)}/mcp`,
			canonicalPublic: siteDeployment?.publicUrl ?? null,
			preview: { status: "not_requested", requiresSignedContentPreview: true },
		},
		revisions: {
			bundleVersion: siteDeployment?.activeBundleVersion ?? null,
			themeSource: siteDeployment?.sourceRevision ?? null,
			hotCss:
				hotTheme?.orgSlug === ctx.orgSlug
					? { revision: hotTheme.revision, sha256: hotTheme.sha256 }
					: null,
			content:
				"Read content_get data._rev before a write; recent list versions are not mutation preconditions.",
			schema:
				"Definitions observed in this request; no schema revision token supplied by the native API.",
		},
		capabilities: {
			observedAt: new Date().toISOString(),
			blockSchema: blockTypesResult.isError
				? { status: "unavailable", error: errorText(blockTypesResult) }
				: {
						status: "observed",
						types: recordsFromEnvelope(
							unwrapInspectionResult(blockTypesResult),
						),
					},
			nativeTools: nativeToolsResult.isError
				? { status: "not_inspected", reason: errorText(nativeToolsResult) }
				: {
						status: "observed",
						authorization:
							"Tool metadata describes installed support; individual execution remains subject to caller scopes and native authorization.",
						tools:
							asRecord(unwrapInspectionResult(nativeToolsResult))?.tools ?? [],
					},
			activeBundleFeatures: "not_inspected",
		},
		locale,
		authModes: buildCmsAuthHeaderCandidates(ctx).map(
			(candidate) => candidate.source,
		),
		settings: settingsResult.isError
			? { error: errorText(settingsResult) }
			: summarizeSettings(unwrapInspectionResult(settingsResult)),
		collections: collections.map((collection) =>
			summarizeCollection(collection, maxFieldsPerCollection),
		),
		menus:
			menusResult && !menusResult.isError
				? recordsFromEnvelope(unwrapInspectionResult(menusResult)).map(
						summarizeMenu,
					)
				: undefined,
		taxonomies:
			taxonomiesResult && !taxonomiesResult.isError
				? recordsFromEnvelope(
						unwrapInspectionResult(taxonomiesResult),
						"taxonomies",
					).map((taxonomy) => ({
						name: taxonomy.name,
						label: taxonomy.label,
						hierarchical: taxonomy.hierarchical,
					}))
				: undefined,
		plugins: pluginSummary,
		databaseRuntime: cmsDatabaseRuntimeSummary(),
		mediaRuntime: cmsMediaRuntimeSummary(),
		recentContent: includeRecentContent ? recentContent : undefined,
		errors: {
			...("error" in siteDeploymentResult
				? { siteDeployment: String(siteDeploymentResult.error) }
				: {}),
			...("error" in hotThemeResult
				? { hotCssRevision: String(hotThemeResult.error) }
				: {}),
			...(Object.keys(schemaErrors).length > 0
				? { schemas: schemaErrors }
				: {}),
			...(settingsResult.isError
				? { settings: errorText(settingsResult) }
				: {}),
			...(menusResult?.isError ? { menus: errorText(menusResult) } : {}),
			...(taxonomiesResult?.isError
				? { taxonomies: errorText(taxonomiesResult) }
				: {}),
			...(pluginsResult?.isError ? { plugins: errorText(pluginsResult) } : {}),
			...recentErrors,
		},
		operatorHints: [
			"The active bundle source revision identifies deployed theme code; hotCssRevision is a separate live CSS override.",
			"Use schema_get_collection before content_create/content_update so field types match the live Emdash schema.",
			"Pass locale on multi-locale tenants when using slugs for publish, schedule, delete, compare, or discard-draft.",
			"Create drafts first; publish only after review. Use content_schedule for future publication.",
			"Use media_to_field_value before assigning uploaded or provider media to image/file fields.",
			"Run cms:database-architecture:validate after CMS runtime or Emdash adapter changes; durableObjects() is live only when the template, Worker Loader env, EmDashDB binding, and migrations all validate together.",
			"Run cms:responsive-media:validate for the source path, then inspect the active bundle and live image responses before claiming responsive srcsets for this tenant.",
			"After plugin lifecycle changes, run route smoke plus draft-write smoke before customer-visible publication.",
		],
	};

	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	} as ToolResult;
}

function pluginItems(value: unknown): Array<Record<string, unknown>> {
	const data = apiData(value);
	const items = data?.items;
	return Array.isArray(items)
		? items.filter(
				(item): item is Record<string, unknown> =>
					item !== null && typeof item === "object" && !Array.isArray(item),
			)
		: [];
}

function filterPluginItems(
	items: Array<Record<string, unknown>>,
	args: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const source = typeof args.source === "string" ? args.source : undefined;
	const status = typeof args.status === "string" ? args.status : undefined;

	return items.filter((item) => {
		if (source && item.source !== source) return false;
		if (status && item.status !== status) return false;
		return true;
	});
}

function pluginSourceCounts(
	items: Array<Record<string, unknown>>,
): Record<string, number> {
	return items.reduce<Record<string, number>>((counts, item) => {
		const source = typeof item.source === "string" ? item.source : "unknown";
		counts[source] = (counts[source] ?? 0) + 1;
		return counts;
	}, {});
}

function pluginStatusCounts(
	items: Array<Record<string, unknown>>,
): Record<string, number> {
	return items.reduce<Record<string, number>>((counts, item) => {
		const status = typeof item.status === "string" ? item.status : "unknown";
		counts[status] = (counts[status] ?? 0) + 1;
		return counts;
	}, {});
}

function pluginHasRecord(item: Record<string, unknown>, key: string): boolean {
	const value = item[key];
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pluginHasCompatibilityWarning(item: Record<string, unknown>): boolean {
	const candidates = [
		item.compatibility,
		item.envCompatibility,
		item.compatibilityWarnings,
		item.envCompatibilityWarnings,
		item.mismatches,
		item.envMismatches,
		item.warning,
		item.error,
	];

	return candidates.some((value) => {
		if (typeof value === "string") return value.length > 0;
		if (Array.isArray(value)) return value.length > 0;
		if (value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.compatible === false) return true;
			if (record.ok === false) return true;
			if (Array.isArray(record.mismatches)) {
				return record.mismatches.length > 0;
			}
		}
		return false;
	});
}

export function pluginRegistrySignalSummary(
	items: Array<Record<string, unknown>>,
) {
	const registryItems = items.filter((item) => item.source === "registry");
	return {
		withRequires: registryItems.filter((item) =>
			pluginHasRecord(item, "requires"),
		).length,
		withArtifacts: registryItems.filter((item) =>
			pluginHasRecord(item, "artifacts"),
		).length,
		withProfileSections: registryItems.filter((item) =>
			pluginHasRecord(item, "sections"),
		).length,
		withSbom: registryItems.filter((item) => pluginHasRecord(item, "sbom"))
			.length,
		withCompatibilityWarnings: registryItems.filter(
			pluginHasCompatibilityWarning,
		).length,
	};
}

export async function pluginList(
	ctx: CmsProxyContext,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const result = await callCmsRest(ctx, "plugin_list", {});
	if (result.isError) return result;

	const parsed = unwrapInspectionResult(result);
	const items = filterPluginItems(pluginItems(parsed), args);
	const payload = {
		items,
		summary: {
			total: items.length,
			bySource: pluginSourceCounts(items),
			byStatus: pluginStatusCounts(items),
			registrySignals: pluginRegistrySignalSummary(items),
		},
	};
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	} as ToolResult;
}

export async function registryStatus(
	ctx: CmsProxyContext,
): Promise<ToolResult> {
	const [manifestResult, pluginsResult, updatesResult] = await Promise.all([
		callCmsRest(ctx, "manifest_get", {}),
		callCmsRest(ctx, "plugin_list", {}),
		pluginUpdates(ctx),
	]);

	const pluginListError = pluginsResult.isError
		? (pluginsResult.content[0]?.text ?? "plugin_list failed")
		: null;
	if (pluginListError) {
		return {
			content: [{ type: "text", text: pluginListError }],
			isError: true,
		};
	}

	const manifest = manifestResult.isError
		? null
		: apiData(unwrapInspectionResult(manifestResult));
	const plugins = pluginItems(unwrapInspectionResult(pluginsResult));
	const updates = updatesResult.isError
		? []
		: pluginItems(unwrapInspectionResult(updatesResult));
	const payload = {
		registry: {
			installationState: "unverified",
			reason:
				"The parent CMS runtime can inject a tenant-qualified plugin host for an exact canary site, but this inspection does not verify that binding or a successful signed install.",
			policy:
				"Keep customer-site installs and updates held until a signed zero-access plugin passes install-hook and private-route proof on a disposable site.",
			manifestVisible: Boolean(manifest),
			manifestError: manifestResult.isError
				? (manifestResult.content[0]?.text ?? "manifest_get failed")
				: undefined,
		},
		plugins: {
			total: plugins.length,
			bySource: pluginSourceCounts(plugins),
			byStatus: pluginStatusCounts(plugins),
			registryInstalled: plugins.filter(
				(plugin) => plugin.source === "registry",
			).length,
			registrySignals: pluginRegistrySignalSummary(plugins),
			items: plugins,
		},
		updates: {
			total: updates.length,
			items: updates,
			registrySignals: pluginRegistrySignalSummary(updates),
			warning: updatesResult.isError
				? (updatesResult.content[0]?.text ?? "plugin_updates failed")
				: (apiData(unwrapInspectionResult(updatesResult))?.warning ??
					undefined),
		},
	};

	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	} as ToolResult;
}

export async function pluginUpdates(ctx: CmsProxyContext): Promise<ToolResult> {
	const result = await callCmsRest(ctx, "plugin_updates", {});
	if (!result.isError) return result;

	const text = result.content[0]?.text ?? "";
	if (
		text.includes("MARKETPLACE_NOT_CONFIGURED") ||
		text.includes("REGISTRY_NOT_CONFIGURED")
	) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							data: {
								items: [],
								warning:
									"Plugin update source is not configured; returning an empty update list.",
							},
						},
						null,
						2,
					),
				},
			],
		};
	}

	return result;
}
