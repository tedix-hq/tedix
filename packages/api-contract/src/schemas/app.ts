import { TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS } from "./tedi-durable-code";
import { HostDelegationSchema } from "./host-delegation";
/**
 * App Schemas for oRPC Contracts
 * Zod schemas for App entity validation
 */

import { SURFACE_SLUG_PATTERN } from "@tedix/tenant-directory";
import * as z from "zod";
import {
	CatalogMcpPromptSchema,
	CatalogMcpResourceSchema,
	CatalogMcpResourceTemplateSchema,
} from "./catalog";
import { JsonValueSchema } from "./common";
import { AppToolCspDomainSchema } from "./config";
import { ConnectionCredentialProfileSchema } from "./connections";
import { ExtractionConfigExpandedSchema } from "./extraction-config";
import { OpenApiWidgetDefaultsSchema } from "./openapi-sync";
import {
	TOOL_EXECUTION_TASK_SUPPORT_VALUES,
	TOOL_SCHEMA_DIALECT_VALUES,
	TOOL_SCHEMA_SOURCE_VALUES,
	TOOL_WRITE_CAPABILITY_VALUES,
	ToolAnnotationsSchema,
	ToolIconSchema,
	ToolInputJsonSchemaSchema,
	ToolInvocationStatusSchema,
	ToolJsonSchemaSchema,
	ToolMetaSchema,
} from "./tools";

// =============================================================================
// ENUMS
// =============================================================================

/**
 * App visibility options
 * - public: Visible in cross-app aggregator (global search)
 * - private: Only visible via app-specific MCP endpoint
 * - disabled: Hidden from all MCP agents (admin-only access)
 */
export const AppVisibilitySchema = z.enum(["public", "private", "disabled"]);
export type AppVisibility = z.infer<typeof AppVisibilitySchema>;

/**
 * Discovery pipeline status
 * - pending: Initial state
 * - discovered: Domain validated and reachable
 * - scraping: Firecrawl job in progress
 * - scraped: Content extracted successfully
 * - failed: Discovery/scraping failed
 */
export const DiscoveryStatusSchema = z.enum([
	"pending",
	"discovered",
	"scraping",
	"scraped",
	"failed",
]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

/**
 * App Store submission status
 * - draft: Not yet submitted
 * - pending_verification: Domain verification in progress
 * - pending_review: Submitted for review
 * - approved: Live in App Store
 * - rejected: Review rejected
 */
export const AppStoreStatusSchema = z.enum([
	"draft",
	"pending_verification",
	"pending_review",
	"approved",
	"rejected",
]);
export type AppStoreStatus = z.infer<typeof AppStoreStatusSchema>;

/**
 * App vertical types
 */
export const VerticalSchema = z.enum([
	"ecommerce",
	"marketplace",
	"automotive",
	"real_estate",
	"jobs",
	"travel",
	"crypto",
	"content",
	"services",
]);
export type Vertical = z.infer<typeof VerticalSchema>;

/**
 * Config version lifecycle status
 */
export const AppConfigVersionStatusSchema = z.enum([
	"draft",
	"published",
	"archived",
]);
export type AppConfigVersionStatus = z.infer<
	typeof AppConfigVersionStatusSchema
>;

// =============================================================================
// NESTED SCHEMAS
// =============================================================================

/**
 * App capabilities schema
 */
export const AppCapabilitiesSchema = z
	.object({
		vertical: VerticalSchema.optional(),
		checkout: z
			.object({
				enabled: z.boolean(),
				methods: z
					.array(z.enum(["native", "redirect", "deeplink", "modal"]))
					.optional(),
				nativePayments: z.boolean().optional(),
				minOrderValue: z.number().optional(),
				currency: z.string().optional(),
			})
			.optional(),
		cart: z
			.object({
				enabled: z.boolean(),
				persistCart: z.boolean().optional(),
				maxItems: z.number().optional(),
				expirationHours: z.number().optional(),
			})
			.optional(),
		wishlist: z
			.object({
				enabled: z.boolean(),
				maxItems: z.number().optional(),
			})
			.optional(),
		compare: z
			.object({
				enabled: z.boolean(),
				maxItems: z.number().optional(),
			})
			.optional(),
		map: z
			.object({
				enabled: z.boolean(),
				defaultCenter: z
					.object({ lat: z.number(), lng: z.number() })
					.optional(),
				defaultZoom: z.number().optional(),
			})
			.optional(),
		externalCta: z
			.object({
				enabled: z.boolean(),
				ctaText: z.string().optional(),
				ctaUrl: z.string().optional(),
				openInNewTab: z.boolean().optional(),
				utmParams: z
					.object({
						source: z.string().optional(),
						medium: z.string().optional(),
						campaign: z.string().optional(),
					})
					.optional(),
			})
			.optional(),
		// Payment methods supported
		paymentMethods: z
			.array(
				z.enum([
					"credit_card",
					"paypal",
					"apple_pay",
					"google_pay",
					"klarna",
					"sofort",
					"ideal",
					"giropay",
					"crypto",
					"bank_transfer",
					"invoice",
				]),
			)
			.optional(),
		// Metadata about capabilities update
		capabilitiesUpdatedAt: z.string().optional(),
		capabilitiesSource: z.enum(["auto", "manual"]).optional(),
	})
	.passthrough();
export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>;

/**
 * MCP configuration schema
 */
const AggregateAppSchema = z.object({
	/** Source app slug to pull tools from */
	slug: z.string(),
	appId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Stable app id this entry links to; preferred over slug. Slug remains for display and as a fallback for entries written before ids were stored.",
		),
	/** Prefix for tool names (defaults to slug). Tools become `{prefix}__{toolName}`. */
	prefix: z
		.string()
		.optional()
		.describe("Defaults to the source app slug when omitted."),
	/** Legacy routing hint retained only for stored metadata reads. */
	connectionLabel: z
		.string()
		.optional()
		.describe("Legacy stored routing hint; omitted on new integrations."),
	/** Descope outbound app ID to apply to inherited connection-auth tools. */
	connectionInstanceId: z.uuid().optional(),
	connectionProviderId: z
		.string()
		.optional()
		.describe("Omit to inherit the source app connection provider."),
	connectionScope: z
		.enum(["tenant", "user", "hybrid"])
		.optional()
		.describe("Omit to inherit the source app connection scope."),
	connectionScopes: z
		.array(z.string())
		.optional()
		.describe("Omit to inherit the source app requested connection scopes."),
	/** Trusted query params forwarded to every inherited tool call. */
	forwardedQueryParams: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Platform-managed parameters; omitted when no forwarding is configured.",
		),
	/**
	 * Mount only the source's read tools.
	 *
	 * Prefer this over enumerating `toolIds` when the intent is "everything this
	 * source exposes for reading": a list is a snapshot that has to be
	 * recomputed whenever the source changes, and one nobody refreshes silently
	 * withholds every tool added after it was taken.
	 */
	readOnly: z
		.boolean()
		.optional()
		.describe(
			"Mount only source tools whose write capability is read. A tool with no recorded capability is withheld.",
		),
	/**
	 * Allowlist: restrict inherited tools to these exact source
	 * tool_ids. Omit to inherit all of the source app's tools.
	 */
	toolIds: z
		.array(z.string())
		.optional()
		.describe("Omit to include all eligible source tools."),
	/**
	 * Allowlist: restrict inherited tools to those whose endpoint
	 * path starts with one of these prefixes.
	 */
	endpointPrefixes: z
		.array(z.string())
		.optional()
		.describe("Omit when no endpoint prefix restriction is configured."),
});

export const McpConfigSchema = z
	.object({
		embeddedHostDelegation: z
			.object({ audience: HostDelegationSchema.shape.audience })
			.strict()
			.optional()
			.describe(
				"Omitted unless this source app opts into provider-owned host delegation.",
			),
		widgetDomain: z.string().optional(),
		serverName: z.string().optional(),
		serverVersion: z.string().optional(),
		corsOrigins: z.array(z.string()).optional(),
		toolTimeout: z.number().optional(),
		widgetCSP: z
			.object({
				connect_domains: z.array(z.string()).optional(),
				resource_domains: z.array(z.string()).optional(),
				frame_domains: z.array(z.string()).optional(),
				redirect_domains: z.array(z.string()).optional(),
			})
			.passthrough()
			.optional(),
		authMode: z
			.enum(["public", "authenticated", "hybrid", "proxy-target"])
			.default("authenticated"),
		/**
		 * Legacy routing hint retained only for stored app metadata reads.
		 * New project-specific credentials must use project-specific
		 * `connectionProviderId` / outbound app IDs instead.
		 */
		connectionLabel: z.string().optional(),
		capabilities: z.array(z.string()).default([]),
		descopeResourceId: z.string().optional(),
		expectedAudience: z.string().optional(),
		protectedResourceMetadata: z.record(z.string(), JsonValueSchema).optional(),
		/**
		 * Default scopes named in the unauthenticated 401 challenge (RFC 6750
		 * `scope`). Hosts that follow the MCP spec request these on first
		 * sign-in instead of every advertised scope; clients that ask for more
		 * explicitly (the CLI's admin login) still can.
		 */
		challengeScopes: z.array(z.string()).optional(),
		toolScopes: z.record(z.string(), z.array(z.string())).optional(),
		chatgptToolAllowlist: z.array(z.string()).optional(),
		scopeDescriptions: z.record(z.string(), z.string()).optional(),
		toolAuthRequirements: z
			.record(
				z.string(),
				z.object({
					authRequired: z.boolean(),
					scopes: z.array(z.string()).optional(),
				}),
			)
			.optional(),
		lastScopesSyncedAt: z.string().optional(),
		/** Descope Policy ID for this MCP server (from Descope Console) */
		policyId: z.string().optional(),
		/** Whether to enforce Descope-issued scope claims (vs D1 toolScopes fallback) */
		enforcePolicies: z.boolean().optional().default(false),
		/** Scope sync configuration */
		scopeSync: z
			.object({
				/** Auto-sync tool scopes to Descope when app config changes */
				enabled: z.boolean().default(false),
				/** Sync strategy: explicit Descope management API or live protected-resource metadata */
				strategy: z
					.enum(["descope-api", "resource-metadata"])
					.default("descope-api"),
				/** Last successful sync timestamp */
				lastSyncedAt: z.string().optional(),
				/** Last sync error message */
				lastError: z.string().optional(),
			})
			.optional(),
		assignmentConfig: z
			.object({
				/** Whether Tedix should materialize this app to matching tedis via FGA */
				mode: z.enum(["manual", "profile-default"]).default("manual"),
				/** Role granted when this app is materialized for a tedi */
				role: z.enum(["operator", "observer"]).default("operator"),
				/** Eligible tedi capability profiles when mode = profile-default */
				capabilityProfiles: z
					.array(
						z.enum([
							"standard",
							"content_admin",
							"org_admin",
							"platform_admin",
						]),
					)
					.optional(),
				/** Optional tedi tags that must all be present */
				requiredTediTags: z.array(z.string()).optional(),
				/** Optional tedi tags that prevent assignment when present */
				excludedTediTags: z.array(z.string()).optional(),
				/** Ordered role/profile rules. First match wins. */
				rules: z
					.array(
						z.object({
							role: z.enum(["operator", "observer"]).default("operator"),
							capabilityProfiles: z
								.array(
									z.enum([
										"standard",
										"content_admin",
										"org_admin",
										"platform_admin",
									]),
								)
								.optional(),
							requiredTediTags: z.array(z.string()).optional(),
							excludedTediTags: z.array(z.string()).optional(),
						}),
					)
					.optional(),
			})
			.optional(),
		// Descope Agentic Identity Hub — consent flow configuration
		consentConfig: z
			.object({
				/** Whether user consent is required before granting scopes (default: true) */
				requireConsent: z.boolean().default(true),
				/** Custom consent page URL (Descope provides a default if not set) */
				consentPageUrl: z.url().optional(),
				/** Scopes granted by default without explicit consent */
				defaultScopes: z.array(z.string()).optional(),
				/** Scopes that always require explicit user consent, even if previously granted */
				sensitiveScopes: z.array(z.string()).optional(),
			})
			.optional(),
		// Descope Agentic Identity Hub — client registration configuration
		clientRegistration: z
			.object({
				/**
				 * Client registration mode:
				 * - cimd: Client ID Metadata Document (recommended, no registration endpoint)
				 * - dcr: Dynamic Client Registration (RFC 7591)
				 * - pre-registered: Only pre-registered clients allowed
				 * - disabled: No client registration accepted
				 */
				mode: z
					.enum(["cimd", "dcr", "pre-registered", "disabled"])
					.default("cimd"),
				/** Allowed redirect URI patterns (glob-style, e.g. "https://example.com/*") */
				allowedRedirectPatterns: z.array(z.string()).optional(),
				/** Require PKCE for all authorization flows (default: true) */
				requirePkce: z.boolean().default(true),
			})
			.optional(),
		/**
		 * Descope Token Vault connection provider ID inherited by generated or
		 * catalog-synced tool rows when tool-level auth does not override it.
		 */
		connectionProviderId: z.string().optional(),
		connectionInstanceId: z.uuid().optional(),
		/** OAuth scopes inherited by generated or catalog-synced tool rows. */
		connectionScopes: z.array(z.string()).optional(),
		/** Token Vault credential scope inherited by generated or catalog-synced tool rows. */
		connectionScope: z
			.enum(["tenant", "user", "hybrid"])
			.default("tenant")
			.optional(),
		/** Credential form and injection metadata for provider-backed tools. */
		credentialProfile: ConnectionCredentialProfileSchema.optional(),
		/**
		 * External REST/OpenAPI projection sync. When enabled, scheduled sync can
		 * refresh `external` app_tools rows from the provider's OpenAPI spec.
		 */
		openApiSync: z
			.object({
				enabled: z.boolean().default(false),
				spec: JsonValueSchema.optional(),
				specUrl: z.string().url().optional(),
				supplementalSpecUrls: z.array(z.string().url()).max(4).optional(),
				baseUrl: z.string().url().optional(),
				namespace: z.string().optional(),
				connectionProviderId: z.string().optional(),
				connectionScope: z.enum(["tenant", "user", "hybrid"]).default("tenant"),
				credentialProfile: ConnectionCredentialProfileSchema.optional(),
				authScopes: z.array(z.string()).optional(),
				authHeader: z.string().optional(),
				authTemplate: z.string().optional(),
				authEncoding: z.enum(["base64"]).optional(),
				staticHeaders: z.record(z.string(), z.string()).optional(),
				includeOperationIds: z.array(z.string()).optional(),
				includePathPrefixes: z.array(z.string()).optional(),
				excludePathPrefixes: z.array(z.string()).optional(),
				stripPathPrefixes: z.array(z.string()).optional(),
				pathReplacements: z.record(z.string(), z.string()).optional(),
				widgetDefaults: OpenApiWidgetDefaultsSchema.optional(),
				widgetOverrides: z
					.record(z.string(), OpenApiWidgetDefaultsSchema)
					.optional(),
				replaceExisting: z.boolean().default(true),
				lastSyncedAt: z.string().optional(),
				lastError: z.string().optional(),
				lastResult: z
					.object({
						totalOperations: z.number().int(),
						planned: z.number().int(),
						created: z.number().int(),
						updated: z.number().int(),
						deleted: z.number().int(),
						inSync: z.number().int(),
						failed: z.number().int(),
					})
					.optional(),
			})
			.optional(),
		/**
		 * Google API Discovery sync. Google publishes Discovery docs instead of
		 * OpenAPI for these APIs, so this has a dedicated source shape while still
		 * generating config-driven external app_tools.
		 */
		googleDiscoverySync: z
			.object({
				enabled: z.boolean().default(false),
				services: z
					.array(
						z.object({
							name: z.string().min(1),
							version: z.string().min(1),
							discoveryUrl: z.string().url().optional(),
						}),
					)
					.optional(),
				connectionProviderId: z.string().optional(),
				connectionScope: z.enum(["tenant", "user", "hybrid"]).default("user"),
				includeMethodIds: z.array(z.string()).optional(),
				excludeMethodIds: z.array(z.string()).optional(),
				replaceExisting: z.boolean().default(true),
				lastSyncedAt: z.string().optional(),
				lastError: z.string().optional(),
				lastResult: z
					.object({
						totalOperations: z.number().int(),
						planned: z.number().int(),
						created: z.number().int(),
						updated: z.number().int(),
						deleted: z.number().int(),
						inSync: z.number().int(),
						failed: z.number().int(),
					})
					.optional(),
			})
			.optional(),
		/**
		 * Per-org/app consent for tool-call PAYLOAD forensics capture (R2 SQL).
		 * `true` = opt in, `false` = opt out, `undefined` = platform default
		 * (`MCP_PAYLOAD_CAPTURE_DEFAULT`). Gates whether redacted request/response
		 * bodies are written to the forensics table — metrics/audit are unaffected.
		 */
		capturePayloads: z.boolean().optional(),
		/** Enable Code Mode — collapses all tools into a single `code` tool via Dynamic Worker Loaders */
		codeMode: z.boolean().optional(),
		/** Exact Interaction reply webhook events for human OAuth hosts. Opt-in, not a background agent. */
		interactionEvents: z.boolean().optional(),
		/**
		 * Code Mode execution timeout in ms. When unset, the runtime default is
		 * 330000 (apps/mcp/src/mcp/codemode.ts). The max must stay >= that default,
		 * otherwise a configured value would silently cap execution BELOW the
		 * effective default and starve long aggregate Code Mode runs.
		 */
		codeModeTimeout: z
			.number()
			.int()
			.min(5000)
			.max(TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS)
			.optional(),
		/**
		 * Code Mode namespace overrides — maps endpoint prefixes to custom namespace names.
		 * When omitted, namespaces are auto-derived from endpoint prefixes (e.g. "blog/" -> "blog").
		 * Use this to merge related prefixes into one namespace.
		 * Example: { "tediObjectives": "mission", "rationaleRecords": "mission" }
		 */
		codeModeNamespaces: z.record(z.string(), z.string()).optional(),
		/**
		 * Custom ES modules injected into the Code Mode sandbox.
		 * Keys are module specifiers (e.g. "helpers.js"), values are ES module source code.
		 * LLM-generated code can `import { fn } from "helpers.js"` to use them.
		 */
		codeModeModules: z.record(z.string(), z.string()).optional(),
		/** Static base instructions sent during MCP init handshake */
		serverInstructions: z.string().optional(),
		/** Whether to auto-append skill catalog to server instructions (default: true) */
		autoAppendSkillInstructions: z.boolean().optional(),
		tediPolicy: z
			.object({
				enabled: z.boolean().default(false),
				tediId: z.string().optional(),
				allowedTools: z.array(z.string()).default([]),
				blockedTools: z.array(z.string()).default([]),
				maxTokens: z.number().default(4096),
				timeoutMs: z.number().default(60000),
				allowedDomains: z.array(z.string()).optional(),
			})
			.optional(),
		/**
		 * Aggregated app slugs whose skills should be registered as `skill://` resources
		 * on this server. The Agent runtime exposes their summaries in MCP guidance
		 * context, with full content available on demand through `mcp_read_resource`
		 * using the resource's exact server and URI.
		 *
		 * Operator-curated: only listed apps get VIP treatment. Avoids context bomb when
		 * many apps are aggregated but only a few have actionable skills.
		 *
		 * Values must match `aggregateApps[].slug` entries on this server.
		 */
		guidanceSkillApps: z.array(z.string()).optional(),
		/**
		 * Exact app-scoped skill slugs deliberately published through the
		 * unauthenticated HTTP Agent Skills index. Skill visibility is an
		 * authenticated organization policy and never implies web publication.
		 */
		publicSkillSlugs: z
			.array(
				z
					.string()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid Agent Skill slug"),
			)
			.max(50)
			.optional(),
		/**
		 * Org-wide MCP aggregator — merges tools from multiple source apps into one server.
		 *
		 * Each entry loads tools from the source app via D1 (internal resolution, no HTTP —
		 * avoids the 522 self-loopback hazard for same-zone apps). Tools are prefixed with
		 * `{prefix}__{toolName}` where prefix defaults to the app slug.
		 *
		 * Auth: rpc-transport tools (most tools) use the caller's JWT + service binding and
		 * need no extra config. external-transport tools should reference a Descope
		 * outbound app ID via their auth config.
		 */
		aggregateApps: z.array(AggregateAppSchema).optional(),
		/** Saved membership settings, restored when an installed app is re-enabled. */
		inactiveAggregateApps: z
			.array(AggregateAppSchema)
			.optional()
			.describe(
				"Absent until gateway membership settings have been saved by the platform.",
			),
		/**
		 * Org workforce aggregator — exposes selected tedi MCP surfaces under stable
		 * Code Mode namespaces such as `cto.*`, `ceo.*`, and `cmo.*`.
		 *
		 * This is intentionally separate from `aggregateApps`: apps are D1 tool
		 * bundles, while tedis are durable runtime assets with their own memory,
		 * rationale, skills, sessions, and Descope AIH MCP registration.
		 */
		aggregateTedis: z
			.array(
				z.object({
					/** Tedi slug to connect to, e.g. "cto" for cto.tedi.tedix.dev/mcp. */
					slug: z.string(),
					/** Code Mode namespace. Defaults to slug. */
					namespace: z.string().optional(),
					/** Main session used by the ask alias. Defaults to "agent:main:main". */
					sessionKey: z.string().optional(),
					/** Explicit MCP URL for non-standard deployments. */
					serverUrl: z.string().url().optional(),
					/** Tedi tool surface. Defaults to "full"; "collaboration" keeps a narrow role-chat/read surface. */
					surface: z.enum(["full", "collaboration"]).optional(),
					/** Optional cache revision for a materialized tedi tool surface. */
					surfaceRev: z.string().optional(),
				}),
			)
			.optional(),
		/**
		 * Query params automatically appended to materialized MCP transport tool rows.
		 * Used by tenant-scoped apps
		 * (e.g. cms-acme → builder.tedix.dev/mcp?org=acme)
		 * where the upstream server uses the query string to scope multi-tenant data.
		 *
		 * Platform-set only — values are trusted as part of app metadata. Threaded
		 * onto each tool's config as `_forwardedQueryParams` during aggregation/
		 * same-zone resolution so the handler can apply them at call time.
		 */
		forwardedQueryParams: z.record(z.string(), z.string()).optional(),
	})
	.passthrough();
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * App branding schema
 * Extended to capture all Firecrawl branding extraction fields
 */
export const AppBrandingSchema = z.object({
	logo: z.string().nullish(),
	/** Detected color scheme from page ("light" or "dark") */
	colorScheme: z.enum(["light", "dark"]).nullish(),
	colors: z
		.object({
			// Core brand colors
			primary: z.string().nullish(),
			secondary: z.string().nullish(),
			accent: z.string().nullish(),
			/** Optional light brand tint for subtle backgrounds and badges. */
			tint: z.string().nullish(),
			primaryTint: z.string().nullish(),
			/** Optional pressed/hover color for primary interactive elements. */
			primaryHover: z.string().nullish(),
			primaryDark: z.string().nullish(),
			interactiveHover: z.string().nullish(),
			// UI colors
			background: z.string().nullish(),
			text: z.string().nullish(),
			textSecondary: z.string().nullish(),
			link: z.string().nullish(),
			// Semantic colors
			success: z.string().nullish(),
			warning: z.string().nullish(),
			error: z.string().nullish(),
		})
		.nullish(),
	colorsDark: z
		.object({
			// Core brand colors
			primary: z.string().nullish(),
			secondary: z.string().nullish(),
			accent: z.string().nullish(),
			/** Optional light brand tint for subtle backgrounds and badges. */
			tint: z.string().nullish(),
			primaryTint: z.string().nullish(),
			/** Optional pressed/hover color for primary interactive elements. */
			primaryHover: z.string().nullish(),
			primaryDark: z.string().nullish(),
			interactiveHover: z.string().nullish(),
			// UI colors
			background: z.string().nullish(),
			text: z.string().nullish(),
			textSecondary: z.string().nullish(),
			link: z.string().nullish(),
			// Semantic colors
			success: z.string().nullish(),
			warning: z.string().nullish(),
			error: z.string().nullish(),
		})
		.nullish(),
	fonts: z
		.object({
			heading: z.string().nullish(),
			body: z.string().nullish(),
			provider: z.string().nullish(),
		})
		.nullish(),
	/** Main brand/product homepage used by CMS chrome links. */
	homepageUrl: z.string().nullish(),
	/** Tenant theme mode. `system` enables light/dark switching; fixed modes hide the switcher. */
	themeMode: z.enum(["light", "dark", "system"]).nullish(),
	images: z
		.object({
			logo: z.string().nullish(),
			favicon: z.string().nullish(),
			ogImage: z.string().nullish(),
		})
		.nullish(),
});
export type AppBranding = z.infer<typeof AppBrandingSchema>;

/**
 * Content tool UI customization config
 * Allows apps to customize the search_content tool title/description
 */
export const ContentToolUIConfigSchema = z.object({
	title: z.string().optional(),
	description: z.string().optional(),
});
export type ContentToolUIConfig = z.infer<typeof ContentToolUIConfigSchema>;

/**
 * Content AI config
 * Allows apps to customize AI answer generation for content search
 */
export const ContentAIConfigSchema = z.object({
	aiModel: z.string().optional(),
	temperature: z.number().optional(),
	maxTokens: z.number().optional(),
	systemPrompt: z.string().optional(),
	syncInterval: z.enum(["daily", "weekly", "monthly", "disabled"]).optional(),
});
export type ContentAIConfig = z.infer<typeof ContentAIConfigSchema>;

/**
 * Blog image generation config
 */
export const BlogImageStyleSchema = z.enum([
	"photorealistic",
	"illustration",
	"diagram",
	"abstract",
]);
export type BlogImageStyle = z.infer<typeof BlogImageStyleSchema>;

export const BlogImageGenerationSchema = z.object({
	enabled: z.boolean().optional(),
	style: BlogImageStyleSchema.optional(),
	prompt: z.string().optional(),
	negativePrompt: z.string().optional(),
	size: z.enum(["1792x1024", "1024x1024", "1024x1792"]).optional(),
	model: z.string().optional(),
});
export type BlogImageGeneration = z.infer<typeof BlogImageGenerationSchema>;

/**
 * Blog config (metadata.blogConfig)
 */
export const VoicePersonaSchema = z.object({
	icpProfile: z.string().optional(),
	voiceStyle: z.string().optional(),
	doList: z.array(z.string()).optional(),
	dontList: z.array(z.string()).optional(),
	examplePhrases: z.array(z.string()).optional(),
});
export type VoicePersona = z.infer<typeof VoicePersonaSchema>;

export const BlogCompanyDataSchema = z.object({
	companyName: z.string().optional(),
	companyUrl: z.string().optional(),
	industry: z.string().optional(),
	description: z.string().optional(),
	products: z.string().optional(),
	targetAudience: z.string().optional(),
	tone: z.string().optional(),
	painPoints: z.string().optional(),
	valuePropositions: z.string().optional(),
});
export type BlogCompanyData = z.infer<typeof BlogCompanyDataSchema>;

export const ContentStrategySchema = z.object({
	targetAeoScore: z.number().optional(),
	autoPublish: z.boolean().optional(),
	maxPostsPerWeek: z.number().optional(),
	focusKeywords: z.array(z.string()).optional(),
});
export type ContentStrategy = z.infer<typeof ContentStrategySchema>;

/**
 * Hot-theme deploy manifest, written by the CMS hot-theme agent via
 * `json_set(metadata, '$.blogConfig.hotTheme', ...)`
 * (apps/cms/src/agent/hot-theme.ts::updateHotThemeMetadata). Declared here so
 * app reads don't fail output validation on rows the agent has themed.
 */
export const BlogHotThemeSchema = z.object({
	enabled: z.boolean().optional(),
	cssKey: z.string().optional(),
	historyKey: z.string().optional(),
	manifestKey: z.string().optional(),
	previousRevision: z.string().nullable().optional(),
	revision: z.string().optional(),
	revisionKey: z.string().optional(),
	sha256: z.string().optional(),
	updatedAt: z.string().optional(),
	summary: z.string().nullable().optional(),
	publicPath: z.string().optional(),
});
export type BlogHotTheme = z.infer<typeof BlogHotThemeSchema>;

export const BlogConfigSchema = z.object({
	enabled: z.boolean().optional(),
	hotTheme: BlogHotThemeSchema.optional(),
	blogTitle: z.string().optional(),
	blogDescription: z.string().optional(),
	defaultTone: z.enum(["professional", "casual", "technical"]).optional(),
	sitemapEnabled: z.boolean().optional(),
	rssEnabled: z.boolean().optional(),
	privacyBannerEnabled: z.boolean().optional(),
	/** Content-language hint for generated posts. Prefer defaultLocale for routing. */
	language: z.string().optional(),
	/** Author URL for schema markup and generated content attribution. */
	authorUrl: z.string().optional(),
	imageGeneration: BlogImageGenerationSchema.optional(),
	voicePersona: VoicePersonaSchema.optional(),
	companyData: BlogCompanyDataSchema.optional(),
	competitors: z.array(z.string()).optional(),
	contentStrategy: ContentStrategySchema.optional(),
	// Per-org i18n. The Astro bundle declares the platform-wide superset
	// (en/de/es/fr/it/pt/nl); this list narrows enabled locales for the org
	// and `defaultLocale` drives root-locale redirect behavior in the
	// tenant middleware.
	locales: z.array(z.string()).optional(),
	defaultLocale: z.string().optional(),
	/** Custom public hostname for the CMS (e.g. "blog.acme.example"). Used by cms-runtime to resolve custom domains. */
	cmsDomain: z.string().optional(),
	/**
	 * Descope tenant ID used for Emdash admin login.
	 * Defaults to the owning organization tenant when omitted.
	 */
	authDescopeTenantId: z.string().optional(),
	/**
	 * Public mount path for reverse-proxied CMS content (e.g. "/ratgeber").
	 * Keep publicSiteUrl origin-only; content paths belong to Emdash urlPattern.
	 */
	publicPathPrefix: z.string().optional(),
	/**
	 * Studio starter the tenant deploys from (maps to apps/cms/templates/{slug}).
	 * Authoritative source the deploy workflow reads to select the template;
	 * defaults to "tedix". Set "marketing" for full-site / landing-page tenants.
	 */
	templateSlug: z.string().optional(),
});
export type BlogConfig = z.infer<typeof BlogConfigSchema>;

/**
 * App metadata schema (stored as JSON)
 */
export const AppMetadataSchema = z
	.object({
		vertical: VerticalSchema.optional(),
		branding: AppBrandingSchema.nullable().optional(),
		brandingExtractedAt: z.string().optional(),
		socialLinks: z
			.object({
				twitter: z.string().optional(),
				linkedin: z.string().optional(),
				github: z.string().optional(),
				facebook: z.string().optional(),
				instagram: z.string().optional(),
				youtube: z.string().optional(),
				email: z.string().optional(),
			})
			.passthrough()
			.optional(),
		capabilities: AppCapabilitiesSchema.optional(),
		mcpConfig: McpConfigSchema.optional(),
		// Widget customization (passed via X-Tedix-App-Theme header)
		// Uses WidgetConfigSchema from ./widget.ts - import that file for the full type
		widgetConfig: z.record(z.string(), JsonValueSchema).optional(),
		// MCP tool customization
		contentToolConfig: ContentToolUIConfigSchema.optional(),
		contentConfig: ContentAIConfigSchema.optional(),
		blogConfig: BlogConfigSchema.optional(),
		// Public browser-facing origin/base URL. When set, every
		// SEO surface (canonical, og:url, sitemap, llms.txt, post .md mirror,
		// hreflang) emits this URL instead of the *.cms.tedix.dev origin so
		// authority accrues to the customer's domain. Keep this origin-only;
		// public path mounts belong in blogConfig.publicPathPrefix and native
		// Emdash collection urlPattern.
		publicSiteUrl: z.string().optional(),
		// Extraction workflow configuration (single source of truth)
		// @see docs/engineering/platform/api.md for configuration guide
		extractionConfig: ExtractionConfigExpandedSchema.optional(),
		itemImport: z
			.object({
				lastImportedAt: z.string().optional(),
				itemsImported: z.number().optional(),
				itemsSaved: z.number().optional(),
				method: z.string().optional(),
				vectorize: z
					.object({
						synced: z.number().optional(),
						failed: z.number().optional(),
					})
					.optional(),
			})
			.optional(),
	})
	.passthrough();
export type AppMetadata = z.infer<typeof AppMetadataSchema>;

/**
 * Patch-only metadata shape. A null connectionProviderId explicitly removes
 * the app-level Connection binding; persisted app metadata remains governed by
 * AppMetadataSchema and never stores the null sentinel.
 */
export const AppMetadataUpdateSchema = AppMetadataSchema.extend({
	mcpConfig: McpConfigSchema.partial()
		.extend({
			connectionProviderId: z
				.string()
				.min(1)
				.nullable()
				.optional()
				.describe(
					"Patch lifecycle: omit to preserve the app-level Connection binding; null explicitly removes it and its inherited credential settings.",
				),
		})
		.optional()
		.describe(
			"Partial MCP configuration patch; omitted fields preserve their persisted values.",
		),
});

// =============================================================================
// APP ENTITY SCHEMAS
// =============================================================================

/**
 * Full App schema (response)
 */
export const AppSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	primaryDomain: z.string().nullable(),
	logoUrl: z.string().nullable(),
	visibility: AppVisibilitySchema.nullable(),
	discoveryStatus: DiscoveryStatusSchema.nullable(),
	customMcpDomain: z.string().nullable(),
	openaiChallengeToken: z.string().nullable(),
	openaiAppId: z.string().nullable(),
	appStoreStatus: AppStoreStatusSchema.nullable(),
	activeConfigVersionId: z.uuid().nullable(),
	latestConfigVersion: z.number().int().nullable(),
	vertical: z.string().nullable().optional(),
	metadata: AppMetadataSchema.nullable(),
	extractedAt: z.string().nullable(),
	aiSearchSyncedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type App = z.infer<typeof AppSchema>;

export const AppConfigVersionSchema = z.object({
	id: z.uuid(),
	appId: z.uuid(),
	version: z.number().int(),
	status: AppConfigVersionStatusSchema,
	config: JsonValueSchema,
	changeSummary: z.string().nullable(),
	publishedAt: z.string().nullable(),
	publishedBy: z.string().nullable(),
	activatedAt: z.string().nullable(),
	activatedBy: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type AppConfigVersion = z.infer<typeof AppConfigVersionSchema>;

/**
 * App list item schema (simplified for list views)
 */
export const AppListItemSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z.string(),
	domain: z.string().nullable(),
	description: z.string().nullable(),
	logoUrl: z.string().nullable(),
	visibility: AppVisibilitySchema.nullable(),
	discoveryStatus: DiscoveryStatusSchema.nullable(),
	customMcpDomain: z.string().nullable(),
	appStoreStatus: AppStoreStatusSchema.nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type AppListItem = z.infer<typeof AppListItemSchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

/**
 * Create app input schema
 */
export const CreateAppInputSchema = z.object({
	name: z.string().min(1, "Name is required").max(100),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(
			SURFACE_SLUG_PATTERN,
			"Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens",
		)
		.optional(),
	description: z.string().max(500).optional(),
	primaryDomain: z.string().max(253).optional(),
	logoUrl: z.url().optional(),
	visibility: AppVisibilitySchema.optional().default("private"),
	metadata: AppMetadataSchema.optional(),
});
export type CreateAppInput = z.infer<typeof CreateAppInputSchema>;

/**
 * Update app input schema
 */
export const UpdateAppInputSchema = z.object({
	openaiChallengeToken: z
		.string()
		.min(1)
		.max(4096)
		.regex(
			/^[!-~]+$/,
			"Challenge token must contain printable ASCII without whitespace",
		)
		.nullable()
		.optional(),
	name: z.string().min(1).max(100).optional(),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(
			SURFACE_SLUG_PATTERN,
			"Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens",
		)
		.optional(),
	description: z.string().max(500).nullable().optional(),
	primaryDomain: z.string().max(253).nullable().optional(),
	logoUrl: z.url().nullable().optional(),
	visibility: AppVisibilitySchema.optional(),
	metadata: AppMetadataUpdateSchema.optional(),
});
export type UpdateAppInput = z.infer<typeof UpdateAppInputSchema>;

export const CreateAppConfigVersionInputSchema = z.object({
	appId: z.uuid(),
	config: JsonValueSchema,
	changeSummary: z.string().max(1000).nullable().optional(),
	createdBy: z.string().nullable().optional(),
});
export type CreateAppConfigVersionInput = z.infer<
	typeof CreateAppConfigVersionInputSchema
>;

export const AppConfigVersionIdParamSchema = z.object({
	appId: z.uuid(),
	versionId: z.uuid(),
});
export type AppConfigVersionIdParam = z.infer<
	typeof AppConfigVersionIdParamSchema
>;

export const PublishAppConfigVersionInputSchema =
	AppConfigVersionIdParamSchema.extend({
		publishedBy: z.string().nullable().optional(),
	});
export type PublishAppConfigVersionInput = z.infer<
	typeof PublishAppConfigVersionInputSchema
>;

export const ActivateAppConfigVersionInputSchema =
	AppConfigVersionIdParamSchema.extend({
		activatedBy: z.string().nullable().optional(),
	});
export type ActivateAppConfigVersionInput = z.infer<
	typeof ActivateAppConfigVersionInputSchema
>;

// =============================================================================
// MCP-SPECIFIC SCHEMAS (for apps/mcp)
// =============================================================================

/**
 * Tool response schema for getBySlugWithTools / getByIdWithTools
 */
export const AppToolSchema = z.object({
	id: z.string(),
	toolId: z.string(),
	toolTypeId: z.string().min(1),
	title: z.string(),
	description: z.string().nullable(),
	inputSchema: ToolInputJsonSchemaSchema,
	outputSchema: ToolJsonSchemaSchema.nullable(),
	adapterScope: z.string().nullable(),
	resultStrategy: z.string().nullable(),
	outputTemplate: z.string().nullable(),
	widgetKey: z.string().nullable(),
	widgetRoute: z.string().nullable(),
	widgetAccessible: z.boolean().nullable(),
	authRequired: z.boolean().default(false),
	visibility: z.string().nullable(),
	/**
	 * DERIVED, read-only. Ignored on write.
	 */
	requiredScopes: z
		.array(z.string())
		.optional()
		.describe(
			"MCP capability scopes a caller must hold to invoke this tool, resolved by the same function the MCP edge enforces with. Absent on write paths and on responses that do not carry the app's mcpConfig, because the answer depends on it — an empty array means the tool requires no scope, which is not the same as unknown. A disabled tool reports the scope it would require if enabled, since the edge serves only enabled tools.",
		),
	scopeMappingMissing: z
		.literal(true)
		.optional()
		.describe(
			"Derived read-only marker that the MCP capability resolver has no mapping for this tool. requiredScopes is absent in this state; it is never reported as an empty grant, and MCP dispatch remains fail-closed.",
		),
	icons: z.array(ToolIconSchema).nullable(),
	// `.catch(null)` on the D1-sourced enums below is load-bearing, not defensive
	// habit. These columns are free text in SQLite, so any writer — a scan, a
	// migration, a hand edit — can leave a value this enum does not know. On a
	// READ path a strict enum turns that single unknown string into a 500 for the
	// entire app, and the blast radius is not local: apps/mcp resolves every
	// aggregate app through getBySlugWithTools, one failed resolve marks the whole
	// aggregate surface `degraded`, and a degraded surface is never written to L1,
	// L2 or L3/R2. The cache then stays permanently cold.
	//
	// Degrading one unknown field to null keeps the tool, the app and the surface
	// usable. Writers still validate strictly; this is the read path being
	// forgiving about data it did not write.
	executionTaskSupport: z
		.enum(TOOL_EXECUTION_TASK_SUPPORT_VALUES)
		.nullable()
		.catch(null),
	annotations: ToolAnnotationsSchema.nullable(),
	/**
	 * DECLARED write capability. `null` means UNDECLARED, NOT read-only —
	 * apps/mcp folds this onto the wire annotations so the gates that classify a
	 * tool (Kernel write planner, destructive-approval gate, Code Mode) see the
	 * declaration. `.catch(null)` for the same read-path reason as the enums
	 * above: an unknown value degrades this tool to UNDECLARED (gated), never
	 * 500s the whole app resolve.
	 */
	writeCapability: z
		.enum(TOOL_WRITE_CAPABILITY_VALUES)
		.nullable()
		.catch(null)
		.optional()
		.describe(
			"Absent or null means UNDECLARED — nobody has stated what this tool does — which every gate treats as write-capable. It is NOT a synonym for read-only, and absent is also how code-built tools that carry explicit annotations arrive.",
		),
	meta: ToolMetaSchema.nullable(),
	invocationStatus: ToolInvocationStatusSchema.nullable(),
	fileParams: z.array(z.string()).nullable(),
	widgetDescription: z.string().nullable(),
	widgetPrefersBorder: z.boolean().nullable(),
	widgetDomain: z.string().nullable(),
	config: z.record(z.string(), JsonValueSchema).nullable(),
	schemaDialect: z.enum(TOOL_SCHEMA_DIALECT_VALUES).nullable().catch(null),
	schemaSource: z.enum(TOOL_SCHEMA_SOURCE_VALUES).nullable().catch(null),
	schemaSourceRef: z.string().nullable(),
	schemaSourceHash: z.string().nullable(),
	schemaSyncedAt: z.string().nullable(),
	sortOrder: z.number().nullable(),
	enabled: z.boolean().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	toolCspDomains: z.array(AppToolCspDomainSchema).optional(),
});
export type AppTool = z.infer<typeof AppToolSchema>;

export const AppCatalogMcpMetadataSchema = z.object({
	id: z.string(),
	slug: z.string().nullable(),
	mcpEndpointNormalized: z.string().nullable(),
	baseUrl: z.string().nullable(),
	scanConnectionId: z.string().nullable(),
	scanConnectionHeader: z.string().nullable(),
	scanConnectionTemplate: z.string().nullable(),
});

/**
 * App with tools response (includes full app data + tools array)
 */
export const AppWithToolsSchema = z.object({
	app: AppSchema.nullable(),
	tools: z.array(AppToolSchema),
	catalogMcp: AppCatalogMcpMetadataSchema.nullable().optional(),
	catalogResources: z.array(CatalogMcpResourceSchema).optional(),
	catalogResourceTemplates: z
		.array(CatalogMcpResourceTemplateSchema)
		.optional(),
	catalogPrompts: z.array(CatalogMcpPromptSchema).optional(),
});
export type AppWithTools = z.infer<typeof AppWithToolsSchema>;

/**
 * Domain lookup response
 */
export const AppByDomainSchema = z.object({
	app: z
		.object({
			id: z.string(),
			organizationId: z.string(),
			name: z.string(),
			visibility: AppVisibilitySchema,
			slug: z.string(),
			domain: z.string().nullable(),
		})
		.nullable(),
});
export type AppByDomain = z.infer<typeof AppByDomainSchema>;
