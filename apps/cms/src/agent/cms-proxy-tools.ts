import {
	blockFieldDefinitionSchema as NativeBlockFieldSchema,
	blockTypeSchema as NativeBlockTypeSchema,
	contentSeoInput,
	contentBylineInputSchema,
	calendarQuery,
	createCollectionBody,
	updateCollectionBody,
	createFieldBody,
	updateFieldBody,
	searchEnableBody,
} from "emdash/api/schemas";
import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import {
	getCmsSiteOverview,
	pluginList,
	pluginUpdates,
	registryStatus,
} from "./cms-proxy-inspection";
import { mediaToFieldValue, mediaUpload } from "./cms-proxy-media";
import {
	createSiteTransferImport,
	prepareSiteTransferExport,
} from "./cms-proxy-transfer";
import {
	callCmsRest,
	callCmsTransferRest,
	callCmsFormsTool,
	completeExistingCmsSetup,
	NATIVE_FORM_TOOL_NAMES,
	callTenantMcpTool,
	type CmsProxyContext,
	hasTenantMcpCredential,
	menuSetItems,
	type ToolResult,
} from "./cms-proxy-runtime";
import {
	BylineFieldSchema,
	BylineFieldUsageSchema,
	BylineSchema,
	CollectionSchema,
	ContentAuthorSchema,
	ContentCreateResponseSchema,
	ContentItemSchema,
	GetResponseSchema,
	ListResponseSchema,
	MediaItemSchema,
	MediaFolderSchema,
	MediaUsageDetailsResponseSchema,
	MediaProviderItemSchema,
	MediaProviderSchema,
	MenuSchema,
	PluginSchema,
	PluginSettingsSchema,
	RevisionSchema,
	schema,
	SearchHitSchema,
	TaxonomySchema,
	TaxonomyGetResponseSchema,
	TaxonomyListResponseSchema,
	TaxonomyTermsResponseSchema,
	TermSchema,
	TranslationsResponseSchema,
} from "./cms-proxy-schemas";

const CmsLocaleSchema = z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i);

// Native JSON Schema is the boundary between independently resolved Zod versions.
const BlockFieldSchema = z.fromJSONSchema(
	NativeBlockFieldSchema.toJSONSchema(),
);
const BlockTypeSchema = z.fromJSONSchema(NativeBlockTypeSchema.toJSONSchema());

const OverviewCollectionSchema = CollectionSchema.extend({
	fields: CollectionSchema.shape.fields.nullable(),
	fieldCount: z.number().int().nullable(),
});
const OverviewErrorsSchema = z
	.object({ schemas: z.record(z.string(), z.string()).optional() })
	.catchall(z.string());
const CollectionDeletionItemSchema = z.object({
	collectionId: z.string(),
	collectionSlug: z.string(),
	state: z.enum(["pending", "retry", "leased", "failed"]),
	phase: z.enum([
		"fence",
		"registry",
		"table",
		"work",
		"sources",
		"status",
		"finalize",
	]),
	attemptCount: z.number().int().min(0),
	nextAttemptAt: z.string(),
	leaseExpiresAt: z.string().nullable(),
	lastErrorCode: z.string().nullable(),
	updatedAt: z.string(),
});
const CollectionDeletionListResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CollectionDeletionItemSchema).max(100),
		nextCursor: z.string().optional(),
	}),
});

const blockSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z][a-z0-9_]*$/);
const mediaFolderId = z.string().min(1).max(64);
const mediaFolderName = z.string().refine((name) => {
	const length = name.trim().length;
	return length >= 1 && length <= 200;
});
const referencesSchema = z
	.record(blockSlug, z.array(z.string()).max(1000))
	.describe(
		"Reference field slugs mapped to entry IDs; publish the draft to make links live",
	);
const relationLabelsSchema = z.object({
	parentLabel: z.string().min(1).max(200).optional(),
	parentLabelSingular: z.string().min(1).max(200).nullable().optional(),
	childLabel: z.string().min(1).max(200).optional(),
	childLabelSingular: z.string().min(1).max(200).nullable().optional(),
	maxChildrenPerParent: z.number().int().positive().nullable().optional(),
	maxParentsPerChild: z.number().int().positive().nullable().optional(),
});
// ---------------------------------------------------------------------------
// Register tenant CMS tools
// ---------------------------------------------------------------------------

function proxyTool(
	ctx: CmsProxyContext,
	toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
	return (args) => callCmsRest(ctx, toolName, args);
}

function operatorRestTool(
	ctx: CmsProxyContext,
	toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
	// The forwarded OAuth JWT is not an Emdash cookie session. Gate the trusted
	// service path on Site Builder's verified CMS maintenance authority instead.
	return (args) => {
		if (!ctx.mediaMaintenanceAuthorized) {
			return Promise.resolve({
				content: [{ type: "text", text: "[FORBIDDEN] Content admin required" }],
				isError: true,
			});
		}
		return callCmsRest(ctx, toolName, args);
	};
}

function mediaUsageAdminTool(
	ctx: CmsProxyContext,
	toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
	return (args) => {
		if (!ctx.isPlatformAdmin) {
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: "[FORBIDDEN] Platform admin required for media usage activation and indexing",
					},
				],
				isError: true,
			});
		}
		return callCmsRest(ctx, toolName, args);
	};
}

function mediaUsageReadTool(
	ctx: CmsProxyContext,
	toolName: "media_list" | "media_get" | "media_usage_details",
): (args: Record<string, unknown>) => Promise<ToolResult> {
	return (args) => {
		if (
			(toolName === "media_usage_details" || args.includeUsage === true) &&
			!ctx.mediaMaintenanceAuthorized
		) {
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: "[FORBIDDEN] Content admin required for media usage reads",
					},
				],
				isError: true,
			});
		}
		return callCmsRest(ctx, toolName, args);
	};
}

/** A whole-site package includes drafts and media, so tenant membership alone is insufficient. */
function siteTransferTool(
	ctx: CmsProxyContext,
	toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
	return (args) => {
		if (!ctx.isPlatformAdmin) {
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: "[FORBIDDEN] Platform admin required for site transfer. The calling credential must carry platform:admin or a platform-admin role; ordinary MCP admin scopes do not qualify. Eligible humans can use tedix login --scope-profile platform-admin and explicitly approve Platform administration. Tedis require an existing platform_admin capability profile through trusted delegation.",
					},
				],
				isError: true,
			});
		}
		if (ctx.humanAuthRequired) return callCmsTransferRest(ctx, toolName, args);
		if (!hasTenantMcpCredential(ctx)) {
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: "[UNAUTHORIZED] Site transfer requires an Emdash service PAT",
					},
				],
				isError: true,
			});
		}
		return callTenantMcpTool(ctx, toolName, args);
	};
}

const transferOperationId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);
const transferApprovalId = z.string().min(1).max(64);
const transferDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const portableId = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[\x21-\x7e]+$/);
const importDecisions = z.strictObject({
	principalMappings: z.record(portableId, portableId.nullable()).optional(),
	siteTitle: z.enum(["package", "target"]).optional(),
	siteTagline: z.enum(["package", "target"]).optional(),
});

function registerSiteTransferTools(
	server: McpServer,
	ctx: CmsProxyContext,
): void {
	const bridgeInput = z.object({
		sourceSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
		targetSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
		exportOperationId: transferOperationId,
	});
	server.registerTool(
		"site_transfer_prepare_export",
		{
			title: "Prepare Same-Org Site Export",
			description:
				"Verify an Emdash 0.42 export manifest for two active sites owned by the same organization. Returns metadata only.",
			inputSchema: schema(bridgeInput),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => prepareSiteTransferExport(ctx, args),
	);
	server.registerTool(
		"site_transfer_create_import",
		{
			title: "Create Same-Org Site Import",
			description:
				"Create or resume a target import and copy one bounded page of missing package files. Stops before analysis and execution.",
			inputSchema: schema(
				bridgeInput.extend({
					importOperationId: transferOperationId.optional(),
					limit: z.number().int().min(1).max(2).optional(),
					cursor: z.string().min(1).max(2048).optional(),
				}),
			),
		},
		async (args: any) => createSiteTransferImport(ctx, args),
	);
	const definitions = [
		{
			name: "site_transfer_capabilities",
			title: "Get Site Transfer Capabilities",
			description:
				"Report Emdash package versions, limits, and whether this tenant can receive an import.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		{
			name: "site_export_start",
			title: "Start Site Export",
			description:
				"Start a whole-site portable export. Returns an operation ID; download package bytes through the authenticated Emdash admin REST API.",
			inputSchema: z.object({
				comments: z.boolean().optional(),
				approvalId: transferApprovalId.optional(),
			}),
		},
		{
			name: "site_export_status",
			title: "Get Site Export Status",
			description:
				"Advance one bounded export step by default and report progress; set advance=false for a read only status call.",
			inputSchema: z.object({
				operationId: transferOperationId,
				advance: z.boolean().optional(),
			}),
		},
		{
			name: "site_import_analyze",
			title: "Analyze Site Import",
			description:
				"Analyze an uploaded package and return a bounded plan. Package bytes must be uploaded through authenticated Emdash admin REST.",
			inputSchema: z.object({
				operationId: transferOperationId,
				decisions: importDecisions.optional(),
			}),
		},
		{
			name: "site_import_start",
			title: "Start Site Import",
			description:
				"Start import of the analyzed package into an empty site using the exact package and plan digests.",
			inputSchema: z.object({
				operationId: transferOperationId,
				packageDigest: transferDigest,
				planDigest: transferDigest,
				approvalId: transferApprovalId.optional(),
			}),
			annotations: { destructiveHint: true },
		},
		{
			name: "site_import_status",
			title: "Get Site Import Status",
			description: "Read import progress without advancing it.",
			inputSchema: z.object({ operationId: transferOperationId }),
			annotations: { readOnlyHint: true },
		},
		{
			name: "site_import_resume",
			title: "Resume Site Import",
			description: "Run one bounded step of a started import.",
			inputSchema: z.object({ operationId: transferOperationId }),
		},
		{
			name: "site_import_receipt",
			title: "Get Site Import Receipt",
			description:
				"Read the verified receipt and digests of a completed import.",
			inputSchema: z.object({ operationId: transferOperationId }),
			annotations: { readOnlyHint: true },
		},
	] as const;
	for (const definition of definitions) {
		server.registerTool(
			definition.name,
			{
				title: definition.title,
				description: definition.description,
				inputSchema: schema(definition.inputSchema),
				annotations:
					"annotations" in definition ? definition.annotations : undefined,
			},
			async (args: any) => siteTransferTool(ctx, definition.name)(args),
		);
	}
}

export function registerCmsProxyTools(
	server: McpServer,
	ctx: CmsProxyContext,
): void {
	registerSiteTransferTools(server, ctx);
	// =====================================================================
	// Operator orientation tools
	// =====================================================================

	server.registerTool(
		"get_site_overview",
		{
			title: "Get CMS Site Overview",
			description:
				"Return a compact operator context for this tenant: site template, live bundle and CSS revisions, settings, collections, fields, menus, taxonomies, plugins, auth modes, and workflow hints. Use this first when a tedi or kernel needs to operate a CMS efficiently.",
			inputSchema: schema(
				z.object({
					locale: z
						.string()
						.optional()
						.describe("Locale for menu and recent-content context"),
					collections: z
						.array(z.string())
						.optional()
						.describe(
							"Collections to sample when includeRecentContent=true. Defaults to posts/pages when present.",
						),
					includeRecentContent: z
						.boolean()
						.optional()
						.describe(
							"Include a small recent-content sample per selected collection. Defaults to false.",
						),
					recentLimit: z
						.number()
						.int()
						.min(1)
						.max(20)
						.optional()
						.describe("Recent content items per selected collection"),
					includeMenus: z
						.boolean()
						.optional()
						.describe("Include menu summaries. Defaults to true."),
					includeTaxonomies: z
						.boolean()
						.optional()
						.describe("Include taxonomy summaries. Defaults to true."),
					includePlugins: z
						.boolean()
						.optional()
						.describe(
							"Include plugin source/status summary. Defaults to true.",
						),
					maxFieldsPerCollection: z
						.number()
						.int()
						.min(0)
						.max(50)
						.optional()
						.describe(
							"Maximum field summaries per collection. Defaults to 16.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						environment: z.string(),
						site: z.object({
							templateSlug: z.string().nullable(),
							publicUrl: z.string().nullable(),
							activeBundleVersion: z.number().int().nullable(),
							sourceRevision: z
								.object({
									kind: z.enum(["artifacts_commit", "editable_source_digest"]),
									value: z.string(),
								})
								.nullable(),
							hotCssRevision: z.string().nullable(),
						}),
						locale: z.string().optional(),
						authModes: z.array(z.enum(["jwt", "pat", "internal"])),
						settings: z.record(z.string(), z.unknown()).optional(),
						collections: z.array(OverviewCollectionSchema),
						menus: z.array(MenuSchema).optional(),
						taxonomies: z.array(TaxonomySchema).optional(),
						plugins: z.record(z.string(), z.unknown()).optional(),
						databaseRuntime: z.record(z.string(), z.unknown()).optional(),
						mediaRuntime: z.record(z.string(), z.unknown()).optional(),
						recentContent: z
							.record(z.string(), z.array(ContentItemSchema))
							.optional(),
						errors: OverviewErrorsSchema.optional(),
						operatorHints: z.array(z.string()),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => getCmsSiteOverview(ctx, args),
	);

	// =====================================================================
	// Content tools
	// =====================================================================

	server.registerTool(
		"content_list",
		{
			title: "List Content",
			description:
				"List content items in a collection with native Emdash search, filtering, and pagination.",
			inputSchema: schema(
				z.object({
					collection: z
						.string()
						.describe("Collection slug (e.g. 'posts', 'pages')"),
					q: z
						.string()
						.optional()
						.describe("Native Emdash content search query"),
					status: z
						.enum(["draft", "published", "scheduled"])
						.optional()
						.describe("Filter by status"),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Max items (default 50)"),
					cursor: z.string().optional().describe("Pagination cursor"),
					orderBy: z.string().optional().describe("Field to sort by"),
					order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
					locale: z.string().optional().describe("Filter by locale"),
					authorId: z
						.string()
						.optional()
						.describe(
							"Filter to entries authored by this Emdash user ID. Use list_content_authors first when you need valid IDs.",
						),
					dateField: z
						.enum(["createdAt", "updatedAt", "publishedAt"])
						.optional()
						.describe(
							"Timestamp field for dateFrom/dateTo filtering. Required when using either date bound.",
						),
					dateFrom: z
						.string()
						.optional()
						.describe(
							"Inclusive ISO date or datetime lower bound. Requires dateField.",
						),
					dateTo: z
						.string()
						.optional()
						.describe(
							"Inclusive ISO date or datetime upper bound. Requires dateField.",
						),
				}),
			),
			outputSchema: schema(ListResponseSchema(ContentItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_list")(args),
	);

	server.registerTool(
		"list_content_authors",
		{
			title: "List Content Authors",
			description:
				"List distinct authors and byline credits for a collection's live content. Use filterableByAuthorId rows with content_list authorId filtering; use byline-only rows with list_content_byline_entries.",
			inputSchema: schema(
				z.object({
					collection: z
						.string()
						.describe("Collection slug (e.g. 'posts', 'pages')"),
				}),
			),
			outputSchema: schema(ListResponseSchema(ContentAuthorSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "list_content_authors")(args),
	);

	server.registerTool(
		"list_content_byline_entries",
		{
			title: "List Content Byline Entries",
			description:
				"List content credited to one or more Emdash byline IDs using native byline filtering and cursor pagination. Translated row IDs resolve to their translation groups.",
			inputSchema: schema(
				z.object({
					collection: z
						.string()
						.describe("Collection slug (e.g. 'posts', 'pages')"),
					bylineId: z
						.string()
						.optional()
						.describe(
							"Byline row ID or translation group. Accepts IDs from list_content_authors byline-only rows or byline_list.",
						),
					bylineIds: z
						.array(z.string())
						.optional()
						.describe(
							"One or more byline row IDs or translation groups. Matches any supplied ID.",
						),
					q: z
						.string()
						.optional()
						.describe("Native Emdash content search query"),
					status: z
						.enum(["draft", "published", "scheduled"])
						.optional()
						.describe("Native status filter"),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Max matching items to return (default 50)"),
					includeInferredBylines: z
						.boolean()
						.optional()
						.describe(
							"Also include credits inferred from the entry author when there is no explicit credit; defaults to false",
						),
					cursor: z
						.string()
						.optional()
						.describe(
							"Opaque native cursor returned by the previous filtered page.",
						),
					orderBy: z.string().optional().describe("Field to sort by"),
					order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
					locale: z.string().optional().describe("Native locale filter"),
					authorId: z
						.string()
						.optional()
						.describe("Optional native authorId prefilter"),
					dateField: z
						.enum(["createdAt", "updatedAt", "publishedAt"])
						.optional()
						.describe(
							"Timestamp field for dateFrom/dateTo prefiltering. Required when using either date bound.",
						),
					dateFrom: z
						.string()
						.optional()
						.describe(
							"Inclusive ISO date or datetime lower bound. Requires dateField.",
						),
					dateTo: z
						.string()
						.optional()
						.describe(
							"Inclusive ISO date or datetime upper bound. Requires dateField.",
						),
				}),
			),
			outputSchema: schema(ListResponseSchema(ContentItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "list_content_byline_entries")(args),
	);

	server.registerTool(
		"list_calendar_entries",
		{
			title: "List Publishing Calendar Entries",
			description:
				"Read published and scheduled entries across visible collections using the native calendar. Requires content:read_drafts. From is inclusive, to is exclusive; maximum range 62 days. Follow nextCursor for more entries.",
			inputSchema: schema(
				z
					.fromJSONSchema(calendarQuery.toJSONSchema({ io: "input" }))
					.refine((args) => calendarQuery.safeParse(args).success, {
						message:
							"Invalid native calendar range; to must be after from and at most 62 days later",
					}),
			),
			outputSchema: schema(
				z.object({
					success: z.literal(true),
					data: z.object({
						items: z.array(
							z.object({
								collection: z.string(),
								id: z.string(),
								locale: z.string(),
								title: z.string(),
								status: z.string(),
								kind: z.enum(["published", "scheduled"]),
								at: z.string(),
							}),
						),
						nextCursor: z.string().optional(),
					}),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "list_calendar_entries")(args),
	);

	server.registerTool(
		"content_get",
		{
			title: "Get Content",
			description:
				"Get a single content item by ID or slug. Returns full data including _rev token for concurrency.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID (ULID) or slug"),
					locale: z.string().optional().describe("Locale for slug lookup"),
				}),
			),
			outputSchema: schema(GetResponseSchema(ContentItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_get")(args),
	);

	server.registerTool(
		"content_preview_url",
		{
			title: "Create Signed Content Preview URL",
			description:
				"Create a short-lived signed URL that renders a content item's draft at its public route. " +
				"Omit pathPattern to use the collection URL pattern, including its {slug} placeholder. " +
				"Override only when the collection pattern does not resolve to the page route.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					expiresIn: z
						.enum(["15m", "1h", "4h", "24h"])
						.optional()
						.describe("Preview lifetime; defaults to one hour"),
					pathPattern: z
						.string()
						.max(256)
						.regex(/^\/(?!\/)[^?#]*$/)
						.regex(
							/^(?:[^{}]|\{(?:collection|id|locale)\})*$/,
							"Preview overrides support only {collection}, {id}, and {locale}; omit pathPattern to use the collection URL pattern with {slug}, or provide a concrete path",
						)
						.optional()
						.describe(
							"Absolute site path, such as /, /de/, or /posts/{id}; supports {collection}, {id}, and {locale}, not {slug}; no query or fragment",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					success: z.literal(true),
					data: z.object({
						url: z
							.string()
							.regex(/^\/(?!\/)[^\s#]*[?&]_preview=/)
							.describe("Site-relative URL with Emdash's signed preview token"),
						expiresAt: z.number().int(),
					}),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_preview_url")(args),
	);

	server.registerTool(
		"content_create",
		{
			title: "Create Content",
			description:
				"Create a new content item. Use schema_get_collection to check field types. Items are 'draft' by default.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					data: z
						.record(z.string(), z.unknown())
						.describe("Field values matching collection schema"),
					slug: z
						.string()
						.optional()
						.describe("URL slug (auto-generated if omitted)"),
					status: z
						.enum(["draft"])
						.optional()
						.describe(
							"Initial status. Emdash creates drafts; use cms_*.content_publish to publish.",
						),
					locale: z.string().optional().describe("Locale"),
					translationOf: z
						.string()
						.optional()
						.describe("ID of item this is a translation of"),
					references: referencesSchema.optional(),
				}),
			),
			outputSchema: schema(ContentCreateResponseSchema),
		},
		async (args: any) => proxyTool(ctx, "content_create")(args),
	);

	server.registerTool(
		"content_update",
		{
			title: "Update Content",
			description:
				"Update an existing content item. Only include fields to change. Requires _rev from content_get; stale writes fail with CONFLICT. Published edits stay in a draft until content_publish. " +
				"seo, bylines, and publishedAt are first-class fields — no SQL fallback needed.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					data: z
						.record(z.string(), z.unknown())
						.optional()
						.describe("Custom field values to update"),
					slug: z.string().optional().describe("New URL slug"),
					status: z
						.enum(["draft"])
						.optional()
						.describe("New status. Use cms_*.content_publish to publish."),
					seo: contentSeoInput
						.optional()
						.describe(
							"Native SEO metadata; omitted fields remain unchanged, null clears",
						),
					bylines: z
						.array(z.fromJSONSchema(contentBylineInputSchema.toJSONSchema()))
						.optional()
						.describe(
							"Author bylines (replaces existing list); roleLabel is optional and null clears it",
						),
					publishedAt: z
						.string()
						.optional()
						.describe(
							"ISO timestamp; back-date or schedule (requires content:publish_any scope)",
						),
					references: referencesSchema.optional(),
					migrateBlocks: z
						.boolean()
						.optional()
						.describe(
							"Allow retained blocks to move to the active type version",
						),
					replaceBlocks: z
						.boolean()
						.optional()
						.describe(
							"Replace an existing blocks array with an entirely keyless array",
						),
					_rev: z.string().describe("Revision token for conflict detection"),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Write anyway if a human editor has this entry open (409 ENTRY_LOCKED). Only set this after checking who holds the lock — it can discard their unsaved changes.",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_update")(args),
	);

	server.registerTool(
		"content_get_terms",
		{
			title: "Get Content Terms",
			description: "Get taxonomy terms assigned to a content item.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					taxonomy: z
						.string()
						.describe("Taxonomy name (e.g. 'tag' or 'category')"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						terms: z.array(TermSchema).optional(),
						items: z.array(TermSchema).optional(),
						data: z
							.object({
								terms: z.array(TermSchema).optional(),
								items: z.array(TermSchema).optional(),
							})
							.catchall(z.unknown())
							.optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_get_terms")(args),
	);

	server.registerTool(
		"content_set_terms",
		{
			title: "Set Content Terms",
			description:
				"Replace taxonomy terms assigned to a content item. Pass term IDs from taxonomy_list_terms.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					taxonomy: z
						.string()
						.describe("Taxonomy name (e.g. 'tag' or 'category')"),
					termIds: z
						.array(z.string())
						.describe("Term IDs to assign; empty array clears the taxonomy."),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_set_terms")(args),
	);

	server.registerTool(
		"content_delete",
		{
			title: "Delete Content (Trash)",
			description:
				"Soft-delete a content item by moving to trash. Can be restored with content_restore.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Delete anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_delete")(args),
	);

	server.registerTool(
		"content_restore",
		{
			title: "Restore Content",
			description:
				"Restore a soft-deleted content item from trash as a draft. Publish or schedule it separately to make it public.",
			// Mutating. Omitting this left the tool UNDECLARED, and under the old
			// name-based inference `content_restore` matched no write verb.
			annotations: { readOnlyHint: false, destructiveHint: false },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_restore")(args),
	);

	server.registerTool(
		"content_permanent_delete",
		{
			title: "Permanently Delete Content",
			description:
				"Permanently and irreversibly delete a trashed item. Must be in trash first.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Delete anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_permanent_delete")(args),
	);

	server.registerTool(
		"content_publish",
		{
			title: "Publish Content",
			description:
				"Publish a content item, making it live. Creates a published revision from the draft. " +
				"Pass the _rev from content_get to reject a publish if the draft changed. " +
				"Pass publishedAt only to correct the publication timestamp with publish-any access; use content_schedule for future release.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
					publishedAt: z
						.string()
						.optional()
						.describe(
							"ISO publication timestamp override (requires publish-any access)",
						),
					_rev: z
						.string()
						.describe(
							"Opaque revision token from content_get for conflict detection",
						),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Publish anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_publish")(args),
	);

	server.registerTool(
		"content_unpublish",
		{
			title: "Unpublish Content",
			description:
				"Unpublish a content item, reverting to draft. No longer visible on the live site.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
					_rev: z
						.string()
						.describe(
							"Required opaque token from content_get; re-read after CONFLICT",
						),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Unpublish anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_unpublish")(args),
	);

	server.registerTool(
		"content_schedule",
		{
			title: "Schedule Content",
			description:
				"Schedule a content item for future publication at the specified ISO 8601 datetime.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
					scheduledAt: z
						.string()
						.describe("ISO 8601 datetime (e.g. '2025-06-01T09:00:00Z')"),
					_rev: z
						.string()
						.describe(
							"Required opaque token from content_get; re-read after CONFLICT",
						),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Schedule anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_schedule")(args),
	);

	server.registerTool(
		"content_unschedule",
		{
			title: "Cancel Scheduled Publication",
			description: "Cancel a previously scheduled publication. Idempotent.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_unschedule")(args),
	);

	server.registerTool(
		"content_compare",
		{
			title: "Compare Live vs Draft",
			description:
				"Compare the published version with the current draft. Shows whether there are changes.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						hasChanges: z.boolean().optional(),
						hasDraft: z.boolean().optional(),
						hasPublished: z.boolean().optional(),
						published: ContentItemSchema.nullable().optional(),
						draft: ContentItemSchema.nullable().optional(),
						diff: z.record(z.string(), z.unknown()).optional(),
						data: z.record(z.string(), z.unknown()).optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_compare")(args),
	);

	server.registerTool(
		"content_discard_draft",
		{
			title: "Discard Draft",
			description:
				"Discard draft changes and revert to last published version.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					locale: z
						.string()
						.optional()
						.describe("Locale for slug lookup on multi-locale sites"),
					_rev: z
						.string()
						.describe(
							"Required opaque token from content_get; re-read after CONFLICT",
						),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Discard anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_discard_draft")(args),
	);

	server.registerTool(
		"content_list_trashed",
		{
			title: "List Trashed Content",
			description: "List soft-deleted items in a collection's trash.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Max items"),
					cursor: z.string().optional().describe("Pagination cursor"),
				}),
			),
			outputSchema: schema(ListResponseSchema(ContentItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_list_trashed")(args),
	);

	server.registerTool(
		"content_duplicate",
		{
			title: "Duplicate Content",
			description:
				"Create a copy of a content item as a draft with '(Copy)' appended to the title.",
			// Mutating: creates a draft.
			annotations: { readOnlyHint: false, destructiveHint: false },
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug to duplicate"),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "content_duplicate")(args),
	);

	server.registerTool(
		"content_translations",
		{
			title: "Get Content Translations",
			description:
				"Get all locale variants of a content item. Only relevant when i18n is enabled.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						translations: z
							.array(
								z
									.object({
										locale: z.string(),
										id: z.string(),
										slug: z.string().optional(),
										status: z.string().optional(),
									})
									.catchall(z.unknown()),
							)
							.optional(),
						items: z.array(ContentItemSchema).optional(),
						data: z.record(z.string(), z.unknown()).optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "content_translations")(args),
	);

	// =====================================================================
	// Collection, field, and versioned block schema tools
	// =====================================================================

	server.registerTool(
		"schema_list_collections",
		{
			title: "List Collections",
			description:
				"List all content collections (content types) with their slug, label, features, and timestamps.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(ListResponseSchema(CollectionSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_list_collections")(args),
	);

	server.registerTool(
		"schema_get_collection",
		{
			title: "Get Collection Schema",
			description:
				"Get detailed collection info including all field definitions, types, and validation rules.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("Collection slug"),
				}),
			),
			outputSchema: schema(GetResponseSchema(CollectionSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_get_collection")(args),
	);

	server.registerTool(
		"schema_list_block_types",
		{
			title: "List Block Types",
			description:
				"List database-owned block types with every retained version and fingerprint.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(ListResponseSchema(BlockTypeSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_list_block_types")(args),
	);

	server.registerTool(
		"schema_get_block_type",
		{
			title: "Get Block Type",
			description:
				"Get a block type, including its active and retained versions. Read the active fingerprint before updating or activating a version.",
			inputSchema: schema(z.object({ slug: blockSlug })),
			outputSchema: schema(GetResponseSchema(BlockTypeSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_get_block_type")(args),
	);

	server.registerTool(
		"schema_create_block_type",
		{
			title: "Create Block Type",
			description:
				"Create a block type with an active version 1. Define its fields before adding the type to a collection's blocks field.",
			inputSchema: schema(
				z
					.object({
						slug: blockSlug,
						label: z.string().min(1).max(200),
						description: z.string().optional(),
						icon: z.string().optional(),
						category: z.string().optional(),
						fields: z.array(BlockFieldSchema),
					})
					.strict(),
			),
			outputSchema: schema(GetResponseSchema(BlockTypeSchema)),
		},
		async (args: any) => proxyTool(ctx, "schema_create_block_type")(args),
	);

	server.registerTool(
		"schema_update_block_type",
		{
			title: "Update Block Type",
			description:
				"Update metadata or compatible fields using the current active fingerprint. Set breaking=true to retain an incompatible field change as an inactive version.",
			inputSchema: schema(
				z
					.object({
						slug: blockSlug,
						expectedFingerprint: z.string().min(1),
						label: z.string().min(1).max(200).optional(),
						description: z.string().nullish(),
						icon: z.string().nullish(),
						category: z.string().nullish(),
						fields: z.array(BlockFieldSchema).optional(),
						breaking: z.boolean().optional(),
					})
					.strict(),
			),
			outputSchema: schema(GetResponseSchema(BlockTypeSchema)),
		},
		async (args: any) => proxyTool(ctx, "schema_update_block_type")(args),
	);

	server.registerTool(
		"schema_activate_block_type_version",
		{
			title: "Activate Block Type Version",
			description:
				"Make a retained version active using the current active fingerprint as a concurrency check.",
			inputSchema: schema(
				z
					.object({
						slug: blockSlug,
						version: z.number().int().positive(),
						expectedFingerprint: z.string().min(1),
					})
					.strict(),
			),
			outputSchema: schema(GetResponseSchema(BlockTypeSchema)),
		},
		async (args: any) =>
			proxyTool(ctx, "schema_activate_block_type_version")(args),
	);

	server.registerTool(
		"schema_create_collection",
		{
			title: "Create Collection",
			description:
				"Create a new content collection with its database table and schema.",
			inputSchema: schema(
				z.fromJSONSchema(
					createCollectionBody.omit({ source: true }).toJSONSchema(),
				),
			),
		},
		async (args: any) => proxyTool(ctx, "schema_create_collection")(args),
	);

	server.registerTool(
		"schema_update_collection",
		{
			title: "Update Collection",
			description:
				"Update collection metadata and native Emdash features such as URL patterns, per-entry SEO, comments, and supported workflows.",
			inputSchema: schema(
				z.fromJSONSchema(
					updateCollectionBody
						.extend({ slug: createCollectionBody.shape.slug })
						.toJSONSchema(),
				),
			),
		},
		async (args: any) => proxyTool(ctx, "schema_update_collection")(args),
	);

	server.registerTool(
		"schema_delete_collection",
		{
			title: "Delete Collection",
			description: "Delete a collection and ALL its content. Irreversible.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("Collection slug to delete"),
					force: z
						.boolean()
						.optional()
						.describe("Force deletion even if collection has content"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_delete_collection")(args),
	);

	server.registerTool(
		"schema_create_field",
		{
			title: "Add Field to Collection",
			description:
				"Add a new field (column) to a collection. Use type=blocks with validation.allowedTypes to reference versioned block types.",
			inputSchema: schema(
				z.fromJSONSchema(
					createFieldBody
						.extend({
							collection: blockSlug,
							allowedTypes: z
								.array(z.string())
								.optional()
								.describe(
									"Image/file MIME allowlist; merged into validation.allowedMimeTypes",
								),
						})
						.toJSONSchema(),
				),
			),
		},
		async (args: any) => proxyTool(ctx, "schema_create_field")(args),
	);

	server.registerTool(
		"update_schema_field",
		{
			title: "Update Collection Field",
			description:
				"Update a field in place. Use schema_get_collection first; type or validation changes may migrate stored values.",
			inputSchema: schema(
				z.fromJSONSchema(
					updateFieldBody
						.extend({
							collection: blockSlug,
							fieldSlug: blockSlug,
						})
						.toJSONSchema(),
				),
			),
		},
		async (args: any) => proxyTool(ctx, "schema_update_field")(args),
	);

	server.registerTool(
		"schema_delete_field",
		{
			title: "Remove Field from Collection",
			description: "Remove a field and delete all its data. Irreversible.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					fieldSlug: z.string().describe("Field slug to remove"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "schema_delete_field")(args),
	);

	server.registerTool(
		"list_relations",
		{
			title: "List Relations",
			description:
				"List Emdash collection relations and their bound fields and link counts.",
			inputSchema: schema(z.object({ collection: blockSlug.optional() })),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "relation_list")(args),
	);
	server.registerTool(
		"get_relation",
		{
			title: "Get Relation",
			inputSchema: schema(z.object({ id: z.string().min(1) })),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "relation_get")(args),
	);
	server.registerTool(
		"create_relation",
		{
			title: "Create Relation",
			description:
				"Define a relation between two collections before binding reference fields.",
			inputSchema: schema(
				relationLabelsSchema.extend({
					slug: blockSlug,
					parentCollection: blockSlug,
					childCollection: blockSlug,
					parentLabel: z.string().min(1).max(200),
					childLabel: z.string().min(1).max(200),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "relation_create")(args),
	);
	server.registerTool(
		"update_relation",
		{
			title: "Update Relation",
			inputSchema: schema(
				relationLabelsSchema
					.extend({ id: z.string().min(1) })
					.refine(
						(value) =>
							Object.entries(value).some(
								([key, field]) => key !== "id" && field !== undefined,
							),
						{ message: "At least one relation field is required" },
					),
			),
		},
		async (args: any) => proxyTool(ctx, "relation_update")(args),
	);
	server.registerTool(
		"delete_relation",
		{
			title: "Delete Relation",
			description:
				"Delete a relation and its links and bound reference fields. Irreversible.",
			inputSchema: schema(z.object({ id: z.string().min(1) })),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "relation_delete")(args),
	);

	// =====================================================================
	// Media tools
	// =====================================================================

	server.registerTool(
		"media_list",
		{
			title: "List Media",
			description:
				"List uploaded media files with optional MIME type, folder, and coverage-aware usage filtering.",
			inputSchema: schema(
				z.object({
					mimeType: z
						.string()
						.optional()
						.describe("Filter by MIME type prefix (e.g. 'image/')"),
					folderId: z
						.string()
						.min(1)
						.max(64)
						.optional()
						.describe("Media folder ID, or 'unfiled' for the Main library"),
					includeUsage: z
						.boolean()
						.optional()
						.describe("Include usage count and index coverage on each item"),
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(MediaItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => mediaUsageReadTool(ctx, "media_list")(args),
	);

	server.registerTool(
		"list_media_folders",
		{
			title: "List Media Folders",
			description:
				"List native Emdash media folders with search and pagination.",
			inputSchema: schema(
				z.object({
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().min(1).optional(),
					q: z.string().trim().min(1).max(200).optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(MediaFolderSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "list_media_folders")(args),
	);

	server.registerTool(
		"get_media_folder",
		{
			title: "Get Media Folder",
			description: "Read one native Emdash media folder by ID.",
			inputSchema: schema(z.object({ id: mediaFolderId })),
			outputSchema: schema(GetResponseSchema(MediaFolderSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "get_media_folder")(args),
	);

	server.registerTool(
		"create_media_folder",
		{
			title: "Create Media Folder",
			description: "Create a native Emdash media folder.",
			inputSchema: schema(z.object({ name: mediaFolderName })),
			outputSchema: schema(GetResponseSchema(MediaFolderSchema)),
		},
		async (args: any) => proxyTool(ctx, "create_media_folder")(args),
	);

	server.registerTool(
		"rename_media_folder",
		{
			title: "Rename Media Folder",
			description:
				"Rename a native Emdash media folder without moving its media.",
			inputSchema: schema(
				z.object({ id: mediaFolderId, name: mediaFolderName }),
			),
			outputSchema: schema(GetResponseSchema(MediaFolderSchema)),
		},
		async (args: any) => proxyTool(ctx, "rename_media_folder")(args),
	);

	server.registerTool(
		"delete_media_folder",
		{
			title: "Delete Media Folder",
			description:
				"Delete a folder. Its media return to the unfiled library with their IDs and files retained.",
			inputSchema: schema(z.object({ id: mediaFolderId })),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "delete_media_folder")(args),
	);

	server.registerTool(
		"media_create",
		{
			title: "Register Uploaded Media",
			description:
				"Register a media file already uploaded to storage. For binary uploads use the signed-upload flow.",
			inputSchema: schema(
				z.object({
					filename: z.string().describe("Original filename"),
					mimeType: z.string().describe("MIME type"),
					storageKey: z
						.string()
						.describe("Storage key the file was uploaded to"),
					size: z.number().int().optional(),
					width: z.number().int().optional(),
					height: z.number().int().optional(),
					contentHash: z.string().optional(),
					blurhash: z.string().optional(),
					dominantColor: z.string().optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "media_create")(args),
	);

	server.registerTool(
		"media_get",
		{
			title: "Get Media Item",
			description:
				"Get details of a single media file by ID, optionally with its coverage-aware usage count.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Media item ID"),
					includeUsage: z.boolean().optional(),
				}),
			),
			outputSchema: schema(GetResponseSchema(MediaItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => mediaUsageReadTool(ctx, "media_get")(args),
	);

	server.registerTool(
		"get_media_usage",
		{
			title: "Get Media Usage",
			description:
				"List content references and site settings that select one media item. The index coverage is reported separately; counts are advisory and do not cover custom HTML or external references. Requires draft-read authority.",
			inputSchema: schema(
				z.object({
					id: z.string().min(1).describe("Media item ID"),
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().min(1).max(2048).optional(),
				}),
			),
			outputSchema: schema(MediaUsageDetailsResponseSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => mediaUsageReadTool(ctx, "media_usage_details")(args),
	);

	server.registerTool(
		"get_media_usage_activation",
		{
			title: "Get Media Usage Activation",
			description:
				"Read Emdash media usage capture activation state before interpreting index progress. Requires platform admin authority.",
			inputSchema: schema(z.object({}).strict()),
			annotations: { readOnlyHint: true },
		},
		async () => mediaUsageAdminTool(ctx, "media_usage_activation")({}),
	);

	server.registerTool(
		"activate_media_usage",
		{
			title: "Activate Media Usage Capture",
			description:
				"Advance Emdash media usage capture by one collection. Only assert writersDrained after all content, schema, revision, import, and repair writers have stopped and in-flight writes have finished. Activation temporarily fences tenant writes and cannot be undone. Requires platform admin authority.",
			inputSchema: schema(
				z.object({ writersDrained: z.literal(true) }).strict(),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => mediaUsageAdminTool(ctx, "media_usage_activate")(args),
	);

	server.registerTool(
		"get_media_usage_progress",
		{
			title: "Get Media Usage Index Progress",
			description:
				"Read native Emdash media usage indexing progress after activation reaches active. Requires platform admin authority.",
			inputSchema: schema(z.object({})),
			annotations: { readOnlyHint: true },
		},
		async () => mediaUsageAdminTool(ctx, "media_usage_progress")({}),
	);

	server.registerTool(
		"list_collection_deletions",
		{
			title: "List Collection Deletions",
			description:
				"Read one bounded page of native Emdash collection deletion work, including lease and error metadata. Requires platform admin authority.",
			inputSchema: schema(
				z
					.object({
						state: z.enum(["pending", "retry", "leased", "failed"]).optional(),
						limit: z.number().int().min(1).max(100).optional(),
						cursor: z.string().min(1).max(2048).optional(),
					})
					.strict(),
			),
			outputSchema: schema(CollectionDeletionListResponseSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) =>
			mediaUsageAdminTool(ctx, "media_usage_collection_deletions")(args),
	);

	server.registerTool(
		"advance_media_usage_index",
		{
			title: "Advance Media Usage Index",
			description:
				"Run one bounded Emdash media usage maintenance step after activation begins; inspect activation, progress, and nextRequestInMs before repeating. Requires platform admin authority.",
			inputSchema: schema(z.object({}).strict()),
		},
		async () => mediaUsageAdminTool(ctx, "media_usage_progress_advance")({}),
	);

	server.registerTool(
		"repair_media_usage",
		{
			title: "Repair Media Usage Index",
			description:
				"Rebuild the native Emdash media usage index for one collection or all collections. Inspect the returned complete, partial, failed, or stale status before relying on usage protection. Requires content-write plus settings-admin, content-admin, or platform-admin authority.",
			inputSchema: schema(
				z.discriminatedUnion("scope", [
					z
						.object({ scope: z.literal("collection"), collection: blockSlug })
						.strict(),
					z.object({ scope: z.literal("all") }).strict(),
				]),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => operatorRestTool(ctx, "media_usage_repair")(args),
	);

	server.registerTool(
		"media_update",
		{
			title: "Update Media Metadata",
			description:
				"Update alt text, caption, dimensions, or folder of an uploaded media file. Use null or 'unfiled' to move it to the Main library.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Media item ID"),
					alt: z.string().optional(),
					caption: z.string().optional(),
					width: z.number().int().optional(),
					height: z.number().int().optional(),
					folderId: mediaFolderId.nullable().optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "media_update")(args),
	);

	server.registerTool(
		"media_delete",
		{
			title: "Delete Media",
			description:
				"Permanently delete a media file. Content referencing it will have broken references.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Media item ID"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "media_delete")(args),
	);

	// Media picker MCP equivalents — closes the gap with the Block Kit
	// admin picker. Order: upload (binary) → search (text) → providers (browse
	// external) → to_field_value (reshape into MediaValue for content_update).

	server.registerTool(
		"media_upload",
		{
			title: "Upload Media",
			description:
				"Upload media from base64 bytes. Forwards to the tenant's native Emdash MCP " +
				"media_upload (MIME allowlist, 50MB default limit, content-hash dedupe, " +
				"image enrichment) when the org's Emdash service PAT is provisioned; base64 uploads without a PAT " +
				"use the authenticated multipart REST route with the same pipeline. Returns the stable media item " +
				"for media_to_field_value.",
			inputSchema: schema(
				z
					.object({
						filename: z
							.string()
							.min(1)
							.describe("Original filename — informs MIME detection + display"),
						mimeType: z
							.string()
							.min(1)
							.describe("Content type, e.g. image/png"),
						dataBase64: z.string().min(1).describe("Base64-encoded file bytes"),
						alt: z
							.string()
							.optional()
							.describe("Accessibility alt text (recommended for images)"),
						caption: z.string().optional().describe("Caption / description"),
					})
					.strict(),
			),
		},
		async (args: any) => mediaUpload(ctx, args),
	);

	server.registerTool(
		"media_search",
		{
			title: "Search Media",
			description:
				"Search media with native Emdash q filtering. Optional mimeType filter (e.g. 'image/'). " +
				"Returns media items with the same shape as media_list.",
			inputSchema: schema(
				z.object({
					q: z.string().optional().describe("Native Emdash media search query"),
					query: z
						.string()
						.optional()
						.describe("Alias for q when calling the Site Builder MCP tool"),
					mimeType: z
						.string()
						.optional()
						.describe("MIME prefix filter, e.g. 'image/'"),
					limit: z
						.number()
						.int()
						.positive()
						.optional()
						.describe("Max items returned by native Emdash media search"),
					cursor: z.string().optional().describe("Pagination cursor"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						items: z.array(MediaItemSchema).optional(),
						q: z.string().optional(),
						query: z.string().optional(),
						nextCursor: z.string().nullable().optional(),
						data: z
							.object({ items: z.array(MediaItemSchema).optional() })
							.catchall(z.unknown())
							.optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "media_search")(args),
	);

	server.registerTool(
		"media_providers_list",
		{
			title: "List Media Providers",
			description:
				"List external media providers configured for this CMS (Unsplash, Mux, Cloudinary, etc).",
			inputSchema: schema(z.object({})),
			outputSchema: schema(ListResponseSchema(MediaProviderSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "media_providers_list")(args),
	);

	server.registerTool(
		"media_providers_browse",
		{
			title: "Browse Media Provider",
			description:
				"Search/browse a specific external media provider. Returns provider items that can be " +
				"converted to a MediaValue via media_to_field_value (no upload required for hot-link providers).",
			inputSchema: schema(
				z.object({
					providerId: z.string().describe("Provider ID, e.g. 'unsplash'"),
					query: z
						.string()
						.optional()
						.describe("Search text (provider-defined search semantics)"),
					mimeType: z.string().optional().describe("MIME prefix filter"),
					limit: z.number().int().positive().optional(),
					cursor: z.string().optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(MediaProviderItemSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "media_providers_browse")(args),
	);

	server.registerTool(
		"media_to_field_value",
		{
			title: "Build MediaValue for Content Field",
			description:
				"Reshape a media item (local or external) into the JSON MediaValue shape that Emdash " +
				"content fields expect. Pass mediaId for a local media item — the tool fetches it and " +
				"builds the value with provider='local'. Or pass providerId + providerItemId for an " +
				"external provider reference (no DB lookup). The returned object is ready to drop into " +
				"content_update.data.{fieldName}.",
			inputSchema: schema(
				z.object({
					mediaId: z
						.string()
						.optional()
						.describe("Local media item ID (mode 1)"),
					providerId: z
						.string()
						.optional()
						.describe("External provider ID (mode 2)"),
					providerItemId: z
						.string()
						.optional()
						.describe("Provider's item ID (mode 2)"),
					previewUrl: z
						.string()
						.optional()
						.describe("Provider preview URL (mode 2)"),
					filename: z.string().optional(),
					mimeType: z.string().optional(),
					width: z.number().int().optional(),
					height: z.number().int().optional(),
					alt: z.string().optional(),
				}),
			),
			outputSchema: schema(
				z
					.object({
						provider: z.string(),
						id: z.union([z.string(), z.number()]).optional(),
						src: z.string().optional(),
						filename: z.string().optional(),
						mimeType: z.string().optional(),
						width: z.number().int().nullable().optional(),
						height: z.number().int().nullable().optional(),
						alt: z.string().nullable().optional(),
						caption: z.string().nullable().optional(),
						meta: z.record(z.string(), z.unknown()).optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => mediaToFieldValue(ctx, args),
	);

	// =====================================================================
	// Search
	// =====================================================================

	server.registerTool(
		"search",
		{
			title: "Search Content",
			description:
				"Full-text search across content collections. Returns collection, item ID, title, excerpt, and relevance score.",
			inputSchema: schema(
				z.object({
					query: z.string().describe("Search query text"),
					collections: z
						.array(z.string())
						.optional()
						.describe("Limit to specific collection slugs"),
					locale: z.string().optional(),
					limit: z.number().int().min(1).max(50).optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(SearchHitSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "search")(args),
	);

	server.registerTool(
		"configure_search",
		{
			title: "Configure Collection Search",
			description:
				"Enable or disable native full-text search for a collection. Enable after creating searchable fields to initialize and populate the index. Disabling removes the search index, preserving content. Requires native search:manage permission.",
			inputSchema: schema(z.fromJSONSchema(searchEnableBody.toJSONSchema())),
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "configure_search")(args),
	);

	// =====================================================================
	// Taxonomy definitions, terms, and translations
	// =====================================================================

	server.registerTool(
		"taxonomy_list",
		{
			title: "List Taxonomies",
			description: "List taxonomy definitions, optionally in one locale.",
			inputSchema: schema(z.object({ locale: CmsLocaleSchema.optional() })),
			outputSchema: schema(TaxonomyListResponseSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_list")(args),
	);

	server.registerTool(
		"taxonomy_get",
		{
			title: "Get Taxonomy Definition",
			description:
				"Get one taxonomy definition. Pass locale when translated definitions share a name.",
			inputSchema: schema(
				z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
			),
			outputSchema: schema(TaxonomyGetResponseSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_get")(args),
	);

	server.registerTool(
		"taxonomy_translations",
		{
			title: "List Taxonomy Translations",
			description:
				"List every locale variant of a taxonomy definition in its translation group.",
			inputSchema: schema(
				z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
			),
			outputSchema: schema(TranslationsResponseSchema(TaxonomySchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_translations")(args),
	);

	server.registerTool(
		"taxonomy_create",
		{
			title: "Create Taxonomy Definition",
			description:
				"Create a taxonomy definition. Structure applies across locales; translationOf links a new locale variant to an existing definition ID.",
			inputSchema: schema(
				z.object({
					name: z
						.string()
						.regex(/^[a-z][a-z0-9_]*$/)
						.max(63),
					label: z.string().min(1).max(200),
					labelSingular: z.string().min(1).max(200).optional(),
					hierarchical: z.boolean().optional(),
					collections: z
						.array(
							z
								.string()
								.regex(/^[a-z][a-z0-9_]*$/)
								.max(63),
						)
						.max(100)
						.optional(),
					locale: CmsLocaleSchema.optional(),
					translationOf: z.string().min(1).optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "taxonomy_create")(args),
	);

	server.registerTool(
		"taxonomy_update",
		{
			title: "Update Taxonomy Definition",
			description:
				"Update translated labels in one locale or shared hierarchy and collection membership across every locale.",
			inputSchema: schema(
				z.object({
					name: z.string(),
					label: z.string().min(1).max(200).optional(),
					labelSingular: z.string().min(1).max(200).nullable().optional(),
					hierarchical: z.boolean().optional(),
					collections: z.array(z.string()).max(100).optional(),
					locale: CmsLocaleSchema.optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "taxonomy_update")(args),
	);

	server.registerTool(
		"taxonomy_delete",
		{
			title: "Delete Taxonomy Definition",
			description:
				"Permanently delete the taxonomy in every locale, including all terms and content assignments.",
			inputSchema: schema(z.object({ name: z.string() })),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_delete")(args),
	);

	server.registerTool(
		"taxonomy_list_terms",
		{
			title: "List Taxonomy Terms",
			description:
				"List the locale-aware term tree. Use resolveFallback to fill missing translations from the default locale.",
			inputSchema: schema(
				z
					.object({
						taxonomy: z
							.string()
							.describe("Taxonomy name (e.g. 'categories', 'tags')"),
						locale: CmsLocaleSchema.optional(),
						includeCounts: z.boolean().optional(),
						resolveFallback: z.boolean().optional(),
					})
					.strict(),
			),
			outputSchema: schema(TaxonomyTermsResponseSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_list_terms")(args),
	);

	server.registerTool(
		"taxonomy_term_translations",
		{
			title: "List Term Translations",
			description:
				"List locale variants of a term. Pass locale when slugs overlap across translation groups.",
			inputSchema: schema(
				z.object({
					taxonomy: z.string(),
					termSlug: z.string(),
					locale: CmsLocaleSchema.optional(),
				}),
			),
			outputSchema: schema(TranslationsResponseSchema(TermSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_term_translations")(args),
	);

	server.registerTool(
		"taxonomy_create_term",
		{
			title: "Create Taxonomy Term",
			description:
				"Create a new term. For hierarchical taxonomies, specify parentId for nesting.",
			inputSchema: schema(
				z.object({
					taxonomy: z.string().describe("Taxonomy name"),
					slug: z
						.string()
						.min(1)
						.optional()
						.describe("URL-safe identifier; omit to derive from label"),
					label: z.string().describe("Display name"),
					parentId: z
						.string()
						.nullable()
						.optional()
						.describe("Parent term ID for hierarchical taxonomies"),
					description: z.string().optional(),
					locale: CmsLocaleSchema.optional(),
					translationOf: z
						.string()
						.min(1)
						.optional()
						.describe("Existing term ID to create a locale translation from"),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "taxonomy_create_term")(args),
	);

	server.registerTool(
		"taxonomy_update_term",
		{
			title: "Update Taxonomy Term",
			description:
				"Update a term in one locale. Set parentId to null to detach its translation group from a parent.",
			inputSchema: schema(
				z.object({
					taxonomy: z.string().describe("Taxonomy name"),
					termSlug: z.string().describe("Current slug of the term"),
					slug: z.string().optional().describe("New slug"),
					label: z.string().optional().describe("New label"),
					parentId: z
						.string()
						.nullable()
						.optional()
						.describe("New parent ID or null to detach"),
					description: z.string().optional(),
					locale: CmsLocaleSchema.optional().describe(
						"Locale for a slug shared by translated terms",
					),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "taxonomy_update_term")(args),
	);

	server.registerTool(
		"taxonomy_delete_term",
		{
			title: "Delete Taxonomy Term",
			description:
				"Permanently delete a term. Delete children first for hierarchical taxonomies.",
			inputSchema: schema(
				z.object({
					taxonomy: z.string().describe("Taxonomy name"),
					termSlug: z.string().describe("Slug of the term to delete"),
					locale: CmsLocaleSchema.optional().describe(
						"Locale for a slug shared by translated terms",
					),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "taxonomy_delete_term")(args),
	);

	// =====================================================================
	// Byline tools
	// =====================================================================

	server.registerTool(
		"byline_list",
		{
			title: "List Bylines",
			description:
				"List author bylines with optional search. Use this to find an author ID before assigning or updating a byline.",
			inputSchema: schema(
				z.object({
					search: z
						.string()
						.optional()
						.describe("Search display names and slugs"),
					isGuest: z.boolean().optional().describe("Filter guest bylines"),
					userId: z
						.string()
						.optional()
						.describe("Filter by linked Emdash user ID"),
					locale: z
						.string()
						.optional()
						.describe(
							"Strict locale filter. Emdash 0.15+ byline credits hydrate only from a matching-locale byline.",
						),
					cursor: z.string().optional().describe("Pagination cursor"),
					limit: z.number().int().min(1).max(100).optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(BylineSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "byline_list")(args),
	);

	server.registerTool(
		"byline_get",
		{
			title: "Get Byline",
			description: "Get a single author byline by ID.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Byline ID"),
				}),
			),
			outputSchema: schema(GetResponseSchema(BylineSchema, false)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "byline_get")(args),
	);

	server.registerTool(
		"byline_create",
		{
			title: "Create Byline",
			description:
				"Create an author byline. Set websiteUrl to the author's profile URL when it should appear in the author bio.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("URL-safe byline slug"),
					displayName: z.string().describe("Public author name"),
					bio: z.string().nullable().optional(),
					avatarMediaId: z.string().nullable().optional(),
					websiteUrl: z.string().url().nullable().optional(),
					userId: z.string().nullable().optional(),
					isGuest: z.boolean().optional(),
					locale: z.string().optional().describe("Locale for this byline row"),
					translationOf: z
						.string()
						.optional()
						.describe(
							"Existing byline ID whose translation group should be reused",
						),
					customFields: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							"Native Emdash 0.17 byline custom-field values keyed by registered field slug.",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "byline_create")(args),
	);

	server.registerTool(
		"byline_update",
		{
			title: "Update Byline",
			description:
				"Partial update of an author byline. Omitted fields are preserved; use websiteUrl for LinkedIn or another trusted author profile.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Byline ID"),
					slug: z.string().optional(),
					displayName: z.string().optional(),
					bio: z.string().nullable().optional(),
					avatarMediaId: z.string().nullable().optional(),
					websiteUrl: z.string().url().nullable().optional(),
					userId: z.string().nullable().optional(),
					isGuest: z.boolean().optional(),
					customFields: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							"Partial native Emdash 0.17 byline custom-field values keyed by registered field slug. Omit to preserve existing custom-field values.",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "byline_update")(args),
	);

	server.registerTool(
		"byline_delete",
		{
			title: "Delete Byline",
			description:
				"Delete an author byline. Existing content credits should be inspected before deletion.",
			inputSchema: schema(
				z.object({ id: z.string().min(1).describe("Byline ID") }),
			),
			outputSchema: schema(
				z.object({
					success: z.literal(true),
					data: z.object({ deleted: z.literal(true) }),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "byline_delete")(args),
	);

	server.registerTool(
		"byline_translations",
		{
			title: "List Byline Translations",
			description:
				"List all locale variants for one author byline translation group.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Source byline ID"),
				}),
			),
			outputSchema: schema(ListResponseSchema(BylineSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "byline_translations")(args),
	);

	server.registerTool(
		"byline_create_translation",
		{
			title: "Create Byline Translation",
			description:
				"Create a locale variant for an existing byline. Use this before assigning credits to translated content, because native Emdash hydrates credits strictly per locale.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Source byline ID"),
					locale: z.string().describe("Target locale"),
					slug: z.string().optional(),
					displayName: z.string().optional(),
					bio: z.string().nullable().optional(),
					avatarMediaId: z.string().nullable().optional(),
					websiteUrl: z.string().url().nullable().optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "byline_create_translation")(args),
	);

	// =====================================================================
	// Byline custom-field schema tools (Emdash 0.17)
	// =====================================================================

	server.registerTool(
		"list_byline_fields",
		{
			title: "List Byline Fields",
			description:
				"List native Emdash byline custom-field definitions. Use before setting byline customFields.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(ListResponseSchema(BylineFieldSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "list_byline_fields")(args),
	);

	server.registerTool(
		"get_byline_field",
		{
			title: "Get Byline Field",
			description: "Get one native Emdash byline custom-field definition.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("Byline field slug"),
				}),
			),
			outputSchema: schema(GetResponseSchema(BylineFieldSchema, false)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "get_byline_field")(args),
	);

	const bylineFieldInput = z.object({
		slug: z
			.string()
			.regex(/^[a-z][a-z0-9_]*$/)
			.describe("Lowercase field slug, e.g. job_title or linkedin_url"),
		label: z.string().describe("Human-readable field label"),
		type: z.enum(["string", "text", "url", "boolean", "select"]),
		required: z.boolean().optional(),
		translatable: z
			.boolean()
			.optional()
			.describe(
				"Whether values are locale-specific. Set false for shared identifiers like LinkedIn URLs.",
			),
		validation: z
			.object({
				options: z.array(z.string()).optional(),
			})
			.nullable()
			.optional(),
		sortOrder: z.number().int().min(0).optional(),
	});

	server.registerTool(
		"create_byline_field",
		{
			title: "Create Byline Field",
			description:
				"Create a native Emdash byline custom-field definition. Requires Emdash schema:manage permission.",
			inputSchema: schema(bylineFieldInput),
			outputSchema: schema(GetResponseSchema(BylineFieldSchema, false)),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "create_byline_field")(args),
	);

	server.registerTool(
		"update_byline_field",
		{
			title: "Update Byline Field",
			description:
				"Update a native Emdash byline custom-field definition. Slug and type are immutable upstream.",
			inputSchema: schema(
				bylineFieldInput
					.omit({ type: true })
					.extend({
						label: z.string().optional(),
					})
					.refine(
						(value) =>
							value.label !== undefined ||
							value.required !== undefined ||
							value.translatable !== undefined ||
							value.validation !== undefined ||
							value.sortOrder !== undefined,
						{ message: "At least one update field is required" },
					),
			),
			outputSchema: schema(GetResponseSchema(BylineFieldSchema, false)),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "update_byline_field")(args),
	);

	server.registerTool(
		"delete_byline_field",
		{
			title: "Delete Byline Field",
			description:
				"Delete a native Emdash byline custom-field definition and its stored values. Check get_byline_field_usage first.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("Byline field slug"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "delete_byline_field")(args),
	);

	server.registerTool(
		"get_byline_field_usage",
		{
			title: "Get Byline Field Usage",
			description:
				"Inspect stored value counts for a native Emdash byline custom field before deleting or changing it.",
			inputSchema: schema(
				z.object({
					slug: z.string().describe("Byline field slug"),
				}),
			),
			outputSchema: schema(GetResponseSchema(BylineFieldUsageSchema, false)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "get_byline_field_usage")(args),
	);

	server.registerTool(
		"reorder_byline_fields",
		{
			title: "Reorder Byline Fields",
			description:
				"Replace the native Emdash byline custom-field display order with the exact current slug set.",
			inputSchema: schema(
				z.object({
					slugs: z
						.array(z.string())
						.describe(
							"Exact set of currently registered field slugs in desired order",
						),
				}),
			),
			outputSchema: schema(ListResponseSchema(BylineFieldSchema)),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "reorder_byline_fields")(args),
	);

	// =====================================================================
	// Menu tools (6)
	// =====================================================================

	server.registerTool(
		"menu_list",
		{
			title: "List Menus",
			description:
				"List navigation menus. Pass locale on multi-locale sites to inspect one locale.",
			inputSchema: schema(
				z.object({
					locale: z
						.string()
						.optional()
						.describe("Locale filter, e.g. 'en' or 'de'"),
				}),
			),
			outputSchema: schema(ListResponseSchema(MenuSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "menu_list")(args),
	);

	server.registerTool(
		"menu_get",
		{
			title: "Get Menu with Items",
			description: "Get a menu by name with all its ordered items.",
			inputSchema: schema(
				z.object({
					name: z.string().describe("Menu name"),
					locale: z
						.string()
						.optional()
						.describe(
							"Locale to resolve when the menu exists in multiple locales",
						),
				}),
			),
			outputSchema: schema(GetResponseSchema(MenuSchema, false)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "menu_get")(args),
	);

	server.registerTool(
		"menu_translations",
		{
			title: "List Menu Translations",
			description:
				"List every locale variant of a menu in its translation group.",
			inputSchema: schema(
				z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
			),
			outputSchema: schema(TranslationsResponseSchema(MenuSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "menu_translations")(args),
	);

	server.registerTool(
		"menu_create",
		{
			title: "Create Menu",
			description:
				"Create a new navigation menu. Add items with menu_set_items.",
			inputSchema: schema(
				z.object({
					name: z
						.string()
						.describe("Stable identifier (lowercase, underscores)"),
					label: z.string().describe("Display name"),
					locale: z
						.string()
						.optional()
						.describe("Locale for this menu, e.g. 'en' or 'de'"),
					translationOf: z
						.string()
						.optional()
						.describe(
							"Existing menu ID to create this locale variant from; requires locale",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "menu_create")(args),
	);

	server.registerTool(
		"menu_update",
		{
			title: "Update Menu",
			description: "Update a menu's label. The name cannot be changed.",
			inputSchema: schema(
				z.object({
					name: z.string().describe("Menu name"),
					label: z.string().describe("New display label"),
					locale: z
						.string()
						.optional()
						.describe("Locale of the menu to update"),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "menu_update")(args),
	);

	server.registerTool(
		"menu_delete",
		{
			title: "Delete Menu",
			description: "Delete a menu and all its items.",
			inputSchema: schema(
				z.object({
					name: z.string().describe("Menu name"),
					locale: z
						.string()
						.optional()
						.describe("Locale of the menu to delete"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "menu_delete")(args),
	);

	server.registerTool(
		"menu_set_items",
		{
			title: "Set Menu Items",
			description:
				"Replace the entire item list of a menu. Atomic (single upstream transaction via the native Emdash " +
				"MCP tool) when the org's Emdash service PAT is provisioned; otherwise decomposed into delete+create " +
				"with best-effort restore. Items are ordered by array position. Use parentIndex for nesting.",
			inputSchema: schema(
				z.object({
					name: z.string().describe("Menu name"),
					locale: z
						.string()
						.optional()
						.describe("Locale of the menu to rewrite"),
					items: z.array(
						z.object({
							label: z.string().describe("Item display text"),
							type: z
								.enum(["custom", "page", "post", "taxonomy", "collection"])
								.describe("Item kind"),
							customUrl: z
								.string()
								.optional()
								.describe("URL for type='custom'"),
							referenceCollection: z.string().optional(),
							referenceId: z.string().optional(),
							titleAttr: z.string().optional(),
							target: z.string().optional(),
							cssClasses: z.string().optional(),
							parentIndex: z
								.number()
								.int()
								.nonnegative()
								.optional()
								.describe("Array index of parent item for nesting"),
						}),
					),
				}),
			),
		},
		async (args: any) => menuSetItems(ctx, args),
	);

	// =====================================================================
	// Revision tools (2)
	// =====================================================================

	server.registerTool(
		"revision_list",
		{
			title: "List Revisions",
			description: "List revision history for a content item. Newest first.",
			inputSchema: schema(
				z.object({
					collection: z.string().describe("Collection slug"),
					id: z.string().describe("Content item ID or slug"),
					limit: z.number().int().min(1).max(50).optional(),
				}),
			),
			outputSchema: schema(ListResponseSchema(RevisionSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "revision_list")(args),
	);

	server.registerTool(
		"revision_restore",
		{
			title: "Restore Revision",
			description:
				"Restore a content item to a previous revision. Use cms_*.content_publish after to make it live.",
			inputSchema: schema(
				z.object({
					revisionId: z.string().describe("Revision ID to restore"),
					overrideLock: z
						.boolean()
						.optional()
						.describe(
							"Restore anyway if another editor holds this entry. Only set after checking the holder; this can discard their unsaved changes.",
						),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "revision_restore")(args),
	);

	// =====================================================================
	// Settings tools (2)
	// =====================================================================

	server.registerTool(
		"settings_get",
		{
			title: "Get Site Settings",
			description:
				"Get all site-wide settings (title, tagline, logo, favicon, URL, social, SEO).",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						title: z.string().nullable().optional(),
						tagline: z.string().nullable().optional(),
						logo: z.record(z.string(), z.unknown()).nullable().optional(),
						favicon: z.record(z.string(), z.unknown()).nullable().optional(),
						url: z.string().nullable().optional(),
						postsPerPage: z.number().int().nullable().optional(),
						dateFormat: z.string().nullable().optional(),
						timezone: z.string().nullable().optional(),
						social: z.record(z.string(), z.unknown()).nullable().optional(),
						seo: z.record(z.string(), z.unknown()).nullable().optional(),
						data: z.record(z.string(), z.unknown()).optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "settings_get")(args),
	);

	server.registerTool(
		"settings_update",
		{
			title: "Update Site Settings",
			description:
				"Partial update of native Emdash site settings. Configure tenant branding through cms_*.settings_update: upload/select local media first, then pass logo, favicon, or seo.defaultOgImage as { mediaId, alt? }.",
			inputSchema: schema(
				z.object({
					title: z.string().optional().describe("Site title"),
					tagline: z.string().optional(),
					logo: z
						.object({ mediaId: z.string(), alt: z.string().optional() })
						.describe(
							"Native Emdash logo media reference. Use media_upload or media_search first.",
						)
						.optional(),
					favicon: z
						.object({ mediaId: z.string(), alt: z.string().optional() })
						.describe(
							"Native Emdash favicon media reference. Use media_upload or media_search first.",
						)
						.optional(),
					url: z.string().optional().describe("Canonical site URL"),
					postsPerPage: z.number().int().min(1).max(100).optional(),
					dateFormat: z.string().optional(),
					timezone: z.string().optional(),
					social: z
						.object({
							twitter: z.string().optional(),
							github: z.string().optional(),
							facebook: z.string().optional(),
							instagram: z.string().optional(),
							linkedin: z.string().optional(),
							youtube: z.string().optional(),
						})
						.optional(),
					seo: z
						.object({
							titleSeparator: z.string().optional(),
							defaultOgImage: z
								.object({ mediaId: z.string(), alt: z.string().optional() })
								.describe(
									"Native Emdash site-wide fallback social image. EmDashHead emits it as og:image, twitter:image, and BlogPosting image when a page has no own image.",
								)
								.optional(),
							robotsTxt: z.string().optional(),
							googleVerification: z.string().optional(),
							bingVerification: z.string().optional(),
						})
						.optional(),
				}),
			),
		},
		async (args: any) => proxyTool(ctx, "settings_update")(args),
	);

	// =====================================================================
	// Plugin / registry tools
	// =====================================================================

	server.registerTool(
		"registry_status",
		{
			title: "Get Plugin Registry Status",
			description:
				"Tenant plugin inventory and signed sandbox-canary proof state. Installation capability requires separate exact-site verification.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z.object({
					registry: z.object({
						installationState: z.literal("unverified"),
						reason: z.string(),
						policy: z.string(),
						manifestVisible: z.boolean(),
						manifestError: z.string().optional(),
					}),
					plugins: z.object({
						total: z.number().int(),
						bySource: z.record(z.string(), z.number().int()),
						byStatus: z.record(z.string(), z.number().int()),
						registryInstalled: z.number().int(),
						registrySignals: z.object({
							withRequires: z.number().int(),
							withArtifacts: z.number().int(),
							withProfileSections: z.number().int(),
							withSbom: z.number().int(),
							withCompatibilityWarnings: z.number().int(),
						}),
						items: z.array(PluginSchema),
					}),
					updates: z.object({
						total: z.number().int(),
						items: z.array(PluginSchema),
						registrySignals: z.object({
							withRequires: z.number().int(),
							withArtifacts: z.number().int(),
							withProfileSections: z.number().int(),
							withSbom: z.number().int(),
							withCompatibilityWarnings: z.number().int(),
						}),
						warning: z.string().optional(),
					}),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async () => registryStatus(ctx),
	);

	server.registerTool(
		"plugin_list",
		{
			title: "List Plugins",
			description:
				"List native Emdash plugins for the tenant, including configured, marketplace, and registry-source plugins.",
			inputSchema: schema(
				z.object({
					source: z.enum(["config", "marketplace", "registry"]).optional(),
					status: z.enum(["active", "inactive"]).optional(),
				}),
			),
			outputSchema: schema(
				z.object({
					items: z.array(PluginSchema),
					summary: z.object({
						total: z.number().int(),
						bySource: z.record(z.string(), z.number().int()),
						byStatus: z.record(z.string(), z.number().int()),
						registrySignals: z.object({
							withRequires: z.number().int(),
							withArtifacts: z.number().int(),
							withProfileSections: z.number().int(),
							withSbom: z.number().int(),
							withCompatibilityWarnings: z.number().int(),
						}),
					}),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => pluginList(ctx, args),
	);

	server.registerTool(
		"plugin_get",
		{
			title: "Get Plugin",
			description: "Get native Emdash plugin details by plugin id.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Plugin id"),
				}),
			),
			outputSchema: schema(GetResponseSchema(PluginSchema)),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_get")(args),
	);

	server.registerTool(
		"plugin_updates",
		{
			title: "List Plugin Updates",
			description:
				"Check native Emdash marketplace and registry plugin updates for this tenant.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						data: z
							.object({
								items: z.array(PluginSchema).optional(),
								warning: z.string().optional(),
							})
							.catchall(z.unknown())
							.optional(),
						items: z.array(PluginSchema).optional(),
						warning: z.string().optional(),
					})
					.catchall(z.unknown()),
			),
			annotations: { readOnlyHint: true },
		},
		async () => pluginUpdates(ctx),
	);

	for (const [name, action] of [
		["plugin_enable", "enable"],
		["plugin_disable", "disable"],
	] as const) {
		server.registerTool(
			name,
			{
				title: `${action === "enable" ? "Enable" : "Disable"} Plugin`,
				description: `${action === "enable" ? "Enable" : "Disable"} an installed native Emdash plugin. Requires plugins:manage permission.`,
				inputSchema: schema(
					z.object({ id: z.string().min(1).describe("Plugin ID") }),
				),
				outputSchema: schema(GetResponseSchema(PluginSchema)),
				annotations: { destructiveHint: true },
			},
			async (args: any) => proxyTool(ctx, name)(args),
		);
	}

	server.registerTool(
		"set_plugin_mcp",
		{
			title: "Set Plugin MCP Consent",
			description:
				"Enable or revoke native plugin MCP consent after reviewing its declared tools. Requires content admin and native plugins:manage permission.",
			inputSchema: schema(
				z.strictObject({
					id: z.literal("emdash-forms"),
					enabled: z.boolean(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => operatorRestTool(ctx, "set_plugin_mcp")(args),
	);

	server.registerTool(
		"complete_existing_setup",
		{
			title: "Complete Existing Site Onboarding",
			description:
				"Complete native onboarding for an already populated CMS site without applying a seed. Requires content admin and native settings:manage permission; preserves the acting human. Refuses unfinished wizard state and empty sites.",
			inputSchema: schema(z.object({}).strict()),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
			},
		},
		async () => completeExistingCmsSetup(ctx),
	);

	for (const name of NATIVE_FORM_TOOL_NAMES) {
		const readOnly =
			name === "list_forms" ||
			name === "list_form_submissions" ||
			name === "get_form_submission";
		server.registerTool(
			name,
			{
				title: name,
				description:
					"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
				inputSchema: schema(z.record(z.string(), z.unknown())),
				annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
			},
			async (args: any) => callCmsFormsTool(ctx, name, args),
		);
	}

	server.registerTool(
		"plugin_settings_get",
		{
			title: "Get Plugin Settings",
			description:
				"Read a plugin's settings schema and values. Emdash omits secret values and returns only secretsSet booleans. Requires plugins:manage permission.",
			inputSchema: schema(
				z.object({ id: z.string().min(1).describe("Plugin ID") }),
			),
			outputSchema: schema(PluginSettingsSchema),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_settings_get")(args),
	);

	server.registerTool(
		"plugin_settings_update",
		{
			title: "Update Plugin Settings",
			description:
				"Update only supplied plugin settings. Set a value to null to clear it. Secret values are write-only and omitted from the Emdash response. Requires plugins:manage permission.",
			inputSchema: schema(
				z.object({
					id: z.string().min(1).describe("Plugin ID"),
					values: z
						.record(z.string(), z.unknown())
						.describe("Setting keys and new values"),
				}),
			),
			outputSchema: schema(PluginSettingsSchema),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_settings_update")(args),
	);

	server.registerTool(
		"plugin_verify",
		{
			title: "Verify Registry Plugin",
			description:
				"Verify a signed Emdash registry release and inspect its declared access, public routes, MCP tools, and record CIDs before installation.",
			inputSchema: schema(
				z.object({
					did: z.string().regex(/^did:[a-z]+:/),
					slug: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
					version: z.string().optional(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_verify")(args),
	);

	server.registerTool(
		"plugin_install",
		{
			title: "Install Registry Plugin",
			description:
				"Install a verified Emdash registry release by publisher DID and package slug. Requires native plugins:manage permission and exact acknowledgements from plugin_verify, including both signed record CIDs.",
			inputSchema: schema(
				z.object({
					did: z
						.string()
						.regex(/^did:[a-z]+:/)
						.describe("Publisher DID resolved from the registry aggregator"),
					slug: z
						.string()
						.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
						.describe("Registry package slug"),
					version: z.string().optional().describe("Optional explicit version"),
					acknowledgedDeclaredAccess: z
						.unknown()
						.optional()
						.describe(
							"Declared access returned by plugin_verify and acknowledged by the operator",
						),
					acknowledgedMcpTools: z.unknown().optional(),
					acknowledgedPublicRoutes: z.unknown().optional(),
					acknowledgedProfileCid: z.string().min(1).max(256).optional(),
					acknowledgedReleaseCid: z.string().min(1).max(256).optional(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_install")(args),
	);

	server.registerTool(
		"plugin_update",
		{
			title: "Update Plugin",
			description:
				"Update a marketplace or registry-source Emdash plugin. Pass source='registry' for registry plugins; use confirm flags only after reviewing returned escalation details.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Plugin id"),
					source: z
						.enum(["marketplace", "registry"])
						.default("registry")
						.describe("Plugin source update endpoint"),
					version: z.string().optional().describe("Target version"),
					confirmCapabilityChanges: z.boolean().optional(),
					confirmRouteVisibilityChanges: z.boolean().optional(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_update")(args),
	);

	server.registerTool(
		"plugin_uninstall",
		{
			title: "Uninstall Plugin",
			description:
				"Uninstall a marketplace or registry-source Emdash plugin. Use deleteData only when plugin-owned data should be removed too.",
			inputSchema: schema(
				z.object({
					id: z.string().describe("Plugin id"),
					source: z
						.enum(["marketplace", "registry"])
						.default("registry")
						.describe("Plugin source uninstall endpoint"),
					deleteData: z.boolean().optional(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => proxyTool(ctx, "plugin_uninstall")(args),
	);
}
