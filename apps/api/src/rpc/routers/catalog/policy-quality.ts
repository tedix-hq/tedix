import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
	withFleetAuthority,
} from "../../orpc";
import type {
	CatalogInstallability,
	CatalogQuality,
	InstallTenantMcpAppInput,
	InstallTenantMcpAppOutput,
	OpenApiImportInput,
	ReconcileCatalogAppStage,
	Source,
} from "@tedix/api-contract/schemas/catalog";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	ToolInputJsonSchemaSchema,
	type ToolJsonSchema,
	ToolJsonSchemaSchema,
} from "@tedix/api-contract/schemas/tools";
import { canonicalCatalogCategory } from "@tedix/db/queries/catalog/list-apps";
import { catalogContract } from "@tedix/api-contract/contracts/catalog";
import { tenantCatalogContract } from "@tedix/api-contract/contracts/tenant-catalog";
import { aggregateAppEntryMatches } from "@tedix/db/queries/aggregate-app-links";
import { getAppById } from "@tedix/db/queries/app-records";
import { getCatalogAppById } from "@tedix/db/queries/catalog/get-app";
import { getCatalogAppBySlugWithRelations } from "@tedix/db/queries/catalog/list-with-relations";
import {
	getCatalogBaseApp as getCatalogBaseAppRecord,
	getLinkedOpenApiCatalogSnapshot,
	listBaseAppsForCatalogApps as listBaseAppRecordsForCatalogApps,
} from "@tedix/db/queries/apps";
import {
	hasCatalogOperatorAccess,
	hasTenantOpenApiImportAccess,
} from "../catalog-operator-access";
import { implement } from "@orpc/server";
import { listCatalogStoreListingsByAppIds } from "@tedix/db/queries/catalog/store-listings";

export // =============================================================================
// CONTRACT IMPLEMENTER
// =============================================================================

/**
 * Create the contract implementer with base context
 * This router uses withAuth middleware for all procedures
 */
const catalogOs = implement(catalogContract)
	.$context<BaseContext>()
	.use(withAuth);

export const fleetCatalogOs = catalogOs.use(withFleetAuthority);

export const tenantCatalogOs = implement(tenantCatalogContract)
	.$context<BaseContext>()
	.use(withAuth);

// Alias for consistency

export // Alias for consistency

type DiscoverabilityPriority = "high" | "medium" | "low";

export type WorkflowBinding<TPayload> = {
	create(input: { params: TPayload }): Promise<{
		id: string;
	}>;
};

export type CatalogAppRecord = NonNullable<
	Awaited<ReturnType<typeof getCatalogAppById>>
>;

export function openApiSyncWorkflow(context: BaseContext) {
	const workflow = (
		context.env as CloudflareEnv & {
			OPENAPI_SYNC_WORKFLOW?: WorkflowBinding<Record<string, unknown>>;
		}
	).OPENAPI_SYNC_WORKFLOW;
	if (!workflow) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"OPENAPI_SYNC_WORKFLOW not configured",
		);
	}
	return workflow;
}

export async function queueOpenApiSyncWorkflow(
	context: BaseContext,
	input: Record<string, unknown> & {
		appId: string;
		dryRun?: boolean;
	},
) {
	const workflow = openApiSyncWorkflow(context);
	const params = {
		...input,
		dryRun: input.dryRun ?? false,
	};
	const instance = await workflow.create({
		params,
	});
	return {
		appId: input.appId,
		workflowId: instance.id,
		status: "queued" as const,
		message: `OpenAPI sync queued for app ${input.appId}`,
	};
}

export async function requireOpenApiImportAccess(
	context: BaseContext,
	input: OpenApiImportInput,
): Promise<void> {
	if (hasCatalogOperatorAccess(context)) return;
	const app = await getAppById(context.db, input.appId);
	const linked = app
		? await getLinkedOpenApiCatalogSnapshot(context.db, input.appId)
		: null;
	const target = app
		? {
				...app,
				catalogToolSource: linked?.toolSource ?? null,
			}
		: null;
	if (!target) {
		throw createError(ErrorCodes.NOT_FOUND, `App not found: ${input.appId}`);
	}
	if (!hasTenantOpenApiImportAccess(context, target, input)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"OpenAPI import requires platform catalog access or an org-owned OpenAPI base app",
		);
	}
}

export function normalizeToolJsonSchema(schema: unknown): ToolJsonSchema {
	const parsed = ToolInputJsonSchemaSchema.safeParse(schema);
	return parsed.success ? parsed.data : EMPTY_TOOL_INPUT_SCHEMA;
}

export function normalizeOutputJsonSchema(
	schema: unknown,
): ToolJsonSchema | null {
	if (schema == null) return null;
	const parsed = ToolJsonSchemaSchema.safeParse(schema);
	return parsed.success ? parsed.data : null;
}

export type BaseAppSummary = {
	id: string;
	slug: string;
	name: string;
	organizationId: string;
	metadata: unknown;
};

export type TenantMcpInstallInput = InstallTenantMcpAppInput & {
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
	forwardedQueryParams?: Record<string, string>;
};

export type TenantMcpInstallResult = InstallTenantMcpAppOutput;

export function hasAggregateAppOverlay(app: { metadata?: unknown }): boolean {
	const metadata =
		typeof app.metadata === "object" && app.metadata !== null
			? (app.metadata as Record<string, unknown>)
			: {};
	const mcpConfig =
		typeof metadata.mcpConfig === "object" && metadata.mcpConfig !== null
			? (metadata.mcpConfig as Record<string, unknown>)
			: {};
	return (
		Array.isArray(mcpConfig.aggregateApps) && mcpConfig.aggregateApps.length > 0
	);
}

export type CatalogInstallabilityApp = {
	status?: string | null;
	connectorType?: string | null;
	baseUrl?: string | null;
	mcpEndpointNormalized?: string | null;
	mcpToolCount?: number | null;
	mcpResourceCount?: number | null;
	mcpPromptCount?: number | null;
};

export function calculateCatalogInstallability(
	app: CatalogInstallabilityApp,
	baseApp?: BaseAppSummary | null,
): CatalogInstallability {
	const inventoryCount =
		(app.mcpToolCount ?? 0) +
		(app.mcpResourceCount ?? 0) +
		(app.mcpPromptCount ?? 0);
	const hasEndpoint = Boolean(app.mcpEndpointNormalized || app.baseUrl);
	const connectorType = app.connectorType ?? null;
	if (app.status && app.status !== "ENABLED") {
		return {
			installable: false,
			state: "disabled",
			reason: "This catalog entry is not enabled for tenant installation.",
		};
	}
	if (connectorType === "FIRST_PARTY_ECOSYSTEM") {
		return {
			installable: false,
			state: "listing_only",
			reason:
				"This is a first-party directory listing, not a concrete MCP app.",
		};
	}

	// Store-brokered connector (e.g. GitHub's ChatGPT SERVICE connector): the
	// store proxies the OAuth/connection internally and publishes no public MCP
	// endpoint, so it can never be installed through Tedix MCP. Surface it as a
	// distinct, legible state instead of a generic listing so operators know the
	// runnable version is a separate `official` entry (or does not exist).
	if (
		(connectorType === "SERVICE" || connectorType === "NATIVE") &&
		!hasEndpoint &&
		inventoryCount === 0
	) {
		return {
			installable: false,
			state: "service_connector",
			reason:
				"Store-brokered connector with no public MCP endpoint. The runnable version is a separate official MCP entry, if one exists.",
		};
	}
	if (connectorType !== "MCP" && inventoryCount === 0) {
		return {
			installable: false,
			state: "listing_only",
			reason:
				"This store listing has no Tedix MCP tools, resources, or prompts to install.",
		};
	}
	if (!hasEndpoint && inventoryCount === 0) {
		return {
			installable: false,
			state: "needs_mcp_endpoint",
			reason:
				"This catalog entry has no MCP endpoint or discovered inventory yet.",
		};
	}
	if (!baseApp) {
		return {
			installable: false,
			state: "needs_base_app",
			reason:
				"A platform catalog operator must create or reconcile the base app before tenants can install this entry.",
		};
	}
	if (hasAggregateAppOverlay(baseApp)) {
		return {
			installable: false,
			state: "needs_base_app",
			reason:
				"This catalog entry resolves to a proxy app; tenant installs require a prepared base app.",
		};
	}
	return {
		installable: true,
		state: "installable",
		reason: "This catalog entry has a prepared base app for tenant install.",
	};
}

export function stageData(
	values: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, value == null ? "" : String(value)]),
	);
}

export function summarizeBaseApp(baseApp: BaseAppSummary | null) {
	return baseApp
		? {
				id: baseApp.id,
				slug: baseApp.slug,
				name: baseApp.name,
			}
		: null;
}

export type AggregateAppEntry = {
	slug: string;
	/** Stable id of the linked app; preferred over slug when matching. */
	appId?: string;
	prefix?: string;
	toolIds?: string[];
	endpointPrefixes?: string[];
	connectionLabel?: string;
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
};

export function metadataRecord(metadata: unknown): Record<string, unknown> {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? {
				...(metadata as Record<string, unknown>),
			}
		: {};
}

export function mcpConfigRecord(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	const mcpConfig = metadata.mcpConfig;
	return mcpConfig && typeof mcpConfig === "object" && !Array.isArray(mcpConfig)
		? {
				...(mcpConfig as Record<string, unknown>),
			}
		: {};
}

export function sanitizeNamespace(value: string): string {
	const namespace = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return /^[a-z]/.test(namespace) ? namespace : `app_${namespace || "catalog"}`;
}

export function readAggregateApps(
	mcpConfig: Record<string, unknown>,
): AggregateAppEntry[] {
	return Array.isArray(mcpConfig.aggregateApps)
		? mcpConfig.aggregateApps
				.filter(
					(entry): entry is AggregateAppEntry =>
						Boolean(entry) &&
						typeof entry === "object" &&
						typeof (
							entry as {
								slug?: unknown;
							}
						).slug === "string",
				)
				.map((entry) => ({
					...entry,
				}))
		: [];
}

/**
 * Insert `nextEntry` or merge it into the entry that already links to the same
 * app. Matching uses `appId` when both sides have one, else slug, so an old
 * slug-only entry and an id entry whose app was renamed are both found. Later
 * duplicates of the same link are dropped.
 */
export function upsertAggregateAppEntry(
	entries: AggregateAppEntry[],
	nextEntry: AggregateAppEntry,
): {
	entries: AggregateAppEntry[];
	attached: boolean;
} {
	let attached = true;
	const merged: AggregateAppEntry[] = [];
	const link = { appId: nextEntry.appId, slug: nextEntry.slug };
	for (const entry of entries) {
		if (!aggregateAppEntryMatches(entry, link)) {
			merged.push(entry);
			continue;
		}
		if (!attached) continue;
		attached = false;
		merged.push({
			...entry,
			...nextEntry,
		});
	}
	if (attached) merged.push(nextEntry);
	return {
		entries: merged,
		attached,
	};
}

/**
 * Split `entries` into the first entry matching the detach request and the
 * entries that remain. `appId`/`slug` identify the linked app (id preferred,
 * slug for entries written before ids were stored); `prefix` narrows by
 * Code Mode namespace. At least one criterion must be given.
 */
export function detachAggregateAppEntries(
	entries: AggregateAppEntry[],
	target: { appId?: string | null; slug?: string | null; prefix?: string },
): {
	aggregateEntry: AggregateAppEntry | null;
	remainingAggregateApps: AggregateAppEntry[];
} {
	const link = { appId: target.appId, slug: target.slug };
	const matches = (entry: AggregateAppEntry) => {
		if ((link.appId || link.slug) && !aggregateAppEntryMatches(entry, link))
			return false;
		if (target.prefix) {
			const entryNamespace = entry.prefix ?? sanitizeNamespace(entry.slug);
			if (entryNamespace !== target.prefix) return false;
		}
		return Boolean(target.appId || target.slug || target.prefix);
	};
	const aggregateEntry = entries.find(matches) ?? null;
	return {
		aggregateEntry,
		remainingAggregateApps: aggregateEntry
			? entries.filter((entry) => !matches(entry))
			: entries,
	};
}

export function readNamespaceToolScopes(
	mcpConfig: Record<string, unknown>,
): Record<string, string[]> {
	return mcpConfig.toolScopes &&
		typeof mcpConfig.toolScopes === "object" &&
		!Array.isArray(mcpConfig.toolScopes)
		? Object.fromEntries(
				Object.entries(mcpConfig.toolScopes).filter(
					(entry): entry is [string, string[]] =>
						Array.isArray(entry[1]) &&
						entry[1].every((scope) => typeof scope === "string"),
				),
			)
		: {};
}

export function mergeNamespaceToolScopes(
	mcpConfig: Record<string, unknown>,
	namespace: string,
	scopes: string[],
): Record<string, string[]> {
	const current = readNamespaceToolScopes(mcpConfig);
	current[namespace] = [...new Set(scopes)];
	return current;
}

export function removeNamespaceToolScopes(
	mcpConfig: Record<string, unknown>,
	namespaces: string[],
): {
	toolScopes: Record<string, string[]>;
	removedKeys: string[];
} {
	const namespaceSet = new Set(namespaces.filter(Boolean));
	const current = readNamespaceToolScopes(mcpConfig);
	const removedKeys = Object.keys(current).filter((key) =>
		namespaceSet.has(key),
	);
	for (const key of removedKeys) delete current[key];
	return {
		toolScopes: current,
		removedKeys,
	};
}

export async function getCatalogBaseApp(
	db: BaseContext["db"],
	catalogAppId: string,
	baseAppId?: string,
): Promise<BaseAppSummary | null> {
	return getCatalogBaseAppRecord(db, {
		catalogAppId,
		baseAppId,
	});
}

export function pushReconcileStage(
	stages: ReconcileCatalogAppStage[],
	stage: ReconcileCatalogAppStage["stage"],
	status: ReconcileCatalogAppStage["status"],
	summary: string,
	data?: ReconcileCatalogAppStage["data"],
) {
	stages.push({
		stage,
		status,
		summary,
		...(data
			? {
					data,
				}
			: {}),
	});
}

export type DiscoverabilityTip = {
	tip: string;
	priority: DiscoverabilityPriority;
};

export type DiscoverabilityCriterion = {
	label: string;
	score: number;
	max: number;
};

export type DiscoverabilityLabel = "Excellent" | "Good" | "Fair" | "Low";

export type PrimaryListing = {
	source: Source;
	sourceAppId: string | null;
};

export type CatalogStoreListingSummary = {
	catalogAppId: string;
	source: Source;
	sourceAppId: string | null;
	regions: string[] | null;
};

/**
 * D1 rejects a statement with more than 100 bound parameters. Any
 * `inArray(column, appIds)` fan-out over a caller-controlled page of catalog
 * apps therefore has to be batched — `catalog.list` accepts `limit` up to 200,
 * so an unbatched lookup 500s for every page larger than 100.
 */

export /**
 * D1 rejects a statement with more than 100 bound parameters. Any
 * `inArray(column, appIds)` fan-out over a caller-controlled page of catalog
 * apps therefore has to be batched — `catalog.list` accepts `limit` up to 200,
 * so an unbatched lookup 500s for every page larger than 100.
 */
const CATALOG_ID_LOOKUP_BATCH_SIZE = 50;

/**
 * Run an id-keyed lookup in D1-safe batches and concatenate the rows.
 *
 * Every `inArray(..., appIds)` lookup in this router must go through here so
 * the bound-parameter ceiling cannot be reintroduced one query at a time.
 */

export /**
 * Run an id-keyed lookup in D1-safe batches and concatenate the rows.
 *
 * Every `inArray(..., appIds)` lookup in this router must go through here so
 * the bound-parameter ceiling cannot be reintroduced one query at a time.
 */
async function selectByCatalogAppIds<Row>(
	appIds: string[],
	select: (batch: string[]) => Promise<Row[]>,
): Promise<Row[]> {
	const rows: Row[] = [];
	for (
		let index = 0;
		index < appIds.length;
		index += CATALOG_ID_LOOKUP_BATCH_SIZE
	) {
		rows.push(
			...(await select(
				appIds.slice(index, index + CATALOG_ID_LOOKUP_BATCH_SIZE),
			)),
		);
	}
	return rows;
}

export async function listStoreListingsForCatalogApps(
	db: BaseContext["db"],
	appIds: string[],
): Promise<CatalogStoreListingSummary[]> {
	return listCatalogStoreListingsByAppIds(db, appIds);
}

export async function listBaseAppsForCatalogApps(
	db: BaseContext["db"],
	appIds: string[],
): Promise<
	(BaseAppSummary & {
		catalogAppId: string | null;
	})[]
> {
	return listBaseAppRecordsForCatalogApps(db, appIds);
}

export function getDaysSince(
	dateString: string | null | undefined,
): number | null {
	if (!dateString) return null;
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return null;
	return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

export function hasUsableLogo(
	logoUrl: string | null | undefined,
	svgLogo: string | null | undefined,
): boolean {
	if (svgLogo) return true;
	if (!logoUrl) return false;
	return !logoUrl.startsWith("connectors://");
}

export function sanitizePublicText(
	value: string | null | undefined,
): string | null {
	if (typeof value !== "string") return null;
	const normalized = value
		.replace(/\\r\\n/g, "\n")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\n")
		.replace(/\\t/g, " ")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return normalized.length > 0 ? normalized : null;
}

export function publicLogoUrl(
	logoUrl: string | null | undefined,
): string | null {
	if (!logoUrl) return null;
	const trimmed = logoUrl.trim();
	if (!/^https?:\/\//i.test(trimmed)) return null;
	if (/^data:image\//i.test(trimmed)) return null;
	if (trimmed.startsWith("connectors://")) return null;
	return trimmed;
}

export function publicCategory(
	category: string | null | undefined,
): string | null {
	return canonicalCatalogCategory(category) ?? category ?? null;
}

export function publicCategories(
	categories: string[] | null | undefined,
): string[] | null {
	const normalized =
		categories
			?.map(publicCategory)
			.filter((category): category is string => Boolean(category)) ?? [];
	return normalized.length > 0 ? Array.from(new Set(normalized)) : null;
}

export function syncLogSourceLabel(
	source: string | null | undefined,
	details: unknown,
): string | null {
	if (source) return source;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return null;
	}
	const detailRecord = details as Record<string, unknown>;
	const detailSource = detailRecord.source;
	return typeof detailSource === "string" && detailSource.trim()
		? detailSource.trim()
		: legacySyncFeedLabel(detailRecord);
}

function legacySyncFeedLabel(details: Record<string, unknown>): string | null {
	const files = details.filesProcessed;
	if (!Array.isArray(files)) return null;
	const marker = files.find(
		(file): file is string =>
			typeof file === "string" && file.endsWith("-live"),
	);
	return marker ? marker.slice(0, -5) : null;
}

export function calculateCatalogQuality(
	app: {
		name?: string | null;
		slug?: string | null;
		description?: string | null;
		category?: string | null;
		developer?: string | null;
		website?: string | null;
		logoUrl?: string | null;
		systemHints?: {
			svgLogo?: string | null;
		} | null;
		mcpToolCount?: number | null;
		connectorType?: string | null;
		healthStatus?: string | null;
		lastSyncedAt?: string | null;
		updatedAt?: string | null;
		scores?: {
			overall?: number | null;
			trust?: number | null;
			freshness?: number | null;
		} | null;
	},
	primaryListing?: PrimaryListing | null,
): CatalogQuality {
	const signals: string[] = [];
	const descriptionLength = (app.description ?? "").trim().length;
	const daysSinceSync = getDaysSince(app.lastSyncedAt ?? app.updatedAt ?? null);
	const logoUrl = app.logoUrl ?? null;
	const svgLogo = app.systemHints?.svgLogo ?? null;
	const logoStatus: CatalogQuality["logoStatus"] = svgLogo
		? "inline_svg"
		: !logoUrl
			? "missing"
			: logoUrl.startsWith("connectors://")
				? "internal_url"
				: logoUrl.includes("/app_catalog/")
					? "normalized"
					: "external_url";
	const source = primaryListing?.source ?? null;
	const sourceConfidence: CatalogQuality["sourceConfidence"] =
		source === "official" || source === "tedix"
			? "official"
			: source === "chatgpt" || source === "claude"
				? primaryListing?.sourceAppId
					? "high"
					: "medium"
				: source
					? "medium"
					: "low";
	const freshnessStatus: CatalogQuality["freshnessStatus"] =
		daysSinceSync === null
			? "unknown"
			: daysSinceSync <= 7
				? "fresh"
				: daysSinceSync <= 45
					? "aging"
					: "stale";
	let score = 0;
	if (app.name && app.slug) score += 10;
	else signals.push("Missing stable name or slug.");
	if (descriptionLength >= 120) score += 18;
	else if (descriptionLength >= 60) score += 12;
	else if (descriptionLength >= 24) score += 6;
	else signals.push("Description is thin.");
	if (app.category) score += 8;
	else signals.push("Category missing.");
	if (app.developer) score += 8;
	else signals.push("Developer missing.");
	if (app.website) score += 8;
	if (logoStatus === "normalized" || logoStatus === "inline_svg") score += 14;
	else if (logoStatus === "external_url") score += 10;
	else signals.push("Renderable logo missing.");
	if ((app.mcpToolCount ?? 0) > 0 || app.connectorType !== "MCP") score += 14;
	else signals.push("No MCP tools discovered yet.");
	if (app.healthStatus === "healthy") score += 10;
	else if (app.healthStatus === "requires_auth") score += 7;
	else if (app.healthStatus === "unknown") score += 5;
	else if (app.healthStatus) signals.push(`Health is ${app.healthStatus}.`);
	if (freshnessStatus === "fresh") score += 10;
	else if (freshnessStatus === "aging") score += 6;
	else signals.push("Catalog data is stale or unsynced.");
	const storedOverall = app.scores?.overall;
	if (typeof storedOverall === "number" && Number.isFinite(storedOverall)) {
		score = Math.round(
			score * 0.7 + Math.max(0, Math.min(100, storedOverall)) * 0.3,
		);
	}
	score = Math.max(0, Math.min(100, Math.round(score)));
	const label: CatalogQuality["label"] =
		score >= 85
			? "Excellent"
			: score >= 70
				? "Good"
				: score >= 50
					? "Fair"
					: "Thin";
	const status: CatalogQuality["status"] =
		app.healthStatus === "blocked" || app.healthStatus === "unhealthy"
			? "quarantined"
			: score < 50 || logoStatus === "missing"
				? "thin"
				: signals.some((signal) => signal.includes("missing"))
					? "needs_review"
					: "publishable";
	return {
		score,
		label,
		status,
		logoStatus,
		sourceConfidence,
		freshnessStatus,
		signals: signals.slice(0, 5),
	};
}

export function calculateDiscoverability(
	result: Awaited<ReturnType<typeof getCatalogAppBySlugWithRelations>>,
) {
	if (!result) {
		return {
			score: 0,
			label: "Low" as DiscoverabilityLabel,
			criteria: [] as DiscoverabilityCriterion[],
			tips: [] as DiscoverabilityTip[],
		};
	}
	const description = (result.description || "").trim();
	const descriptionLength = description.length;
	const promptCount = result.richContent?.examplePrompts?.length ?? 0;
	const discoveryKeywordCount = result.keywordsForDiscovery?.length ?? 0;
	const triggerKeywordCount = result.keywordsForTriggering?.length ?? 0;
	const keywordTotal = discoveryKeywordCount + triggerKeywordCount;
	const screenshotCount = result.screenshots?.length ?? 0;
	const toolCount = result.mcpToolCount ?? 0;
	const resourceCount = result.mcpResourceCount ?? 0;
	const resourceTemplateCount = result.resourceTemplates?.length ?? 0;
	const mcpPromptCount = result.mcpPromptCount ?? 0;
	const mcpInventoryCount =
		toolCount + resourceCount + resourceTemplateCount + mcpPromptCount;
	const describedTools =
		result.tools?.filter((t) => (t.description || "").trim().length >= 20)
			.length ?? 0;
	const daysSinceSync = getDaysSince(
		result.lastSyncedAt || result.updatedAt || null,
	);
	const descriptionScore =
		descriptionLength >= 140
			? 20
			: descriptionLength >= 80
				? 14
				: descriptionLength >= 30
					? 8
					: 0;
	const promptScore =
		promptCount >= 4 ? 20 : promptCount >= 2 ? 14 : promptCount >= 1 ? 8 : 0;
	const keywordScore =
		discoveryKeywordCount >= 4 && triggerKeywordCount >= 2
			? 15
			: keywordTotal >= 6
				? 12
				: keywordTotal >= 3
					? 8
					: keywordTotal >= 1
						? 4
						: 0;
	const categoryScore = result.category ? 5 : 0;
	const toolScore = (() => {
		if (result.connectorType !== "MCP") {
			let score = 8;
			if (result.hasInteractive || result.hasWrites) score += 5;
			if (result.hasFileSearch || result.hasDeepResearch || result.hasSync)
				score += 3;
			return Math.min(20, score);
		}
		const base = toolCount >= 5 ? 10 : toolCount >= 1 ? 6 : 0;
		const coverage =
			toolCount > 0 ? describedTools / Math.max(toolCount, 1) : 0;
		const quality = Math.round(coverage * 10);
		return Math.min(20, base + quality);
	})();
	const visualScore = Math.min(
		20,
		(hasUsableLogo(result.logoUrl, result.systemHints?.svgLogo) ? 8 : 0) +
			(screenshotCount >= 4
				? 12
				: screenshotCount >= 2
					? 8
					: screenshotCount >= 1
						? 5
						: 0),
	);
	const healthScore = (() => {
		switch (result.healthStatus) {
			case "healthy":
				return 10;
			case "degraded":
				return 8;
			case "requires_auth":
				return 6;
			case "blocked":
				return 4;
			case "unknown":
				return 5;
			default:
				return 2;
		}
	})();
	const freshnessScore =
		daysSinceSync === null
			? 4
			: daysSinceSync <= 7
				? 15
				: daysSinceSync <= 30
					? 11
					: daysSinceSync <= 90
						? 7
						: daysSinceSync <= 180
							? 4
							: 2;
	const criteria: DiscoverabilityCriterion[] = [
		{
			label: "Description quality",
			score: descriptionScore,
			max: 20,
		},
		{
			label: "Example prompts",
			score: promptScore,
			max: 20,
		},
		{
			label: "Keyword coverage",
			score: keywordScore,
			max: 15,
		},
		{
			label: "Category clarity",
			score: categoryScore,
			max: 5,
		},
		{
			label: "Tool metadata",
			score: toolScore,
			max: 20,
		},
		{
			label: "Visual assets",
			score: visualScore,
			max: 20,
		},
		{
			label: "Endpoint health",
			score: healthScore,
			max: 10,
		},
		{
			label: "Data freshness",
			score: freshnessScore,
			max: 15,
		},
	];
	const totalScore = criteria.reduce((sum, c) => sum + c.score, 0);
	const totalMax = criteria.reduce((sum, c) => sum + c.max, 0);
	const score = Math.round((totalScore / totalMax) * 100);
	const tips: DiscoverabilityTip[] = [];
	if (descriptionLength < 80) {
		tips.push({
			tip: "Expand the app description to 80-160 chars with clear use-cases so ranking and matching quality improve.",
			priority: descriptionLength === 0 ? "high" : "medium",
		});
	}
	if (promptCount === 0) {
		tips.push({
			tip: "Add at least 2 example prompts. Prompt examples strongly improve app matching and click-through intent.",
			priority: "high",
		});
	} else if (promptCount < 2) {
		tips.push({
			tip: "Add 1-2 more example prompts to cover different user intents.",
			priority: "medium",
		});
	}
	if (keywordTotal < 3) {
		tips.push({
			tip: "Increase keyword coverage (discovery + trigger) to improve retrieval for long-tail queries.",
			priority: keywordTotal === 0 ? "high" : "medium",
		});
	}
	if (!result.category) {
		tips.push({
			tip: "Choose a primary catalog category so visitors and AI agents can route this app into the right browse and recommendation surfaces.",
			priority: "high",
		});
	}
	if (result.connectorType === "MCP" && mcpInventoryCount === 0) {
		tips.push({
			tip:
				result.healthStatus === "healthy" || result.healthStatus === "degraded"
					? "The MCP endpoint is reachable but publishes no listable tools, resources, templates, or prompts. Add at least one public capability to improve agent usefulness."
					: "MCP capabilities are not currently discovered. Fix endpoint/auth handshake to restore tool-level discoverability.",
			priority: "high",
		});
	} else if (result.connectorType === "MCP" && toolCount > 0) {
		if (result.healthStatus === "requires_auth") {
			tips.push({
				tip: "OAuth is required for live MCP verification. Configure scan credentials if the publisher wants Tedix to validate executable tools, not just public manifest metadata.",
				priority: "medium",
			});
		}
		const coverage = describedTools / Math.max(toolCount, 1);
		if (coverage < 0.6) {
			tips.push({
				tip: "Improve MCP tool descriptions. Clear tool descriptions increase tool selection accuracy.",
				priority: "medium",
			});
		}
	}
	if (!hasUsableLogo(result.logoUrl, result.systemHints?.svgLogo)) {
		tips.push({
			tip: "Provide a stable HTTPS logo URL (avoid connectors://) so cards render consistently across clients.",
			priority: "high",
		});
	}
	if (screenshotCount < 2) {
		tips.push({
			tip: "Add at least 2 screenshots that show real workflows to increase confidence and conversion.",
			priority: screenshotCount === 0 ? "high" : "medium",
		});
	}
	if (result.healthStatus === "blocked") {
		tips.push({
			tip: "Endpoint is blocked by anti-bot/WAF from scanner infrastructure. Add allowlisting or alternate endpoint for scans.",
			priority: "high",
		});
	}
	if (result.healthStatus === "unhealthy") {
		tips.push({
			tip: "Endpoint health is failing. Resolve transport/protocol errors to recover visibility and tool extraction.",
			priority: "high",
		});
	}
	if (daysSinceSync !== null && daysSinceSync > 30) {
		tips.push({
			tip: "Metadata is stale (>30 days). Re-run the catalog sync to keep listings current and reliable.",
			priority: "medium",
		});
	}
	const priorityOrder: Record<DiscoverabilityPriority, number> = {
		high: 0,
		medium: 1,
		low: 2,
	};
	const sortedTips = tips
		.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
		.slice(0, 6);
	const label: DiscoverabilityLabel =
		score >= 85
			? "Excellent"
			: score >= 70
				? "Good"
				: score >= 50
					? "Fair"
					: "Low";
	return {
		score,
		label,
		criteria,
		tips: sortedTips,
	};
}

// =============================================================================
// PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * List catalog apps with filtering and pagination
 * GET /catalog/apps
 */
