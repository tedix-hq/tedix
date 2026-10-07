/**
 * Catalog Schemas
 * Zod schemas for the App Catalog public API
 *
 * This module provides a clean, focused API for browsing the catalog
 * with optimized schemas for listing, detail views, and health monitoring.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";
import { ConnectionCredentialProfileSchema } from "./connections";
import { OpenApiWidgetDefaultsSchema } from "./openapi-sync";
import {
	TOOL_EXECUTION_TASK_SUPPORT_VALUES,
	TOOL_SCHEMA_SOURCE_VALUES,
	ToolAnnotationsSchema,
	ToolIconSchema,
	ToolInputJsonSchemaSchema,
	ToolJsonSchemaSchema,
} from "./tools";

// ============================================================
// Enums (re-exported from app-catalog for consistency)
// ============================================================

export const SourceSchema = z.enum([
	"chatgpt",
	"claude",
	"gemini",
	"copilot",
	"official",
	"tedix",
	"tedi",
	"community",
	"manual",
]);
export type Source = z.infer<typeof SourceSchema>;

export const CatalogToolSourceSchema = z.enum([
	"upstream_mcp",
	"tedix_app",
	"openapi",
	"google-discovery",
]);
export type CatalogToolSource = z.infer<typeof CatalogToolSourceSchema>;

export const ConnectorTypeSchema = z.enum([
	"MCP",
	"SERVICE",
	"FIRST_PARTY_ECOSYSTEM",
	"NATIVE",
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

export const DeveloperTypeSchema = z.enum([
	"TRUSTED_PARTNER",
	"OAI",
	"THIRD_PARTY",
	"UNTRUSTED",
]);
export type DeveloperType = z.infer<typeof DeveloperTypeSchema>;

export const CategorySchema = z.enum([
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
]);
export type Category = z.infer<typeof CategorySchema>;

export const HealthStatusSchema = z.enum([
	"healthy",
	"degraded",
	"unhealthy",
	"requires_auth",
	"blocked",
	"unsupported",
	"unknown",
]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// ============================================================
// Store Listing Schema
// ============================================================

export const CatalogStoreListingSchema = z.object({
	id: z.string(),
	source: SourceSchema,
	sourceAppId: z.string(),
	regions: z.array(z.string()).nullable(),
	storeUrl: z.string().nullable(),
	reviewStatus: z.string().nullable(),
	authRequired: z.boolean().nullable(),
	storeLogoUrl: z.string().nullable(),
	storeDescription: z.string().nullable(),
	lastSyncedAt: z.string(),
});
export type CatalogStoreListing = z.infer<typeof CatalogStoreListingSchema>;

// ============================================================
// MCP Tool Schema
// ============================================================

export const CatalogMcpToolSchema = z.object({
	id: z.string(),
	toolName: z.string(),
	title: z.string().nullable().optional(),
	description: z.string().nullable(),
	inputSchema: ToolInputJsonSchemaSchema,
	outputSchema: ToolJsonSchemaSchema.nullable().optional(),
	icons: z
		.array(ToolIconSchema)
		.nullable()
		.optional()
		.describe(
			"Optional upstream icon metadata; null or absence means no icon was observed.",
		),
	executionTaskSupport: z
		.enum(TOOL_EXECUTION_TASK_SUPPORT_VALUES)
		.nullable()
		.optional(),
	annotations: ToolAnnotationsSchema.nullable(),
	meta: z.record(z.string(), JsonValueSchema).nullable().optional(),
	detectedAt: z.string(),
	lastSeenAt: z.string(),
	removedAt: z.string().nullable(),
});
export type CatalogMcpTool = z.infer<typeof CatalogMcpToolSchema>;

/**
 * MCP tool schema with test metrics and example I/O for API responses
 */
export const CatalogMcpToolWithMetricsSchema = CatalogMcpToolSchema.extend({
	lastTestedAt: z.string().nullable(),
	testSuccessRate: z.number().nullable(),
	avgLatencyMs: z.number().nullable(),
	testCount: z.number().nullable(),
	// Example I/O from successful tests
	exampleInput: z.record(z.string(), JsonValueSchema).nullable(),
	exampleOutput: JsonValueSchema.nullable(),
});
export type CatalogMcpToolWithMetrics = z.infer<
	typeof CatalogMcpToolWithMetricsSchema
>;

export const CatalogMcpResourceSchema = z.object({
	id: z.string(),
	uri: z.string(),
	name: z.string().nullable(),
	title: z.string().nullable(),
	description: z.string().nullable(),
	mimeType: z.string().nullable(),
	icons: z.array(ToolIconSchema).nullable().optional(),
	annotations: z
		.object({
			// Keep the observed catalog value lossless. Upstream metadata is
			// persisted before any protocol-facing validation is applied.
			audience: z
				.array(z.string())
				.optional()
				.describe(
					"Optional upstream audience annotation, retained losslessly.",
				),
			priority: z
				.number()
				.optional()
				.describe("Optional upstream priority annotation."),
			lastModified: z
				.string()
				.optional()
				.describe("Optional upstream last-modified annotation."),
		})
		.nullable()
		.optional()
		.describe(
			"Optional MCP annotations; null or absence reflects upstream omission or legacy rows.",
		),
	meta: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.optional()
		.describe("Optional upstream extension metadata, preserved when supplied."),
	detectedAt: z.string(),
	lastSeenAt: z.string(),
	removedAt: z.string().nullable(),
});
export type CatalogMcpResource = z.infer<typeof CatalogMcpResourceSchema>;

export const CatalogMcpResourceTemplateSchema = z.object({
	id: z.string(),
	name: z.string(),
	title: z.string().nullable(),
	uriTemplate: z.string(),
	description: z.string().nullable(),
	mimeType: z.string().nullable(),
	icons: z
		.array(ToolIconSchema)
		.nullable()
		.optional()
		.describe(
			"Optional upstream icon metadata; null or absence means no icon was observed.",
		),
	annotations: z
		.object({
			audience: z
				.array(z.string())
				.optional()
				.describe(
					"Optional upstream audience annotation, retained losslessly.",
				),
			priority: z
				.number()
				.optional()
				.describe("Optional upstream priority annotation."),
			lastModified: z
				.string()
				.optional()
				.describe("Optional upstream last-modified annotation."),
		})
		.nullable()
		.optional()
		.describe(
			"Optional MCP annotations; null or absence reflects upstream omission or legacy rows.",
		),
	meta: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.optional()
		.describe("Optional upstream extension metadata, preserved when supplied."),
	detectedAt: z.string(),
	lastSeenAt: z.string(),
	removedAt: z.string().nullable(),
});
export type CatalogMcpResourceTemplate = z.infer<
	typeof CatalogMcpResourceTemplateSchema
>;

export const CatalogMcpPromptSchema = z.object({
	id: z.string(),
	promptName: z.string(),
	title: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional display title added by newer servers; older catalog rows may omit it.",
		),
	description: z.string().nullable(),
	arguments: z
		.array(
			z.object({
				name: z.string(),
				description: z.string().optional(),
				required: z.boolean().optional(),
			}),
		)
		.nullable(),
	icons: z
		.array(ToolIconSchema)
		.nullable()
		.optional()
		.describe(
			"Optional upstream icon metadata; null or absence means no icon was observed.",
		),
	annotations: z
		.object({
			audience: z
				.array(z.string())
				.optional()
				.describe(
					"Optional upstream audience annotation, retained losslessly.",
				),
			priority: z
				.number()
				.optional()
				.describe("Optional upstream priority annotation."),
			lastModified: z
				.string()
				.optional()
				.describe("Optional upstream last-modified annotation."),
		})
		.nullable()
		.optional()
		.describe(
			"Optional MCP annotations; null or absence reflects upstream omission or legacy rows.",
		),
	meta: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.optional()
		.describe("Optional upstream extension metadata, preserved when supplied."),
	detectedAt: z.string(),
	lastSeenAt: z.string(),
	removedAt: z.string().nullable(),
});

export const CatalogMcpSkillSchema = z.object({
	id: z.string(),
	skillUri: z.string(),
	frontmatter: z.record(z.string(), JsonValueSchema),
	resources: z.union([
		z.array(
			z.object({
				uri: z.string(),
				digest: z.string(),
				size: z.number().int().nonnegative(),
			}),
		),
		z.literal("dynamic"),
	]),
	detectedAt: z.string(),
	lastSeenAt: z.string(),
});
export type CatalogMcpPrompt = z.infer<typeof CatalogMcpPromptSchema>;

// ============================================================
// App Summary Schema (for list views)
// ============================================================

export const CatalogAppSummarySchema = z.object({
	id: z.string(),
	slug: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	logoUrl: z.string().nullable(),
	// Use string to accept any category from DB (may have values not in our enum)
	category: z.string().nullable(),
	developer: z.string().nullable(),
	website: z.string().nullable(),
	// Use string to accept any connector type from DB
	connectorType: z.string().nullable(),
	// Use string to accept any developer type from DB
	developerType: z.string().nullable(),
	hasWrites: z.boolean().nullable(),
	hasInteractive: z.boolean().nullable(),
	// Use string to accept any health status from DB
	healthStatus: z.string().nullable(),
	healthUptimePercent: z.number().nullable(),
	mcpToolCount: z.number().nullable(),
	screenshotUrl: z.string().nullable(),
});
export type CatalogAppSummary = z.infer<typeof CatalogAppSummarySchema>;

export const CatalogQualitySchema = z.object({
	score: z.number().min(0).max(100),
	label: z.enum(["Excellent", "Good", "Fair", "Thin"]),
	status: z.enum(["publishable", "thin", "needs_review", "quarantined"]),
	logoStatus: z.enum([
		"normalized",
		"inline_svg",
		"external_url",
		"internal_url",
		"missing",
	]),
	sourceConfidence: z.enum(["official", "high", "medium", "low"]),
	freshnessStatus: z.enum(["fresh", "aging", "stale", "unknown"]),
	signals: z.array(z.string()),
});
export type CatalogQuality = z.infer<typeof CatalogQualitySchema>;

export const CatalogInstallabilitySchema = z.object({
	installable: z.boolean(),
	state: z.enum([
		"installable",
		"listing_only",
		"service_connector",
		"needs_base_app",
		"needs_mcp_endpoint",
		"disabled",
	]),
	reason: z.string(),
});
export type CatalogInstallability = z.infer<typeof CatalogInstallabilitySchema>;

/**
 * Catalog App List Item - Extended summary for list views with more metadata
 * (Used by landing page catalog grid)
 */
export const CatalogAppListItemSchema = z.object({
	id: z.string(),
	source: SourceSchema.nullable(),
	sourceAppId: z.string().nullable(),
	slug: z.string().nullable(),
	regions: z.array(z.string()).nullable(),
	name: z.string(),
	description: z.string().nullable(),
	logoUrl: z.string().nullable(),
	/** Inline SVG logo from system_hints (raw SVG markup) */
	svgLogo: z.string().nullable().optional(),
	category: z.string().nullable(),
	developer: z.string().nullable(),
	website: z.string().nullable(),
	connectorType: z.string().nullable(),
	developerType: z.string().nullable(),
	hasWrites: z.boolean().nullable(),
	hasInteractive: z.boolean().nullable(),
	hasFileSearch: z.boolean().nullable(),
	keywordsForTriggering: z.array(z.string()).nullable(),
	version: z.string().nullable(),
	screenshotUrl: z.string().nullable(),
	healthStatus: z.string().nullable(),
	healthUptimePercent: z.number().nullable(),
	mcpToolCount: z.number().nullable(),
	sourceCreatedAt: z.string().nullable(),
	lastSyncedAt: z.string().nullable(),
	toolSource: CatalogToolSourceSchema.nullable(),
	quality: CatalogQualitySchema,
	installability: CatalogInstallabilitySchema,
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type CatalogAppListItem = z.infer<typeof CatalogAppListItemSchema>;

// ============================================================
// Full App Schema (for detail views)
// ============================================================

export const CatalogAppDetailSchema = z.object({
	// Identity
	id: z.string(),
	slug: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	modelDescription: z.string().nullable(),

	// MCP Endpoint
	baseUrl: z.string().nullable(),
	mcpEndpointNormalized: z.string().nullable(),
	toolSource: CatalogToolSourceSchema.nullable(),

	// Classification (use string to accept any value from DB)
	connectorType: z.string().nullable(),
	distributionChannel: z.string().nullable(),
	developerType: z.string().nullable(),
	status: z.string().nullable(),

	// Branding (use string to accept any category from DB)
	category: z.string().nullable(),
	developer: z.string().nullable(),
	website: z.string().nullable(),
	privacyPolicy: z.string().nullable(),
	termsOfService: z.string().nullable(),
	logoUrl: z.string().nullable(),
	/** Inline SVG logo from system_hints (raw SVG markup) */
	svgLogo: z.string().nullable().optional(),
	logoUrlDark: z.string().nullable(),
	screenshots: z.array(z.string()).nullable(),

	// Discovery
	keywordsForDiscovery: z.array(z.string()).nullable(),
	keywordsForTriggering: z.array(z.string()).nullable(),

	// Capabilities
	hasWrites: z.boolean().nullable(),
	hasInteractive: z.boolean().nullable(),
	hasFileSearch: z.boolean().nullable(),
	hasDeepResearch: z.boolean().nullable(),
	hasSync: z.boolean().nullable(),
	authTypes: z.array(z.string()).nullable(),

	// MCP Server Metadata
	mcpServerName: z.string().nullable(),
	mcpServerVersion: z.string().nullable(),
	mcpToolCount: z.number().nullable(),
	mcpResourceCount: z.number().nullable(),
	mcpPromptCount: z.number().nullable(),
	mcpLastScannedAt: z.string().nullable(),
	mcpInstructions: z.string().nullable(),

	// Health Status (use string to accept any status from DB)
	healthStatus: z.string().nullable(),
	healthLastCheckedAt: z.string().nullable(),
	healthConnectTimeMs: z.number().nullable(),
	healthUptimePercent: z.number().nullable(),
	healthErrorMessage: z.string().nullable(),

	// Enrichment Data
	screenshotUrl: z.string().nullable(),
	enrichedDescription: z.string().nullable(),
	seoDescription: z.string().nullable(),
	socialLinks: z.array(z.string()).nullable(),
	examplePrompts: z
		.array(
			z.object({
				raw: z.string(),
				cleanPrompt: z.string(),
				appMention: z.string(),
				screenshotUrl: z.string().nullable().optional(),
				sourceFileId: z.string().nullable().optional(),
				confidence: z.number().nullable().optional(),
				source: z.enum(["markdown", "raw_html", "sync"]).optional(),
			}),
		)
		.nullable(),
	categories: z.array(z.string()).nullable(),
	enrichedAt: z.string().nullable(),

	// Computed discoverability insights (API-generated)
	discoverability: z.object({
		score: z.number().min(0).max(100),
		label: z.enum(["Excellent", "Good", "Fair", "Low"]),
		criteria: z.array(
			z.object({
				label: z.string(),
				score: z.number(),
				max: z.number(),
			}),
		),
		tips: z.array(
			z.object({
				tip: z.string(),
				priority: z.enum(["high", "medium", "low"]),
			}),
		),
	}),
	quality: CatalogQualitySchema,
	installability: CatalogInstallabilitySchema,

	// Timestamps
	lastSyncedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	sourceCreatedAt: z.string().nullable(),

	// Relations (populated when requested)
	storeListings: z.array(CatalogStoreListingSchema).optional(),
	tools: z.array(CatalogMcpToolWithMetricsSchema).optional(),
	resources: z.array(CatalogMcpResourceSchema).optional(),
	resourceTemplates: z.array(CatalogMcpResourceTemplateSchema).optional(),
	prompts: z.array(CatalogMcpPromptSchema).optional(),
	skills: z
		.array(CatalogMcpSkillSchema)
		.optional()
		.describe(
			"Populated when catalog detail relations are requested; omitted from lighter list projections.",
		),
});
export type CatalogAppDetail = z.infer<typeof CatalogAppDetailSchema>;

// ============================================================
// List Apps Input/Output
// ============================================================

export const ListCatalogAppsInputSchema = z.object({
	search: z.string().optional(),
	category: z.string().optional(),
	connectorType: ConnectorTypeSchema.optional(),
	developerType: DeveloperTypeSchema.optional(),
	hasInteractive: z.coerce.boolean().optional(),
	hasWrites: z.coerce.boolean().optional(),
	healthStatus: HealthStatusSchema.optional(),
	region: z.string().optional(),
	source: SourceSchema.optional(),
	tag: z.string().optional(),
	sortBy: z
		.enum(["sourceCreatedAt", "updatedAt", "lastSyncedAt", "name", "relevance"])
		.optional(),
	sortDir: z.enum(["asc", "desc"]).optional(),
	limit: z.coerce.number().min(1).max(200).default(50),
	offset: z.coerce.number().min(0).default(0),
});
export type ListCatalogAppsInput = z.infer<typeof ListCatalogAppsInputSchema>;

export const ListCatalogAppsOutputSchema = z.object({
	apps: z.array(CatalogAppListItemSchema),
	total: z.number(),
	pagination: z.object({
		limit: z.number(),
		offset: z.number(),
		hasMore: z.boolean(),
	}),
});
export type ListCatalogAppsOutput = z.infer<typeof ListCatalogAppsOutputSchema>;

// ============================================================
// Category Counts
// ============================================================

export const CategoryCountSchema = z.object({
	name: z.string(),
	label: z.string(),
	count: z.number(),
});
export type CategoryCount = z.infer<typeof CategoryCountSchema>;

export const GetCategoriesOutputSchema = z.array(CategoryCountSchema);
export type GetCategoriesOutput = z.infer<typeof GetCategoriesOutputSchema>;

// ============================================================
// Statistics
// ============================================================

export const CatalogStatsSchema = z.object({
	total: z.number(),
	mcp: z.number(),
	withInteractive: z.number(),
	withWrites: z.number(),
	sourceBreakdown: z.array(
		z.object({
			source: z.string(),
			count: z.number(),
		}),
	),
	lastSyncedAt: z.string().nullable(),
	syncSource: z.string().nullable(),
	autoSyncEnabledBaseApps: z.number().optional(),
});
export type CatalogStats = z.infer<typeof CatalogStatsSchema>;

// ============================================================
// Health Summary
// ============================================================

export const HealthSummarySchema = z.object({
	total: z.number(),
	healthy: z.number(),
	degraded: z.number(),
	unhealthy: z.number(),
	requiresAuth: z.number(),
	blocked: z.number(),
	unsupported: z.number(),
	unknown: z.number(),
	qualityScorecard: z.object({
		version: z.literal("catalog_quality_v1"),
		score: z.number().min(0).max(100),
		grade: z.enum(["healthy", "needs_attention", "critical"]),
		measuredAt: z.string(),
		dimensions: z.object({
			healthClassifiedPercent: z.number().min(0).max(100),
			freshProtocolPercent: z.number().min(0).max(100),
			backlogClearPercent: z.number().min(0).max(100),
		}),
		remediation: z.array(
			z.object({
				key: z.enum([
					"scan_backlog",
					"unhealthy_inventory",
					"protocol_freshness",
				]),
				severity: z.enum(["warning", "critical"]),
				count: z.number().int().nonnegative(),
				action: z.string(),
			}),
		),
	}),
	protocolInventory: z.object({
		modern2026: z.number(),
		legacyStreamable: z.number(),
		legacySse: z.number(),
		unknown: z.number(),
		freshWithin24h: z.object({
			modern2026: z.number(),
			legacyStreamable: z.number(),
			legacySse: z.number(),
			unknown: z.number(),
		}),
		staleOrUnscanned: z.number(),
		enabled: z.object({
			total: z.number(),
			modern2026: z.number(),
			legacyStreamable: z.number(),
			legacySse: z.number(),
			unknown: z.number(),
			freshWithin24h: z.object({
				modern2026: z.number(),
				legacyStreamable: z.number(),
				legacySse: z.number(),
				unknown: z.number(),
			}),
			staleOrUnscanned: z.number(),
		}),
		tedixOwned: z.object({
			total: z.number(),
			modern2026: z.number(),
			legacyStreamable: z.number(),
			legacySse: z.number(),
			unknown: z.number(),
			freshWithin24h: z.object({
				modern2026: z.number(),
				legacyStreamable: z.number(),
				legacySse: z.number(),
				unknown: z.number(),
			}),
			staleOrUnscanned: z.number(),
			apps: z.array(
				z.object({
					slug: z.string(),
					endpoint: z.string().url(),
					protocolVersion: z
						.string()
						.nullable()
						.describe(
							"Null when the latest Tedix-owned endpoint scan did not negotiate a revision.",
						),
					protocolEra: z.enum([
						"modern_2026",
						"legacy_streamable_2025",
						"legacy_sse_2024",
						"unknown",
					]),
					healthStatus: z
						.string()
						.nullable()
						.describe(
							"Null until the Tedix-owned endpoint has a persisted health result.",
						),
					protocolObservedAt: z
						.string()
						.nullable()
						.describe(
							"Null until a scan successfully negotiates a protocol revision with the Tedix-owned endpoint.",
						),
				}),
			),
			appsTruncated: z.boolean(),
		}),
		legacyApps: z.array(
			z.object({
				slug: z.string(),
				protocolVersion: z
					.string()
					.nullable()
					.describe(
						"Null when the last external scan did not negotiate a revision.",
					),
				protocolEra: z.enum(["legacy_streamable_2025", "legacy_sse_2024"]),
				healthStatus: z
					.string()
					.nullable()
					.describe(
						"Null for catalog rows that have not completed a health scan.",
					),
				protocolObservedAt: z
					.string()
					.nullable()
					.describe(
						"Null until a scan successfully negotiates a protocol revision with the endpoint.",
					),
			}),
		),
		legacyAppsTruncated: z.boolean(),
	}),
	compatibilityUsage: z.object({
		status: z.enum(["available", "unconfigured", "unavailable"]),
		from: z.string(),
		to: z.string(),
		sampled: z.literal(true),
		uses: z
			.object({
				external: z.object({
					modern2026: z.number(),
					legacyStreamable: z.number(),
					legacySse: z.number(),
				}),
				firstParty: z.object({
					modern2026: z.number(),
					legacyStreamable: z.number(),
					legacySse: z.number(),
				}),
			})
			.nullable()
			.describe(
				"Null when Analytics Engine querying is unconfigured or temporarily unavailable; never interpret null as zero use.",
			),
		callerClasses: z.array(
			z.object({
				callerClass: z.enum([
					"os",
					"tedi_runtime",
					"human_client",
					"api_client",
					"external_agent",
					"internal_service",
					"unknown",
					"pre_attribution",
				]),
				boundary: z.enum(["external", "first_party"]),
				protocolEra: z.enum([
					"modern_2026",
					"legacy_streamable_2025",
					"legacy_sse_2024",
				]),
				estimatedUses: z.number(),
			}),
		),
		attributionCoverage: z
			.object({
				version: z.literal("caller_class_v1"),
				attributedUses: z.number(),
				unknownUses: z.number(),
				preAttributionUses: z.number(),
				attributedPercent: z.number(),
			})
			.nullable()
			.describe(
				"Null for legacy health snapshots produced before caller attribution coverage was recorded.",
			),
		legacyApps: z.array(
			z.object({
				slug: z.string(),
				protocolEra: z.enum(["legacy_streamable_2025", "legacy_sse_2024"]),
				estimatedUses: z.number(),
				lastObservedAt: z
					.string()
					.nullable()
					.describe(
						"Null only when Analytics Engine returned a legacy aggregate without a valid maximum event timestamp.",
					),
			}),
		),
		legacyAppsTruncated: z.boolean(),
	}),
	scanBacklog: z
		.object({
			totalEnabledMcp: z.number(),
			dueNow: z.number(),
			staleOver24h: z.number(),
			staleOver7d: z.number(),
			skippedRequiresAuth: z.number(),
			skippedBlocked: z.number(),
			blockedZeroToolCandidates: z.number(),
			unhealthyZeroToolCandidates: z.number(),
		})
		.optional(),
});
export type HealthSummary = z.infer<typeof HealthSummarySchema>;

// ============================================================
// Sync Workflow Input/Output
// ============================================================

export const TriggerSyncInputSchema = z.object({
	searchOnly: z
		.boolean()
		.optional()
		.describe(
			"Refresh AI Search from existing enabled catalog records without ingestion or removals.",
		),
	/**
	 * Sync mode:
	 * - "full": Fetch the official registry
	 * - "r2": Read an official registry snapshot from R2
	 * - "upload": Accept JSON data in request body (for small datasets)
	 */
	syncType: z.enum(["full", "incremental", "upload", "r2"]).default("r2"),
	/**
	 * Source dispatch:
	 * - "claude": fetch from Claude MCP Registry API (no r2Path required)
	 * Omit only for explicit R2 maintenance imports.
	 */
	source: z.enum(["claude"]).optional(),
	/**
	 * R2 path to JSON file or folder
	 * Examples:
	 * - "catalog/claude/registry_servers.json" - single official registry snapshot
	 * - "catalog/claude/" - all JSON files in folder
	 */
	r2Path: z.string().optional(),
	/** For upload mode: raw JSON data */
	data: z.record(z.string(), JsonValueSchema).optional(),
});
export type TriggerSyncInput = z.infer<typeof TriggerSyncInputSchema>;

export const TriggerSyncOutputSchema = z.object({
	success: z.boolean(),
	syncLogId: z.string(),
	workflowInstanceId: z.string().optional(),
	message: z.string(),
	/** Files queued for processing (R2 mode) */
	filesQueued: z.array(z.string()).optional(),
});
export type TriggerSyncOutput = z.infer<typeof TriggerSyncOutputSchema>;

// ============================================================
// Claude Registry Sync Input/Output
// ============================================================

export const SyncClaudeRegistryInputSchema = z.object({});
export type SyncClaudeRegistryInput = z.infer<
	typeof SyncClaudeRegistryInputSchema
>;

export const SyncClaudeRegistryOutputSchema = z.object({
	success: z.boolean(),
	serverCount: z.number(),
	syncLogId: z.string().optional(),
	workflowInstanceId: z.string().optional(),
	message: z.string(),
});
export type SyncClaudeRegistryOutput = z.infer<
	typeof SyncClaudeRegistryOutputSchema
>;

// ============================================================
// Scan Workflow Input/Output
// ============================================================

export const TriggerScanInputSchema = z.object({
	limit: z.coerce.number().min(1).max(200).default(50),
	maxAgeHours: z.coerce.number().min(1).max(168).default(24),
	catalogAppIds: z.array(z.string().uuid()).optional(),
});
export type TriggerScanInput = z.infer<typeof TriggerScanInputSchema>;

export const TriggerScanOutputSchema = z.object({
	success: z.boolean(),
	appsQueued: z.number(),
	workflowInstanceId: z.string().optional(),
	message: z.string(),
});
export type TriggerScanOutput = z.infer<typeof TriggerScanOutputSchema>;

// ============================================================
// Tool Testing Input/Output
// ============================================================

export const TestTypeSchema = z.enum(["programmatic", "ai_eval"]);
export type TestType = z.infer<typeof TestTypeSchema>;

export const InputSourceSchema = z.enum([
	"schema_generated",
	"ai_generated",
	"manual",
]);
export type InputSource = z.infer<typeof InputSourceSchema>;

export const TestErrorClassSchema = z.enum([
	"validation",
	"timeout",
	"auth",
	"server_error",
	"unknown",
]);
export type TestErrorClass = z.infer<typeof TestErrorClassSchema>;

/**
 * Tool test result - individual test run
 */
export const ToolTestResultSchema = z.object({
	id: z.string(),
	catalogAppId: z.string(),
	toolName: z.string(),
	testedAt: z.string(),

	// Test configuration
	testType: TestTypeSchema,
	inputSource: InputSourceSchema,

	// Results
	success: z.boolean(),
	latencyMs: z.number().nullable(),
	errorMessage: z.string().nullable(),
	errorClass: TestErrorClassSchema.nullable(),

	// I/O capture
	inputUsed: z.record(z.string(), JsonValueSchema).nullable(),
	outputReceived: JsonValueSchema.nullable(),
	outputValid: z.boolean().nullable(),

	// AI eval specific
	aiModel: z.string().nullable(),
	aiPromptUsed: z.string().nullable(),
	aiToolSelectionCorrect: z.boolean().nullable(),
	aiOutputQualityScore: z.number().nullable(),
	aiTokensUsed: z.number().nullable(),
});
export type ToolTestResult = z.infer<typeof ToolTestResultSchema>;

/**
 * Extended MCP tool schema with test metrics
 */
export const CatalogMcpToolWithTestsSchema = CatalogMcpToolSchema.extend({
	// Test metrics
	lastTestedAt: z.string().nullable(),
	lastTestSuccess: z.boolean().nullable(),
	testSuccessRate: z.number().nullable(),
	avgLatencyMs: z.number().nullable(),
	testCount: z.number().nullable(),
	exampleInput: z.record(z.string(), JsonValueSchema).nullable(),
	exampleOutput: JsonValueSchema.nullable(),
	aiClarityScore: z.number().nullable(),
});
export type CatalogMcpToolWithTests = z.infer<
	typeof CatalogMcpToolWithTestsSchema
>;

/**
 * Trigger tool test workflow input
 */
export const TriggerToolTestInputSchema = z.object({
	/** Maximum number of tools to test (default 50) */
	limit: z.coerce.number().min(1).max(200).default(50),
	/** Max age in hours before re-testing (default 24) */
	maxAgeHours: z.coerce.number().min(1).max(168).default(24),
	/** Test type: programmatic (fast, free) or ai_eval (smart, costs tokens) */
	testType: TestTypeSchema.default("programmatic"),
	/** Timeout per tool test in ms (default 15000) */
	timeout: z.coerce.number().min(1000).max(60000).default(15000),
	/** Optional: specific app IDs to test tools for */
	appIds: z.array(z.string()).optional(),
	/** Optional: specific tool names to test */
	toolNames: z.array(z.string()).optional(),
});
export type TriggerToolTestInput = z.infer<typeof TriggerToolTestInputSchema>;

/**
 * Trigger tool test workflow output
 */
export const TriggerToolTestOutputSchema = z.object({
	success: z.boolean(),
	toolsQueued: z.number(),
	workflowInstanceId: z.string().optional(),
	message: z.string(),
});
export type TriggerToolTestOutput = z.infer<typeof TriggerToolTestOutputSchema>;

/**
 * Tool test statistics
 */
export const ToolTestStatsSchema = z.object({
	totalTools: z.number(),
	testedTools: z.number(),
	untestedTools: z.number(),
	totalTests: z.number(),
	successfulTests: z.number(),
	failedTests: z.number(),
	overallSuccessRate: z.number(),
	avgLatencyMs: z.number().nullable(),
	testsByType: z.object({
		programmatic: z.number(),
		ai_eval: z.number(),
	}),
	testsByErrorClass: z.record(z.string(), z.number()),
});
export type ToolTestStats = z.infer<typeof ToolTestStatsSchema>;

// ============================================================
// Changelog Schemas
// ============================================================

export const CatalogChangeSchema = z.object({
	id: z.string(),
	catalogAppId: z.string(),
	changeType: z.enum(["added", "removed", "updated", "version_bump"]),
	fieldName: z.string().nullable(),
	oldValue: z.string().nullable(),
	newValue: z.string().nullable(),
	versionBefore: z.string().nullable(),
	versionAfter: z.string().nullable(),
	detectedAt: z.string(),
	syncLogId: z.string().nullable(),
});
export type CatalogChange = z.infer<typeof CatalogChangeSchema>;

export const GetAppChangelogInputSchema = z.object({
	id: z.string(),
	limit: z.coerce.number().min(1).max(200).default(50),
});
export type GetAppChangelogInput = z.infer<typeof GetAppChangelogInputSchema>;

export const GetAppChangelogOutputSchema = z.object({
	changes: z.array(CatalogChangeSchema),
	total: z.number(),
});
export type GetAppChangelogOutput = z.infer<typeof GetAppChangelogOutputSchema>;

export const GetRecentChangesInputSchema = z.object({
	limit: z.coerce.number().min(1).max(200).default(100),
	changeType: z
		.enum(["added", "removed", "updated", "version_bump"])
		.optional(),
});
export type GetRecentChangesInput = z.infer<typeof GetRecentChangesInputSchema>;

export const GetRecentChangesOutputSchema = z.object({
	changes: z.array(CatalogChangeSchema),
	total: z.number(),
});
export type GetRecentChangesOutput = z.infer<
	typeof GetRecentChangesOutputSchema
>;

// ============================================================

/**
 * Get tool tests input
 */
export const GetToolTestsInputSchema = z.object({
	catalogAppId: z.string().optional(),
	toolName: z.string().optional(),
	testType: TestTypeSchema.optional(),
	successOnly: z.boolean().optional(),
	limit: z.coerce.number().min(1).max(100).default(50),
	offset: z.coerce.number().min(0).default(0),
});
export type GetToolTestsInput = z.infer<typeof GetToolTestsInputSchema>;

/**
 * Get tool tests output
 */
export const GetToolTestsOutputSchema = z.object({
	tests: z.array(ToolTestResultSchema),
	total: z.number(),
	pagination: z.object({
		limit: z.number(),
		offset: z.number(),
		hasMore: z.boolean(),
	}),
});
export type GetToolTestsOutput = z.infer<typeof GetToolTestsOutputSchema>;

// ============================================================
// Install from Catalog
// ============================================================

export const InstallFromCatalogInputSchema = z.object({
	catalogAppId: z.string().uuid(),
	slug: z.string().min(1).max(100).optional(),
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).optional(),
	visibility: z.enum(["public", "private"]).default("private"),
	connectionProviderId: z
		.string()
		.optional()
		.describe("Descope outbound app ID for the installed proxy app"),
	connectionScope: z
		.enum(["tenant", "user", "hybrid"])
		.optional()
		.describe("Token scope for the installed proxy app"),
	connectionScopes: z.array(z.string()).optional(),
});
export type InstallFromCatalogInput = z.infer<
	typeof InstallFromCatalogInputSchema
>;

export const InstallFromCatalogOutputSchema = z.object({
	app: z.object({
		id: z.string().uuid(),
		organizationId: z.string().uuid(),
		name: z.string(),
		slug: z.string(),
		description: z.string().nullable(),
		logoUrl: z.string().nullable(),
		visibility: z.string().nullable(),
		discoveryStatus: z.string().nullable(),
		createdAt: z.string().nullable(),
		updatedAt: z.string().nullable(),
	}),
	catalogAppId: z.string(),
	catalogAppName: z.string(),
});
export type InstallFromCatalogOutput = z.infer<
	typeof InstallFromCatalogOutputSchema
>;

// ============================================================
// Tenant MCP App Install (catalog → org proxy → aggregator)
// ============================================================

const TenantMcpInstallScopeSchema = z.enum([
	"mcp:tedis.read",
	"mcp:tedis.write",
	"mcp:tedis.admin",
	"mcp:apps.read",
	"mcp:apps.write",
	"mcp:apps.admin",
	"mcp:memory.read",
	"mcp:memory.write",
	"mcp:memory.admin",
	"mcp:skills.read",
	"mcp:skills.write",
	"mcp:skills.admin",
	"mcp:content.read",
	"mcp:content.write",
	"mcp:content.admin",
	"mcp:catalog.read",
	"mcp:catalog.write",
	"mcp:catalog.admin",
	"mcp:observe.read",
	"mcp:observe.write",
	"mcp:observe.admin",
	"mcp:messaging.read",
	"mcp:messaging.write",
	"mcp:messaging.admin",
	"mcp:settings.read",
	"mcp:settings.write",
	"mcp:settings.admin",
]);

export const InstallTenantMcpAppInputSchema = z
	.object({
		catalogAppId: z.string().uuid().optional(),
		catalogAppSlug: z.string().min(1).max(120).optional(),
		targetAggregatorSlug: z
			.string()
			.min(1)
			.max(100)
			.describe(
				"Caller-owned aggregator app to attach the installed proxy to.",
			),
		slug: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe(
				"Optional proxy app slug. Defaults to {baseAppSlug}-{orgSlug}.",
			),
		name: z.string().min(1).max(200).optional(),
		description: z.string().max(1000).optional(),
		visibility: z.enum(["public", "private"]).default("private"),
		prefix: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[a-z][a-z0-9_]*$/)
			.optional()
			.describe("Code Mode namespace prefix for the aggregator entry."),
		connectionProviderId: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe(
				"Optional Descope outbound app ID to bind the tenant proxy namespace to.",
			),
		connectionScope: z
			.enum(["tenant", "user", "hybrid"])
			.optional()
			.describe(
				"Credential scope for the installed namespace. Defaults to tenant when a connection provider is configured.",
			),
		connectionScopes: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Optional provider scopes required by the installed namespace.",
			),
		organizationQueryParam: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
			.optional()
			.describe(
				"Optional upstream query-parameter name whose value is always derived from the caller organization slug. Use for prepared multitenant apps that require an org selector; callers cannot supply another tenant's value.",
			),
		toolScopes: z
			.array(TenantMcpInstallScopeSchema)
			.min(1)
			.default(["mcp:content.write"])
			.describe(
				"Scopes required to use the installed namespace from the aggregator. platform:admin is intentionally excluded.",
			),
		dryRun: z.boolean().default(true),
	})
	.refine(
		(value) => Boolean(value.catalogAppId) !== Boolean(value.catalogAppSlug),
		{
			message: "Provide exactly one of catalogAppId or catalogAppSlug",
			path: ["catalogAppId"],
		},
	);
export type InstallTenantMcpAppInput = z.infer<
	typeof InstallTenantMcpAppInputSchema
>;

export const InstallTenantMcpAppOutputSchema = z.object({
	dryRun: z.boolean(),
	created: z.boolean(),
	attached: z.boolean(),
	/**
	 * True when the app is bound to a tenant/hybrid-scoped OAuth provider that has
	 * no tenant credential yet — a human must complete a one-time consent before
	 * the app's tools work. An operator should surface `connectUrl` to a human.
	 */
	requiresConnection: z.boolean().optional(),
	/**
	 * Deep-link to the connections page's Connect button, pre-selecting the
	 * provider. Behaves exactly like clicking Connect (tenant-scoped grant). Null
	 * when no connection is required. Prefer this over any pre-minted authorize
	 * URL, which lands a user-scoped grant.
	 */
	connectUrl: z.string().nullable().optional(),
	/** Human-readable next-step message when requiresConnection is true. */
	connectionMessage: z.string().nullable().optional(),
	proxyApp: z.object({
		id: z.string().uuid().nullable(),
		organizationId: z.string().uuid(),
		name: z.string(),
		slug: z.string(),
		visibility: z.string().nullable(),
		sourceAppId: z.string().uuid(),
		catalogAppId: z.string().uuid(),
	}),
	targetAggregator: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		organizationId: z.string().uuid(),
	}),
	baseApp: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		name: z.string(),
	}),
	catalogApp: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		name: z.string(),
	}),
	aggregateEntry: z.object({
		slug: z.string(),
		appId: z.string().uuid().optional(),
		prefix: z.string().optional(),
		connectionProviderId: z.string().optional(),
		connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
		connectionScopes: z.array(z.string()).optional(),
		forwardedQueryParams: z.record(z.string(), z.string()).optional(),
	}),
	toolScopes: z.array(TenantMcpInstallScopeSchema),
	summary: z.string(),
});
export type InstallTenantMcpAppOutput = z.infer<
	typeof InstallTenantMcpAppOutputSchema
>;

/**
 * Chat-friendly batch install. Queries are resolved against the canonical
 * catalog at execution time so operators may use product names (for example,
 * "Outlook") instead of having to know Tedix catalog slugs.
 */
export const InstallTenantMcpAppsInputSchema = z.object({
	catalogAppQueries: z
		.array(z.string().trim().min(1).max(120))
		.min(1)
		.max(10)
		.describe("Catalog app names or slugs to resolve and install."),
	targetAggregatorSlug: z
		.string()
		.min(1)
		.max(100)
		.describe("Caller-owned aggregator app to attach installed proxies to."),
	dryRun: z.boolean().default(false),
});
export type InstallTenantMcpAppsInput = z.infer<
	typeof InstallTenantMcpAppsInputSchema
>;

export const TenantMcpBatchInstallResultSchema = z.object({
	query: z.string(),
	status: z.enum(["installed", "would_install", "blocked", "not_found"]),
	catalogAppId: z.string().uuid().nullable(),
	catalogAppSlug: z.string().nullable(),
	catalogAppName: z.string().nullable(),
	proxySlug: z.string().nullable(),
	requiresConnection: z.boolean(),
	connectUrl: z.string().nullable(),
	reason: z.string().nullable(),
});

export const InstallTenantMcpAppsOutputSchema = z.object({
	dryRun: z.boolean(),
	installedCount: z.number().int().nonnegative(),
	blockedCount: z.number().int().nonnegative(),
	results: z.array(TenantMcpBatchInstallResultSchema),
	summary: z.string(),
});
export type InstallTenantMcpAppsOutput = z.infer<
	typeof InstallTenantMcpAppsOutputSchema
>;

export const UninstallTenantMcpAppInputSchema = z
	.object({
		targetAggregatorSlug: z
			.string()
			.min(1)
			.max(100)
			.describe("Caller-owned aggregator app to detach the namespace from."),
		slug: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.optional()
			.describe("Proxy app slug to detach from the aggregator."),
		prefix: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[a-z][a-z0-9_]*$/)
			.optional()
			.describe("Optional Code Mode namespace prefix to detach."),
		removeToolScopes: z
			.boolean()
			.default(true)
			.describe(
				"Remove the detached namespace's tool-scope entries from the aggregator.",
			),
		dryRun: z.boolean().default(true),
	})
	.refine((value) => Boolean(value.slug) || Boolean(value.prefix), {
		message: "Provide slug or prefix",
		path: ["slug"],
	});
export type UninstallTenantMcpAppInput = z.infer<
	typeof UninstallTenantMcpAppInputSchema
>;

const TenantMcpAggregateEntrySchema = z.object({
	slug: z.string(),
	appId: z.string().uuid().optional(),
	prefix: z.string().optional(),
	toolIds: z.array(z.string()).optional(),
	endpointPrefixes: z.array(z.string()).optional(),
	connectionLabel: z.string().optional(),
	connectionProviderId: z.string().optional(),
	connectionInstanceId: z.string().uuid().optional(),
	connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
	connectionScopes: z.array(z.string()).optional(),
});

export const UninstallTenantMcpAppOutputSchema = z.object({
	dryRun: z.boolean(),
	detached: z.boolean(),
	targetAggregator: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		organizationId: z.string().uuid(),
	}),
	aggregateEntry: TenantMcpAggregateEntrySchema.nullable(),
	removedToolScopeKeys: z.array(z.string()),
	remainingAggregateApps: z.array(TenantMcpAggregateEntrySchema),
	summary: z.string(),
});
export type UninstallTenantMcpAppOutput = z.infer<
	typeof UninstallTenantMcpAppOutputSchema
>;

// ============================================================
// Drift Reports
// ============================================================

export const DriftReportSchema = z.object({
	id: z.string(),
	catalogAppId: z.string(),
	catalogAppName: z.string(),
	addedTools: z.number(),
	removedTools: z.number(),
	changedTools: z.number(),
	summary: z.string(),
	checkedAt: z.string(),
	resolvedAt: z.string().nullable(),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

export const GetDriftReportsInputSchema = z.object({
	catalogAppId: z.string().uuid().optional(),
});
export type GetDriftReportsInput = z.infer<typeof GetDriftReportsInputSchema>;

export const GetDriftReportsOutputSchema = z.object({
	reports: z.array(DriftReportSchema),
});
export type GetDriftReportsOutput = z.infer<typeof GetDriftReportsOutputSchema>;

// ============================================================
// Catalog Tool Provenance Maintenance
// ============================================================

export const BackfillCatalogToolProvenanceInputSchema = z.object({
	catalogAppId: z
		.string()
		.uuid()
		.optional()
		.describe("Optional catalog app UUID to backfill a single snapshot."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10_000)
		.default(500)
		.describe("Maximum missing snapshot rows to process in this run."),
	dryRun: z
		.boolean()
		.default(true)
		.describe("Preview without writing when true."),
});
export type BackfillCatalogToolProvenanceInput = z.infer<
	typeof BackfillCatalogToolProvenanceInputSchema
>;

export const BackfillCatalogToolProvenanceItemSchema = z.object({
	catalogAppId: z.string().uuid(),
	catalogAppName: z.string(),
	toolName: z.string(),
	schemaSource: z.enum(TOOL_SCHEMA_SOURCE_VALUES),
	schemaSourceRef: z.string(),
	schemaSourceHash: z.string(),
	sourceCopiedFromAppTool: z.boolean(),
	action: z.enum(["would_update", "updated"]),
});

export const BackfillCatalogToolProvenanceOutputSchema = z.object({
	dryRun: z.boolean(),
	catalogAppId: z.string().uuid().nullable(),
	totalMissing: z.number().int(),
	planned: z.number().int(),
	updated: z.number().int(),
	remaining: z.number().int(),
	items: z.array(BackfillCatalogToolProvenanceItemSchema),
	summary: z.string(),
});
export type BackfillCatalogToolProvenanceOutput = z.infer<
	typeof BackfillCatalogToolProvenanceOutputSchema
>;

// ============================================================
// Catalog Integrity
// ============================================================

export const CheckCatalogIntegrityInputSchema = z.object({
	catalogAppId: z
		.string()
		.uuid()
		.optional()
		.describe("Optional catalog app UUID to check one catalog entry."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10_000)
		.default(1000)
		.describe("Maximum enabled catalog apps to check."),
	apply: z
		.boolean()
		.default(false)
		.describe(
			"Apply safe repairs: provenance backfill and parent mcpToolCount reconciliation.",
		),
	staleLastSeenDays: z
		.number()
		.int()
		.min(1)
		.max(365)
		.default(14)
		.describe(
			"Read-only quality threshold for active snapshot rows whose lastSeenAt is stale.",
		),
});
export type CheckCatalogIntegrityInput = z.infer<
	typeof CheckCatalogIntegrityInputSchema
>;

export const CatalogIntegrityIssueSchema = z.object({
	catalogAppId: z.string().uuid(),
	catalogAppName: z.string(),
	catalogAppSlug: z.string().nullable(),
	toolSource: CatalogToolSourceSchema,
	code: z.enum([
		"missing_base_app",
		"missing_mcp_endpoint",
		"empty_tool_snapshot",
		"tool_count_mismatch",
		"missing_schema_provenance",
		"missing_output_schema",
		"missing_annotations",
		"unresolved_drift",
		"brokered_service_connector",
	]),
	severity: z.enum(["error", "warning"]),
	count: z.number().int(),
	summary: z.string(),
	repairAction: z.enum([
		"backfill_provenance",
		"update_tool_count",
		"reconcile_app",
		"none",
	]),
});
export type CatalogIntegrityIssue = z.infer<typeof CatalogIntegrityIssueSchema>;

export const CatalogQualityIssueSchema = z.object({
	code: z.enum([
		"missing_name",
		"missing_slug",
		"missing_logo",
		"missing_description",
		"weak_description",
		"asset_backfill_candidate",
		"missing_source_id",
		"tenant_proxy_or_internal_leakage",
		"duplicateish_slug",
		"stale_last_seen",
	]),
	severity: z.enum(["error", "warning"]),
	count: z.number().int(),
	summary: z.string(),
	catalogAppId: z.string().uuid().nullable(),
	catalogAppName: z.string().nullable(),
	catalogAppSlug: z.string().nullable(),
	details: z.record(z.string(), JsonValueSchema).optional(),
});
export type CatalogQualityIssue = z.infer<typeof CatalogQualityIssueSchema>;

export const CatalogQualityReportSchema = z.object({
	checkedAt: z.string(),
	catalogAppId: z.string().uuid().nullable(),
	staleLastSeenDays: z.number().int(),
	issueCount: z.number().int(),
	errorCount: z.number().int(),
	warningCount: z.number().int(),
	issues: z.array(CatalogQualityIssueSchema),
	summary: z.string(),
});
export type CatalogQualityReport = z.infer<typeof CatalogQualityReportSchema>;

/**
 * One tool whose write capability nobody has declared.
 *
 * `app_tools.write_capability` is NULL for these, which every gate treats as
 * write-capable (fail closed). The listing exists so the set is a shrinking
 * backlog rather than a permanent silent default.
 */
export const UnclassifiedWriteCapabilityItemSchema = z.object({
	appId: z.string(),
	appSlug: z
		.string()
		.nullable()
		.describe(
			"Null when the owning app row has no slug — a data-quality gap, not a lifecycle state; appId always identifies the app.",
		),
	appName: z.string(),
	toolRowId: z.string(),
	toolId: z.string(),
	toolTypeId: z.string().min(1),
	schemaSource: z
		.string()
		.nullable()
		.describe(
			"Null for hand-seeded rows that came through neither catalog sync nor the oRPC projection — precisely the rows most likely to be unclassified.",
		),
	enabled: z.boolean(),
	reason: z.enum([
		// Upstream never sent annotations — needs an explicit declaration.
		"no_annotations",
		// Annotations exist but say nothing about mutation.
		"inconclusive_annotations",
		// Annotations DO say — re-syncing the app populates the column.
		"stale_sync",
	]),
	derivable: z
		.enum(["read", "write", "destructive"])
		.nullable()
		.describe(
			"What a re-sync would derive from the row's existing annotations, or null when the annotations state nothing and only an explicit declaration can classify the tool.",
		),
});
export type UnclassifiedWriteCapabilityItem = z.infer<
	typeof UnclassifiedWriteCapabilityItemSchema
>;

export const WriteCapabilityReportSchema = z.object({
	checkedAt: z.string(),
	totalTools: z.number().int(),
	totalApps: z.number().int(),
	listed: z.number().int(),
	truncated: z.boolean(),
	items: z.array(UnclassifiedWriteCapabilityItemSchema),
	summary: z.string(),
});
export type WriteCapabilityReport = z.infer<typeof WriteCapabilityReportSchema>;

export const CheckCatalogIntegrityOutputSchema = z.object({
	apply: z.boolean(),
	catalogAppId: z.string().uuid().nullable(),
	checkedApps: z.number().int(),
	issueCount: z.number().int(),
	errorCount: z.number().int(),
	warningCount: z.number().int(),
	repaired: z.object({
		provenanceRows: z.number().int(),
		toolCounts: z.number().int(),
	}),
	issues: z.array(CatalogIntegrityIssueSchema),
	qualityReport: CatalogQualityReportSchema.optional(),
	writeCapabilityReport: WriteCapabilityReportSchema.optional().describe(
		"Absent on responses produced before this report existed; a fresh integrity run always includes it.",
	),
	summary: z.string(),
});
export type CheckCatalogIntegrityOutput = z.infer<
	typeof CheckCatalogIntegrityOutputSchema
>;

// ============================================================
// Tool Propagation (base app → explicit custom forks)
// ============================================================

export const PropagateToolsInputSchema = z.object({
	sourceAppId: z.string().uuid().describe("Base app to propagate FROM"),
	appIds: z
		.array(z.string().uuid())
		.min(1)
		.describe("Explicit custom-fork apps to propagate TO"),
	applyTypes: z
		.array(
			z.enum([
				"schema_changed",
				"description_changed",
				"metadata_changed",
				"new_tool",
				"removed_tool",
			]),
		)
		.optional(),
	preserveFields: z
		.array(z.string())
		.optional()
		.describe("Config fields to preserve on target (e.g., 'auth.scopes')"),
	dryRun: z.boolean().default(true),
});
export type PropagateToolsInput = z.infer<typeof PropagateToolsInputSchema>;

export const PropagateToolsResultItemSchema = z.object({
	targetAppId: z.string(),
	targetAppName: z.string(),
	toolName: z.string(),
	action: z.enum([
		"created",
		"updated_schema",
		"updated_description",
		"updated_metadata",
		"skipped",
		"would_create",
		"would_update",
	]),
	reason: z.string().optional(),
});

export const PropagateToolsOutputSchema = z.object({
	sourceAppId: z.string(),
	sourceAppName: z.string(),
	dryRun: z.boolean(),
	results: z.array(PropagateToolsResultItemSchema),
	summary: z.string(),
});
export type PropagateToolsOutput = z.infer<typeof PropagateToolsOutputSchema>;

// ============================================================
// Sync Catalog Tools To App (catalog → app tool rows)
// ============================================================

export const SyncCatalogToolsToAppInputSchema = z.object({
	catalogAppId: z.string().uuid().describe("Catalog app to read tools FROM"),
	appId: z
		.string()
		.uuid()
		.describe("App to write tool rows TO; proxy apps are rejected"),
	mcpServerUrl: z
		.string()
		.url()
		.describe(
			"MCP server URL for tool execution (e.g., https://api.peec.ai/mcp)",
		),
	connectionProviderId: z
		.string()
		.optional()
		.describe("Descope outbound app ID for auth (e.g., 'peec')"),
	connectionScope: z
		.enum(["tenant", "user", "hybrid"])
		.optional()
		.describe("Token scope for auth"),
	connectionScopes: z.array(z.string()).optional(),
	dryRun: z.boolean().default(true),
});
export type SyncCatalogToolsToAppInput = z.infer<
	typeof SyncCatalogToolsToAppInputSchema
>;

export const SyncCatalogToolsToAppResultItemSchema = z.object({
	toolName: z.string(),
	action: z.enum([
		"created",
		"updated",
		"disabled",
		"skipped",
		"would_create",
		"would_update",
		"would_disable",
	]),
	reason: z.string().optional(),
});

export const SyncCatalogToolsToAppOutputSchema = z.object({
	catalogAppId: z.string(),
	catalogAppName: z.string(),
	appId: z.string(),
	appName: z.string(),
	mcpServerUrl: z.string(),
	dryRun: z.boolean(),
	results: z.array(SyncCatalogToolsToAppResultItemSchema),
	summary: z.string(),
});
export type SyncCatalogToolsToAppOutput = z.infer<
	typeof SyncCatalogToolsToAppOutputSchema
>;

// ============================================================
// OpenAPI Import (catalog-owned REST tool projection)
// ============================================================

export const OpenApiImportInputSchema = z.object({
	appId: z.string().uuid().describe("Target app UUID."),
	specUrl: z
		.string()
		.url()
		.optional()
		.describe("OpenAPI JSON URL to fetch. Either specUrl or spec must be set."),
	supplementalSpecUrls: z
		.array(z.string().url())
		.max(4)
		.optional()
		.describe(
			"Optional additional OpenAPI documents merged with specUrl. Use for providers that publish one bounded specification per service or action group.",
		),
	spec: JsonValueSchema.optional().describe(
		"Inline OpenAPI JSON object. Either specUrl or spec must be set.",
	),
	baseUrl: z
		.string()
		.url()
		.optional()
		.describe(
			"External API base URL used by generated tools. Required unless stored in metadata.mcpConfig.openApiSync.",
		),
	namespace: z
		.string()
		.min(1)
		.optional()
		.describe("Code Mode namespace stored in config._aggregateNamespace."),
	connectionProviderId: z
		.string()
		.min(1)
		.optional()
		.describe("Descope Token Vault provider ID for generated tool auth."),
	connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
	authScopes: z
		.array(z.string())
		.optional()
		.describe(
			"Required Descope Token Vault scopes for generated external tools. OAuth providers such as Gmail, Google Calendar, or Google Drive use these to request a token with the exact API scopes the tool needs.",
		),
	authHeader: z
		.string()
		.min(1)
		.optional()
		.describe("Credential header name for generated external tools."),
	authTemplate: z
		.string()
		.min(1)
		.optional()
		.describe("Credential header template. Use {token} as the placeholder."),
	authEncoding: z
		.enum(["base64"])
		.optional()
		.describe(
			"Optional credential transform before inserting into authTemplate.",
		),
	staticHeaders: z
		.record(z.string(), z.string())
		.optional()
		.describe("Static headers merged into every generated external request."),
	includeOperationIds: z
		.array(z.string().min(1))
		.nullish()
		.describe(
			"Optional operationId allowlist. Omit to keep the stored allowlist; pass null to clear it so every operation in the spec is imported, including ones added later.",
		),
	includePathPrefixes: z
		.array(z.string().min(1))
		.nullish()
		.describe(
			"Optional OpenAPI path prefix allowlist. Use this to import only a source-owned surface such as /v1/mgmt. Omit to keep the stored allowlist; pass null to clear it.",
		),
	excludePathPrefixes: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Optional OpenAPI path prefix denylist applied after include filters.",
		),
	stripPathPrefixes: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Optional OpenAPI path prefixes to remove from generated external endpoints after filtering.",
		),
	pathReplacements: z
		.record(z.string().min(1), z.string().min(1))
		.optional()
		.describe(
			"Optional exact source-path replacements for provider aliases that cannot be represented by prefix stripping.",
		),
	widgetDefaults: OpenApiWidgetDefaultsSchema.optional().describe(
		"Generic json-render widget defaults for generated REST tools. Keeps app/tool UI config in catalog sync data instead of apps/mcp-ui code.",
	),
	widgetOverrides: z
		.record(z.string(), OpenApiWidgetDefaultsSchema)
		.optional()
		.describe(
			"Per-tool json-render widget overrides keyed by generated tool id or OpenAPI operationId.",
		),
	replaceExisting: z
		.boolean()
		.optional()
		.describe(
			"Delete existing external tools on the target app that are not generated by this import. Defaults to true.",
		),
	dryRun: z.boolean().optional(),
	limit: z.number().int().positive().max(1000).optional(),
});

export const OpenApiImportStatusSchema = z.enum([
	"inSync",
	"wouldCreate",
	"created",
	"wouldUpdate",
	"updated",
	"wouldDelete",
	"deleted",
	"skipped",
	"failed",
]);

export const OpenApiImportItemSchema = z.object({
	toolId: z.string(),
	operationId: z.string().nullable(),
	method: z.string(),
	path: z.string(),
	status: OpenApiImportStatusSchema,
	message: z.string().optional(),
});

export const OpenApiImportResultSchema = z.object({
	appId: z.string(),
	dryRun: z.boolean(),
	totalOperations: z.number().int(),
	planned: z.number().int(),
	created: z.number().int(),
	updated: z.number().int(),
	inSync: z.number().int(),
	deleted: z.number().int(),
	skipped: z.number().int(),
	failed: z.number().int(),
	items: z.array(OpenApiImportItemSchema),
	profileReconciliations: z
		.array(
			z.object({
				installationId: z.string(),
				fromRevision: z.number().int(),
				toRevision: z
					.number()
					.int()
					.nullable()
					.describe(
						"Revision published by the reconcile, equal to fromRevision when nothing was stale. Null when no revision was written because a route would have been emptied, another publish won the compare-and-swap, or the write failed; the profile is then left at fromRevision.",
					),
				removedCallables: z.array(z.string()),
				status: z.enum([
					"unchanged",
					"reconciled",
					"route_would_empty",
					"conflict",
					"failed",
				]),
				message: z
					.string()
					.optional()
					.describe(
						"Why this installation was not reconciled. Absent when the status needs no explanation, which is every reconciled or unchanged profile.",
					),
			}),
		)
		.optional()
		.describe(
			"Published WebMCP profiles reconciled because this import removed a tool they admitted. Present only when the import deleted tools.",
		),
});

export const OpenApiImportWorkflowOutputSchema = z.object({
	appId: z.string().uuid(),
	workflowId: z.string(),
	status: z.enum(["queued", "running"]),
	message: z.string(),
});

export type OpenApiImportInput = z.infer<typeof OpenApiImportInputSchema>;
export type OpenApiImportResult = z.infer<typeof OpenApiImportResultSchema>;
export type OpenApiImportWorkflowOutput = z.infer<
	typeof OpenApiImportWorkflowOutputSchema
>;

// ============================================================
// Tenant OpenAPI MCP App Creation
// ============================================================

const TenantMcpAppSlugSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9-]*$/)
	.describe("DNS-safe app slug used for the tenant-owned base app.");

const TenantOpenApiConnectionProviderSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z0-9][a-z0-9_-]*$/)
		.optional()
		.describe(
			"Optional stable Descope outbound app ID. Restricted to platform callers; tenant callers get an org-scoped generated ID.",
		),
	type: z.enum(["oauth", "api_key"]).default("api_key"),
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(254).optional(),
	logo: z.string().url().optional(),
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	authorizationUrl: z.string().url().optional(),
	authorizationUrlParams: z
		.array(z.object({ key: z.string(), value: z.string() }))
		.optional(),
	tokenUrl: z.string().url().optional(),
	tokenUrlParams: z
		.array(z.object({ key: z.string(), value: z.string() }))
		.optional(),
	revocationUrl: z.string().url().optional(),
	discoveryUrl: z.string().url().optional(),
	pkce: z.boolean().optional(),
	defaultScopes: z.array(z.string()).optional(),
	defaultRedirectUrl: z.string().url().optional(),
	callbackDomain: z.string().optional(),
	accessType: z.enum(["offline", "online"]).optional(),
	prompt: z
		.array(z.enum(["none", "login", "consent", "select_account"]))
		.optional(),
	useDcr: z.boolean().optional(),
	dcrUrl: z.string().url().optional(),
	credentialProfile: ConnectionCredentialProfileSchema.optional(),
});

export const CreateTenantOpenApiMcpAppInputSchema =
	OpenApiImportInputSchema.omit({
		appId: true,
		dryRun: true,
	})
		.extend({
			appSlug: TenantMcpAppSlugSchema,
			name: z.string().min(1).max(200),
			description: z.string().max(1000).optional(),
			catalogSlug: TenantMcpAppSlugSchema.optional().describe(
				"Optional catalog slug. Defaults to appSlug.",
			),
			targetAggregatorSlug: z
				.string()
				.min(1)
				.max(100)
				.describe(
					"Caller-owned aggregator app to attach the generated proxy to.",
				),
			proxySlug: TenantMcpAppSlugSchema.optional().describe(
				"Optional zero-tool proxy slug. Defaults to {appSlug}-{orgSlug}.",
			),
			prefix: z
				.string()
				.min(1)
				.max(80)
				.regex(/^[a-z][a-z0-9_]*$/)
				.optional()
				.describe("Code Mode namespace prefix for the aggregator entry."),
			visibility: z.enum(["public", "private"]).default("private"),
			toolScopes: z
				.array(TenantMcpInstallScopeSchema)
				.min(1)
				.default(["mcp:content.write"])
				.describe(
					"Scopes required to use the installed namespace from the aggregator. platform:admin is intentionally excluded.",
				),
			category: CategorySchema.optional(),
			developer: z.string().max(300).optional(),
			website: z.string().url().optional(),
			logoUrl: z.string().url().optional(),
			connectionProvider:
				TenantOpenApiConnectionProviderSchema.optional().describe(
					"Provision a dedicated Descope outbound app for this tenant-owned OpenAPI app. Mutually exclusive with connectionProviderId.",
				),
			catalogDiscoverable: z
				.boolean()
				.default(false)
				.describe(
					"Whether the tenant-authored catalog row should appear in public catalog discovery.",
				),
			specText: z
				.string()
				.optional()
				.describe(
					"Inline OpenAPI JSON or YAML text. Parsed into spec before queuing OpenApiSyncWorkflow.",
				),
			dryRun: z.boolean().default(true),
		})
		.refine(
			(value) =>
				Boolean(value.specUrl) ||
				Boolean(value.spec) ||
				Boolean(value.specText),
			{
				message: "Provide one of specUrl, spec, or specText",
				path: ["specUrl"],
			},
		)
		.refine(
			(value) => !(value.connectionProvider && value.connectionProviderId),
			{
				message:
					"Use connectionProvider to provision or connectionProviderId to reuse, not both",
				path: ["connectionProvider"],
			},
		);
export type CreateTenantOpenApiMcpAppInput = z.infer<
	typeof CreateTenantOpenApiMcpAppInputSchema
>;

const TenantOpenApiAppSummarySchema = z.object({
	id: z.string().uuid().nullable(),
	organizationId: z.string().uuid(),
	name: z.string(),
	slug: z.string(),
	catalogAppId: z.string().uuid().nullable(),
});

export const CreateTenantOpenApiMcpAppOutputSchema = z.object({
	dryRun: z.boolean(),
	created: z.object({
		catalogApp: z.boolean(),
		baseApp: z.boolean(),
		proxyApp: z.boolean(),
		connectionProvider: z.boolean(),
	}),
	connectionProvider: z
		.object({
			id: z.string().min(1),
			name: z.string(),
			type: z.enum(["oauth", "api_key"]),
			status: z.enum(["planned", "created", "updated", "existing"]),
		})
		.nullable(),
	catalogApp: z.object({
		id: z.string().uuid().nullable(),
		slug: z.string(),
		name: z.string(),
		source: SourceSchema,
		toolSource: CatalogToolSourceSchema,
		isDiscoverable: z.boolean(),
	}),
	baseApp: TenantOpenApiAppSummarySchema,
	proxyInstall: InstallTenantMcpAppOutputSchema,
	openApiPreview: OpenApiImportResultSchema.nullable(),
	openApiSync: z.object({
		appId: z.string().uuid().nullable(),
		workflowId: z.string().nullable(),
		status: z.enum(["queued", "running", "skipped"]),
		message: z.string(),
	}),
	summary: z.string(),
});
export type CreateTenantOpenApiMcpAppOutput = z.infer<
	typeof CreateTenantOpenApiMcpAppOutputSchema
>;

// ============================================================
// Catalog Reconciliation
// ============================================================

export const ReconcileCatalogAppInputSchema = z.object({
	catalogAppId: z.string().uuid().optional(),
	slug: z.string().min(1).optional(),
	organizationId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Owner org to use when creating a missing upstream-MCP base app.",
		),
	baseAppId: z
		.string()
		.uuid()
		.optional()
		.describe("Override base/custom app to reconcile."),
	mcpServerUrl: z
		.string()
		.url()
		.optional()
		.describe("Override upstream MCP URL for upstream_mcp catalog rows."),
	connectionProviderId: z.string().min(1).optional(),
	connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
	connectionScopes: z.array(z.string()).optional(),
	customForkAppIds: z
		.array(z.string().uuid())
		.default([])
		.describe("Explicit custom-fork app IDs to propagate copied rows to."),
	dryRun: z.boolean().default(true),
});
export type ReconcileCatalogAppInput = z.infer<
	typeof ReconcileCatalogAppInputSchema
>;

export const ReconcileCatalogAppStageSchema = z.object({
	stage: z.enum([
		"resolve",
		"upstream_scan",
		"openapi_import",
		"catalog_projection",
		"catalog_to_app",
		"custom_fork_propagation",
	]),
	status: z.enum(["skipped", "would_run", "completed", "failed"]),
	summary: z.string(),
	data: z.record(z.string(), z.string()).optional(),
});
export type ReconcileCatalogAppStage = z.infer<
	typeof ReconcileCatalogAppStageSchema
>;

export const ReconcileCatalogAppOutputSchema = z.object({
	catalogAppId: z.string().uuid(),
	catalogAppName: z.string(),
	catalogAppSlug: z.string(),
	toolSource: CatalogToolSourceSchema,
	dryRun: z.boolean(),
	baseApp: z
		.object({
			id: z.string().uuid(),
			slug: z.string(),
			name: z.string(),
		})
		.nullable(),
	stages: z.array(ReconcileCatalogAppStageSchema),
	summary: z.string(),
});
export type ReconcileCatalogAppOutput = z.infer<
	typeof ReconcileCatalogAppOutputSchema
>;

// ============================================================
// Create Base App From Catalog
// ============================================================

export const CreateBaseAppFromCatalogInputSchema = z.object({
	catalogAppId: z
		.string()
		.uuid()
		.describe("Catalog entry to create the base app from"),
	organizationId: z
		.string()
		.uuid()
		.describe("Org that will own the base app (typically platform org)"),
	slug: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.describe("Override slug — defaults to catalogApp.slug"),
	name: z.string().min(1).max(200).optional(),
	connectionProviderId: z.string().optional(),
	connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
	connectionScopes: z.array(z.string()).optional(),
	dryRun: z.boolean().default(true),
});
export type CreateBaseAppFromCatalogInput = z.infer<
	typeof CreateBaseAppFromCatalogInputSchema
>;

export const CreateBaseAppFromCatalogOutputSchema = z.object({
	app: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		name: z.string(),
		organizationId: z.string().uuid(),
	}),
	created: z
		.boolean()
		.describe(
			"true if the base app was newly created; false if it already existed",
		),
	sync: SyncCatalogToolsToAppOutputSchema,
});
export type CreateBaseAppFromCatalogOutput = z.infer<
	typeof CreateBaseAppFromCatalogOutputSchema
>;

// ============================================================
// Update Catalog App
// ============================================================

export const AppStatusSchema = z.enum([
	"ENABLED",
	"DISABLED",
	"PENDING",
	"DELISTED",
]);
export type AppStatus = z.infer<typeof AppStatusSchema>;

export const ReviewStatusSchema = z.enum(["RELEASED", "PENDING", "REJECTED"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const UpdateCatalogAppInputSchema = z.object({
	id: z.string().uuid(),
	slug: z.string().min(1).max(200).optional(),
	name: z.string().min(1).max(300).optional(),
	description: z.string().max(2000).optional(),
	modelDescription: z.string().max(2000).optional(),
	seoDescription: z.string().max(500).optional(),
	status: AppStatusSchema.optional(),
	category: CategorySchema.optional(),
	developer: z.string().max(300).optional(),
	website: z.string().url().optional(),
	privacyPolicy: z.string().url().optional(),
	termsOfService: z.string().url().optional(),
	logoUrl: z.string().url().optional(),
	logoUrlDark: z.string().url().optional(),
	connectorType: ConnectorTypeSchema.optional(),
	developerType: DeveloperTypeSchema.optional(),
	keywordsForDiscovery: z.array(z.string()).optional(),
	keywordsForTriggering: z.array(z.string()).optional(),
	examplePrompts: z.array(z.string()).optional(),
	isDiscoverable: z.boolean().optional(),
	baseUrl: z.string().url().optional(),
	toolSource: CatalogToolSourceSchema.optional(),
	authTypes: z
		.array(z.enum(["OAUTH", "API_KEY", "NONE"]))
		.min(1)
		.optional(),
	scanConnectionId: z.string().max(200).nullish(),
	scanOrganizationId: z.string().uuid().nullish(),
	scanConnectionHeader: z.string().max(100).nullish(),
	scanConnectionTemplate: z.string().max(200).nullish(),
});
export type UpdateCatalogAppInput = z.infer<typeof UpdateCatalogAppInputSchema>;

export const UpdateCatalogAppOutputSchema = CatalogAppDetailSchema.nullable();
export type UpdateCatalogAppOutput = z.infer<
	typeof UpdateCatalogAppOutputSchema
>;

// ============================================================
// Update Catalog Store Listing
// ============================================================

export const UpdateCatalogStoreListingInputSchema = z.object({
	id: z.string().uuid(),
	source: SourceSchema.optional(),
	sourceAppId: z.string().min(1).max(500).optional(),
	regions: z.array(z.string().min(1).max(20)).nullable().optional(),
	storeUrl: z.string().url().nullable().optional(),
	reviewStatus: ReviewStatusSchema.nullable().optional(),
	authRequired: z.boolean().nullable().optional(),
	storeLogoUrl: z.string().url().nullable().optional(),
	storeDescription: z.string().max(2000).nullable().optional(),
	popularityScore: z.number().int().nullable().optional(),
	trendingScore: z.number().int().nullable().optional(),
	rank: z.number().int().positive().nullable().optional(),
	worksWith: z.array(z.string().min(1).max(100)).nullable().optional(),
	lastSyncedAt: z.string().optional(),
});
export type UpdateCatalogStoreListingInput = z.infer<
	typeof UpdateCatalogStoreListingInputSchema
>;

export const UpdateCatalogStoreListingOutputSchema =
	CatalogStoreListingSchema.nullable();
export type UpdateCatalogStoreListingOutput = z.infer<
	typeof UpdateCatalogStoreListingOutputSchema
>;

// ============================================================
// Delete Catalog App
// ============================================================

export const DeleteCatalogAppInputSchema = z.object({
	id: z.string().uuid(),
});
export type DeleteCatalogAppInput = z.infer<typeof DeleteCatalogAppInputSchema>;

export const DeleteCatalogAppOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	name: z.string().nullable(),
});
export type DeleteCatalogAppOutput = z.infer<
	typeof DeleteCatalogAppOutputSchema
>;

export const MergeCatalogAppsInputSchema = z.object({
	/** The orphan/duplicate catalog app to merge and delete. */
	fromCatalogAppId: z.string().uuid(),
	/** The canonical catalog app to keep and fold listings onto. */
	intoCatalogAppId: z.string().uuid(),
	/** Preview the merge without mutating (default true). */
	dryRun: z.boolean().optional().default(true),
});
export type MergeCatalogAppsInput = z.infer<typeof MergeCatalogAppsInputSchema>;

export const MergeCatalogAppsOutputSchema = z.object({
	dryRun: z.boolean(),
	intoCatalogAppId: z.string(),
	intoSlug: z.string(),
	fromCatalogAppId: z.string(),
	fromSlug: z.string(),
	relistedListings: z.number().int(),
	droppedSnapshotRows: z.number().int(),
	movedChangeRows: z.number().int(),
	deletedOrphan: z.boolean(),
	summary: z.string(),
});
export type MergeCatalogAppsOutput = z.infer<
	typeof MergeCatalogAppsOutputSchema
>;

// ============================================================
// Create from MCP Endpoint Schemas
// ============================================================

export const CreateFromEndpointInputSchema = z.object({
	mcpEndpointUrl: z
		.string()
		.url()
		.describe("The MCP server endpoint URL (e.g., https://mcp.notion.so/mcp)"),
	name: z.string().optional().describe("Override the server-reported name"),
	description: z
		.string()
		.optional()
		.describe("Override the server-reported description"),
	category: CategorySchema.optional().describe("App category"),
	developer: z.string().optional().describe("Developer/company name"),
	website: z.string().url().optional().describe("Developer website URL"),
	logoUrl: z.string().url().optional().describe("Logo URL"),
	authType: z
		.enum(["OAUTH", "NONE", "API_KEY"])
		.optional()
		.default("NONE")
		.describe("Auth type required by this MCP server"),
	authHeaders: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Auth headers to send when scanning this MCP server (e.g., { Authorization: 'Bearer ...' }). Encrypted and persisted for periodic re-scans.",
		),
	connectionId: z
		.string()
		.optional()
		.describe(
			"Resolve auth from a Descope AIH outbound app connection (e.g., 'promptwatch-api-key'). The token is fetched from Descope Token Vault and combined with connectionHeader to build authHeaders automatically.",
		),
	connectionHeader: z
		.string()
		.optional()
		.default("Authorization")
		.describe(
			"Header name to use when resolving from connectionId (default: 'Authorization'). E.g., 'X-API-Key' for API key auth.",
		),
	connectionTemplate: z
		.string()
		.optional()
		.default("{token}")
		.describe(
			"Template for the header value when resolving from connectionId. Use {token} as placeholder. E.g., 'Bearer {token}' or '{token}'.",
		),
});
export type CreateFromEndpointInput = z.infer<
	typeof CreateFromEndpointInputSchema
>;

export const CreateFromEndpointOutputSchema = z.object({
	catalogApp: z.object({
		id: z.string(),
		slug: z.string().nullable(),
		name: z.string(),
		mcpEndpointNormalized: z.string().nullable(),
	}),
	created: z.boolean(),
	toolsDiscovered: z.number(),
	resourcesDiscovered: z.number(),
	promptsDiscovered: z.number(),
	transport: z.enum(["streamable-http", "sse"]),
	serverName: z.string().nullable(),
	serverVersion: z.string().nullable(),
	healthStatus: z.string(),
	connectTimeMs: z.number(),
});
export type CreateFromEndpointOutput = z.infer<
	typeof CreateFromEndpointOutputSchema
>;

// ============================================================
// Sync Logs (Pipeline Insights)
// ============================================================

export const SyncLogSchema = z.object({
	id: z.string(),
	syncType: z.string(),
	source: z.string().nullable(),
	startedAt: z.string(),
	completedAt: z.string().nullable(),
	appsDiscovered: z.number().nullable(),
	appsUpdated: z.number().nullable(),
	appsRemoved: z.number().nullable(),
	appsFailed: z.number().nullable(),
	status: z.string().nullable(),
	error: z.string().nullable(),
});
export type SyncLog = z.infer<typeof SyncLogSchema>;

export const GetSyncLogsInputSchema = z.object({
	limit: z.number().int().min(1).max(50).optional().default(20),
});
export type GetSyncLogsInput = z.infer<typeof GetSyncLogsInputSchema>;

export const GetSyncLogsOutputSchema = z.object({
	logs: z.array(SyncLogSchema),
});
export type GetSyncLogsOutput = z.infer<typeof GetSyncLogsOutputSchema>;
