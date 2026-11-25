/**
 * App Tool Query Helpers
 * Database queries for dynamic MCP tool configuration management
 *
 * Tools define MCP endpoints that apps expose to AI host.
 * Used by the unified MCP engine to dynamically register tools per app.
 */

import { toolClassDeclarationGap } from "@tedix/api-contract/utils/tool-declared-class";
import type {
	ToolInvocationStatus,
	ToolMeta,
} from "@tedix/api-contract/schemas/tools";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	withDerivedToolOperationalRiskPolicy,
} from "@tedix/api-contract/schemas/tools";
import { and, asc, count, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import {
	inferOutputSchema,
	mergeOutputSchemas,
	INFERRED_SCHEMA_PROVENANCE,
} from "@tedix/api-contract/utils/output-schema-inference";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { apps as schemaApps } from "../schema/apps";
import type { AppTool, NewAppTool } from "../schema/tools";
import { appTools as schemaAppTools } from "../schema/tools";
import { batchNonEmpty } from "../utils/batch";
import {
	anyIds,
	coreStore,
	booleanValue,
	containsText,
	jsonRead,
	jsonType,
} from "../core-store/dialect";
import { prefixedColumns } from "../utils/select";

// ============================================================================
// Read Operations
// ============================================================================

/** Tenant-owned source tools that declare an action class; this is not an authorization decision. */
export async function listDeclaredActionToolsForOrganization(
	db: DbClient,
	organizationId: string,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			appId: sql<string>`${apps.id}`.as("inventory_app_id"),
			appName: apps.name,
			appSlug: apps.slug,
			toolRowId: sql<string>`${appTools.id}`.as("inventory_tool_row_id"),
			toolId: appTools.toolId,
			title: appTools.title,
			actionType: appTools.actionType,
			enabled: appTools.enabled,
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(
			and(
				eq(apps.organizationId, organizationId),
				isNotNull(appTools.actionType),
			),
		)
		.orderBy(asc(apps.slug), asc(appTools.toolId))
		.limit(501);
}

/** Resolve an exact tool name within the resource's tenant and connection route.
 * Two matches are enough to refuse an ambiguous name without loading an inventory.
 */
export async function findWorkspaceConnectionTool(
	db: DbClient,
	input: {
		organizationId: string;
		toolName: string;
		providerId: string;
		connectionInstanceId: string;
		connectionScope: "user" | "tenant";
	},
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const rows = await db
		.select({ appId: appTools.appId, toolId: appTools.toolId })
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(
			and(
				eq(apps.organizationId, input.organizationId),
				eq(appTools.toolId, input.toolName),
				sql`${jsonRead(db, apps.metadata, ["mcpConfig", "connectionProviderId"])} = ${input.providerId}`,
				sql`${jsonRead(db, apps.metadata, ["mcpConfig", "connectionInstanceId"])} = ${input.connectionInstanceId}`,
				sql`${jsonRead(db, apps.metadata, ["mcpConfig", "connectionScope"])} = ${input.connectionScope}`,
			),
		)
		.limit(2);
	return rows.length === 1 ? rows[0] : undefined;
}

/** Composer opt-in is stored in config; discovery grants no execution authority. */
export async function listComposerToolsForOrganization(
	db: DbClient,
	organizationId: string,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			appSlug: apps.slug,
			toolId: appTools.toolId,
			title: appTools.title,
			description: appTools.description,
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(
			and(
				eq(apps.organizationId, organizationId),
				ne(apps.visibility, "disabled"),
				eq(appTools.enabled, true),
				ne(appTools.visibility, "private"),
				sql`${jsonType(db, appTools.config, ["composer"])} = 'boolean'`,
				sql`${jsonRead(db, appTools.config, ["composer"], "boolean")} = ${booleanValue(db, true)}`,
			),
		)
		.orderBy(asc(apps.slug), asc(appTools.toolId));
}

/** One tenant-scoped statement, including disabled tools required by skills. */
export async function listSetupToolsForOrganization(
	db: DbClient,
	organizationId: string,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			id: appTools.id,
			appId: appTools.appId,
			toolId: appTools.toolId,
			title: appTools.title,
			enabled: appTools.enabled,
			config: appTools.config,
		})
		.from(appTools)
		.innerJoin(apps, eq(apps.id, appTools.appId))
		.where(eq(apps.organizationId, organizationId))
		.orderBy(asc(appTools.id));
}

/**
 * Get all tools for an app
 * Ordered by sortOrder (ascending) for consistent display
 */
export async function getToolsByAppId(
	db: DbClient,
	appId: string,
): Promise<AppTool[]> {
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select()
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
}

export async function listPendingToolReviewsForApp(
	db: DbClient,
	appId: string,
) {
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			rowId: appTools.id,
			toolId: appTools.toolId,
			// A held change is reviewed by the hash of its new definition.
			schemaSourceHash: sql<
				string | null
			>`coalesce(${jsonRead(db, appTools.reviewPending, ["schemaSourceHash"])}, ${appTools.schemaSourceHash})`,
			diff: appTools.reviewDiff,
			reviewBatchId: appTools.reviewBatchId,
		})
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, appId),
				eq(appTools.reviewState, "pending"),
				isNotNull(appTools.schemaSourceHash),
				isNotNull(appTools.reviewDiff),
				isNotNull(appTools.reviewBatchId),
			),
		)
		.orderBy(asc(appTools.toolId));
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
	const appTools = coreTable(db, schemaAppTools);
	const terms = toolSearchTerms(options.query);
	const searchable = sql`lower(replace(replace(${appTools.toolId} || ' ' || ${appTools.title} || ' ' || coalesce(${appTools.description}, ''), '_', ' '), '-', ' '))`;
	const search =
		terms.length > 0
			? and(...terms.map((term) => containsText(db, searchable, term)))
			: undefined;
	const filteredWhere = search
		? and(eq(appTools.appId, appId), search)
		: eq(appTools.appId, appId);

	const counts = await db
		.select({
			inventoryTotal: count(appTools.id),
			matchedTotal: sql<number>`sum(case when ${search ?? sql`true`} then 1 else 0 end)`,
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

function scopePreviewColumns(db: DbClient) {
	const appTools = coreTable(db, schemaAppTools);
	return {
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
}

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
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select(scopePreviewColumns(db))
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
}

/** Narrow scope-preview projection for many aggregate sources at once. */
export async function listToolsForScopePreviewByAppIds(
	db: DbClient,
	appIds: string[],
): Promise<ToolScopePreviewResult[]> {
	const appTools = coreTable(db, schemaAppTools);
	const ids = [...new Set(appIds.filter(Boolean))];
	if (!ids.length) return [];
	return db
		.select(scopePreviewColumns(db))
		.from(appTools)
		.where(anyIds(db, appTools.appId, ids))
		.orderBy(asc(appTools.sortOrder), asc(appTools.createdAt));
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
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
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

export interface ConnectionToolPolicyRow {
	appId: string;
	toolId: string;
	title: string;
	meta: ToolMeta | null;
	authType: string | null;
	connectionId: string | null;
}

/** Narrow bulk projection for connection-provider references and capability copy. */
export async function listConnectionToolPoliciesByAppIds(
	db: DbClient,
	appIds: string[],
): Promise<ConnectionToolPolicyRow[]> {
	const appTools = coreTable(db, schemaAppTools);
	const ids = [...new Set(appIds.filter(Boolean))];
	if (!ids.length) return [];
	return db
		.select({
			appId: appTools.appId,
			toolId: appTools.toolId,
			title: appTools.title,
			meta: appTools.meta,
			authType: sql<
				string | null
			>`${jsonRead(db, appTools.config, ["auth", "type"])}`.as("auth_type"),
			connectionId: sql<
				string | null
			>`${jsonRead(db, appTools.config, ["auth", "connectionId"])}`.as(
				"connection_id",
			),
		})
		.from(appTools)
		.where(and(anyIds(db, appTools.appId, ids), eq(appTools.enabled, true)));
}

/** Tool inventory ordered by its stable public identifier for schema sync. */
export async function listToolsForSchemaSync(
	db: DbClient,
	appId: string,
): Promise<AppTool[]> {
	const appTools = coreTable(db, schemaAppTools);
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
	const appTools = coreTable(db, schemaAppTools);
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
 * Both key lists bind one set each, avoiding parameter limits and read fan-outs.
 */
export async function listToolsForSchemaSyncScoped(
	db: DbClient,
	appId: string,
	scope: { toolIds?: string[]; endpoints?: string[] },
): Promise<AppTool[]> {
	const appTools = coreTable(db, schemaAppTools);
	const toolIds = [...new Set((scope.toolIds ?? []).filter(Boolean))];
	const endpoints = [...new Set((scope.endpoints ?? []).filter(Boolean))];
	if (toolIds.length === 0 && endpoints.length === 0) return [];

	return db
		.select()
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, appId),
				or(
					anyIds(db, appTools.toolId, toolIds),
					anyIds(db, jsonRead(db, appTools.config, ["endpoint"]), endpoints),
				),
			),
		)
		.orderBy(asc(appTools.toolId));
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
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
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
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
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
	const appTools = coreTable(db, schemaAppTools);
	// Enforce: no plaintext secrets in tool configs
	validateNoPlaintextSecrets(tool.config);

	const existingById = tool.id ? await getToolById(db, tool.id) : undefined;
	const existing =
		existingById ?? (await getToolByAppAndToolId(db, tool.appId, tool.toolId));
	const classified = {
		...tool,
		writeCapability:
			tool.writeCapability === undefined
				? existing?.writeCapability
				: tool.writeCapability,
		meta: tool.meta === undefined ? existing?.meta : tool.meta,
	};
	const gap = toolClassDeclarationGap(classified);
	if (gap) throw new Error(`Tool ${tool.toolId} ${gap}.`);

	const normalizedTool = {
		...classified,
		// Only the contract projection vouches for a contract hash. Any other
		// writer changes the row in ways the hash does not describe, so clearing
		// it makes the next projection revisit this row.
		contractHash: tool.contractHash ?? null,
		inputSchema: tool.inputSchema ?? EMPTY_TOOL_INPUT_SCHEMA,
		meta: withDerivedToolOperationalRiskPolicy({
			meta: classified.meta,
			config: tool.config,
			writeCapability: classified.writeCapability,
		}),
	};

	const now = new Date().toISOString();

	if (existing) {
		await db
			.update(appTools)
			.set({ ...normalizedTool, id: existing.id, updatedAt: now })
			.where(eq(appTools.id, existing.id));
		const updated = await getToolById(db, existing.id);
		if (!updated) throw new Error(`Failed to update tool: ${existing.id}`);
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
	const appTools = coreTable(db, schemaAppTools);
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
	const appTools = coreTable(db, schemaAppTools);
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
 * Provenance-only refresh for rows whose regenerated schema and config matched
 * what is stored. Nothing the sync owns changed, so `updated_at` stays put —
 * only the sync bookkeeping moves:
 *
 * - `touchIds`: provenance columns already match; only `schema_synced_at`
 *   advances, in one set-based `UPDATE`.
 * - `certify`: provenance columns drifted (hash, ref, dialect, source); each
 *   row is re-certified in place with its own hash.
 *
 * Everything lands in a single `db.batch()` round trip.
 */
export async function refreshToolSchemaProvenance(
	db: DbClient,
	input: {
		touchIds: string[];
		certify: Array<{
			id: string;
			schemaSourceRef: string;
			schemaSourceHash: string;
		}>;
		now: string;
	},
): Promise<void> {
	const appTools = coreTable(db, schemaAppTools);
	const touchIds = [...new Set(input.touchIds)];
	const queries = [
		...(touchIds.length
			? [
					db
						.update(appTools)
						.set({ schemaSyncedAt: input.now })
						.where(anyIds(db, appTools.id, touchIds)),
				]
			: []),
		...input.certify.map((row) =>
			db
				.update(appTools)
				.set({
					schemaDialect: "json-schema-2020-12",
					schemaSource: "orpc",
					schemaSourceRef: row.schemaSourceRef,
					schemaSourceHash: row.schemaSourceHash,
					schemaSyncedAt: input.now,
				})
				.where(eq(appTools.id, row.id)),
		),
	];
	if (queries.length === 0) return;
	await db.batch(batchNonEmpty(queries));
}

export interface ToolContractHashResult {
	toolId: string;
	transport: string | null;
	endpoint: string | null;
	contractHash: string | null;
}

/**
 * The lookup keys and stored contract hash of every row on an app, without the
 * schema/config JSON. This is what an incremental projection plan compares the
 * deployed contract against, so it reads only the two keys the projection
 * matches rows by (`config.endpoint` for rpc rows, and `tool_id`).
 */
export async function listToolContractHashesForSchemaSync(
	db: DbClient,
	appId: string,
): Promise<ToolContractHashResult[]> {
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			toolId: appTools.toolId,
			transport: sql<
				string | null
			>`${jsonRead(db, appTools.config, ["transport"])}`,
			endpoint: sql<
				string | null
			>`${jsonRead(db, appTools.config, ["endpoint"])}`,
			contractHash: appTools.contractHash,
		})
		.from(appTools)
		.where(eq(appTools.appId, appId))
		.orderBy(asc(appTools.toolId));
}

/**
 * Record the contract hash on rows the projection found already in sync.
 * Nothing user-visible changed, so `updated_at` stays put. One `db.batch()`
 * round trip.
 */
export async function recordToolContractHashes(
	db: DbClient,
	rows: Array<{ id: string; contractHash: string }>,
): Promise<void> {
	const appTools = coreTable(db, schemaAppTools);
	if (rows.length === 0) return;
	await db.batch(
		batchNonEmpty(
			rows.map((row) =>
				db
					.update(appTools)
					.set({ contractHash: row.contractHash })
					.where(eq(appTools.id, row.id)),
			),
		),
	);
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
	const appTools = coreTable(db, schemaAppTools);
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
	const appTools = coreTable(db, schemaAppTools);
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

/** Public catalog samples must never be inferred for sensitive installed rows. */
export async function inferCatalogToolOutputSchemas(
	db: DbClient,
	catalogAppId: string,
	toolName: string,
	sample: () => unknown,
): Promise<number> {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const rows = await db
		.select({ id: appTools.id, outputSchema: appTools.outputSchema })
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(
			and(
				eq(apps.catalogAppId, catalogAppId),
				eq(appTools.toolId, toolName),
				eq(appTools.sensitiveData, false),
				sql`${jsonRead(db, appTools.config, ["transport"])} = 'mcp'`,
				sql`${jsonRead(db, appTools.config, ["mcpServerId"])} = ${catalogAppId}`,
				sql`${jsonRead(db, appTools.config, ["mcpToolName"])} = ${toolName}`,
				sql`(${appTools.outputSchema} IS NULL OR ${jsonRead(db, appTools.outputSchema, ["x-tedix-provenance"])} = 'inferred')`,
			),
		);
	if (!rows.length) return 0;
	const inferred = inferOutputSchema(sample());
	const now = new Date().toISOString();
	const updates = rows.map((row) => {
		const previous = row.outputSchema
			? Object.fromEntries(
					Object.entries(row.outputSchema).filter(
						([key]) => key !== INFERRED_SCHEMA_PROVENANCE,
					),
				)
			: undefined;
		const schema = {
			...mergeOutputSchemas(previous, inferred),
			[INFERRED_SCHEMA_PROVENANCE]: "inferred",
		};
		return { id: row.id, previous: row.outputSchema, schema };
	});
	const payload = JSON.stringify(updates);
	const candidates =
		coreStore(db) === "postgres"
			? sql`SELECT id, previous, schema FROM jsonb_to_recordset(${payload}::jsonb) AS candidate(id text, previous jsonb, schema jsonb)`
			: sql`SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.previous') AS previous, json_extract(value, '$.schema') AS schema FROM json_each(${payload})`;
	// One set-based write; the previous schema and sensitivity are checked again
	// under the write lock, so an intervening declaration cannot be overwritten.
	const unchanged =
		coreStore(db) === "postgres"
			? sql`${appTools.outputSchema} IS NOT DISTINCT FROM candidate.previous`
			: sql`${appTools.outputSchema} IS candidate.previous`;
	const changed = await db.all<{
		id: string;
	}>(sql`WITH candidate AS (${candidates})
		UPDATE ${appTools} SET output_schema = (SELECT schema FROM candidate WHERE candidate.id = ${appTools.id}), updated_at = ${now}
		WHERE ${appTools.sensitiveData} = ${booleanValue(db, false)} AND ${appTools.id} IN (
			SELECT candidate.id FROM candidate WHERE ${unchanged}
		) RETURNING id`);
	return changed.length;
}
