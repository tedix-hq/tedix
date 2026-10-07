/**
 * Core app record and hydrated-surface queries.
 *
 * Kept separate from the compatibility query barrel so an app lookup does not
 * evaluate every unrelated DB query module in a fresh Worker isolate.
 */

import type { AppCapabilities } from "@tedix/api-contract/schemas/app";
import type { WidgetConfig } from "@tedix/api-contract/schemas/widget";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { AppMetadata, NewApp } from "../schema/apps";
import { apps } from "../schema/apps";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
} from "../schema/catalog";
import { appToolCspDomains } from "../schema/configuration";
import { appTools } from "../schema/tools";
import { withTransientD1ReadRetry } from "../utils/d1-retry";
import { aggregateAppEntryMatchesSql } from "./aggregate-app-links";

type ToolSelectionOptions = {
	endpointPrefixes?: string[];
	toolIds?: string[];
};

type CatalogMcpSurface = {
	catalogMcp: {
		id: string;
		slug: string | null;
		mcpEndpointNormalized: string | null;
		baseUrl: string | null;
		scanConnectionId: string | null;
		scanConnectionHeader: string | null;
		scanConnectionTemplate: string | null;
	} | null;
	catalogResources: Array<typeof appCatalogMcpResources.$inferSelect>;
	catalogResourceTemplates: Array<
		typeof appCatalogMcpResourceTemplates.$inferSelect
	>;
	catalogPrompts: Array<typeof appCatalogMcpPrompts.$inferSelect>;
};

function emptyCatalogMcpSurface(): CatalogMcpSurface {
	return {
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
	};
}

async function getCatalogMcpSurfaceForApp(
	db: DbClient,
	catalogAppId: string | null,
): Promise<CatalogMcpSurface> {
	if (!catalogAppId) return emptyCatalogMcpSurface();

	const [
		catalogRows,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
	] = await Promise.all([
		db
			.select({
				id: appCatalog.id,
				slug: appCatalog.slug,
				mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
				baseUrl: appCatalog.baseUrl,
				scanConnectionId: appCatalog.scanConnectionId,
				scanConnectionHeader: appCatalog.scanConnectionHeader,
				scanConnectionTemplate: appCatalog.scanConnectionTemplate,
			})
			.from(appCatalog)
			.where(eq(appCatalog.id, catalogAppId))
			.limit(1),
		db
			.select()
			.from(appCatalogMcpResources)
			.where(
				and(
					eq(appCatalogMcpResources.catalogAppId, catalogAppId),
					isNull(appCatalogMcpResources.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpResources.uri)),
		db
			.select()
			.from(appCatalogMcpResourceTemplates)
			.where(
				and(
					eq(appCatalogMcpResourceTemplates.catalogAppId, catalogAppId),
					isNull(appCatalogMcpResourceTemplates.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpResourceTemplates.name)),
		db
			.select()
			.from(appCatalogMcpPrompts)
			.where(
				and(
					eq(appCatalogMcpPrompts.catalogAppId, catalogAppId),
					isNull(appCatalogMcpPrompts.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpPrompts.promptName)),
	]);

	return {
		catalogMcp: catalogRows[0] ?? null,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
	};
}

/**
 * Batched {@link getCatalogMcpSurfaceForApp}. Four statements per chunk of
 * catalog ids instead of four per app — the single-app version issued 4×N
 * queries for an N-app aggregate rebuild.
 *
 * Ordering within a catalog app is unchanged: rows come back ordered by
 * (catalog id, natural key), and grouping by catalog id restricts that to the
 * same relative order the per-app query produced.
 */
async function getCatalogMcpSurfacesForApps(
	db: DbClient,
	catalogAppIds: string[],
): Promise<Map<string, CatalogMcpSurface>> {
	const out = new Map<string, CatalogMcpSurface>();
	const unique = [...new Set(catalogAppIds.filter(Boolean))];
	for (const id of unique) out.set(id, emptyCatalogMcpSurface());
	if (unique.length === 0) return out;

	for (const chunk of chunked(unique, APP_SURFACE_ID_CHUNK)) {
		const [
			catalogRows,
			catalogResources,
			catalogResourceTemplates,
			catalogPrompts,
		] = await Promise.all([
			db
				.select({
					id: appCatalog.id,
					slug: appCatalog.slug,
					mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
					baseUrl: appCatalog.baseUrl,
					scanConnectionId: appCatalog.scanConnectionId,
					scanConnectionHeader: appCatalog.scanConnectionHeader,
					scanConnectionTemplate: appCatalog.scanConnectionTemplate,
				})
				.from(appCatalog)
				.where(inArray(appCatalog.id, chunk)),
			db
				.select()
				.from(appCatalogMcpResources)
				.where(
					and(
						inArray(appCatalogMcpResources.catalogAppId, chunk),
						isNull(appCatalogMcpResources.removedAt),
					),
				)
				.orderBy(
					asc(appCatalogMcpResources.catalogAppId),
					asc(appCatalogMcpResources.uri),
				),
			db
				.select()
				.from(appCatalogMcpResourceTemplates)
				.where(
					and(
						inArray(appCatalogMcpResourceTemplates.catalogAppId, chunk),
						isNull(appCatalogMcpResourceTemplates.removedAt),
					),
				)
				.orderBy(
					asc(appCatalogMcpResourceTemplates.catalogAppId),
					asc(appCatalogMcpResourceTemplates.name),
				),
			db
				.select()
				.from(appCatalogMcpPrompts)
				.where(
					and(
						inArray(appCatalogMcpPrompts.catalogAppId, chunk),
						isNull(appCatalogMcpPrompts.removedAt),
					),
				)
				.orderBy(
					asc(appCatalogMcpPrompts.catalogAppId),
					asc(appCatalogMcpPrompts.promptName),
				),
		]);

		for (const row of catalogRows) {
			const surface = out.get(row.id);
			if (surface) surface.catalogMcp = row;
		}
		for (const row of catalogResources) {
			out.get(row.catalogAppId)?.catalogResources.push(row);
		}
		for (const row of catalogResourceTemplates) {
			out.get(row.catalogAppId)?.catalogResourceTemplates.push(row);
		}
		for (const row of catalogPrompts) {
			out.get(row.catalogAppId)?.catalogPrompts.push(row);
		}
	}
	return out;
}

function buildToolSelectionConditions(options?: ToolSelectionOptions) {
	const conditions = [eq(appTools.enabled, true)];
	const toolIds = options?.toolIds?.filter(Boolean) ?? [];
	const endpointPrefixes = options?.endpointPrefixes?.filter(Boolean) ?? [];

	if (toolIds.length > 0) {
		conditions.push(inArray(appTools.toolId, toolIds));
	}

	if (endpointPrefixes.length > 0) {
		const endpointConditions = endpointPrefixes.flatMap((prefix) => [
			sql`json_extract(${appTools.config}, '$.endpoint') = ${prefix}`,
			sql`json_extract(${appTools.config}, '$.endpoint') LIKE ${`${prefix}/%`}`,
		]);
		conditions.push(or(...endpointConditions)!);
	}

	return conditions;
}

const APP_TOOL_SELECTION_PARAM_BUDGET = 95;

function compareAppToolOrder(
	a: typeof appTools.$inferSelect,
	b: typeof appTools.$inferSelect,
): number {
	const sortA = a.sortOrder ?? Number.NEGATIVE_INFINITY;
	const sortB = b.sortOrder ?? Number.NEGATIVE_INFINITY;
	if (sortA !== sortB) return sortA - sortB;
	return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}

function chunkToolSelection(
	options?: ToolSelectionOptions,
): ToolSelectionOptions[] {
	const toolIds = [...new Set(options?.toolIds?.filter(Boolean) ?? [])];
	const endpointPrefixes = options?.endpointPrefixes?.filter(Boolean) ?? [];
	if (toolIds.length === 0) return [{ endpointPrefixes }];

	// Each statement also binds enabled, at least one app id, and two values per
	// endpoint prefix. Chunk the caller-controlled IN list itself; shrinking only
	// the app-id chunk cannot make an oversized tool-id selection valid on D1.
	const chunkSize = Math.max(
		1,
		APP_TOOL_SELECTION_PARAM_BUDGET - 2 - endpointPrefixes.length * 2,
	);
	return chunked(toolIds, chunkSize).map((chunk) => ({
		toolIds: chunk,
		endpointPrefixes,
	}));
}

// ============================================================================
// App Queries
// ============================================================================

/**
 * Get app by ID
 */
export async function getAppById(db: DbClient, id: string) {
	return db.query.apps.findFirst({ where: { id } });
}

/**
 * Get an app only when it belongs to the requested organization.
 *
 * Tenant-facing callers should prefer this over fetching by id and checking
 * ownership afterward: the organization predicate stays in the D1 statement,
 * so a foreign row never crosses the query boundary.
 */
export async function getAppByIdForOrganization(
	db: DbClient,
	id: string,
	organizationId: string,
) {
	return db.query.apps.findFirst({ where: { id, organizationId } });
}

/**
 * Get an organization-owned app by ID with enabled tools (and tool type
 * metadata). The app ownership predicate is evaluated before any child rows
 * are loaded.
 */
export async function getAppByIdWithToolsForOrganization(
	db: DbClient,
	id: string,
	organizationId: string,
) {
	const appRows = await db
		.select()
		.from(apps)
		.where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)))
		.limit(1);
	const app = appRows[0];
	if (!app) return null;

	const tools = await db
		.select()
		.from(appTools)
		.where(and(eq(appTools.appId, id), eq(appTools.enabled, true)))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));

	const toolIds = tools.map((t) => t.id);
	const toolCsp: Array<typeof appToolCspDomains.$inferSelect> = [];
	if (toolIds.length > 0) {
		const BATCH_SIZE = 50;
		for (let i = 0; i < toolIds.length; i += BATCH_SIZE) {
			const batch = toolIds.slice(i, i + BATCH_SIZE);
			const results = await db
				.select()
				.from(appToolCspDomains)
				.where(inArray(appToolCspDomains.appToolId, batch));
			toolCsp.push(...results);
		}
	}
	const toolCspByToolId = new Map<string, typeof toolCsp>();
	for (const domain of toolCsp) {
		const list = toolCspByToolId.get(domain.appToolId) ?? [];
		list.push(domain);
		toolCspByToolId.set(domain.appToolId, list);
	}

	const toolsWithCsp = tools.map((tool) => {
		const cspDomains = toolCspByToolId.get(tool.id) ?? [];
		return {
			...tool,
			toolCspDomains: cspDomains.map((domain) => ({
				toolId: tool.toolId,
				domainType: domain.domainType,
				domainUrl: domain.domainUrl,
				active: domain.active ?? true,
			})),
		};
	});

	const catalogSurface = await getCatalogMcpSurfaceForApp(db, app.catalogAppId);

	return { app, tools: toolsWithCsp, ...catalogSurface };
}

/**
 * Get app by slug
 */
export async function getAppBySlug(db: DbClient, slug: string) {
	return db.query.apps.findFirst({ where: { slug } });
}

/**
 * Collapse CONCURRENT identical app-surface reads onto one in-flight promise.
 *
 * This is a memory fix, not a latency one. `getAppBySlugWithTools` hydrates every
 * enabled tool for an app, and an aggregate gateway app is not small: hundreds
 * of tools and hundreds of KiB of raw input_schema, which becomes many times
 * that as parsed objects plus DTOs plus the serialized oRPC
 * response. One such request is affordable; several at once in the same isolate
 * are not.
 *
 * They do arrive at once, and an `exceededMemory` kill restarts the isolate, so
 * the next request pays a cold start and the MCP gateway's `resolve_app` times
 * out with a 503.
 *
 * Deliberately NOT a cache: there is no TTL and nothing is retained past
 * settlement, so this cannot serve a stale tool surface. It only guarantees that
 * callers who ask for the identical surface *while a read is already running*
 * share that read instead of duplicating it. Rejections are shared too, and the
 * entry is always cleared, so a failure never pins a bad promise.
 */
const appSurfaceInFlight = new Map<string, Promise<unknown>>();

function appSurfaceKey(slug: string, options?: ToolSelectionOptions): string {
	// Sorted so two callers asking for the same set in a different order share.
	const toolIds = [...(options?.toolIds ?? [])].sort().join(",");
	const prefixes = [...(options?.endpointPrefixes ?? [])].sort().join(",");
	return `${slug}\0${toolIds}\0${prefixes}`;
}

/**
 * Get app by slug with enabled tools (and tool type metadata)
 * Used by MCP to load tools quickly in one pass.
 */
export async function getAppBySlugWithTools(
	db: DbClient,
	slug: string,
	options?: ToolSelectionOptions,
) {
	const key = appSurfaceKey(slug, options);
	const inFlight = appSurfaceInFlight.get(key);
	if (inFlight) {
		return inFlight as ReturnType<typeof loadAppBySlugWithTools>;
	}
	const pending = loadAppBySlugWithTools(db, slug, options).finally(() => {
		appSurfaceInFlight.delete(key);
	});
	appSurfaceInFlight.set(key, pending);
	return pending;
}

function loadAppBySlugWithTools(
	db: DbClient,
	slug: string,
	options?: ToolSelectionOptions,
) {
	return withTransientD1ReadRetry(`app ${slug} with tools`, async () => {
		const appRows = await db
			.select()
			.from(apps)
			.where(eq(apps.slug, slug))
			.limit(1);
		const app = appRows[0];
		if (!app) return null;

		const toolsById = new Map<string, typeof appTools.$inferSelect>();
		for (const selection of chunkToolSelection(options)) {
			const rows = await db
				.select()
				.from(appTools)
				.where(
					and(
						eq(appTools.appId, app.id),
						...buildToolSelectionConditions(selection),
					),
				)
				.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
			for (const row of rows) toolsById.set(row.id, row);
		}
		const tools = [...toolsById.values()].sort(compareAppToolOrder);

		const toolIds = tools.map((t) => t.id);
		const toolCsp: Array<typeof appToolCspDomains.$inferSelect> = [];
		if (toolIds.length > 0) {
			const BATCH_SIZE = 50;
			for (let i = 0; i < toolIds.length; i += BATCH_SIZE) {
				const batch = toolIds.slice(i, i + BATCH_SIZE);
				const results = await db
					.select()
					.from(appToolCspDomains)
					.where(inArray(appToolCspDomains.appToolId, batch));
				toolCsp.push(...results);
			}
		}
		const toolCspByToolId = new Map<string, typeof toolCsp>();
		for (const domain of toolCsp) {
			const list = toolCspByToolId.get(domain.appToolId) ?? [];
			list.push(domain);
			toolCspByToolId.set(domain.appToolId, list);
		}

		const toolsWithCsp = tools.map((tool) => {
			const cspDomains = toolCspByToolId.get(tool.id) ?? [];
			return {
				...tool,
				toolCspDomains: cspDomains.map((domain) => ({
					toolId: tool.toolId,
					domainType: domain.domainType,
					domainUrl: domain.domainUrl,
					active: domain.active ?? true,
				})),
			};
		});

		const catalogSurface = await getCatalogMcpSurfaceForApp(
			db,
			app.catalogAppId,
		);

		return { app, tools: toolsWithCsp, ...catalogSurface };
	});
}

export type AppSurfaceRequest = { slug: string } & ToolSelectionOptions;

/** Result element of {@link getAppsBySlugsWithTools}; `null` = slug not found. */
export type AppSurfaceResult = Awaited<
	ReturnType<typeof loadAppBySlugWithTools>
>;

/**
 * D1 caps bound parameters at 100 per statement. Every chunked `inArray` below
 * stays at 50 ids so the remaining conditions (enabled, tool-id allowlists,
 * endpoint-prefix LIKEs) cannot push a statement past the cap.
 */
const APP_SURFACE_ID_CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

/**
 * Batched {@link getAppBySlugWithTools} — one apps/api invocation for MANY apps.
 *
 * The MCP aggregate rebuild resolves ~40 apps and was issuing one
 * `apps.getBySlugWithTools` per app. Each apps/api invocation pays a cold-isolate
 * startup cost, so that fan-out pushed entries past the per-entry deadline and
 * degraded the surface.
 *
 * The results array is POSITIONALLY parallel to `requests`: index i is the
 * surface for `requests[i]`, and `null` means that slug does not exist. A caller
 * can therefore always tell "this app has no tools" (`tools: []`) from "this app
 * was never resolved" (absent / null) without a second lookup. Duplicate slugs
 * with different tool selections are legal and each gets its own entry.
 *
 * Per-app ordering is preserved exactly: `app_tools` is globally ordered by the
 * same (sort_order, created_at) keys and then grouped by app, which restricts to
 * the same relative order the single-app query produced. Same for the catalog
 * surfaces, which order by (catalog id, natural key).
 */
export async function getAppsBySlugsWithTools(
	db: DbClient,
	requests: AppSurfaceRequest[],
): Promise<AppSurfaceResult[]> {
	if (requests.length === 0) return [];

	return withTransientD1ReadRetry(
		`${requests.length} app surface(s) with tools`,
		async () => {
			// ── apps ──────────────────────────────────────────────────────────────
			const slugs = [...new Set(requests.map((r) => r.slug))];
			const appRows: Array<typeof apps.$inferSelect> = [];
			for (const chunk of chunked(slugs, APP_SURFACE_ID_CHUNK)) {
				appRows.push(
					...(await db.select().from(apps).where(inArray(apps.slug, chunk))),
				);
			}
			const appBySlug = new Map(appRows.map((app) => [app.slug, app]));

			// ── tools, grouped by identical tool selection ────────────────────────
			// Requests overwhelmingly share the empty selection, so this is normally
			// a single statement per 50 apps.
			const selectionGroups = new Map<
				string,
				{ options: ToolSelectionOptions; appIds: string[] }
			>();
			for (const request of requests) {
				const app = appBySlug.get(request.slug);
				if (!app) continue;
				const options: ToolSelectionOptions = {
					toolIds: request.toolIds,
					endpointPrefixes: request.endpointPrefixes,
				};
				const signature = appSurfaceKey("", options);
				const group = selectionGroups.get(signature) ?? { options, appIds: [] };
				if (!group.appIds.includes(app.id)) group.appIds.push(app.id);
				selectionGroups.set(signature, group);
			}

			const toolsBySelection = new Map<
				string,
				Map<string, Array<typeof appTools.$inferSelect>>
			>();
			const allToolRows: Array<typeof appTools.$inferSelect> = [];
			for (const [signature, group] of selectionGroups) {
				const byApp = new Map<string, Array<typeof appTools.$inferSelect>>();
				for (const appId of group.appIds) byApp.set(appId, []);
				const seen = new Set<string>();
				for (const selection of chunkToolSelection(group.options)) {
					const conditions = buildToolSelectionConditions(selection);
					const reserved =
						(selection.toolIds?.length ?? 0) +
						(selection.endpointPrefixes?.length ?? 0) * 2 +
						1;
					const appChunkSize = Math.max(
						1,
						Math.min(
							APP_SURFACE_ID_CHUNK,
							APP_TOOL_SELECTION_PARAM_BUDGET - reserved,
						),
					);
					for (const appChunk of chunked(group.appIds, appChunkSize)) {
						const rows = await db
							.select()
							.from(appTools)
							.where(and(inArray(appTools.appId, appChunk), ...conditions))
							.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
						for (const row of rows) {
							if (seen.has(row.id)) continue;
							seen.add(row.id);
							byApp.get(row.appId)?.push(row);
							allToolRows.push(row);
						}
					}
				}
				for (const rows of byApp.values()) rows.sort(compareAppToolOrder);
				toolsBySelection.set(signature, byApp);
			}

			// ── CSP domains for every tool row in one sweep ───────────────────────
			const toolCspByToolId = new Map<
				string,
				Array<typeof appToolCspDomains.$inferSelect>
			>();
			const toolRowIds = [...new Set(allToolRows.map((tool) => tool.id))];
			for (const chunk of chunked(toolRowIds, APP_SURFACE_ID_CHUNK)) {
				const rows = await db
					.select()
					.from(appToolCspDomains)
					.where(inArray(appToolCspDomains.appToolId, chunk));
				for (const row of rows) {
					const list = toolCspByToolId.get(row.appToolId) ?? [];
					list.push(row);
					toolCspByToolId.set(row.appToolId, list);
				}
			}

			// ── catalog surfaces, batched by catalog app id ───────────────────────
			const catalogAppIds = [
				...new Set(
					appRows
						.map((app) => app.catalogAppId)
						.filter((id): id is string => Boolean(id)),
				),
			];
			const catalogSurfaces = await getCatalogMcpSurfacesForApps(
				db,
				catalogAppIds,
			);

			return requests.map((request) => {
				const app = appBySlug.get(request.slug);
				if (!app) return null;
				const signature = appSurfaceKey("", {
					toolIds: request.toolIds,
					endpointPrefixes: request.endpointPrefixes,
				});
				const tools = toolsBySelection.get(signature)?.get(app.id) ?? [];
				const toolsWithCsp = tools.map((tool) => ({
					...tool,
					toolCspDomains: (toolCspByToolId.get(tool.id) ?? []).map(
						(domain) => ({
							toolId: tool.toolId,
							domainType: domain.domainType,
							domainUrl: domain.domainUrl,
							active: domain.active ?? true,
						}),
					),
				}));
				return {
					app,
					tools: toolsWithCsp,
					...(catalogSurfaces.get(app.catalogAppId ?? "") ??
						emptyCatalogMcpSurface()),
				};
			});
		},
	);
}

/**
 * Get app by domain
 * Checks both primaryDomain (e.g., "tedix.dev") and customMcpDomain (e.g., "mcp.tedix.dev")
 * Custom MCP domains allow apps to use their own TLD for AI app submissions
 */
export async function getAppByDomain(db: DbClient, domain: string) {
	const rows = await db
		.select()
		.from(apps)
		.where(or(eq(apps.primaryDomain, domain), eq(apps.customMcpDomain, domain)))
		.limit(1);
	return rows[0] ?? undefined;
}

/**
 * List all apps with pagination
 */
export async function listApps(
	db: DbClient,
	opts?: { limit?: number; offset?: number },
) {
	return db
		.select()
		.from(apps)
		.orderBy(desc(apps.createdAt))
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);
}

/**
 * List apps by visibility
 * Used by TedixMcpAgent to get public apps for cross-app search
 */
/**
 * Create a new app
 */
export async function createApp(
	db: DbClient,
	data: Omit<NewApp, "id" | "createdAt" | "updatedAt">,
) {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(apps).values({
		...data,
		id,
		createdAt: now,
		updatedAt: now,
	});

	return getAppById(db, id);
}

export async function createAppWithId(db: DbClient, data: NewApp) {
	await db.insert(apps).values(data);
	return getAppById(db, data.id);
}

/**
 * Update an app
 */
export async function updateApp(
	db: DbClient,
	id: string,
	data: Partial<Omit<NewApp, "id" | "createdAt">>,
) {
	const now = new Date().toISOString();

	await db
		.update(apps)
		.set({
			...data,
			updatedAt: now,
		})
		.where(eq(apps.id, id));

	return getAppById(db, id);
}

/**
 * Upsert an app (create or update if exists by domain)
 * This handles race conditions when multiple sources try to create the same app
 *
 * Delete an app
 * @returns true if deletion was successful (no error thrown)
 */
/**
 * Delete an app and, in the same batch, remove every `aggregateApps` /
 * `inactiveAggregateApps` entry that links to it from the other apps of its
 * organization (by id, or by slug for entries written before ids were stored).
 * Links from other organizations are left alone.
 */
export async function deleteApp(db: DbClient, id: string): Promise<boolean> {
	const [target] = await db
		.select({
			id: apps.id,
			organizationId: apps.organizationId,
			slug: apps.slug,
		})
		.from(apps)
		.where(eq(apps.id, id))
		.limit(1);
	const remove = db.delete(apps).where(eq(apps.id, id));
	if (!target) {
		await remove;
		return true;
	}
	const matches = aggregateAppEntryMatchesSql({
		appId: target.id,
		slug: target.slug,
	});
	const now = new Date().toISOString();
	const scrub = (path: string) =>
		db
			.update(apps)
			.set({
				metadata: sql`json_set(${apps.metadata}, ${path}, json((select coalesce(json_group_array(json(value)), json('[]')) from json_each(${apps.metadata}, ${path}) where not ${matches})))`,
				updatedAt: now,
			})
			.where(
				and(
					eq(apps.organizationId, target.organizationId),
					sql`${apps.id} != ${target.id}`,
					sql`json_type(${apps.metadata}, ${path}) = 'array'`,
					sql`exists (select 1 from json_each(${apps.metadata}, ${path}) where ${matches})`,
				),
			);
	await db.batch([
		scrub("$.mcpConfig.aggregateApps"),
		scrub("$.mcpConfig.inactiveAggregateApps"),
		remove,
	]);
	return true;
}

/**
 * Parse app metadata from JSON
 */
function coerceOptionalBoolean(value: unknown): boolean | undefined {
	if (value === 0) return false;
	if (value === 1) return true;
	if (typeof value === "boolean") return value;
	return undefined;
}

function normalizeAppMetadataBooleans(metadata: AppMetadata): AppMetadata {
	const capabilities = metadata.capabilities;
	if (capabilities) {
		const checkoutEnabled = coerceOptionalBoolean(
			capabilities.checkout?.enabled,
		);
		if (checkoutEnabled !== undefined && capabilities.checkout) {
			capabilities.checkout.enabled = checkoutEnabled;
		}
		const nativePayments = coerceOptionalBoolean(
			capabilities.checkout?.nativePayments,
		);
		if (nativePayments !== undefined && capabilities.checkout) {
			capabilities.checkout.nativePayments = nativePayments;
		}
		const cartEnabled = coerceOptionalBoolean(capabilities.cart?.enabled);
		if (cartEnabled !== undefined && capabilities.cart) {
			capabilities.cart.enabled = cartEnabled;
		}
		const persistCart = coerceOptionalBoolean(capabilities.cart?.persistCart);
		if (persistCart !== undefined && capabilities.cart) {
			capabilities.cart.persistCart = persistCart;
		}
		const wishlistEnabled = coerceOptionalBoolean(
			capabilities.wishlist?.enabled,
		);
		if (wishlistEnabled !== undefined && capabilities.wishlist) {
			capabilities.wishlist.enabled = wishlistEnabled;
		}
		const compareEnabled = coerceOptionalBoolean(capabilities.compare?.enabled);
		if (compareEnabled !== undefined && capabilities.compare) {
			capabilities.compare.enabled = compareEnabled;
		}
		const mapEnabled = coerceOptionalBoolean(capabilities.map?.enabled);
		if (mapEnabled !== undefined && capabilities.map) {
			capabilities.map.enabled = mapEnabled;
		}
		const externalCtaEnabled = coerceOptionalBoolean(
			capabilities.externalCta?.enabled,
		);
		if (externalCtaEnabled !== undefined && capabilities.externalCta) {
			capabilities.externalCta.enabled = externalCtaEnabled;
		}
		const externalOpenInNewTab = coerceOptionalBoolean(
			capabilities.externalCta?.openInNewTab,
		);
		if (externalOpenInNewTab !== undefined && capabilities.externalCta) {
			capabilities.externalCta.openInNewTab = externalOpenInNewTab;
		}
	}

	const blogEnabled = coerceOptionalBoolean(metadata.blogConfig?.enabled);
	if (blogEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.enabled = blogEnabled;
	}
	const sitemapEnabled = coerceOptionalBoolean(
		metadata.blogConfig?.sitemapEnabled,
	);
	if (sitemapEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.sitemapEnabled = sitemapEnabled;
	}
	const rssEnabled = coerceOptionalBoolean(metadata.blogConfig?.rssEnabled);
	if (rssEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.rssEnabled = rssEnabled;
	}
	const imageGenEnabled = coerceOptionalBoolean(
		metadata.blogConfig?.imageGeneration?.enabled,
	);
	if (imageGenEnabled !== undefined && metadata.blogConfig?.imageGeneration) {
		metadata.blogConfig.imageGeneration.enabled = imageGenEnabled;
	}

	const generateAnswers = coerceOptionalBoolean(
		metadata.contentConfig?.generateAnswers,
	);
	if (generateAnswers !== undefined && metadata.contentConfig) {
		metadata.contentConfig.generateAnswers = generateAnswers;
	}

	return metadata;
}

export function getAppMetadataJson(app: {
	metadata?: unknown;
}): AppMetadata | null {
	if (!app.metadata) return null;

	try {
		// Drizzle mode: "json" auto-deserializes; handle legacy string case defensively
		const metadata =
			typeof app.metadata === "string"
				? (JSON.parse(app.metadata) as AppMetadata)
				: (app.metadata as AppMetadata);
		if (!metadata) return null;
		return normalizeAppMetadataBooleans(metadata);
	} catch {
		return null;
	}
}

/**
 * Get app capabilities from metadata
 */
export async function getAppCapabilities(
	db: DbClient,
	appId: string,
): Promise<AppCapabilities | null> {
	const app = await getAppById(db, appId);
	if (!app) return null;

	const metadata = getAppMetadataJson(app);
	return metadata?.capabilities || null;
}

/**
 * Get widget config from app metadata
 */
export async function getWidgetConfig(
	db: DbClient,
	appId: string,
): Promise<WidgetConfig | null> {
	const app = await getAppById(db, appId);
	if (!app?.metadata) return null;

	const metadata = getAppMetadataJson(app);
	return metadata?.widgetConfig || null;
}

/**
 * Update app metadata (partial merge)
 */
export async function updateAppMetadata(
	db: DbClient,
	appId: string,
	metadata: Partial<AppMetadata>,
) {
	const app = await getAppById(db, appId);
	if (!app) throw new Error(`App not found: ${appId}`);

	const existingMetadata = getAppMetadataJson(app) || {};
	const mergedMetadata = {
		...existingMetadata,
		...metadata,
	};

	return updateApp(db, appId, {
		metadata: mergedMetadata as AppMetadata,
	});
}

/**
 * Update widget config in app metadata
 */
export async function updateWidgetConfig(
	db: DbClient,
	appId: string,
	config: Partial<WidgetConfig>,
) {
	const existing = await getWidgetConfig(db, appId);
	const merged = { ...existing, ...config } as WidgetConfig;

	return updateAppMetadata(db, appId, { widgetConfig: merged });
}

/**
 * Atomically change only one gateway member; preserve all other metadata.
 *
 * Entries are matched by app id (slug for entries written before ids were
 * stored). Enabling stamps the member's current `{ appId, slug }` onto its
 * entry, so a renamed app stays linked and old slug-only entries gain an id.
 */
export async function setAppGatewayMembership(
	db: DbClient,
	organizationId: string,
	gatewayId: string,
	member: { appId: string; slug: string },
	enabled: boolean,
) {
	const { appId, slug } = member;
	const matches = aggregateAppEntryMatchesSql(member);
	const members = sql`coalesce(json_extract(${apps.metadata}, '$.mcpConfig.aggregateApps'), json('[]'))`;
	const inactive = sql`coalesce(json_extract(${apps.metadata}, '$.mcpConfig.inactiveAggregateApps'), json('[]'))`;
	const stamp = sql`json_set(json(value), '$.appId', ${appId}, '$.slug', ${slug})`;
	const activeMatches = sql`(select coalesce(json_group_array(json(value)), json('[]')) from json_each(${members}) where ${matches})`;
	const savedMatches = sql`(select coalesce(json_group_array(${stamp}), json('[]')) from json_each(${inactive}) where ${matches})`;
	const stampedMembers = sql`(select coalesce(json_group_array(case when ${matches} then ${stamp} else json(value) end), json('[]')) from json_each(${members}))`;
	const filtered = sql`(select coalesce(json_group_array(json(value)), json('[]')) from json_each(${members}) where not ${matches})`;
	const inactiveFiltered = sql`(select coalesce(json_group_array(json(value)), json('[]')) from json_each(${inactive}) where not ${matches})`;
	const restored = sql`case when json_array_length(${savedMatches}) > 0 then ${savedMatches} else json_array(json_object('appId', ${appId}, 'slug', ${slug})) end`;
	const next = enabled
		? sql`case when json_array_length(${activeMatches}) > 0 then ${stampedMembers} else (select json_group_array(json(value)) from (select value from json_each(${members}) union all select value from json_each(${restored}))) end`
		: filtered;
	const nextInactive = enabled
		? inactiveFiltered
		: sql`case when json_array_length(${activeMatches}) = 0 then ${inactive} else (select json_group_array(json(value)) from (select value from json_each(${inactiveFiltered}) union all select value from json_each(${activeMatches}))) end`;
	return db
		.update(apps)
		.set({
			metadata: sql`json_set(coalesce(${apps.metadata}, '{}'), '$.mcpConfig.aggregateApps', json(${next}), '$.mcpConfig.inactiveAggregateApps', json(${nextInactive}))`,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(apps.id, gatewayId), eq(apps.organizationId, organizationId)))
		.returning({ id: apps.id });
}
