/**
 * App Tools Schema
 * Dynamic MCP tool configurations for apps
 *
 * This enables the unified MCP engine where apps can configure
 * MCP tools dynamically via D1 database instead of hardcoding them.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	ToolAnnotations,
	ToolExecutionTaskSupport,
	ToolIcon,
	ToolInputJsonSchema,
	ToolInvocationStatus,
	ToolJsonSchema,
	ToolSchemaDialect,
	ToolSchemaSource,
	ToolWriteCapability,
} from "@tedix/api-contract/schemas/tools";

import {
	TOOL_EXECUTION_TASK_SUPPORT_VALUES,
	TOOL_SCHEMA_DIALECT_VALUES,
	TOOL_SCHEMA_SOURCE_VALUES,
	TOOL_WRITE_CAPABILITY_VALUES,
} from "@tedix/api-contract/schemas/tools";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

export const TOOL_REVIEW_STATE_VALUES = ["live", "pending"] as const;
export type ToolReviewState = (typeof TOOL_REVIEW_STATE_VALUES)[number];

export interface ToolReviewSnapshot {
	description: string | null;
	inputSchema: ToolInputJsonSchema;
	outputSchema: ToolJsonSchema | null;
	schemaSourceHash: string | null;
}

export interface ToolReviewDiff {
	source: "upstream_mcp" | "openapi";
	before: ToolReviewSnapshot | null;
	after: ToolReviewSnapshot;
}

/**
 * The upstream definition an owner has not approved yet, held beside the
 * approved one that stays live. Approval copies these fields onto the row.
 */
export interface ToolReviewPendingDefinition {
	toolTypeId: string;
	config: Record<string, JsonValue>;
	inputSchema: ToolInputJsonSchema;
	outputSchema: ToolJsonSchema | null;
	title: string | null;
	description: string | null;
	icons: JsonValue;
	executionTaskSupport: string | null;
	annotations: JsonValue;
	writeCapability: string | null;
	meta: JsonValue;
	schemaDialect: string;
	schemaSource: string;
	schemaSourceRef: string | null;
	schemaSourceHash: string | null;
	schemaSyncedAt: string;
}

/**
 * App Tools table
 * Stores MCP tool configurations per app for the unified MCP engine.
 *
 * Each tool defines:
 * - Input/output schema (MCP JSON Schema)
 * - Adapter routing (which data sources to query)
 * - Result strategy (how to combine results from multiple adapters)
 * - Widget output (template and route for rendering)
 */
export const appTools = sqliteTable(
	"app_tools",
	{
		id: text("id").primaryKey(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		// Tool type identifier - determines which handler executes this tool
		// e.g., "rpc" for ToolHandler
		toolTypeId: text("tool_type_id").notNull(),

		// Tool identity
		toolId: text("tool_id").notNull(), // "search_listings", "get_crypto_prices"
		title: text("title").notNull(),
		description: text("description"),

		// Input schema (MCP JSON Schema root object for named tool arguments)
		inputSchema: text("input_schema", {
			mode: "json",
		})
			.$type<ToolInputJsonSchema>()
			.notNull()
			.default(
				sql`'{"type":"object","properties":{},"additionalProperties":false}'`,
			),

		// Output schema (optional MCP JSON Schema for structuredContent)
		// The root may be object, array, scalar, or a composed JSON Schema.
		// x-tedix-provenance="inferred" marks advisory shapes sampled by tool tests.
		outputSchema: text("output_schema", {
			mode: "json",
		}).$type<ToolJsonSchema>(),

		// Adapter Configuration
		// Determines which data adapters this tool queries
		// - "all": Query all adapters registered for the app
		// - "primary": Query only the app's primary adapter
		// - JSON array: Query specific adapter IDs ["klarna", "shopify"]
		adapterScope: text("adapter_scope").default("primary"),

		// Result Strategy
		// How to combine results from multiple adapters
		// - "parallel_all": Execute all adapters in parallel, return all results
		// - "first_success": Execute in order, return first successful result
		// - "merge": Execute all, merge and deduplicate results
		resultStrategy: text("result_strategy", {
			enum: ["parallel_all", "first_success", "merge"],
		}).default("merge"),

		// Widget Output Configuration
		// MCP resource URI for the output template
		// Example: "ui://widgets/apps-sdk/{appSlug}/comparison.html"
		outputTemplate: text("output_template"),

		// Widget route path (for SSR rendering)
		// Example: "/:app/search-listings"
		widgetRoute: text("widget_route"),

		// Widget registry key (drives config-driven routing)
		// Example: "searchListings"
		widgetKey: text("widget_key"),

		// Whether the widget is accessible via URL (1 = true, 0 = false)
		widgetAccessible: integer("widget_accessible", { mode: "boolean" }).default(
			true,
		),

		// Auth enforcement: tools with auth_required=true reject unauthenticated calls
		authRequired: integer("auth_required", { mode: "boolean" }).default(false),

		// Apps SDK / MCP metadata (config-driven)
		visibility: text("visibility").default("public"),
		/** MCP tool icons. Auto-(de)serialized via mode: "json". */
		icons: text("icons", { mode: "json" }).$type<ToolIcon[]>(),
		/** Stored upstream/catalog execution.taskSupport, not runtime Tasks advertisement. */
		executionTaskSupport: text("execution_task_support", {
			enum: TOOL_EXECUTION_TASK_SUPPORT_VALUES,
		}).$type<ToolExecutionTaskSupport>(),
		/** MCP tool annotations (behavior hints). Auto-(de)serialized via mode: "json". */
		annotations: text("annotations", { mode: "json" }).$type<ToolAnnotations>(),
		/**
		 * DECLARED write capability — the classification that decides whether a
		 * call must be gated behind approval. THREE-STATE, and the third state is
		 * the point:
		 *
		 *   'read'        declared read-only  → not gated
		 *   'write'       declared mutating   → gated
		 *   'destructive' declared irreversible → gated, never auto-approved
		 *   NULL          UNDECLARED          → gated, and reported as backlog
		 *
		 * NULL is NOT 'read'. Treating "nobody said" as "safe" is the defect this
		 * column replaces: classification used to be INFERRED from the tool name
		 * by a verb regex that never matched camelCase, so `createJiraIssue` and
		 * `cms_provision_service_key` silently classified as non-writes.
		 *
		 * Every sync path declares it: the oRPC projection derives it from the
		 * contract endpoint's kind/method annotations, the OpenAPI and Google
		 * Discovery importers derive it from the HTTP method, and the catalog
		 * scan derives it from upstream MCP `annotations`
		 * (`deriveToolWriteCapability`) or a `writeCapabilityOverrides`
		 * declaration (the app's `mcpConfig.writeCapabilityOverrides` or the
		 * sync option). A new row that would land NULL is refused loudly —
		 * undeclared tools force an explicit scope decision. Rows that predate
		 * the requirement keep NULL (still gated, never read) and are listed by
		 * `reportUnclassifiedWriteCapability`. Nullable BY DESIGN — a NOT NULL
		 * default would have to invent one of the three answers for every
		 * existing row.
		 */
		writeCapability: text("write_capability", {
			enum: TOOL_WRITE_CAPABILITY_VALUES,
		}).$type<ToolWriteCapability>(),
		/**
		 * DECLARED action type, e.g. `comment_on_issue` (see `ToolActionTypeSchema`).
		 * An organization admin can let one declared type run without asking,
		 * through an org-wide `mcp_tool_approval_grants` row. NULL = undeclared:
		 * the call keeps its normal approval. Catalog sync never writes it.
		 */
		actionType: text("action_type"),
		/**
		 * Declared: results of this tool are sensitive. A run that reads through
		 * it is latched (see `@tedix/api-contract/schemas/sensitive-data-latch`).
		 * Default false; a connection's `restricted` classification latches too.
		 */
		sensitiveData: integer("sensitive_data", { mode: "boolean" })
			.notNull()
			.default(false),
		/**
		 * Declared: internal tool whose transport forwards to the public
		 * internet (publish, share link, post, outbound message). A latched run
		 * may not call it, and the handler scans its arguments for secrets.
		 * External and upstream-MCP transports already egress by transport —
		 * the scan covers them without the flag, though a set flag still
		 * forces the scan on a same-organization tedi call.
		 */
		publicEgress: integer("public_egress", { mode: "boolean" })
			.notNull()
			.default(false),
		/** MCP _meta extensions (vendor/app metadata). */
		meta: text("meta", { mode: "json" }).$type<Record<string, JsonValue>>(),
		/** Invocation status text (Apps SDK). Auto-(de)serialized via mode: "json". */
		invocationStatus: text("invocation_status", {
			mode: "json",
		}).$type<ToolInvocationStatus>(),
		/** Parameter names that accept file inputs. Auto-(de)serialized via mode: "json". */
		fileParams: text("file_params", { mode: "json" }).$type<string[]>(),
		widgetDescription: text("widget_description"),
		widgetPrefersBorder: integer("widget_prefers_border", {
			mode: "boolean",
		}).default(true),
		widgetDomain: text("widget_domain"),

		// Tool-type-specific configuration (JSON)
		// Passed to the ToolHandler at runtime
		// Type depends on toolTypeId: SearchToolConfig, ContentToolConfig, etc.
		config: text("config", { mode: "json" }).$type<Record<string, JsonValue>>(),

		// Schema provenance for generated MCP tool schemas.
		schemaDialect: text("schema_dialect", {
			enum: TOOL_SCHEMA_DIALECT_VALUES,
		}).$type<ToolSchemaDialect>(),
		schemaSource: text("schema_source", {
			enum: TOOL_SCHEMA_SOURCE_VALUES,
		}).$type<ToolSchemaSource>(),
		schemaSourceRef: text("schema_source_ref"),
		schemaSourceHash: text("schema_source_hash"),
		schemaSyncedAt: text("schema_synced_at"),
		// Hash of the code-derived projection inputs (contract schemas, overrides,
		// generated metadata) this row was last projected from. Lets the post-deploy
		// sync skip endpoints whose contract did not change. Any write that does not
		// come from the projection clears it, so a hand-edited row is re-projected.
		contractHash: text("contract_hash"),

		// Tool Status
		enabled: integer("enabled", { mode: "boolean" }).default(true),
		/**
		 * New upstream tools stay hidden until an owner approves their diff. A
		 * changed tool keeps its approved definition live and holds the new one
		 * in `reviewPending` (see toolDefinitionIsLive).
		 */
		reviewState: text("review_state", {
			enum: TOOL_REVIEW_STATE_VALUES,
		})
			.$type<ToolReviewState>()
			.notNull()
			.default("live"),
		reviewDiff: text("review_diff", { mode: "json" }).$type<ToolReviewDiff>(),
		reviewBatchId: text("review_batch_id"),
		reviewPending: text("review_pending", {
			mode: "json",
		}).$type<ToolReviewPendingDefinition>(),

		// Display order in tool listings (lower = earlier)
		sortOrder: integer("sort_order").default(0),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Each app can only have one tool with a given tool_id
		unique("idx_app_tool_unique").on(table.appId, table.toolId),
		// Fast lookup for MCP tool loading
		index("idx_app_tools_app_enabled").on(table.appId, table.enabled),
		index("idx_app_tools_app_review").on(table.appId, table.reviewState),
		index("idx_app_tools_app_sort").on(table.appId, table.sortOrder),
		// NOTE: No index on computed `layout` until Drizzle/D1 supports it reliably.
	],
);

export type AppTool = typeof appTools.$inferSelect;
export type NewAppTool = typeof appTools.$inferInsert;

/**
 * Re-export tool types from api-contract (canonical source)
 *
 * These types are used throughout the codebase:
 * - AdapterScope: "all" | "primary" | string[]
 * - ResultStrategy: "parallel_all" | "first_success" | "merge"
 * - ToolInputJsonSchema: MCP root-object JSON Schema for input schemas
 * - ToolJsonSchema: MCP JSON Schema object for output schemas
 *
 * @see packages/api-contract/src/schemas/tools.ts for canonical definitions
 */
export type {
	AdapterScope,
	ResultStrategy,
	ToolInputJsonSchema,
	ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";

/**
 * Re-export utility functions from api-contract
 * - parseAdapterScope: Convert DB string to typed AdapterScope
 * - serializeAdapterScope: Convert AdapterScope to DB string
 */
export {
	parseAdapterScope,
	serializeAdapterScope,
} from "@tedix/api-contract/schemas/tools";
