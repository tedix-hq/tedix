/**
 * Apps Schema
 * Core AI app entity with discovery pipeline and capabilities configuration
 *
 * TERMINOLOGY:
 * - "App" = A AI app (MCP server) owned by an organization
 * - "Brand" = Visual identity/theming (logo, colors, fonts)
 * - An App HAS branding, but "App" is the entity, not "Brand"
 */

import type {
	AppCapabilities,
	Vertical,
} from "@tedix/api-contract/schemas/app";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ExtractionConfigExpanded as AppExtractionConfig } from "@tedix/api-contract/schemas/extraction-config";
import type { WidgetConfig } from "@tedix/api-contract/schemas/widget";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { appCatalog } from "./catalog";
import { organizations } from "./organizations";

export const apps = sqliteTable(
	"apps",
	{
		id: text("id").primaryKey(),

		// ==========================================================================
		// ORGANIZATION OWNERSHIP (REQUIRED)
		// Every app belongs to an organization for multi-tenant billing/members
		// ==========================================================================
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),

		// ==========================================================================
		// MCP ROUTING & APP STORE CONFIGURATION
		// Routing uses `slug` directly: acme.mcp.tedix.dev -> McpAgent(acme)
		// ==========================================================================

		// Custom domain for enterprise apps (e.g., "mcp.acme.example")
		customMcpDomain: text("custom_mcp_domain").unique(),

		// OpenAI App Store verification token for domain ownership
		// Served at: /.well-known/openai-apps-challenge
		openaiChallengeToken: text("openai_challenge_token"),

		// OpenAI App ID after App Store approval
		openaiAppId: text("openai_app_id"),

		// App Directory submission status
		// draft: Not yet submitted
		// pending_verification: Domain verification in progress
		// pending_review: Submitted for review
		// approved: Live in App Store
		// rejected: Review rejected (see metadata for reason)
		appStoreStatus: text("app_store_status", {
			enum: [
				"draft",
				"pending_verification",
				"pending_review",
				"approved",
				"rejected",
			],
		}).default("draft"),

		// ==========================================================================
		// DISCOVERY PIPELINE
		// For apps that need content discovery/scraping
		// ==========================================================================

		// Discovery Pipeline Status
		// pending: Initial state
		// discovered: Domain validated and reachable
		// scraping: Firecrawl job in progress
		// scraped: Content extracted successfully
		// failed: Discovery/scraping failed
		discoveryStatus: text("discovery_status", {
			enum: ["pending", "discovered", "scraping", "scraped", "failed"],
		}).default("pending"),

		// Primary domain for content discovery (may differ from MCP domain)
		primaryDomain: text("primary_domain"),

		// ==========================================================================
		// VISIBILITY
		// ==========================================================================

		// Visibility Control
		// public: Visible in cross-app aggregator (global search)
		// private: Only visible via app-specific MCP endpoint
		// disabled: Hidden from all MCP agents (admin-only access)
		visibility: text("visibility", {
			enum: ["public", "private", "disabled"],
		}).default("private"),

		// ==========================================================================
		// BRANDING
		// ==========================================================================
		logoUrl: text("logo_url"),

		// ==========================================================================
		// CMS STUDIO TEMPLATE
		// Canonical starter slug used by CMS provisioning. Tenant-specific
		// differentiation now lives in Emdash settings + editable theme files,
		// not alternate starter directories.
		// ==========================================================================

		// ==========================================================================
		// METADATA (JSON)
		// Contains: branding profile, jobIds, webhook data, capabilities
		// ==========================================================================
		metadata: text("metadata", { mode: "json" }).$type<AppMetadata>(),

		// ==========================================================================
		// GATING METADATA (JSON)
		// App requirements, provides, gating config for eligibility engine
		// ==========================================================================
		gatingMetadata: text("gating_metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// ==========================================================================
		// LINEAGE
		// ==========================================================================

		// Self-referential: points to the base app this was derived/installed from
		// e.g. PromptWatch client instances → PromptWatch base app
		sourceAppId: text("source_app_id").references(
			(): AnySQLiteColumn => apps.id,
			{
				onDelete: "set null",
			},
		),

		// Link to the catalog entry this app was installed from
		catalogAppId: text("catalog_app_id").references(() => appCatalog.id, {
			onDelete: "set null",
		}),

		// Config versioning
		// Active version integrity is enforced in app-config-versions queries and
		// represented in relations.ts; a schema FK would create an apps <-> versions
		// import cycle in Drizzle's inferred table types.
		activeConfigVersionId: text("active_config_version_id"),
		latestConfigVersion: integer("latest_config_version").notNull().default(0),

		// Timestamps
		extractedAt: text("extracted_at"),
		aiSearchSyncedAt: text("ai_search_synced_at"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Unique constraint: slug must be unique within an organization
		unique("uniq_app_org_slug").on(table.organizationId, table.slug),
		// Index for organization lookup
		index("idx_app_org").on(table.organizationId),
		// Index for slug lookup (MCP routing)
		index("idx_app_slug").on(table.slug),
		// Index for custom domain routing
		index("idx_app_domain").on(table.customMcpDomain),
		// Index for primary domain lookup
		index("idx_app_primary_domain").on(table.primaryDomain),
		// Index for discovery pipeline queries
		index("idx_app_discovery").on(table.discoveryStatus),
		// Index for visibility filtering
		index("idx_app_visibility").on(table.visibility),
		// Index for active config lookups
		index("idx_app_active_config_version").on(table.activeConfigVersionId),
		// Index for source app lineage queries
		index("idx_app_source").on(table.sourceAppId),
		// Index for catalog linkage queries
		index("idx_app_catalog").on(table.catalogAppId),
		// NOTE: No index on computed `vertical` until Drizzle/D1 supports it reliably.
	],
);

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;

/**
 * App visibility options
 * - public: Visible in cross-app aggregator (global search)
 * - private: Only visible via app-specific MCP endpoint
 * - disabled: Hidden from all MCP agents (admin-only access)
 */
export type AppVisibility = "public" | "private" | "disabled";
export const APP_VISIBILITY_VALUES = ["public", "private", "disabled"] as const;

/**
 * App Directory submission status
 * - draft: Not yet submitted
 * - pending_verification: Domain verification in progress
 * - pending_review: Submitted for review
 * - approved: Live in App Store
 * - rejected: Review rejected (see metadata for reason)
 */
export type AppStoreStatus =
	| "draft"
	| "pending_verification"
	| "pending_review"
	| "approved"
	| "rejected";
export const APP_STORE_STATUS_VALUES = [
	"draft",
	"pending_verification",
	"pending_review",
	"approved",
	"rejected",
] as const;

/**
 * App metadata (stored as JSON in apps.metadata column)
 * SOURCE OF TRUTH - this is the canonical AppMetadata definition
 */
export interface AppMetadata {
	/** Allow additional properties for forward-compatibility with contract schema */
	[key: string]: unknown;
	/** Primary vertical for this app (convenience accessor - also available in capabilities.vertical) */
	vertical?: Vertical;
	branding?: {
		logo?: string | null;
		/** Detected color scheme from page ("light" or "dark") */
		colorScheme?: "light" | "dark" | null;
		colors?: {
			// Core brand colors
			primary?: string | null;
			secondary?: string | null;
			accent?: string | null;
			/** Optional light brand tint for subtle backgrounds and badges. */
			tint?: string | null;
			primaryTint?: string | null;
			/** Optional pressed/hover color for primary interactive elements. */
			primaryHover?: string | null;
			primaryDark?: string | null;
			interactiveHover?: string | null;
			// UI colors
			background?: string | null;
			text?: string | null;
			textSecondary?: string | null;
			link?: string | null;
			// Semantic colors
			success?: string | null;
			warning?: string | null;
			error?: string | null;
		} | null;
		colorsDark?: {
			primary?: string | null;
			secondary?: string | null;
			accent?: string | null;
			tint?: string | null;
			primaryTint?: string | null;
			primaryHover?: string | null;
			primaryDark?: string | null;
			interactiveHover?: string | null;
			background?: string | null;
			text?: string | null;
			textSecondary?: string | null;
			link?: string | null;
			success?: string | null;
			warning?: string | null;
			error?: string | null;
		} | null;
		fonts?: {
			heading?: string | null;
			body?: string | null;
			provider?: string | null;
		} | null;
		/** Main brand/product homepage used by CMS chrome links. */
		homepageUrl?: string | null;
		/** Tenant theme mode. `system` enables light/dark switching; fixed modes hide the switcher. */
		themeMode?: "light" | "dark" | "system" | null;
		images?: {
			logo?: string | null;
			favicon?: string | null;
			ogImage?: string | null;
		} | null;
	} | null;
	brandingExtractedAt?: string;

	/** Social media links for blog footer and external presence */
	socialLinks?: {
		twitter?: string; // e.g., "https://twitter.com/acme"
		linkedin?: string; // e.g., "https://linkedin.com/company/acme"
		github?: string; // e.g., "https://github.com/acme"
		facebook?: string;
		instagram?: string;
		youtube?: string;
		email?: string; // e.g., "contact@acme.example"
	};
	capabilities?: AppCapabilities;
	urlAnalysis?: {
		totalUrls: number;
		listingUrls: number;
		productUrls: number;
		ignoredUrls: number;
		analyzedAt: string;
	};
	itemExtraction?: {
		workflowInstanceId?: string;
		workflowStartedAt?: string;
		itemsExtracted?: number;
		itemsSaved?: number;
		extractErrors?: number;
		pagesScraped?: number;
		completedAt?: string;
		urlsMapped?: number;
		listingUrls?: number;
		productUrls?: number;
		listingPages?: number;
		productPages?: number;
		duration?: string;
		error?: string;
		lastExtractedAt?: string;
		cspDomainsAdded?: number;
		creditsUsed?: number;
		detailPagesScraped?: number;
		method?: string;
		vectorize?: Record<string, JsonValue>;
	};
	itemImport?: {
		lastImportedAt?: string;
		itemsImported?: number;
		itemsSaved?: number;
		method?: string;
		vectorize?: {
			synced?: number;
			failed?: number;
		};
	};
	// Discovery pipeline job IDs
	mapJobId?: string;
	scrapeJobId?: string;
	agentJobId?: string;
	// Discovery pipeline timestamps
	scrapeStartedAt?: string;
	itemExtractionStartedAt?: string;
	itemExtractionError?: string;
	itemExtractionFailedAt?: string;
	itemExtractionCompletedAt?: string;
	// Agent discovery fields
	agentDiscoveredAt?: string;
	agentItemsExtracted?: number;
	agentCompletedAt?: string;
	// Scraping metrics
	urlsScraped?: number;
	urlsFailed?: number;
	totalUrls?: number;
	// General metadata
	manuallyCreated?: boolean;
	createdAt?: string;
	error?: string;
	failedAt?: string;
	// Widget configuration
	widgetConfig?: WidgetConfig;
	// Extraction configuration
	extractionConfig?: AppExtractionConfig;
	// MCP Server configuration for Apps SDK
	mcpConfig?: McpConfig;

	/**
	 * Content AI configuration
	 * Controls AI model, temperature, and answer generation behavior
	 */
	contentConfig?: ContentConfig;

	/**
	 * API behavior configuration
	 * Controls rate limiting and other API-level settings
	 */
	apiConfig?: ApiConfig;

	/**
	 * Custom configuration for search_content bootstrap tool
	 * Allows apps to customize the content search / help tool
	 */
	contentToolConfig?: {
		title?: string;
		description?: string;
	};

	/**
	 * Blog configuration for app
	 * Controls blog settings and AI content generation
	 */
	blogConfig?: {
		/** Whether blog is enabled for this app */
		enabled: boolean;
		/** Custom blog title (defaults to "{App Name} Blog") */
		blogTitle?: string;
		/** Blog subtitle/description */
		blogDescription?: string;
		/** Blog tone for AI generation */
		defaultTone?: "professional" | "casual" | "technical";
		/** AI image generation settings for blog posts */
		imageGeneration?: {
			/** Enable AI image generation (Gemini only) */
			enabled?: boolean;
			/** Visual style preset for prompts */
			style?: "photorealistic" | "illustration" | "diagram" | "abstract";
			/** Optional custom prompt prefix (app-specific art direction) */
			prompt?: string;
			/** Negative prompt instructions */
			negativePrompt?: string;
			/** Image size hint (used for aspect ratio in prompt) */
			size?: "1792x1024" | "1024x1024" | "1024x1792";
			/** Gemini model override */
			model?: string;
		};
		/** Enable sitemap generation */
		sitemapEnabled?: boolean;
		/** Enable RSS feed */
		rssEnabled?: boolean;
		/** Register the EmPrivacy consent banner plugin in the tenant bundle. */
		privacyBannerEnabled?: boolean;
		/** Voice persona defaults for AI blog generation */
		voicePersona?: {
			icpProfile?: string;
			voiceStyle?: string;
			doList?: string[];
			dontList?: string[];
			examplePhrases?: string[];
		};
		/** Company data defaults for AI blog generation */
		companyData?: {
			companyName?: string;
			companyUrl?: string;
			industry?: string;
			description?: string;
			products?: string;
			targetAudience?: string;
			tone?: string;
			painPoints?: string;
			valuePropositions?: string;
		};
		/** Default competitor names for AI blog generation */
		competitors?: string[];
		/** Content strategy settings */
		contentStrategy?: {
			targetAeoScore?: number;
			autoPublish?: boolean;
			maxPostsPerWeek?: number;
			focusKeywords?: string[];
		};
		/** Blog language (BCP 47 tag, e.g. "de", "en", "es") */
		language?: string;
		/** Author URL for schema markup (e.g. LinkedIn profile) */
		authorUrl?: string;
		/** Custom public hostname for the CMS blog (e.g. "blog.tedix.dev").
		 *  When set, cms-runtime uses this as SITE_URL so Emdash generates
		 *  canonical URLs, sitemap, and RSS with this hostname instead of the
		 *  default *.cms.tedix.dev subdomain. */
		cmsDomain?: string;
		/** Descope tenant ID used for CMS admin login. Defaults to the owning organization tenant. */
		authDescopeTenantId?: string;
		/**
		 * Public mount path for reverse-proxied CMS content (e.g. "/ratgeber").
		 * Keep publicSiteUrl origin-only; content paths belong to Emdash
		 * collection urlPattern.
		 */
		publicPathPrefix?: string;
		/** Public, read-only WebMCP visitor surface. Defaults to both packs enabled. */
		webMcp?: {
			enabled?: boolean;
			toolPacks?: Array<"site-search" | "page-reader">;
		};
		/** Per-org enabled locales (subset of the platform-wide superset
		 *  declared in the Astro bundle). */
		locales?: string[];
		/** Per-org default locale (BCP 47). When non-"en", the tenant
		 *  middleware redirects unprefixed paths to `/{locale}/...` so
		 *  non-English content can live at the site root. */
		defaultLocale?: string;
	};

	/**
	 * Public browser-facing origin/base URL (e.g. "https://blog.acme.example" or
	 * "https://www.acme.example").
	 * When set, every SEO surface (canonical, og:url, sitemap, llms.txt, post .md
	 * mirror, hreflang) emits this URL instead of the *.cms.tedix.dev origin so
	 * authority accrues to the customer's domain. Keep this origin-only; public
	 * path mounts belong in blogConfig.publicPathPrefix and collection urlPattern.
	 */
	publicSiteUrl?: string;

	/** SEO/GEO configuration for search engine discovery */
	seoConfig?: {
		/** Google Search Console HTML verification token */
		googleVerification?: string;
		/** Per-site verification tokens, keyed by siteUrl (e.g. "https://blog.tedix.dev/"). Lets apex + blog subdomain each have their own token. Issued by `seo.register_google_property`. */
		googleVerifications?: Record<string, string>;
		/** IndexNow API key for proactive search engine notification (8-128 hex chars) */
		indexNowKey?: string;
		/** Canonical Google Search Console property URL (e.g., "https://blog.example.com/"). Used as the siteUrl target for all GSC API calls. */
		gscPropertyUrl?: string;
	};
}

/**
 * MCP Server configuration for Apps SDK
 * Controls widget domain, CSP, server identity, and other Apps SDK metadata
 */
export interface McpConfig {
	/** Allow additional properties for forward-compatibility with contract schema */
	[key: string]: unknown;
	/**
	 * Widget domain for Apps SDK (REQUIRED for App Store submission)
	 * AI host renders widgets under <domain>.web-sandbox.oaiusercontent.com
	 * Must be a full URL with protocol: "https://frontend.example.com"
	 */
	widgetDomain?: string;

	/**
	 * Custom MCP server name (default: "{appName} MCP")
	 * Shown in MCP client tool listings
	 */
	serverName?: string;

	/**
	 * Custom MCP server version (default: "1.0.0")
	 */
	serverVersion?: string;

	/**
	 * Additional CORS origins for this app
	 * Merged with default Tedix origins
	 */
	corsOrigins?: string[];

	/**
	 * Tool execution timeout in milliseconds (default: 30000)
	 */
	toolTimeout?: number;

	/**
	 * Per-tool required scope mapping used in config-driven D1 auth mode.
	 * Key is tool_id, value is the list of acceptable scopes for that tool.
	 */
	toolScopes?: Record<string, string[]>;

	/**
	 * Optional human-readable descriptions keyed by scope string.
	 */
	scopeDescriptions?: Record<string, string>;

	/**
	 * OAuth Protected Resource Metadata override. When provided, this is served as-is.
	 */
	protectedResourceMetadata?: Record<string, JsonValue>;

	/**
	 * Public docs URL for the resource server metadata document.
	 */
	resourceDocumentation?: string;

	/**
	 * Descope scope sync configuration.
	 * Lets D1 choose whether this app treats protected-resource metadata as the
	 * canonical scope source, or actively pushes scope definitions to Descope.
	 */
	scopeSync?: {
		enabled?: boolean;
		strategy?: "descope-api" | "resource-metadata";
		lastSyncedAt?: string;
		lastError?: string;
	};

	/**
	 * Config-driven default tedi assignment policy.
	 * When enabled, Tedix materializes matching tedi↔app grants into FGA.
	 */
	assignmentConfig?: {
		mode?: "manual" | "profile-default";
		role?: "operator" | "observer";
		capabilityProfiles?: (
			| "standard"
			| "content_admin"
			| "org_admin"
			| "platform_admin"
		)[];
		requiredTediTags?: string[];
		excludedTediTags?: string[];
		rules?: {
			role?: "operator" | "observer";
			capabilityProfiles?: (
				| "standard"
				| "content_admin"
				| "org_admin"
				| "platform_admin"
			)[];
			requiredTediTags?: string[];
			excludedTediTags?: string[];
		}[];
	};

	/**
	 * Content Security Policy for widgets
	 * Controls what resources widgets can load
	 */
	widgetCSP?: {
		/** API endpoints for fetch/XHR (must include protocol) */
		connect_domains?: string[];
		/** Static assets like scripts, styles, images, fonts */
		resource_domains?: string[];
		/** Iframe embeds (triggers stricter review) */
		frame_domains?: string[];
		/** External links without safe-link modal */
		redirect_domains?: string[];
	};

	/**
	 * Per-tool auth requirements (config-driven)
	 * Key is tool_id. Allows app owners to require auth for specific tools
	 * without needing a DB migration. Merged with tool-level auth_required column.
	 */
	toolAuthRequirements?: Record<
		string,
		{ authRequired: boolean; scopes?: string[] }
	>;

	/**
	 * Provider ID (Descope outbound app ID) inherited by materialized tool rows
	 * when the row-level auth config does not override it.
	 */
	connectionProviderId?: string;
	connectionInstanceId?: string;
	connectionScopes?: string[];
	connectionScope?: "tenant" | "user" | "hybrid";

	/**
	 * External REST/OpenAPI projection sync. Generated tools are persisted as
	 * app_tools rows with schema_source='openapi' and drift tracked by hash.
	 */
	openApiSync?: {
		enabled?: boolean;
		spec?: unknown;
		specUrl?: string;
		supplementalSpecUrls?: string[];
		baseUrl?: string;
		namespace?: string;
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		authScopes?: string[];
		authHeader?: string;
		authTemplate?: string;
		authEncoding?: "base64";
		staticHeaders?: Record<string, string>;
		includeOperationIds?: string[];
		includePathPrefixes?: string[];
		excludePathPrefixes?: string[];
		stripPathPrefixes?: string[];
		pathReplacements?: Record<string, string>;
		replaceExisting?: boolean;
		lastSyncedAt?: string;
		lastError?: string;
		lastResult?: {
			totalOperations: number;
			planned: number;
			created: number;
			updated: number;
			deleted: number;
			inSync: number;
			failed: number;
		};
	};

	/**
	 * Google API Discovery sync. Google publishes official Discovery documents
	 * rather than OpenAPI specs for these APIs, so generated tools use
	 * schema_source='google-discovery'.
	 */
	googleDiscoverySync?: {
		enabled?: boolean;
		services?: Array<{
			name: string;
			version: string;
			discoveryUrl?: string;
		}>;
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		includeMethodIds?: string[];
		excludeMethodIds?: string[];
		replaceExisting?: boolean;
		lastSyncedAt?: string;
		lastError?: string;
		lastResult?: {
			totalOperations: number;
			planned: number;
			created: number;
			updated: number;
			deleted: number;
			inSync: number;
			failed: number;
		};
	};

	/**
	 * Automatically apply non-breaking upstream catalog changes to materialized tools.
	 * When true, the 6h drift detection cron auto-applies schema_changed,
	 * description_changed, and new_upstream drifts without manual intervention.
	 * Breaking changes (removed_upstream) are always skipped and reported only.
	 */
	autoSync?: boolean;
}

/**
 * Content AI configuration for app
 * Controls AI model, temperature, and content search behavior
 */
export interface ContentConfig {
	/**
	 * Upstash Search index name (default: uses app UUID)
	 */
	indexName?: string;

	/**
	 * Custom system prompt for AI answer generation
	 */
	systemPrompt?: string;

	/**
	 * Workers AI model ID (default: "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
	 */
	aiModel?: string;

	/**
	 * AI temperature for answer generation (default: 0.7)
	 * Higher = more creative, lower = more focused
	 */
	temperature?: number;

	/**
	 * Maximum tokens for AI responses (default: 500)
	 */
	maxTokens?: number;

	/**
	 * Whether to generate AI answers (default: true)
	 * Set to false to only return search results without AI synthesis
	 */
	generateAnswers?: boolean;

	/**
	 * Sync interval for scheduled knowledge sync workflow
	 * - daily: Sync once per day (default)
	 * - weekly: Sync once per week
	 * - monthly: Sync once per month
	 * - disabled: Never auto-sync (manual only)
	 */
	syncInterval?: "daily" | "weekly" | "monthly" | "disabled";
}

/**
 * API behavior configuration for app
 * Controls rate limiting and other API-level settings
 */
export interface ApiConfig {
	/**
	 * Rate limiting configuration
	 */
	rateLimits?: {
		/**
		 * Maximum requests per minute (default: 100)
		 */
		requestsPerMinute?: number;

		/**
		 * Seconds to wait before retrying after rate limit (default: 60)
		 */
		retryAfterSeconds?: number;
	};
}
