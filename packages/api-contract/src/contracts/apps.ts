import "@orpc/openapi/extensions/route";
/**
 * Apps Contract for oRPC
 * Type-safe API contract for App endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ActivateAppConfigVersionInputSchema,
	AppBrandingSchema,
	AppByDomainSchema,
	AppConfigVersionSchema,
	AppListItemSchema,
	AppSchema,
	AppWithToolsSchema,
	CreateAppConfigVersionInputSchema,
	CreateAppInputSchema,
	McpConfigSchema,
	PublishAppConfigVersionInputSchema,
	UpdateAppInputSchema,
} from "../schemas/app";
import {
	BackfillAggregateAppIdsInputSchema,
	BackfillAggregateAppIdsOutputSchema,
	RelinkConnectionProviderInputSchema,
	RelinkConnectionProviderOutputSchema,
	RenameAppSlugInputSchema,
	RenameAppSlugOutputSchema,
} from "../schemas/app-reference-maintenance";
import {
	AppIdOrSlugParamSchema,
	AppIdParamSchema,
	PaginationMetaSchema,
	PaginationSchema,
	SlugParamSchema,
	SuccessResponseSchema,
} from "../schemas/common";

/**
 * Apps contract defining all app-related endpoints
 *
 * All endpoints are org-scoped via JWT context
 */
export const appsContract = oc
	.route({ tags: ["apps"], prefix: "/apps" })
	.errors(baseErrors)
	.router({
		/**
		 * List all apps for the current organization
		 * GET /apps
		 */
		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "List apps",
				description:
					"List all apps for the current organization with pagination. Platform-admin principals may pass `organizationId` to list any org's apps.",
			})
			.input(
				PaginationSchema.extend({
					organizationId: z.uuid().optional(),
				}).optional(),
			)
			.output(
				z.object({
					data: z.array(AppListItemSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get app by ID
		 * GET /apps/{appId}
		 */
		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{appId}",
				summary: "Get app by ID",
				description: "Get detailed information about a specific app",
			})
			.input(AppIdParamSchema)
			.output(AppSchema),

		/**
		 * Get app by slug
		 * GET /apps/slug/{slug}
		 */
		getBySlug: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/slug/{slug}",
				summary: "Get app by slug",
				description: "Get app information by its unique slug",
			})
			.input(SlugParamSchema)
			.output(AppSchema),

		/**
		 * Create a new app
		 * POST /apps
		 */
		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create app",
				description: "Create a new app for the current organization",
				successStatus: 201,
			})
			.input(CreateAppInputSchema)
			.output(AppSchema),

		/**
		 * Provision a new app (D1 row + optional Descope AIH registration).
		 * POST /apps/provision
		 *
		 * Pattern is a soft hint that seeds sensible mcpConfig defaults:
		 *   - "materialized" → MCP app shell whose tools must be copied into app_tools
		 *   - "customer"     → org-owned tools (RPC/external transport)
		 *   - "aggregator"   → multi-app aggregator with Code Mode + capability scopes
		 *
		 * `mcpConfig` overrides win over pattern defaults. `aggregateApps` is a
		 * convenience for the aggregator pattern (also accepted via mcpConfig).
		 *
		 * Descope AIH MCP server registration is opt-in. Set
		 * `registerDescopeAih: true` only for MCP apps that should expose their own
		 * OAuth-protected Tedix-hosted endpoint (for example, `*-unified` apps or
		 * the Tedix admin app). Internal platform base apps should leave it false.
		 */
		provision: oc
			.route({
				method: "POST",
				path: "/provision",
				summary: "Provision app",
				description:
					"Create an MCP app with pattern-based defaults and optional Descope AIH registration",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: z.uuid().optional(),
					slug: z
						.string()
						.min(1)
						.max(63)
						.regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens"),
					name: z.string().min(1).max(100),
					description: z.string().max(500).nullable().optional(),
					pattern: z
						.enum(["materialized", "customer", "aggregator"])
						.optional()
						.default("customer"),
					mcpConfig: McpConfigSchema.partial().optional(),
					aggregateApps: z
						.array(
							z.object({
								slug: z.string(),
								appId: z
									.string()
									.uuid()
									.optional()
									.describe(
										"Stable app id this entry links to; preferred over slug.",
									),
								prefix: z.string().optional(),
								connectionLabel: z.string().optional(),
								connectionProviderId: z.string().optional(),
								connectionScope: z
									.enum(["tenant", "user", "hybrid"])
									.optional(),
								connectionScopes: z.array(z.string()).optional(),
							}),
						)
						.optional(),
					registerDescopeAih: z.boolean().optional().default(false),
				}),
			)
			.output(
				z.object({
					app: AppSchema,
					descopeResourceId: z.string().nullable(),
				}),
			),

		getGatewayMembership: oc
			.route({
				method: "GET",
				path: "/{appId}/gateway-membership",
				summary: "Get app gateway availability",
			})
			.input(AppIdParamSchema)
			.output(
				z.object({
					gateway: z
						.object({ id: z.uuid(), name: z.string(), slug: z.string() })
						.nullable()
						.describe("Null when the organization has no unified gateway."),
					enabled: z.boolean(),
					unavailableReason: z
						.string()
						.nullable()
						.describe(
							"Null when this installed app can be added to the gateway.",
						),
				}),
			),

		listGatewayMemberships: oc
			.route({
				method: "GET",
				path: "/gateway-memberships",
				summary: "List installed app gateway availability",
			})
			.output(
				z.object({
					gateway: z
						.object({ id: z.uuid(), name: z.string(), slug: z.string() })
						.nullable()
						.describe(
							"Null until this organization provisions a unified gateway.",
						),
					memberships: z.array(
						z.object({ appId: z.uuid(), enabled: z.boolean() }),
					),
				}),
			),

		setGatewayMembership: oc
			.route({
				method: "PUT",
				path: "/{appId}/gateway-membership",
				summary: "Set app gateway availability",
			})
			.input(AppIdParamSchema.extend({ enabled: z.boolean() }))
			.output(SuccessResponseSchema),

		/**
		 * Update an existing app
		 * PATCH /apps/{appId}
		 */
		update: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{appId}",
				summary: "Update app",
				description: "Update an existing app",
			})
			.input(AppIdParamSchema.extend(UpdateAppInputSchema.shape))
			.output(AppSchema),

		/**
		 * List config versions for an app
		 * GET /apps/{appId}/config-versions
		 */
		listConfigVersions: oc
			.route({
				method: "GET",
				path: "/{appId}/config-versions",
				summary: "List app config versions",
				description: "List all configuration versions for an app",
			})
			.input(AppIdParamSchema)
			.output(z.array(AppConfigVersionSchema)),

		/**
		 * Create a draft config version
		 * POST /apps/{appId}/config-versions
		 */
		createConfigVersion: oc
			.route({
				method: "POST",
				path: "/{appId}/config-versions",
				summary: "Create app config version",
				description: "Create a new draft configuration version",
				successStatus: 201,
			})
			.input(CreateAppConfigVersionInputSchema)
			.output(AppConfigVersionSchema),

		/**
		 * Publish a config version
		 * POST /apps/{appId}/config-versions/{versionId}/publish
		 */
		publishConfigVersion: oc
			.route({
				method: "POST",
				path: "/{appId}/config-versions/{versionId}/publish",
				summary: "Publish app config version",
				description: "Mark a draft configuration version as published",
			})
			.input(PublishAppConfigVersionInputSchema)
			.output(AppConfigVersionSchema),

		/**
		 * Activate a published config version
		 * POST /apps/{appId}/config-versions/{versionId}/activate
		 */
		activateConfigVersion: oc
			.route({
				method: "POST",
				path: "/{appId}/config-versions/{versionId}/activate",
				summary: "Activate app config version",
				description: "Activate a published config version for runtime use",
			})
			.input(ActivateAppConfigVersionInputSchema)
			.output(AppConfigVersionSchema),

		/**
		 * Delete an app
		 * DELETE /apps/{appId}
		 */
		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{appId}",
				summary: "Delete app",
				description: "Permanently delete an app and all associated data",
				successStatus: 200,
			})
			.input(AppIdParamSchema)
			.output(SuccessResponseSchema),

		/**
		 * Check if a slug is available
		 * GET /apps/slug-check/{slug}
		 */
		isSlugAvailable: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/slug-check/{slug}",
				summary: "Check slug availability",
				description: "Check if an app slug is available for use",
			})
			.input(SlugParamSchema)
			.output(z.object({ available: z.boolean() })),

		// =============================================================================
		// MCP-SPECIFIC ENDPOINTS (for apps/mcp)
		// These endpoints are used by the MCP server for app/tool lookup
		// =============================================================================

		/**
		 * Get app by custom domain
		 * GET /apps/domain/{domain}
		 * Used by MCP server to lookup apps by customMcpDomain or primaryDomain
		 */
		getByDomain: oc
			.route({
				method: "GET",
				path: "/domain/{domain}",
				tags: ["internal"],
				summary: "Get app by domain",
				description: "Lookup app by custom MCP domain or primary domain",
			})
			.input(z.object({ domain: z.string() }))
			.output(AppByDomainSchema),

		/**
		 * Get app with tools by slug
		 * GET /apps/slug/{slug}/with-tools
		 * Used by MCP server to get full app data including tools
		 */
		getBySlugWithTools: oc
			.route({
				method: "GET",
				path: "/slug/{slug}/with-tools",
				tags: ["internal"],
				summary: "Get app with tools by slug",
				description:
					"Get app data with enabled tools. Internal callers may narrow tools by endpoint prefix or tool ID to avoid loading unrelated schemas.",
			})
			.input(
				SlugParamSchema.extend({
					endpointPrefixes: z
						.array(z.string().min(1))
						.optional()
						.describe(
							"Optional config.endpoint prefix allowlist, e.g. catalog or toolSchemaSync.",
						),
					toolIds: z
						.array(z.string().min(1))
						.optional()
						.describe("Optional app_tools.tool_id allowlist."),
				}),
			)
			.output(AppWithToolsSchema),

		/**
		 * Batched {@link getBySlugWithTools} for the MCP aggregate rebuild.
		 * POST /apps/slugs/with-tools
		 *
		 * `tedix-unified` resolves 40 apps to build its surface and was issuing one
		 * `getBySlugWithTools` per app. Each apps/api invocation pays a cold-isolate
		 * startup cost, so that fan-out pushed entries past the gateway's per-entry
		 * deadline and collapsed the surface to `degraded:true`.
		 *
		 * `results` is POSITIONALLY parallel to `apps` — index i answers apps[i],
		 * and `app: null` means that slug does not exist. "No tools" (`tools: []`)
		 * is therefore always distinguishable from "not asked for" (absent index).
		 * Duplicate slugs with different tool selections are legal.
		 *
		 * An entry that carries `appId` is resolved by that stable id instead of
		 * its slug, so renaming an app's slug cannot break the link. An id entry
		 * must name `hostOrganizationId` (the organization of the app whose
		 * `aggregateApps` holds the entry); the target is returned only when it
		 * belongs to that organization or to the Tedix platform organization, or
		 * when the host itself is the platform organization. Otherwise `app: null`.
		 */
		getBySlugsWithTools: oc
			.route({
				method: "POST",
				path: "/slugs/with-tools",
				tags: ["internal"],
				summary: "Get many apps with tools by slug",
				description:
					"Batched app+tool resolution for aggregate MCP surfaces. Returns one result per requested entry, in request order.",
			})
			.input(
				z.object({
					apps: z
						.array(
							z.object({
								slug: z.string().min(1),
								appId: z
									.string()
									.uuid()
									.optional()
									.describe(
										"Stable app id; when present the entry resolves by id and slug is only echoed.",
									),
								hostOrganizationId: z
									.string()
									.min(1)
									.optional()
									.describe(
										"Organization of the app that holds this entry; required for an id entry to resolve.",
									),
								endpointPrefixes: z
									.array(z.string().min(1))
									.optional()
									.describe(
										"Optional config.endpoint prefix allowlist for this entry.",
									),
								toolIds: z
									.array(z.string().min(1))
									.optional()
									.describe("Optional app_tools.tool_id allowlist."),
							}),
						)
						.min(1)
						.max(50),
				}),
			)
			.output(
				z.object({
					results: z.array(
						AppWithToolsSchema.extend({
							/** Echoed request slug, so a caller can assert alignment. */
							slug: z.string(),
						}),
					),
				}),
			),

		/**
		 * Get app with tools by ID
		 * GET /apps/{appId}/with-tools
		 * Used by MCP server to get full app data including tools by ID
		 */
		getByIdWithTools: oc
			.route({
				method: "GET",
				path: "/{appId}/with-tools",
				tags: ["internal"],
				summary: "Get app with tools by ID",
				description:
					"Get full app data including all configured tools by app ID",
			})
			.input(AppIdParamSchema)
			.output(AppWithToolsSchema),

		/**
		 * Refresh app branding by scraping homepage
		 * POST /apps/{appId}/refresh-branding
		 */
		refreshBranding: oc
			.route({
				method: "POST",
				path: "/{appId}/refresh-branding",
				tags: ["internal"],
				summary: "Refresh app branding",
				description: "Scrape homepage branding and update app metadata",
			})
			.input(
				AppIdParamSchema.extend({
					url: z.url().optional(),
					proxy: z.enum(["basic", "stealth", "auto"]).optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					app: AppSchema,
					branding: AppBrandingSchema.nullable(),
					brandingExtractedAt: z.string().datetime().nullable(),
				}),
			),

		/**
		 * Generate scope manifest for an app's MCP server
		 * GET /apps/{appId}/scope-manifest
		 * Used by operators to configure Descope policies
		 */
		getScopeManifest: oc
			.route({
				method: "GET",
				path: "/{appId}/scope-manifest",
				summary: "Get MCP scope manifest",
				description:
					"Generate enforced tool and platform scopes for Descope policy configuration. Unclassified tools are reported explicitly; complete is false until each receives a capability mapping.",
			})
			.input(AppIdParamSchema)
			.output(
				z.object({
					serverUrl: z.string(),
					descopeResourceId: z.string(),
					toolScopes: z.array(
						z.object({
							scope: z.string(),
							description: z.string(),
							toolName: z.string(),
							requiresConsent: z.boolean(),
						}),
					),
					platformScopes: z.array(z.string()),
					complete: z.boolean(),
					unclassifiedTools: z.array(z.string()),
					generatedAt: z.string(),
				}),
			),

		/**
		 * Get app by ID or slug (MCP/Code Mode friendly)
		 * POST /rpc/apps/getByIdOrSlug
		 * Resolves by UUID when appIdOrSlug is a valid UUID, otherwise by slug.
		 * Used by get_app and update_app MCP tools so tedis can reference apps
		 * by name or ID without the ToolHandler security override corrupting the lookup.
		 */
		getByIdOrSlug: oc
			.route({
				method: "GET",
				path: "/by-id-or-slug/{appIdOrSlug}",
				tags: ["internal"],
				summary: "Get app by ID or slug",
				description:
					"Get detailed information about an app by its UUID or slug, org-scoped",
			})
			.input(AppIdOrSlugParamSchema)
			.output(AppSchema),

		/**
		 * Update app by ID or slug (MCP/Code Mode friendly)
		 * POST /rpc/apps/updateByIdOrSlug
		 * Same as update but resolves the target app by UUID or slug first.
		 */
		updateByIdOrSlug: oc
			.route({
				method: "PATCH",
				path: "/by-id-or-slug/{appIdOrSlug}",
				tags: ["internal"],
				summary: "Update app by ID or slug",
				description: "Update an app identified by its UUID or slug, org-scoped",
			})
			.input(AppIdOrSlugParamSchema.extend(UpdateAppInputSchema.shape))
			.output(AppSchema),

		/**
		 * Get app integrations (aggregate of tools, adapters, CSP domains, secrets, capabilities)
		 * GET /apps/{appId}/integrations
		 * Used by the OS integrations view to reduce round-trips
		 */
		getIntegrations: oc
			.route({
				method: "GET",
				path: "/{appId}/integrations",
				tags: ["internal"],
				summary: "Get app integrations",
				description:
					"Get aggregated integration data including tools, adapters, CSP domains, secrets, and capabilities",
			})
			.input(AppIdParamSchema)
			.output(
				z.object({
					tools: z.array(
						z.object({
							id: z.string(),
							toolId: z.string(),
							title: z.string(),
							description: z.string().nullable(),
							enabled: z.boolean(),
							widgetKey: z.string().nullable(),
							sortOrder: z.number(),
						}),
					),
					adapters: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							adapterType: z.string(),
							enabled: z.boolean(),
							priority: z.number(),
						}),
					),
					secrets: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							hint: z.string().nullable(),
							createdAt: z.string().datetime(),
						}),
					),
					capabilities: z
						.object({
							searchListings: z.boolean().optional(),
							searchContent: z.boolean().optional(),
							cartManagement: z.boolean().optional(),
							wishlistManagement: z.boolean().optional(),
							productRecommendations: z.boolean().optional(),
							storeLocator: z.boolean().optional(),
							orderTracking: z.boolean().optional(),
						})
						.passthrough()
						.nullable(),
				}),
			),

		/**
		 * Platform-admin: write the resolved `appId` into aggregate entries that
		 * link only by slug. Dry run by default.
		 */
		backfillAggregateAppIds: oc
			.route({
				method: "POST",
				path: "/maintenance/backfill-aggregate-app-ids",
				tags: ["internal"],
				summary: "Backfill aggregate app ids",
				description:
					"Platform admin only. Resolve every aggregateApps entry lacking appId by slug, exactly as the MCP gateway resolves it, and set appId. Unresolvable entries are reported and left unchanged. Dry run unless dryRun is false.",
			})
			.input(BackfillAggregateAppIdsInputSchema)
			.output(BackfillAggregateAppIdsOutputSchema),

		/**
		 * Platform-admin: rename an app's slug in any organization and rewrite
		 * every aggregate entry that links to it. Dry run by default.
		 */
		renameSlug: oc
			.route({
				method: "POST",
				path: "/maintenance/rename-slug",
				tags: ["internal"],
				summary: "Rename app slug",
				description:
					"Platform admin only. Rename one app's slug across organizations and, in the same batch, update the slug of every aggregateApps entry in any organization that links to it by appId or by the old slug. Refused while a slug-only link is ambiguous. Dry run unless dryRun is false.",
			})
			.input(RenameAppSlugInputSchema)
			.output(RenameAppSlugOutputSchema),

		/**
		 * Platform-admin: point every reference to one connection provider at
		 * another existing provider. Dry run by default.
		 */
		relinkConnectionProvider: oc
			.route({
				method: "POST",
				path: "/maintenance/relink-connection-provider",
				tags: ["internal"],
				summary: "Relink connection provider",
				description:
					"Platform admin only. Replace connection provider id `from` with `to` in apps' mcpConfig.connectionProviderId, mcpConfig.openApiSync.connectionProviderId, aggregate entries, connection-auth tool rows and catalog scan connections. Never creates or deletes Descope apps; `to` must already exist. Dry run unless dryRun is false.",
			})
			.input(RelinkConnectionProviderInputSchema)
			.output(RelinkConnectionProviderOutputSchema),
	});

export type AppsContract = typeof appsContract;
