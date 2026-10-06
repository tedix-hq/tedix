/**
 * App Tool Query Helpers
 * Database queries for dynamic MCP tool configuration management
 *
 * Tools define MCP endpoints that apps expose to AI host.
 * Used by the unified MCP engine to dynamically register tools per app.
 */

import type { ToolInvocationStatus } from "@tedix/api-contract/schemas/tools";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	withDerivedToolOperationalRiskPolicy,
} from "@tedix/api-contract/schemas/tools";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import type { AppTool, NewAppTool } from "../schema/tools";
import { appTools } from "../schema/tools";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import { prefixedColumns } from "../utils/select";

const D1_IN_LIST_CHUNK = 50;

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get all tools for an app
 * Ordered by sortOrder (ascending) for consistent display
 */
export async function getToolsByAppId(
	db: DbClient,
	appId: string,
): Promise<AppTool[]> {
	return db
		.select()
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
}

export interface ListToolsPageOptions {
	limit: number;
	offset: number;
	query?: string;
}

export interface ListToolsPageResult {
	rows: AppTool[];
	total: number;
	inventoryTotal: number;
}

function toolSearchTerms(query: string | undefined): string[] {
	return [
		...new Set(
			(query ?? "")
				.slice(0, 200)
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.toLowerCase()
				.replace(/[_\-\s]+/g, " ")
				.trim()
				.split(" ")
				.filter(Boolean),
		),
	];
}

/**
 * Read one bounded app-tool page plus exact filtered and unfiltered counts.
 *
 * Normalized all-term `instr(...)` matching keeps `%` literal instead of
 * silently making it a SQL wildcard, while spaces, snake_case, and kebab-case
 * remain mutually discoverable.
 * Count aliases are deliberately unique because this query may be composed in
 * a real D1 batch, whose object rows collapse duplicate output names.
 */
export async function listToolsPage(
	db: DbClient,
	appId: string,
	options: ListToolsPageOptions,
): Promise<ListToolsPageResult> {
	const terms = toolSearchTerms(options.query);
	const searchable = sql`lower(replace(replace(${appTools.toolId} || ' ' || ${appTools.title} || ' ' || coalesce(${appTools.description}, ''), '_', ' '), '-', ' '))`;
	const search =
		terms.length > 0
			? and(...terms.map((term) => sql`instr(${searchable}, ${term}) > 0`))
			: undefined;
	const filteredWhere = search
		? and(eq(appTools.appId, appId), search)
		: eq(appTools.appId, appId);

	const counts = await db
		.select({
			inventoryTotal: count(appTools.id),
			matchedTotal: sql<number>`sum(case when ${search ?? sql`1`} then 1 else 0 end)`,
		})
		.from(appTools)
		.where(eq(appTools.appId, appId));
	const rows = await db
		.select()
		.from(appTools)
		.where(filteredWhere)
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt))
		.limit(options.limit)
		.offset(options.offset);

	return {
		rows,
		total: Number(counts[0]?.matchedTotal ?? 0),
		inventoryTotal: Number(counts[0]?.inventoryTotal ?? 0),
	};
}

export type ToolScopePreviewResult = Pick<
	AppTool,
	| "id"
	| "appId"
	| "toolId"
	| "toolTypeId"
	| "annotations"
	| "writeCapability"
	| "authRequired"
	| "visibility"
	| "config"
	| "enabled"
>;

const scopePreviewColumns = {
	id: appTools.id,
	appId: appTools.appId,
	toolId: appTools.toolId,
	toolTypeId: appTools.toolTypeId,
	annotations: appTools.annotations,
	writeCapability: appTools.writeCapability,
	authRequired: appTools.authRequired,
	visibility: appTools.visibility,
	config: appTools.config,
	enabled: appTools.enabled,
};

/**
 * Read only the authorization fields used by MCP scope preview.
 *
 * A full app_tools row includes input/output schemas and execution config. The
 * Tedix app currently has hundreds of tools, so selecting those unused columns
 * can exceed D1's response boundary before the preview evaluates one scope.
 */
export async function listToolsForScopePreview(
	db: DbClient,
	appId: string,
): Promise<ToolScopePreviewResult[]> {
	return db
		.select(scopePreviewColumns)
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
}

/** Narrow scope-preview projection for many aggregate sources at once. */
export async function listToolsForScopePreviewByAppIds(
	db: DbClient,
	appIds: string[],
): Promise<ToolScopePreviewResult[]> {
	const rows: ToolScopePreviewResult[] = [];
	// Keep each response small even when an aggregator exposes hundreds of tools.
	for (const chunk of chunkForBoundParams(
		[...new Set(appIds.filter(Boolean))],
		10,
	)) {
		rows.push(
			...(await db
				.select(scopePreviewColumns)
				.from(appTools)
				.where(inArray(appTools.appId, chunk))
				.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt))),
		);
	}
	return rows;
}

export interface ToolInvocationLabelRow {
	toolId: string;
	invocationStatus: ToolInvocationStatus | null;
}

/**
 * The tenant's own words for each of its enabled tools.
 *
 * `invocation_status` already exists for exactly this: an `invoking` /
 * `invoked` pair a tenant authors per tool. The embedded widget reads it
 * because it must never print a callable, and a label nobody authored has no
 * safe machine-generated substitute.
 */
export async function listToolInvocationLabelsForOrganization(
	db: DbClient,
	organizationId: string,
): Promise<ToolInvocationLabelRow[]> {
	return db
		.select({
			toolId: appTools.toolId,
			invocationStatus: appTools.invocationStatus,
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(
			and(
				eq(apps.organizationId, organizationId),
				// The branding response is PUBLIC and unauthenticated. An app with
				// visibility "disabled" is documented as hidden from every MCP agent
				// (admin-only); its tool ids must not leak through a customer widget.
				ne(apps.visibility, "disabled"),
				eq(appTools.enabled, true),
				sql`${appTools.invocationStatus} IS NOT NULL`,
			),
		)
		.orderBy(asc(appTools.toolId));
}

export interface ToolConnectionReferenceRow {
	appId: string;
	connectionId: string | null;
}

/** Narrow bulk projection for connection-provider reference discovery. */
export async function listToolConnectionReferencesByAppIds(
	db: DbClient,
	appIds: string[],
): Promise<ToolConnectionReferenceRow[]> {
	const rows: ToolConnectionReferenceRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(appIds.filter(Boolean))],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select({
					appId: appTools.appId,
					connectionId: sql<
						string | null
					>`json_extract(${appTools.config}, '$.auth.connectionId')`.as(
						"connection_id",
					),
				})
				.from(appTools)
				.where(
					and(
						inArray(appTools.appId, chunk),
						sql`json_extract(${appTools.config}, '$.auth.type') = 'connection'`,
					),
				)),
		);
	}
	return rows;
}

/** Tool inventory ordered by its stable public identifier for schema sync. */
export async function listToolsForSchemaSync(
	db: DbClient,
	appId: string,
): Promise<AppTool[]> {
	return db
		.select()
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.toolId));
}

/**
 * Logical tool ids for an app, ordered by the same stable key as
 * `listToolsForSchemaSync`. This is the cheap enumeration a batched schema-mode
 * sync plans over: one text column per row instead of the whole `app_tools`
 * payload (input/output schema + config JSON is ~3 MB on the Tedix admin app,
 * which is exactly what has to stay out of a batched Worker invocation).
 */
export async function listToolIdsForSchemaSync(
	db: DbClient,
	appId: string,
): Promise<string[]> {
	const rows = await db
		.select({ toolId: appTools.toolId })
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.toolId));
	return rows.map((row) => row.toolId);
}

/**
 * Batch-scoped variant of `listToolsForSchemaSync`.
 *
 * A batched sync must not re-read every `app_tools` row per batch. The sync
 * service only ever looks an existing row up by two keys — `config.endpoint`
 * (the projected oRPC endpoint path) and `tool_id` — so scoping the read to
 * exactly those two key sets returns the same rows the unscoped read would have
 * matched, and nothing else.
 *
 * Both key lists are chunked: D1 caps bound parameters at 100 per statement and
 * each chunk also binds `app_id`.
 */
export async function listToolsForSchemaSyncScoped(
	db: DbClient,
	appId: string,
	scope: { toolIds?: string[]; endpoints?: string[] },
): Promise<AppTool[]> {
	const toolIds = [...new Set((scope.toolIds ?? []).filter(Boolean))];
	const endpoints = [...new Set((scope.endpoints ?? []).filter(Boolean))];
	if (toolIds.length === 0 && endpoints.length === 0) return [];

	const byId = new Map<string, AppTool>();

	for (const chunk of chunkForBoundParams(toolIds, D1_IN_LIST_CHUNK)) {
		const rows = await db
			.select()
			.from(appTools)
			.where(and(eq(appTools.appId, appId), inArray(appTools.toolId, chunk)))
			.orderBy(asc(appTools.toolId));
		for (const row of rows) byId.set(row.id, row);
	}

	for (const chunk of chunkForBoundParams(endpoints, D1_IN_LIST_CHUNK)) {
		const rows = await db
			.select()
			.from(appTools)
			.where(
				and(
					eq(appTools.appId, appId),
					inArray(
						sql<string>`json_extract(${appTools.config}, '$.endpoint')`,
						chunk,
					),
				),
			)
			.orderBy(asc(appTools.toolId));
		for (const row of rows) byId.set(row.id, row);
	}

	return [...byId.values()].sort((left, right) =>
		left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0,
	);
}

/**
 * Get a single tool by ID
 */
export async function getToolById(
	db: DbClient,
	toolId: string,
): Promise<AppTool | undefined> {
	return db.query.appTools.findFirst({ where: { id: toolId } });
}

/**
 * Get a tool by app ID and tool ID (the logical tool identifier, not the PK)
 */
export async function getToolByAppAndToolId(
	db: DbClient,
	appId: string,
	toolId: string,
): Promise<AppTool | undefined> {
	return db.query.appTools.findFirst({ where: { appId, toolId } });
}

/**
 * Get a tool by primary key only when its parent app belongs to the requested
 * organization. The parent join is the tenant boundary because app_tools has
 * no organization_id column of its own.
 */
export async function getToolByIdForOrganization(
	db: DbClient,
	input: { organizationId: string; toolId: string },
): Promise<AppTool | undefined> {
	const [row] = await db
		.select(prefixedColumns(appTools, "tool"))
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(
			and(
				eq(apps.organizationId, input.organizationId),
				eq(appTools.id, input.toolId),
			),
		)
		.limit(1);
	return row;
}

/** Org-scoped logical tool lookup under a specific parent app. */
export async function getToolByAppAndToolIdForOrganization(
	db: DbClient,
	input: { organizationId: string; appId: string; toolId: string },
): Promise<AppTool | undefined> {
	const [row] = await db
		.select(prefixedColumns(appTools, "tool"))
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(
			and(
				eq(apps.organizationId, input.organizationId),
				eq(appTools.appId, input.appId),
				eq(appTools.toolId, input.toolId),
			),
		)
		.limit(1);
	return row;
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Upsert a tool
 * Creates a new tool or updates existing by ID or by app+toolId unique constraint
 *
 * @param db - Database client
 * @param tool - Tool data (with or without ID)
 */
/**
 * Validate that tool configs don't contain plaintext secrets.
 * All API keys and tokens MUST be managed via Descope Token Vault (auth.type: "connection").
 * Rejects auth.type: "header" with a value that looks like a secret.
 */
function validateNoPlaintextSecrets(config: unknown): void {
	if (!config || typeof config !== "object") return;
	const c = config as Record<string, unknown>;
	const auth = c.auth as Record<string, unknown> | undefined;
	if (!auth) return;
	if (
		auth.type === "header" &&
		typeof auth.value === "string" &&
		auth.value.length > 0
	) {
		throw new Error(
			"Plaintext API keys in tool config are not allowed. " +
				"Use auth.type: 'connection' with a Descope Token Vault connectionId instead. " +
				"See: https://docs.descope.com/agentic-identity-hub/connections",
		);
	}
}

export async function upsertTool(
	db: DbClient,
	tool: Omit<NewAppTool, "id" | "layout" | "inputSchema"> & {
		id?: string;
		inputSchema?: NewAppTool["inputSchema"] | null;
	},
): Promise<AppTool> {
	// Enforce: no plaintext secrets in tool configs
	validateNoPlaintextSecrets(tool.config);

	const normalizedTool = {
		...tool,
		inputSchema: tool.inputSchema ?? EMPTY_TOOL_INPUT_SCHEMA,
		meta: withDerivedToolOperationalRiskPolicy({
			meta: tool.meta,
			config: tool.config,
			writeCapability: tool.writeCapability,
		}),
	};

	const now = new Date().toISOString();

	// First check if tool exists by ID
	if (normalizedTool.id) {
		const existingById = await getToolById(db, normalizedTool.id);
		if (existingById) {
			// Update existing tool by ID
			await db
				.update(appTools)
				.set({
					...normalizedTool,
					updatedAt: now,
				})
				.where(eq(appTools.id, normalizedTool.id));

			const updated = await getToolById(db, normalizedTool.id);
			if (!updated) {
				throw new Error(`Failed to update tool: ${normalizedTool.id}`);
			}
			return updated;
		}
	}

	// Check if tool exists by app + toolId unique constraint
	const existingByToolId = await getToolByAppAndToolId(
		db,
		normalizedTool.appId,
		normalizedTool.toolId,
	);

	if (existingByToolId) {
		// Update existing tool by unique constraint
		await db
			.update(appTools)
			.set({
				...normalizedTool,
				id: existingByToolId.id, // Keep existing ID
				updatedAt: now,
			})
			.where(eq(appTools.id, existingByToolId.id));

		const updated = await getToolById(db, existingByToolId.id);
		if (!updated) {
			throw new Error(`Failed to update tool: ${existingByToolId.id}`);
		}
		return updated;
	}

	// Create new tool
	const id = normalizedTool.id || crypto.randomUUID();

	await db.insert(appTools).values({
		...normalizedTool,
		id,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getToolById(db, id);
	if (!created) {
		throw new Error(`Failed to create tool: ${id}`);
	}
	return created;
}

/**
 * Delete a tool by ID
 *
 * @param db - Database client
 * @param toolId - Tool primary key ID to delete
 */
export async function deleteTool(db: DbClient, toolId: string): Promise<void> {
	await db.delete(appTools).where(eq(appTools.id, toolId));
}

export async function updateToolSchemaProjection(
	db: DbClient,
	input: {
		toolId: string;
		patch: Partial<AppTool>;
		config?: AppTool["config"];
		schemaSourceHash: string;
		now: string;
	},
): Promise<void> {
	await db
		.update(appTools)
		.set({
			...input.patch,
			...(input.config === undefined ? {} : { config: input.config }),
			schemaDialect: "json-schema-2020-12",
			schemaSource: "orpc",
			schemaSourceHash: input.schemaSourceHash,
			schemaSyncedAt: input.now,
			updatedAt: input.now,
		})
		.where(eq(appTools.id, input.toolId));
}

/**
 * Toggle tool enabled status
 *
 * @param db - Database client
 * @param toolId - Tool primary key ID
 * @param enabled - New enabled status
 */
export async function toggleToolEnabled(
	db: DbClient,
	toolId: string,
	enabled: boolean,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(appTools)
		.set({
			enabled,
			updatedAt: now,
		})
		.where(eq(appTools.id, toolId));
}

/**
 * Bulk update tool sort orders
 * Useful for reordering tools via drag-and-drop UI
 *
 * @param db - Database client
 * @param updates - Array of { toolId, sortOrder } pairs
 */
export async function bulkUpdateToolSortOrders(
	db: DbClient,
	updates: Array<{ toolId: string; sortOrder: number }>,
): Promise<void> {
	if (updates.length === 0) return;

	const now = new Date().toISOString();
	const queries = updates.map(({ toolId, sortOrder }) =>
		db
			.update(appTools)
			.set({ sortOrder, updatedAt: now })
			.where(eq(appTools.id, toolId)),
	);
	await db.batch(batchNonEmpty(queries));
}
