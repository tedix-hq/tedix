import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	ToolAnnotations,
	ToolExecutionTaskSupport,
	ToolIcon,
	ToolInputJsonSchema,
	ToolJsonSchema,
	ToolSchemaDialect,
	ToolSchemaSource,
} from "@tedix/api-contract/schemas/tools";
import {
	TOOL_SCHEMA_DIALECT_VALUES,
	TOOL_SCHEMA_SOURCE_VALUES,
} from "@tedix/api-contract/schemas/tools";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * App Catalog - Multi-Store AI App Directory
 *
 * Architecture: One app per MCP server, not per store.
 * Apps published across multiple stores are deduplicated by normalized MCP endpoint.
 *
 * Data sources:
 * - ChatGPT: https://chatgpt.com/apps
 * - Claude: Anthropic's MCP servers
 * - Gemini: Google's AI app ecosystem
 * - Copilot: Microsoft's Copilot extensions
 *
 * Table hierarchy:
 * - app_catalog (main) - one row per unique MCP endpoint
 * Then app_catalog_store_listings - per-store metadata (1:N)
 * Then app_catalog_mcp_tools - discovered tool schemas (1:N)
 * Then app_catalog_health_history - health check history (1:N)
 */

// ============================================
// Enums
// ============================================

// Source platforms
export const sourceEnum = [
	"chatgpt",
	"claude",
	"gemini",
	"copilot",
	"official",
	"tedix",
	"tedi",
	"community",
	"manual",
] as const;
export type Source = (typeof sourceEnum)[number];

// Source of truth for the catalog tool snapshot.
export const catalogToolSourceEnum = [
	"upstream_mcp",
	"tedix_app",
	"openapi",
	"google-discovery",
] as const;
export type CatalogToolSource = (typeof catalogToolSourceEnum)[number];

// Connector types from OpenAI
export const connectorTypeEnum = [
	"MCP",
	"SERVICE",
	"FIRST_PARTY_ECOSYSTEM",
	"NATIVE",
] as const;
export type ConnectorType = (typeof connectorTypeEnum)[number];

// Distribution channels
export const distributionChannelEnum = [
	"ECOSYSTEM_DIRECTORY",
	"DEFAULT_OAI_CATALOG",
	"INDIVIDUAL",
] as const;
export type DistributionChannel = (typeof distributionChannelEnum)[number];

// Developer types
export const developerTypeEnum = [
	"TRUSTED_PARTNER",
	"OAI",
	"THIRD_PARTY",
	"UNTRUSTED",
] as const;
export type DeveloperType = (typeof developerTypeEnum)[number];

// App status
export const appStatusEnum = [
	"ENABLED",
	"DISABLED",
	"PENDING",
	"DELISTED",
] as const;
export type AppStatus = (typeof appStatusEnum)[number];

// Review status
export const reviewStatusEnum = ["RELEASED", "PENDING", "REJECTED"] as const;
export type ReviewStatus = (typeof reviewStatusEnum)[number];

// Auth types
export const authTypeEnum = ["OAUTH", "NONE", "API_KEY"] as const;
export type AuthType = (typeof authTypeEnum)[number];

// Category enum (from OpenAI's branding.category + additional)
export const categoryEnum = [
	"PRODUCTIVITY",
	"DEVELOPER_TOOLS",
	"LIFESTYLE",
	"FINANCE",
	"TRAVEL",
	"DESIGN",
	"EDUCATION",
	"ENTERTAINMENT",
	"SOCIAL",
	"BUSINESS",
	"HEALTH",
	"NEWS",
	"SHOPPING",
	"UTILITIES",
	"COLLABORATION",
	"FOOD",
	"BUSINESS_AND_ANALYTICS",
	"MESSAGING_AND_SOCIAL",
] as const;
export type Category = (typeof categoryEnum)[number];

// Unified health status enum
export const healthStatusEnum = [
	"healthy", // Connected, all features working
	"degraded", // Connected but some features failed (e.g., listResources error)
	"unhealthy", // Failed to connect (timeout, DNS, TLS errors)
	"requires_auth", // 401/403 - NOT penalized in uptime calculations
	"blocked", // Blocked by anti-bot, WAF, or IP allowlist controls
	"unsupported", // Transport not supported (neither streamable-http nor sse)
	"unknown", // Never checked
] as const;
export type HealthStatus = (typeof healthStatusEnum)[number];

// Error classification for debugging
export const errorClassEnum = [
	"timeout",
	"dns",
	"tls",
	"auth",
	"waf",
	"transport",
	"protocol",
	"unknown",
] as const;
export type ErrorClass = (typeof errorClassEnum)[number];

// Tool test types
export const toolTestTypeEnum = ["programmatic", "ai_eval"] as const;
export type ToolTestType = (typeof toolTestTypeEnum)[number];

// Tool test input sources
export const toolTestInputSourceEnum = [
	"schema_generated",
	"ai_generated",
	"manual",
] as const;
export type ToolTestInputSource = (typeof toolTestInputSourceEnum)[number];

// Tool test error classification
export const toolTestErrorClassEnum = [
	"validation",
	"timeout",
	"auth",
	"server_error",
	"unknown",
] as const;
export type ToolTestErrorClass = (typeof toolTestErrorClassEnum)[number];

// Transport types
export const transportTypeEnum = ["streamable-http", "sse"] as const;
export type TransportType = (typeof transportTypeEnum)[number];

// MCP Server Capabilities type
export type ServerCapabilities = {
	extensions?: Record<string, JsonValue>;
	experimental?: Record<string, JsonValue>;
	logging?: Record<string, JsonValue>;
	prompts?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	tools?: { listChanged?: boolean };
	sampling?: Record<string, JsonValue>;
	roots?: { listChanged?: boolean };
};

// ============================================
// Main Table: app_catalog
// ============================================

/**
 * Main table for App Catalog entries
 * One row per unique MCP endpoint (deduplicated across stores)
 */
export const appCatalog = sqliteTable(
	"app_catalog",
	{
		// ========================================
		// Primary Identity
		// ========================================
		id: text("id").primaryKey(), // Internal UUID
		slug: text("slug").unique(), // SEO-friendly URL slug

		// ========================================
		// Basic Info
		// ========================================
		name: text("name").notNull(),
		description: text("description"),
		modelDescription: text("model_description"), // Description for the model

		// ========================================
		// MCP Endpoint (Deduplication Keys)
		// ========================================
		baseUrl: text("base_url"), // Raw value from source (preserved)
		mcpEndpointNormalized: text("mcp_endpoint_normalized"), // Canonical form for dedup
		mcpEndpointHash: text("mcp_endpoint_hash"), // SHA256 for fast dedup (unique via index)

		// ========================================
		// Classification
		// ========================================
		connectorType: text("connector_type").$type<ConnectorType>().notNull(),
		distributionChannel: text(
			"distribution_channel",
		).$type<DistributionChannel>(),
		developerType: text("developer_type").$type<DeveloperType>(),
		status: text("status").$type<AppStatus>().default("ENABLED"),

		// ========================================
		// Branding & Developer Info
		// ========================================
		category: text("category").$type<Category>(),
		developer: text("developer"),
		website: text("website"),
		privacyPolicy: text("privacy_policy"),
		termsOfService: text("terms_of_service"),
		isDiscoverable: integer("is_discoverable", { mode: "boolean" }).default(
			true,
		),

		// ========================================
		// URLs and Endpoints
		// ========================================
		service: text("service"), // Service identifier
		logoUrl: text("logo_url"),
		logoUrlDark: text("logo_url_dark"),

		// ========================================
		// Discovery and Triggering
		// ========================================
		keywordsForDiscovery: text("keywords_for_discovery", {
			mode: "json",
		}).$type<string[] | null>(),
		keywordsForTriggering: text("keywords_for_triggering", {
			mode: "json",
		}).$type<string[] | null>(),

		// ========================================
		// App Metadata
		// ========================================
		version: text("version"),
		versionId: text("version_id"),
		versionNotes: text("version_notes"),
		reviewStatus: text("review_status").$type<ReviewStatus>(),
		seoDescription: text("seo_description"),
		screenshots: text("screenshots", { mode: "json" }).$type<string[] | null>(),
		categories: text("categories", { mode: "json" }).$type<string[] | null>(),
		subCategories: text("sub_categories", { mode: "json" }).$type<
			string[] | null
		>(),

		// ========================================
		// Capabilities (merged from all stores)
		// ========================================
		hasWrites: integer("has_writes", { mode: "boolean" }).default(false),
		hasInteractive: integer("has_interactive", { mode: "boolean" }).default(
			false,
		),
		hasFileSearch: integer("has_file_search", { mode: "boolean" }).default(
			false,
		),
		hasDeepResearch: integer("has_deep_research", { mode: "boolean" }).default(
			false,
		),
		hasSync: integer("has_sync", { mode: "boolean" }).default(false),

		// ========================================
		// Auth Configuration
		// ========================================
		authTypes: text("auth_types", { mode: "json" }).$type<AuthType[]>(),
		supportsFullActions: integer("supports_full_actions", { mode: "boolean" }),

		// ========================================
		// MCP Tool/Resource/Prompt Counts (top-level, used in sorting)
		// ========================================
		mcpToolCount: integer("mcp_tool_count").default(0),
		mcpResourceCount: integer("mcp_resource_count").default(0),
		mcpPromptCount: integer("mcp_prompt_count").default(0),

		// ========================================
		// MCP Protocol Feature Tracking
		// ========================================
		protocolVersion: text("protocol_version"), // negotiated MCP revision, including 2026-07-28
		supportsResources: integer("supports_resources", {
			mode: "boolean",
		}).default(false),
		supportsPrompts: integer("supports_prompts", { mode: "boolean" }).default(
			false,
		),
		supportsSampling: integer("supports_sampling", { mode: "boolean" }).default(
			false,
		),
		supportsRoots: integer("supports_roots", { mode: "boolean" }).default(
			false,
		),

		// ========================================
		// Health Status (top-level, indexed)
		// ========================================
		healthStatus: text("health_status")
			.$type<HealthStatus>()
			.default("unknown"),

		// ========================================
		// Policy Info
		// ========================================
		safetyStatus: text("safety_status"),

		// ========================================
		// MCP Server Metadata (JSON blob)
		// ========================================
		mcpMetadata: text("mcp_metadata", { mode: "json" }).$type<{
			serverName?: string | null;
			serverVersion?: string | null;
			lastScannedAt?: string | null;
			protocolObservedAt?: string | null;
			capabilities?: ServerCapabilities | null;
			instructions?: string | null;
		}>(),

		// ========================================
		// Health Check Data (JSON blob, healthStatus stays top-level)
		// ========================================
		healthData: text("health_data", { mode: "json" }).$type<{
			lastCheckedAt?: string | null;
			connectTimeMs?: number | null;
			uptimePercent?: number | null;
			consecutiveFailures?: number | null;
			errorMessage?: string | null;
			transportUsed?: string | null;
		}>(),

		// ========================================
		// Quality Scores + Conformance (JSON blob)
		// ========================================
		scores: text("scores", { mode: "json" }).$type<{
			overall?: number | null;
			schemaQuality?: number | null;
			capabilityBreadth?: number | null;
			freshness?: number | null;
			standards?: number | null;
			trust?: number | null;
			lastCalculatedAt?: string | null;
			implementsRetrievable?: boolean | null;
			retrievableReason?: string | null;
		}>(),

		// ========================================
		// System Hints from ChatGPT (JSON blob)
		// ========================================
		systemHints: text("system_hints", { mode: "json" }).$type<{
			tierLevel?: string | null;
			isDangerous?: boolean | null;
			badgeText?: string | null;
			estimatedDurationSeconds?: number | null;
			isFeatured?: boolean | null;
			svgLogo?: string | null;
			keywordInvocations?: string[] | null;
			actionLabel?: string | null;
			shortLabel?: string | null;
			suggestedPromptTheme?: string | null;
			allowInTemporaryChat?: boolean | null;
			persistBetweenMessages?: boolean | null;
		}>(),

		// ========================================
		// First-Seen Tracking (JSON blob)
		// ========================================
		firstSeen: text("first_seen", { mode: "json" }).$type<{
			at?: string | null;
			releasedAt?: string | null;
			inDirectoryAt?: string | null;
		}>(),

		// ========================================
		// Rich Content + Enrichment (JSON blob)
		// ========================================
		richContent: text("rich_content", { mode: "json" }).$type<{
			// Original fields
			htmlDescription?: string | null;
			heroVideoId?: string | null;
			heroVideoPreviewLink?: string | null;
			installCommand?: string | null;
			serverLabel?: string | null;
			publishedAt?: string | null;
			sourceUpdatedAt?: string | null;
			enrichmentError?: string | null;
			// Absorbed from enrichment columns
			screenshotUrl?: string | null;
			enrichedDescription?: string | null;
			socialLinks?: string[] | null;
			enrichedAt?: string | null;
			enrichmentSource?: string | null;
			enrichmentFailedAt?: string | null;
			enrichmentSkipped?: boolean | null;
			enrichmentExempt?: boolean | null;
			examplePrompts?: Array<{
				raw: string;
				cleanPrompt: string;
				appMention: string;
				screenshotUrl?: string | null;
				sourceFileId?: string | null;
				confidence?: number | null;
			}> | null;
		}>(),

		// ========================================
		// Documentation & Support
		// ========================================
		documentationUrl: text("documentation_url"),
		supportUrl: text("support_url"),

		// ========================================
		// Scan Auth Credentials (encrypted)
		// ========================================
		scanAuthHeaders: text("scan_auth_headers"), // Encrypted JSON: Record<string,string>

		// Vault-based credential resolution for periodic scans.
		// When set, the scan workflow resolves a fresh token instead of relying
		// on the (potentially expired) scanAuthHeaders snapshot.
		scanConnectionId: text("scan_connection_id"),
		scanConnectionHeader: text("scan_connection_header"), // e.g. "Authorization"
		scanConnectionTemplate: text("scan_connection_template"), // e.g. "Bearer {token}"
		scanOrganizationId: text("scan_organization_id"),
		// When set, the vault-resolved credential (raw `client_id:client_secret`)
		// is exchanged at this OAuth2 token endpoint via the `client_credentials`
		// grant before templating — mirrors the runtime handler so M2M MCP servers
		// re-scan with a fresh short-lived Bearer instead of a stored,
		// expiring token snapshot.
		scanClientCredentialsTokenUrl: text("scan_client_credentials_token_url"),

		// ========================================
		// Raw Data & Sync Metadata
		// ========================================
		rawData: text("raw_data", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		sourceCreatedAt: text("source_created_at"),
		lastSyncedAt: text("last_synced_at").notNull(),
		syncSource: text("sync_source").default("api"), // 'api' | 'scrape'
		toolSource: text("tool_source", { enum: catalogToolSourceEnum })
			.notNull()
			.default("upstream_mcp"),

		// ========================================
		// Timestamps
		// ========================================
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("app_catalog_name_idx").on(table.name),
		index("app_catalog_slug_idx").on(table.slug),
		index("app_catalog_connector_type_idx").on(table.connectorType),
		index("app_catalog_category_idx").on(table.category),
		index("app_catalog_distribution_channel_idx").on(table.distributionChannel),
		index("app_catalog_status_idx").on(table.status),
		index("app_catalog_is_discoverable_idx").on(table.isDiscoverable),
		index("app_catalog_developer_type_idx").on(table.developerType),
		index("app_catalog_health_status_idx").on(table.healthStatus),
		index("app_catalog_tool_source_idx").on(table.toolSource),
		// Unique index for MCP endpoint deduplication (NULLs are allowed and distinct)
		uniqueIndex("app_catalog_mcp_endpoint_hash_unique").on(
			table.mcpEndpointHash,
		),
	],
);

// ============================================
// Store Listings Table (Per-Store Metadata)
// ============================================

/**
 * Store listings for each catalog app
 * One app can have multiple store listings (ChatGPT, Claude, Gemini, etc.)
 */
export const appCatalogStoreListings = sqliteTable(
	"app_catalog_store_listings",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		// Store identification
		source: text("source").$type<Source>().notNull(), // chatgpt, claude, gemini, copilot
		sourceAppId: text("source_app_id").notNull(), // Store-specific ID

		// Per-store metadata
		regions: text("regions", { mode: "json" }).$type<string[]>(),
		storeUrl: text("store_url"), // Direct link to store listing
		reviewStatus: text("review_status").$type<ReviewStatus>(),
		authRequired: integer("auth_required", { mode: "boolean" }).default(false),

		// Store-specific branding (if different from main)
		storeLogoUrl: text("store_logo_url"),
		storeDescription: text("store_description"),

		// Per-store scoring/ranking (source-specific, not cross-store)
		popularityScore: integer("popularity_score"),
		trendingScore: integer("trending_score"),
		rank: integer("rank"),
		worksWith: text("works_with", { mode: "json" }).$type<string[]>(),

		// Sync metadata
		lastSyncedAt: text("last_synced_at").notNull(),
		rawData: text("raw_data", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Each sourceAppId must be unique per source
		uniqueIndex("store_listings_source_id_unique").on(
			table.source,
			table.sourceAppId,
		),
	],
);

// ============================================
// MCP Tools Table (Discovered Tool Schemas)
// ============================================

/**
 * MCP tools discovered from health checks
 * Separate table to avoid row bloat (tool schemas can be large)
 */
export const appCatalogMcpTools = sqliteTable(
	"app_catalog_mcp_tools",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		// Tool identity
		toolName: text("tool_name").notNull(),
		title: text("title"), // Human-readable name (MCP 2025-11-25)
		description: text("description"),

		// MCP input JSON Schema root object (can be large, hence separate table)
		inputSchema: text("input_schema", { mode: "json" })
			.$type<ToolInputJsonSchema>()
			.notNull()
			.default(
				sql`'{"type":"object","properties":{},"additionalProperties":false}'`,
			),

		// Output schema for structuredContent (root may be object/array/scalar)
		outputSchema: text("output_schema", {
			mode: "json",
		}).$type<ToolJsonSchema | null>(),

		// MCP tool icons
		icons: text("icons", { mode: "json" }).$type<ToolIcon[] | null>(),

		// Upstream/catalog execution.taskSupport flattened to top-level
		executionTaskSupport: text(
			"execution_task_support",
		).$type<ToolExecutionTaskSupport | null>(),

		// MCP annotations
		annotations: text("annotations", {
			mode: "json",
		}).$type<ToolAnnotations | null>(),

		// MCP _meta (vendor extensions: audience/priority/provenance, etc.)
		meta: text("meta", { mode: "json" }).$type<Record<
			string,
			JsonValue
		> | null>(),

		// Schema provenance for discovered/catalog-projected MCP tool schemas.
		schemaDialect: text("schema_dialect", {
			enum: TOOL_SCHEMA_DIALECT_VALUES,
		}).$type<ToolSchemaDialect>(),
		schemaSource: text("schema_source", {
			enum: TOOL_SCHEMA_SOURCE_VALUES,
		}).$type<ToolSchemaSource>(),
		schemaSourceRef: text("schema_source_ref"),
		schemaSourceHash: text("schema_source_hash"),
		schemaSyncedAt: text("schema_synced_at"),

		// Tracking
		detectedAt: text("detected_at").notNull(),
		removedAt: text("removed_at"), // Null = still present, set = tool was removed
		lastSeenAt: text("last_seen_at").notNull(),

		// ========================================
		// Test Metrics (aggregated from tool tests)
		// ========================================
		lastTestedAt: text("last_tested_at"),
		lastTestSuccess: integer("last_test_success", { mode: "boolean" }),
		testSuccessRate: real("test_success_rate"), // 0.0 to 1.0, rolling 30 days
		avgLatencyMs: integer("avg_latency_ms"),
		testCount: integer("test_count").default(0),

		// Example I/O (from best successful test)
		exampleInput: text("example_input", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		exampleOutput: text("example_output", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// AI evaluation score (how clear is the tool description)
		aiClarityScore: real("ai_clarity_score"), // 0-10
	},
	(table) => [
		uniqueIndex("mcp_tools_app_name_unique").on(
			table.catalogAppId,
			table.toolName,
		),
		index("mcp_tools_last_tested_idx").on(table.lastTestedAt),
		index("mcp_tools_test_count_idx").on(table.testCount),
		index("mcp_tools_schema_source_idx").on(table.schemaSource),
	],
);

// ============================================
// MCP Resources Table (Discovered Resources)
// ============================================

export const appCatalogMcpResources = sqliteTable(
	"app_catalog_mcp_resources",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		uri: text("uri").notNull(),
		name: text("name"),
		title: text("title"), // Human-readable name (MCP 2025-11-25)
		description: text("description"),
		mimeType: text("mime_type"),

		// Icons (MCP 2025-11-25)
		icons: text("icons", { mode: "json" }).$type<Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}> | null>(),

		annotations: text("annotations", { mode: "json" }).$type<{
			audience?: string[];
			priority?: number;
			lastModified?: string;
		}>(),

		// MCP _meta (vendor extensions: audience/priority/provenance, etc.)
		meta: text("meta", { mode: "json" }).$type<Record<
			string,
			JsonValue
		> | null>(),

		detectedAt: text("detected_at").notNull(),
		removedAt: text("removed_at"),
		lastSeenAt: text("last_seen_at").notNull(),
	},
	(table) => [
		uniqueIndex("mcp_resources_app_uri_unique").on(
			table.catalogAppId,
			table.uri,
		),
	],
);

// ============================================
// MCP Resource Templates Table
// ============================================

export const appCatalogMcpResourceTemplates = sqliteTable(
	"app_catalog_mcp_resource_templates",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		title: text("title"), // Human-readable name (MCP 2025-11-25)
		uriTemplate: text("uri_template").notNull(),
		description: text("description"),
		mimeType: text("mime_type"),

		// Icons (MCP 2025-11-25)
		icons: text("icons", { mode: "json" }).$type<Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}> | null>(),

		annotations: text("annotations", { mode: "json" }).$type<{
			audience?: string[];
			priority?: number;
			lastModified?: string;
		}>(),

		// MCP _meta (vendor extensions: audience/priority/provenance, etc.)
		meta: text("meta", { mode: "json" }).$type<Record<
			string,
			JsonValue
		> | null>(),

		detectedAt: text("detected_at").notNull(),
		removedAt: text("removed_at"),
		lastSeenAt: text("last_seen_at").notNull(),
	},
	(table) => [
		uniqueIndex("mcp_resource_tpl_app_name_unique").on(
			table.catalogAppId,
			table.name,
		),
	],
);

// ============================================
// MCP Prompts Table (Discovered Prompts)
// ============================================

export const appCatalogMcpPrompts = sqliteTable(
	"app_catalog_mcp_prompts",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		promptName: text("prompt_name").notNull(),
		title: text("title"),
		description: text("description"),

		arguments: text("arguments", { mode: "json" }).$type<
			Array<{ name: string; description?: string; required?: boolean }>
		>(),
		icons: text("icons", { mode: "json" }).$type<Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}> | null>(),
		annotations: text("annotations", { mode: "json" }).$type<{
			audience?: string[];
			priority?: number;
			lastModified?: string;
		} | null>(),
		meta: text("meta", { mode: "json" }).$type<Record<
			string,
			JsonValue
		> | null>(),

		detectedAt: text("detected_at").notNull(),
		removedAt: text("removed_at"),
		lastSeenAt: text("last_seen_at").notNull(),
	},
	(table) => [
		uniqueIndex("mcp_prompts_app_name_unique").on(
			table.catalogAppId,
			table.promptName,
		),
	],
);

export type CatalogMcpSkillResource = {
	uri: string;
	digest: string;
	size: number;
};

export type CatalogMcpSkillResources = CatalogMcpSkillResource[] | "dynamic";

/** SEP-2640 skill manifests observed for a catalog MCP endpoint. */
export const appCatalogMcpSkills = sqliteTable(
	"app_catalog_mcp_skills",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),
		skillUri: text("skill_uri").notNull(),
		frontmatter: text("frontmatter", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		resources: text("resources", {
			mode: "json",
		})
			.$type<CatalogMcpSkillResources>()
			.notNull(),
		detectedAt: text("detected_at").notNull(),
		lastSeenAt: text("last_seen_at").notNull(),
	},
	(table) => [
		uniqueIndex("mcp_skills_app_uri_unique").on(
			table.catalogAppId,
			table.skillUri,
		),
		index("mcp_skills_app_last_seen_idx").on(
			table.catalogAppId,
			table.lastSeenAt,
		),
	],
);

// ============================================
// Health History Table (Per-Check Records)
// ============================================

/**
 * Health check history for uptime calculations and debugging
 */
export const appCatalogHealthHistory = sqliteTable(
	"app_catalog_health_history",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),

		// Check result
		checkedAt: text("checked_at").notNull(),
		status: text("status").$type<HealthStatus>().notNull(),

		// Timing
		connectTimeMs: integer("connect_time_ms"),
		totalTimeMs: integer("total_time_ms"),

		// Connection details
		transportUsed: text("transport_used").$type<TransportType>(),
		authState: text("auth_state").$type<"none" | "required" | "failed">(),

		// Server info (captured at check time)
		serverVersion: text("server_version"),
		toolCount: integer("tool_count"),
		resourceCount: integer("resource_count"),
		promptCount: integer("prompt_count"),

		// Error details (for debugging)
		errorMessage: text("error_message"),
		errorClass: text("error_class").$type<ErrorClass>(),
	},
	(table) => [
		index("health_history_checked_idx").on(table.checkedAt),
		// Composite index for uptime queries
		index("health_history_app_checked_idx").on(
			table.catalogAppId,
			table.checkedAt,
		),
	],
);

// ============================================
// Tool Tests Table (Per-Test Records)
// ============================================

/**
 * Tool test history for tracking individual test runs
 * Used for validation, reliability metrics, and AI evaluation
 */
export const appCatalogToolTests = sqliteTable(
	"app_catalog_tool_tests",
	{
		id: text("id").primaryKey(),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),
		toolName: text("tool_name").notNull(),
		testedAt: text("tested_at").notNull(),

		// ========================================
		// Test Configuration
		// ========================================
		testType: text("test_type").$type<ToolTestType>().notNull(),
		inputSource: text("input_source").$type<ToolTestInputSource>().notNull(),

		// ========================================
		// Results
		// ========================================
		success: integer("success", { mode: "boolean" }).notNull(),
		latencyMs: integer("latency_ms"),
		errorMessage: text("error_message"),
		errorClass: text("error_class").$type<ToolTestErrorClass>(),

		// ========================================
		// I/O Capture
		// ========================================
		inputUsed: text("input_used", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		outputReceived: text("output_received", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(), // Truncated to 10KB
		outputValid: integer("output_valid", { mode: "boolean" }), // Matches expected schema

		// ========================================
		// AI Eval Specific (nullable for programmatic tests)
		// ========================================
		aiModel: text("ai_model"), // e.g., 'llama-3.3-70b'
		aiPromptUsed: text("ai_prompt_used"),
		aiToolSelectionCorrect: integer("ai_tool_selection_correct", {
			mode: "boolean",
		}),
		aiOutputQualityScore: real("ai_output_quality_score"), // 0-10
		aiTokensUsed: integer("ai_tokens_used"),
	},
	(table) => [
		index("tool_tests_tested_at_idx").on(table.testedAt),
		index("tool_tests_success_idx").on(table.success),
		// Composite index for metrics calculation
		index("tool_tests_app_tool_tested_idx").on(
			table.catalogAppId,
			table.toolName,
			table.testedAt,
		),
	],
);

// ============================================
// Sync Logs Table
// ============================================

/**
 * Sync logs for tracking directory updates
 */
export const appCatalogSyncLogs = sqliteTable("app_catalog_sync_logs", {
	id: text("id").primaryKey(),

	// Sync metadata
	syncType: text("sync_type").notNull(), // 'full' | 'incremental' | 'single_app'
	source: text("source").$type<Source>(), // Which platform was synced
	startedAt: text("started_at").notNull(),
	completedAt: text("completed_at"),

	// Results
	appsDiscovered: integer("apps_discovered").default(0),
	appsUpdated: integer("apps_updated").default(0),
	appsRemoved: integer("apps_removed").default(0),
	appsFailed: integer("apps_failed").default(0),

	// Status
	status: text("status").default("running"), // running | completed | failed
	error: text("error"),

	// Details
	details: text("details", { mode: "json" }).$type<Record<string, JsonValue>>(),
});

// ============================================
// Type Exports
// ============================================

export type CatalogApp = typeof appCatalog.$inferSelect;
export type NewCatalogApp = typeof appCatalog.$inferInsert;

// JSON blob helper types
export type SystemHints = NonNullable<CatalogApp["systemHints"]>;
export type HealthData = NonNullable<CatalogApp["healthData"]>;
export type Scores = NonNullable<CatalogApp["scores"]>;
export type McpMetadata = NonNullable<CatalogApp["mcpMetadata"]>;
export type FirstSeen = NonNullable<CatalogApp["firstSeen"]>;
export type RichContent = NonNullable<CatalogApp["richContent"]>;

export type CatalogStoreListing = typeof appCatalogStoreListings.$inferSelect;
export type NewCatalogStoreListing =
	typeof appCatalogStoreListings.$inferInsert;

export type CatalogMcpTool = typeof appCatalogMcpTools.$inferSelect;
export type NewCatalogMcpTool = typeof appCatalogMcpTools.$inferInsert;

export type CatalogMcpResource = typeof appCatalogMcpResources.$inferSelect;
export type NewCatalogMcpResource = typeof appCatalogMcpResources.$inferInsert;

export type CatalogMcpResourceTemplate =
	typeof appCatalogMcpResourceTemplates.$inferSelect;
export type NewCatalogMcpResourceTemplate =
	typeof appCatalogMcpResourceTemplates.$inferInsert;

export type CatalogMcpPrompt = typeof appCatalogMcpPrompts.$inferSelect;
export type NewCatalogMcpPrompt = typeof appCatalogMcpPrompts.$inferInsert;

export type CatalogMcpSkill = typeof appCatalogMcpSkills.$inferSelect;
export type NewCatalogMcpSkill = typeof appCatalogMcpSkills.$inferInsert;

export type CatalogHealthHistory = typeof appCatalogHealthHistory.$inferSelect;
export type NewCatalogHealthHistory =
	typeof appCatalogHealthHistory.$inferInsert;

export type CatalogToolTest = typeof appCatalogToolTests.$inferSelect;
export type NewCatalogToolTest = typeof appCatalogToolTests.$inferInsert;

export type AppCatalogSyncLog = typeof appCatalogSyncLogs.$inferSelect;
export type NewAppCatalogSyncLog = typeof appCatalogSyncLogs.$inferInsert;

// ============================================
// Catalog Changes Table (Change Detection)
// ============================================

/**
 * Tracks changes detected during catalog sync operations.
 * Records field-level diffs for updates, and lifecycle events (added/removed).
 */
export const appCatalogChanges = sqliteTable(
	"app_catalog_changes",
	{
		id: text("id").primaryKey(), // uuid
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),
		changeType: text("change_type", {
			enum: ["added", "removed", "updated", "version_bump"],
		}).notNull(),
		fieldName: text("field_name"), // null for added/removed
		oldValue: text("old_value"),
		newValue: text("new_value"),
		versionBefore: text("version_before"),
		versionAfter: text("version_after"),
		detectedAt: text("detected_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		syncLogId: text("sync_log_id"),
	},
	(table) => [
		index("idx_catalog_changes_app").on(table.catalogAppId, table.detectedAt),
		index("idx_catalog_changes_type").on(table.changeType, table.detectedAt),
	],
);

export type AppCatalogChange = typeof appCatalogChanges.$inferSelect;
export type NewAppCatalogChange = typeof appCatalogChanges.$inferInsert;

// ============================================
// Upstream Drift Reports Table
// ============================================

/**
 * Upstream drift detection reports for catalog apps.
 * Catalog-centric: one report per catalog app per scan cycle.
 * Stores detected MCP tool contract and metadata drift between the catalog's
 * recorded snapshot and the live upstream MCP server.
 */
export const upstreamDriftReports = sqliteTable(
	"upstream_drift_reports",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		catalogAppId: text("catalog_app_id")
			.notNull()
			.references(() => appCatalog.id, { onDelete: "cascade" }),
		catalogAppName: text("catalog_app_name").notNull(),
		addedTools: integer("added_tools").notNull().default(0),
		removedTools: integer("removed_tools").notNull().default(0),
		changedTools: integer("changed_tools").notNull().default(0),
		drifts: text("drifts", { mode: "json" })
			.notNull()
			.$type<ToolDriftReportItem[]>(),
		summary: text("summary").notNull(),
		checkedAt: text("checked_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		resolvedAt: text("resolved_at"),
	},
	(table) => [
		uniqueIndex("drift_reports_catalog_app_unique").on(table.catalogAppId),
		index("drift_reports_checked_idx").on(table.checkedAt),
	],
);

/**
 * Drift item shape stored in the JSON `drifts` column.
 * Catalog-centric: references catalog tool IDs, not org app tool rows.
 */
export interface ToolDriftReportItem {
	toolName: string;
	driftType:
		| "schema_changed"
		| "description_changed"
		| "metadata_changed"
		| "new_upstream"
		| "removed_upstream";
	catalogToolId?: string;
	currentDescription?: string;
	upstreamDescription?: string;
	currentSchema?: Record<string, JsonValue>;
	upstreamSchema?: Record<string, JsonValue>;
	currentOutputSchema?: Record<string, JsonValue> | null;
	upstreamOutputSchema?: Record<string, JsonValue> | null;
	currentMetadata?: {
		title: string | null;
		icons: ToolIcon[] | null;
		executionTaskSupport: ToolExecutionTaskSupport | null;
		annotations: ToolAnnotations | null;
		meta: Record<string, JsonValue> | null;
	};
	upstreamMetadata?: {
		title: string | null;
		icons: ToolIcon[] | null;
		executionTaskSupport: ToolExecutionTaskSupport | null;
		annotations: ToolAnnotations | null;
		meta: Record<string, JsonValue> | null;
	};
}

export type UpstreamDriftReport = typeof upstreamDriftReports.$inferSelect;
export type NewUpstreamDriftReport = typeof upstreamDriftReports.$inferInsert;
