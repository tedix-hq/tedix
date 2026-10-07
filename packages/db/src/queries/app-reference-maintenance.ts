/**
 * Cross-organization reads and compare-and-set writes for app reference repair
 * (aggregate-entry app ids, app slug renames, connection-provider relinks).
 *
 * Reads project only the JSON subtrees the repair inspects, so a scan never
 * hydrates whole metadata blobs. Every write is a compare-and-set against the
 * value the plan was computed from: a stale value evaluates `json('…')` on a
 * non-JSON literal, which raises inside the D1 batch and rolls the whole batch
 * back (the precedent is `provider-executions.ts`). An applied plan is
 * therefore exactly the returned plan, or nothing.
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { appTools } from "../schema/tools";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";

/** IN() lists stay well under D1's 100 bound-parameter ceiling. */
const IN_LIST_CHUNK = 50;

export const AGGREGATE_APPS_PATH = "$.mcpConfig.aggregateApps";
export const INACTIVE_AGGREGATE_APPS_PATH = "$.mcpConfig.inactiveAggregateApps";
export const GUIDANCE_SKILL_APPS_PATH = "$.mcpConfig.guidanceSkillApps";
export const CONNECTION_PROVIDER_ID_PATH = "$.mcpConfig.connectionProviderId";
export const OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH =
	"$.mcpConfig.openApiSync.connectionProviderId";

export type AppReferenceMetadataPath =
	| typeof AGGREGATE_APPS_PATH
	| typeof INACTIVE_AGGREGATE_APPS_PATH
	| typeof GUIDANCE_SKILL_APPS_PATH
	| typeof CONNECTION_PROVIDER_ID_PATH
	| typeof OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH;

/** `json_extract` guarded so a malformed metadata row reads as NULL. */
function metadataAt(path: AppReferenceMetadataPath): SQL {
	return sql`CASE WHEN json_valid(${apps.metadata}) THEN json_extract(${apps.metadata}, ${path}) END`;
}

/**
 * One app's reference-bearing metadata subtrees, as the raw text
 * `json_extract` returns (JSON text for arrays, the bare value for strings).
 * The raw text is also the compare-and-set token for writes.
 */
export type AppReferenceScanRow = {
	id: string;
	organizationId: string;
	slug: string;
	aggregateAppsJson: string | null;
	inactiveAggregateAppsJson: string | null;
	guidanceSkillAppsJson: string | null;
	connectionProviderId: string | null;
	openApiSyncConnectionProviderId: string | null;
};

const scanColumns = {
	id: apps.id,
	organizationId: apps.organizationId,
	slug: apps.slug,
	aggregateAppsJson: sql<string | null>`${metadataAt(AGGREGATE_APPS_PATH)}`.as(
		"aggregate_apps_json",
	),
	inactiveAggregateAppsJson: sql<
		string | null
	>`${metadataAt(INACTIVE_AGGREGATE_APPS_PATH)}`.as(
		"inactive_aggregate_apps_json",
	),
	guidanceSkillAppsJson: sql<
		string | null
	>`${metadataAt(GUIDANCE_SKILL_APPS_PATH)}`.as("guidance_skill_apps_json"),
	connectionProviderId: sql<
		string | null
	>`${metadataAt(CONNECTION_PROVIDER_ID_PATH)}`.as("connection_provider_id"),
	openApiSyncConnectionProviderId: sql<
		string | null
	>`${metadataAt(OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH)}`.as(
		"openapi_sync_connection_provider_id",
	),
};

/** True when any active or inactive aggregate entry satisfies `predicate`. */
function anyAggregateEntry(predicate: SQL): SQL {
	return sql`(EXISTS (SELECT 1 FROM json_each(coalesce(${metadataAt(AGGREGATE_APPS_PATH)}, '[]')) WHERE json_type(value) = 'object' AND ${predicate})
		OR EXISTS (SELECT 1 FROM json_each(coalesce(${metadataAt(INACTIVE_AGGREGATE_APPS_PATH)}, '[]')) WHERE json_type(value) = 'object' AND ${predicate}))`;
}

function aggregateArraysPresent(): SQL {
	return sql`(json_type(coalesce(${metadataAt(AGGREGATE_APPS_PATH)}, 'null')) = 'array' OR json_type(coalesce(${metadataAt(INACTIVE_AGGREGATE_APPS_PATH)}, 'null')) = 'array')`;
}

/** Apps holding at least one aggregate entry without an `appId`. */
export async function listAppsWithAggregateEntriesMissingAppId(
	db: DbClient,
	options: { organizationId?: string } = {},
): Promise<AppReferenceScanRow[]> {
	return db
		.select(scanColumns)
		.from(apps)
		.where(
			and(
				options.organizationId
					? eq(apps.organizationId, options.organizationId)
					: undefined,
				aggregateArraysPresent(),
				anyAggregateEntry(
					sql`coalesce(json_extract(value, '$.appId'), '') = ''`,
				),
			),
		)
		.orderBy(apps.id);
}

/** Apps (any organization) whose aggregate entries name `appId` or `slug`. */
export async function listAppsLinkingToApp(
	db: DbClient,
	target: { appId: string; slug: string },
): Promise<AppReferenceScanRow[]> {
	return db
		.select(scanColumns)
		.from(apps)
		.where(
			and(
				aggregateArraysPresent(),
				anyAggregateEntry(
					sql`(json_extract(value, '$.appId') = ${target.appId} OR json_extract(value, '$.slug') = ${target.slug})`,
				),
			),
		)
		.orderBy(apps.id);
}

/** Apps whose mcpConfig or aggregate entries reference `providerId`. */
export async function listAppsReferencingConnectionProvider(
	db: DbClient,
	providerId: string,
	options: { organizationId?: string } = {},
): Promise<AppReferenceScanRow[]> {
	return db
		.select(scanColumns)
		.from(apps)
		.where(
			and(
				options.organizationId
					? eq(apps.organizationId, options.organizationId)
					: undefined,
				sql`(${metadataAt(CONNECTION_PROVIDER_ID_PATH)} = ${providerId}
					OR ${metadataAt(OPENAPI_SYNC_CONNECTION_PROVIDER_ID_PATH)} = ${providerId}
					OR ${anyAggregateEntry(sql`json_extract(value, '$.connectionProviderId') = ${providerId}`)})`,
			),
		)
		.orderBy(apps.id);
}

export type AppSlugCandidate = {
	id: string;
	organizationId: string;
	slug: string;
};

/**
 * Every app carrying each slug, matched exactly as the MCP gateway's aggregate
 * resolution matches it (`getAppsBySlugsWithTools` / `getAppBySlugWithTools`
 * in `app-records.ts`: a global `apps.slug = ?`, no organization scope, no
 * case folding). More than one candidate means the gateway's pick is
 * unspecified.
 */
export async function listAppSlugCandidates(
	db: DbClient,
	slugs: string[],
): Promise<Map<string, AppSlugCandidate[]>> {
	const bySlug = new Map<string, AppSlugCandidate[]>();
	const unique = [...new Set(slugs.filter(Boolean))];
	for (const chunk of chunkForBoundParams(unique, IN_LIST_CHUNK)) {
		const rows = await db
			.select({
				id: apps.id,
				organizationId: apps.organizationId,
				slug: apps.slug,
			})
			.from(apps)
			.where(inArray(apps.slug, chunk))
			.orderBy(apps.id);
		for (const row of rows) {
			const list = bySlug.get(row.slug) ?? [];
			list.push(row);
			bySlug.set(row.slug, list);
		}
	}
	return bySlug;
}

export async function getAppSlugIdentity(
	db: DbClient,
	appId: string,
): Promise<AppSlugCandidate | null> {
	const rows = await db
		.select({
			id: apps.id,
			organizationId: apps.organizationId,
			slug: apps.slug,
		})
		.from(apps)
		.where(eq(apps.id, appId))
		.limit(1);
	return rows[0] ?? null;
}

export type CatalogScanConnectionRow = {
	id: string;
	slug: string | null;
	scanOrganizationId: string | null;
	scanConnectionId: string | null;
};

/** Catalog rows whose scanner borrows `providerId`. */
export async function listCatalogAppsByScanConnection(
	db: DbClient,
	providerId: string,
	options: { organizationId?: string } = {},
): Promise<CatalogScanConnectionRow[]> {
	return db
		.select({
			id: appCatalog.id,
			slug: appCatalog.slug,
			scanOrganizationId: appCatalog.scanOrganizationId,
			scanConnectionId: appCatalog.scanConnectionId,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.scanConnectionId, providerId),
				options.organizationId
					? eq(appCatalog.scanOrganizationId, options.organizationId)
					: undefined,
			),
		)
		.orderBy(appCatalog.id);
}

export type AppToolConnectionRow = {
	id: string;
	appId: string;
	organizationId: string;
	toolId: string;
	connectionId: string | null;
};

const toolConnectionId = sql<
	string | null
>`CASE WHEN json_valid(${appTools.config}) THEN json_extract(${appTools.config}, '$.auth.connectionId') END`;

/** Connection-auth tool rows (`config.auth.connectionId`) bound to `providerId`. */
export async function listAppToolsByConnectionProvider(
	db: DbClient,
	providerId: string,
	options: { organizationId?: string } = {},
): Promise<AppToolConnectionRow[]> {
	return db
		.select({
			id: appTools.id,
			appId: appTools.appId,
			organizationId: apps.organizationId,
			toolId: appTools.toolId,
			connectionId: toolConnectionId.as("connection_id"),
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(
			and(
				sql`${toolConnectionId} = ${providerId}`,
				options.organizationId
					? eq(apps.organizationId, options.organizationId)
					: undefined,
			),
		)
		.orderBy(appTools.id);
}

/**
 * One compare-and-set write. `before` is the exact value the plan read (raw
 * `json_extract` text for metadata paths); a row that no longer holds it
 * aborts the batch.
 */
export type AppReferenceWrite =
	| {
			kind: "app_metadata";
			appId: string;
			path: AppReferenceMetadataPath;
			before: string | null;
			/** JSON text (arrays) or a plain string value. */
			after: string;
			afterIsJson: boolean;
	  }
	| { kind: "app_slug"; appId: string; before: string; after: string }
	| {
			kind: "catalog_scan_connection";
			catalogAppId: string;
			before: string;
			after: string;
	  }
	| {
			kind: "app_tool_connection";
			toolRowId: string;
			before: string;
			after: string;
	  };

const STALE = sql`json('stale_reference_plan')`;

function buildAppReferenceWriteStatement(
	db: DbClient,
	write: AppReferenceWrite,
	now: string,
) {
	switch (write.kind) {
		case "app_metadata": {
			const current = sql`json_extract(${apps.metadata}, ${write.path})`;
			const next = write.afterIsJson
				? sql`json_set(${apps.metadata}, ${write.path}, json(${write.after}))`
				: sql`json_set(${apps.metadata}, ${write.path}, ${write.after})`;
			return db
				.update(apps)
				.set({
					metadata: sql`CASE WHEN json_valid(${apps.metadata}) AND ${current} IS ${write.before} THEN ${next} ELSE ${STALE} END`,
					updatedAt: now,
				})
				.where(eq(apps.id, write.appId));
		}
		case "app_slug":
			// Global slug uniqueness is re-checked at write time: a concurrent
			// claim of the new slug aborts the batch instead of duplicating it.
			return db
				.update(apps)
				.set({
					slug: sql`CASE WHEN ${apps.slug} = ${write.before} AND NOT EXISTS (SELECT 1 FROM apps AS taken WHERE taken.slug = ${write.after}) THEN ${write.after} ELSE ${STALE} END`,
					updatedAt: now,
				})
				.where(eq(apps.id, write.appId));
		case "catalog_scan_connection":
			return db
				.update(appCatalog)
				.set({
					scanConnectionId: sql`CASE WHEN ${appCatalog.scanConnectionId} = ${write.before} THEN ${write.after} ELSE ${STALE} END`,
					updatedAt: now,
				})
				.where(eq(appCatalog.id, write.catalogAppId));
		case "app_tool_connection":
			return db
				.update(appTools)
				.set({
					config: sql`CASE WHEN json_valid(${appTools.config}) AND json_extract(${appTools.config}, '$.auth.connectionId') = ${write.before} THEN json_set(${appTools.config}, '$.auth.connectionId', ${write.after}) ELSE ${STALE} END`,
					updatedAt: now,
				})
				.where(eq(appTools.id, write.toolRowId));
	}
}

/**
 * Most writes one apply may carry. Every apply is a single D1 batch (one
 * transaction), and each statement counts toward the per-invocation query
 * budget; a larger plan must be narrowed (for example by organization).
 */
export const MAX_APP_REFERENCE_WRITES = 500;

/**
 * Apply compare-and-set writes in ONE D1 batch: either every write lands or,
 * if any row no longer holds its planned `before`, none does.
 */
export async function applyAppReferenceWrites(
	db: DbClient,
	writes: AppReferenceWrite[],
): Promise<{ written: number }> {
	if (writes.length === 0) return { written: 0 };
	if (writes.length > MAX_APP_REFERENCE_WRITES) {
		throw new Error(
			`Refusing to apply ${writes.length} reference writes in one batch (max ${MAX_APP_REFERENCE_WRITES})`,
		);
	}
	const now = new Date().toISOString();
	await db.batch(
		batchNonEmpty(
			writes.map((write) => buildAppReferenceWriteStatement(db, write, now)),
		),
	);
	return { written: writes.length };
}
