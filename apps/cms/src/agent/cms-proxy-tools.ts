import type { McpServer } from "@tedix/mcp-shared/server";
import type * as z from "zod";
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
	menuSetItems,
} from "./cms-proxy-rest";
import {
	callTenantMcpTool,
	hasTenantMcpCredential,
} from "./cms-proxy-tenant-mcp";
import { type CmsProxyContext, type ToolResult } from "./cms-proxy-runtime";
import { CMS_PROXY_TOOL_SCHEMAS } from "./cms-proxy-schemas";

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
	toolName: string,
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

type ProxyToolSpec = {
	name: string;
	title: string;
	description?: string;
	input: z.ZodType;
	output?: z.ZodType;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
	};
	kind:
		| "proxy"
		| "operatorRest"
		| "mediaUsageAdmin"
		| "mediaUsageRead"
		| "transfer";
	upstreamName?: string;
	execute?: (
		ctx: CmsProxyContext,
		args: Record<string, unknown>,
	) => Promise<ToolResult>;
};

function registerProxyToolSpecs(
	server: McpServer,
	ctx: CmsProxyContext,
	specs: readonly ProxyToolSpec[],
): void {
	const factories = {
		proxy: proxyTool,
		operatorRest: operatorRestTool,
		mediaUsageAdmin: mediaUsageAdminTool,
		mediaUsageRead: mediaUsageReadTool,
		transfer: siteTransferTool,
	};
	for (const spec of specs) {
		const execute = spec.execute;
		const handler = execute
			? (args: Record<string, unknown>) => execute(ctx, args)
			: factories[spec.kind](ctx, spec.upstreamName ?? spec.name);
		server.registerTool(
			spec.name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.input,
				outputSchema: spec.output,
				annotations: spec.annotations,
			},
			(input) => handler(input as Record<string, unknown>),
		);
	}
}

const CMS_PROXY_TOOL_SPECS: readonly ProxyToolSpec[] = [
	{
		name: "site_transfer_prepare_export",
		kind: "transfer",
		title: "Prepare Same-Org Site Export",
		description:
			"Verify an Emdash 0.42 export manifest for two active sites owned by the same organization. Returns metadata only.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_transfer_prepare_export.input,
		annotations: { readOnlyHint: true },
		execute: async (ctx, args) =>
			prepareSiteTransferExport(
				ctx,
				args as z.infer<
					typeof CMS_PROXY_TOOL_SCHEMAS.site_transfer_prepare_export.input
				>,
			),
	},
	{
		name: "site_transfer_create_import",
		kind: "transfer",
		title: "Create Same-Org Site Import",
		description:
			"Create or resume a target import and copy one bounded page of missing package files. Stops before analysis and execution.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_transfer_create_import.input,
		execute: async (ctx, args) =>
			createSiteTransferImport(
				ctx,
				args as z.infer<
					typeof CMS_PROXY_TOOL_SCHEMAS.site_transfer_create_import.input
				>,
			),
	},
	{
		name: "site_transfer_capabilities",
		kind: "transfer",
		title: "Get Site Transfer Capabilities",
		description:
			"Report Emdash package versions, limits, and whether this tenant can receive an import.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_transfer_capabilities.input,
		annotations: { readOnlyHint: true },
	},
	{
		name: "site_export_start",
		kind: "transfer",
		title: "Start Site Export",
		description:
			"Start a whole-site portable export. Returns an operation ID; download package bytes through the authenticated Emdash admin REST API.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_export_start.input,
	},
	{
		name: "site_export_status",
		kind: "transfer",
		title: "Get Site Export Status",
		description:
			"Advance one bounded export step by default and report progress; set advance=false for a read only status call.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_export_status.input,
	},
	{
		name: "site_import_analyze",
		kind: "transfer",
		title: "Analyze Site Import",
		description:
			"Analyze an uploaded package and return a bounded plan. Package bytes must be uploaded through authenticated Emdash admin REST.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_import_analyze.input,
	},
	{
		name: "site_import_start",
		kind: "transfer",
		title: "Start Site Import",
		description:
			"Start import of the analyzed package into an empty site using the exact package and plan digests.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_import_start.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "site_import_status",
		kind: "transfer",
		title: "Get Site Import Status",
		description: "Read import progress without advancing it.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_import_status.input,
		annotations: { readOnlyHint: true },
	},
	{
		name: "site_import_resume",
		kind: "transfer",
		title: "Resume Site Import",
		description: "Run one bounded step of a started import.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_import_resume.input,
	},
	{
		name: "site_import_receipt",
		kind: "transfer",
		title: "Get Site Import Receipt",
		description: "Read the verified receipt and digests of a completed import.",
		input: CMS_PROXY_TOOL_SCHEMAS.site_import_receipt.input,
		annotations: { readOnlyHint: true },
	},
	{
		name: "get_site_overview",
		kind: "proxy",
		title: "Get CMS Site Overview",
		description:
			"Return a compact operator context for this tenant: site template, live bundle and CSS revisions, settings, collections, fields, menus, taxonomies, plugins, auth modes, and workflow hints. Use this first when a tedi or kernel needs to operate a CMS efficiently.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_site_overview.input,
		output: CMS_PROXY_TOOL_SCHEMAS.get_site_overview.output,
		annotations: { readOnlyHint: true },
		execute: async (ctx, args) => getCmsSiteOverview(ctx, args),
	},
	{
		name: "content_list",
		kind: "proxy",
		title: "List Content",
		description:
			"List content items in a collection with native Emdash search, filtering, and pagination.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "list_content_authors",
		kind: "proxy",
		title: "List Content Authors",
		description:
			"List distinct authors and byline credits for a collection's live content. Use filterableByAuthorId rows with content_list authorId filtering; use byline-only rows with list_content_byline_entries.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_content_authors.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_content_authors.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "list_content_byline_entries",
		kind: "proxy",
		title: "List Content Byline Entries",
		description:
			"List content credited to one or more Emdash byline IDs using native byline filtering and cursor pagination. Translated row IDs resolve to their translation groups.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_content_byline_entries.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_content_byline_entries.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "list_calendar_entries",
		kind: "proxy",
		title: "List Publishing Calendar Entries",
		description:
			"Read published and scheduled entries across visible collections using the native calendar. Requires content:read_drafts. From is inclusive, to is exclusive; maximum range 62 days. Follow nextCursor for more entries.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_calendar_entries.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_calendar_entries.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "content_get",
		kind: "proxy",
		title: "Get Content",
		description:
			"Get a single content item by ID or slug. Returns full data including _rev token for concurrency.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "content_preview_url",
		kind: "proxy",
		title: "Create Signed Content Preview URL",
		description:
			"Create a short-lived signed URL that renders a content item's draft at its public route. " +
			"Omit pathPattern to use the collection URL pattern, including its {slug} placeholder. " +
			"Override only when the collection pattern does not resolve to the page route.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_preview_url.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_preview_url.output,
	},
	{
		name: "content_create",
		kind: "proxy",
		title: "Create Content",
		description:
			"Create a new content item. Use schema_get_collection to check field types. Items are 'draft' by default.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_create.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_create.output,
	},
	{
		name: "content_update",
		kind: "proxy",
		title: "Update Content",
		description:
			"Update an existing content item. Only include fields to change. Requires _rev from content_get; stale writes fail with CONFLICT. Published edits stay in a draft until content_publish. " +
			"seo, bylines, and publishedAt are first-class fields — no SQL fallback needed.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_update.input,
	},
	{
		name: "content_get_terms",
		kind: "proxy",
		title: "Get Content Terms",
		description: "Get taxonomy terms assigned to a content item.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_get_terms.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_get_terms.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "content_set_terms",
		kind: "proxy",
		title: "Set Content Terms",
		description:
			"Replace taxonomy terms assigned to a content item. Pass term IDs from taxonomy_list_terms.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_set_terms.input,
	},
	{
		name: "content_delete",
		kind: "proxy",
		title: "Delete Content (Trash)",
		description:
			"Soft-delete a content item by moving to trash. Can be restored with content_restore.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_delete.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "content_restore",
		kind: "proxy",
		title: "Restore Content",
		description:
			"Restore a soft-deleted content item from trash as a draft. Publish or schedule it separately to make it public.",
		annotations: { readOnlyHint: false, destructiveHint: false },
		input: CMS_PROXY_TOOL_SCHEMAS.content_restore.input,
	},
	{
		name: "content_permanent_delete",
		kind: "proxy",
		title: "Permanently Delete Content",
		description:
			"Permanently and irreversibly delete a trashed item. Must be in trash first.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_permanent_delete.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "content_publish",
		kind: "proxy",
		title: "Publish Content",
		description:
			"Publish a content item, making it live. Creates a published revision from the draft. " +
			"Pass the _rev from content_get to reject a publish if the draft changed. " +
			"Pass publishedAt only to correct the publication timestamp with publish-any access; use content_schedule for future release.",
		annotations: { readOnlyHint: false, destructiveHint: true },
		input: CMS_PROXY_TOOL_SCHEMAS.content_publish.input,
	},
	{
		name: "content_unpublish",
		kind: "proxy",
		title: "Unpublish Content",
		description:
			"Unpublish a content item, reverting to draft. No longer visible on the live site.",
		annotations: { readOnlyHint: false, destructiveHint: true },
		input: CMS_PROXY_TOOL_SCHEMAS.content_unpublish.input,
	},
	{
		name: "content_schedule",
		kind: "proxy",
		title: "Schedule Content",
		description:
			"Schedule a content item for future publication at the specified ISO 8601 datetime.",
		annotations: { readOnlyHint: false, destructiveHint: true },
		input: CMS_PROXY_TOOL_SCHEMAS.content_schedule.input,
	},
	{
		name: "content_unschedule",
		kind: "proxy",
		title: "Cancel Scheduled Publication",
		description: "Cancel a previously scheduled publication. Idempotent.",
		annotations: { readOnlyHint: false, destructiveHint: true },
		input: CMS_PROXY_TOOL_SCHEMAS.content_unschedule.input,
	},
	{
		name: "content_compare",
		kind: "proxy",
		title: "Compare Live vs Draft",
		description:
			"Compare the published version with the current draft. Shows whether there are changes.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_compare.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_compare.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "content_discard_draft",
		kind: "proxy",
		title: "Discard Draft",
		description: "Discard draft changes and revert to last published version.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_discard_draft.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "content_list_trashed",
		kind: "proxy",
		title: "List Trashed Content",
		description: "List soft-deleted items in a collection's trash.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_list_trashed.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_list_trashed.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "content_duplicate",
		kind: "proxy",
		title: "Duplicate Content",
		description:
			"Create a copy of a content item as a draft with '(Copy)' appended to the title.",
		annotations: { readOnlyHint: false, destructiveHint: false },
		input: CMS_PROXY_TOOL_SCHEMAS.content_duplicate.input,
	},
	{
		name: "content_translations",
		kind: "proxy",
		title: "Get Content Translations",
		description:
			"Get all locale variants of a content item. Only relevant when i18n is enabled.",
		input: CMS_PROXY_TOOL_SCHEMAS.content_translations.input,
		output: CMS_PROXY_TOOL_SCHEMAS.content_translations.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "schema_list_collections",
		kind: "proxy",
		title: "List Collections",
		description:
			"List all content collections (content types) with their slug, label, features, and timestamps.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_list_collections.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_list_collections.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "schema_get_collection",
		kind: "proxy",
		title: "Get Collection Schema",
		description:
			"Get detailed collection info including all field definitions, types, and validation rules.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_get_collection.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_get_collection.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "schema_list_block_types",
		kind: "proxy",
		title: "List Block Types",
		description:
			"List database-owned block types with every retained version and fingerprint.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_list_block_types.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_list_block_types.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "schema_get_block_type",
		kind: "proxy",
		title: "Get Block Type",
		description:
			"Get a block type, including its active and retained versions. Read the active fingerprint before updating or activating a version.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_get_block_type.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_get_block_type.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "schema_create_block_type",
		kind: "proxy",
		title: "Create Block Type",
		description:
			"Create a block type with an active version 1. Define its fields before adding the type to a collection's blocks field.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_create_block_type.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_create_block_type.output,
	},
	{
		name: "schema_update_block_type",
		kind: "proxy",
		title: "Update Block Type",
		description:
			"Update metadata or compatible fields using the current active fingerprint. Set breaking=true to retain an incompatible field change as an inactive version.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_update_block_type.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_update_block_type.output,
	},
	{
		name: "schema_activate_block_type_version",
		kind: "proxy",
		title: "Activate Block Type Version",
		description:
			"Make a retained version active using the current active fingerprint as a concurrency check.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_activate_block_type_version.input,
		output: CMS_PROXY_TOOL_SCHEMAS.schema_activate_block_type_version.output,
	},
	{
		name: "schema_create_collection",
		kind: "proxy",
		title: "Create Collection",
		description:
			"Create a new content collection with its database table and schema.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_create_collection.input,
	},
	{
		name: "schema_update_collection",
		kind: "proxy",
		title: "Update Collection",
		description:
			"Update collection metadata and native Emdash features such as URL patterns, per-entry SEO, comments, and supported workflows.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_update_collection.input,
	},
	{
		name: "schema_delete_collection",
		kind: "proxy",
		title: "Delete Collection",
		description: "Delete a collection and ALL its content. Irreversible.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_delete_collection.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "schema_create_field",
		kind: "proxy",
		title: "Add Field to Collection",
		description:
			"Add a new field (column) to a collection. Use type=blocks with validation.allowedTypes to reference versioned block types.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_create_field.input,
	},
	{
		name: "update_schema_field",
		kind: "proxy",
		title: "Update Collection Field",
		description:
			"Update a field in place. Use schema_get_collection first; type or validation changes may migrate stored values.",
		input: CMS_PROXY_TOOL_SCHEMAS.update_schema_field.input,
		upstreamName: "schema_update_field",
	},
	{
		name: "schema_delete_field",
		kind: "proxy",
		title: "Remove Field from Collection",
		description: "Remove a field and delete all its data. Irreversible.",
		input: CMS_PROXY_TOOL_SCHEMAS.schema_delete_field.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "list_relations",
		kind: "proxy",
		title: "List Relations",
		description:
			"List Emdash collection relations and their bound fields and link counts.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_relations.input,
		annotations: { readOnlyHint: true },
		upstreamName: "relation_list",
	},
	{
		name: "get_relation",
		kind: "proxy",
		title: "Get Relation",
		input: CMS_PROXY_TOOL_SCHEMAS.get_relation.input,
		annotations: { readOnlyHint: true },
		upstreamName: "relation_get",
	},
	{
		name: "create_relation",
		kind: "proxy",
		title: "Create Relation",
		description:
			"Define a relation between two collections before binding reference fields.",
		input: CMS_PROXY_TOOL_SCHEMAS.create_relation.input,
		upstreamName: "relation_create",
	},
	{
		name: "update_relation",
		kind: "proxy",
		title: "Update Relation",
		input: CMS_PROXY_TOOL_SCHEMAS.update_relation.input,
		upstreamName: "relation_update",
	},
	{
		name: "delete_relation",
		kind: "proxy",
		title: "Delete Relation",
		description:
			"Delete a relation and its links and bound reference fields. Irreversible.",
		input: CMS_PROXY_TOOL_SCHEMAS.delete_relation.input,
		annotations: { destructiveHint: true },
		upstreamName: "relation_delete",
	},
	{
		name: "media_list",
		kind: "mediaUsageRead",
		title: "List Media",
		description:
			"List uploaded media files with optional MIME type, folder, and coverage-aware usage filtering.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "list_media_folders",
		kind: "proxy",
		title: "List Media Folders",
		description: "List native Emdash media folders with search and pagination.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_media_folders.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_media_folders.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "get_media_folder",
		kind: "proxy",
		title: "Get Media Folder",
		description: "Read one native Emdash media folder by ID.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_media_folder.input,
		output: CMS_PROXY_TOOL_SCHEMAS.get_media_folder.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "create_media_folder",
		kind: "proxy",
		title: "Create Media Folder",
		description: "Create a native Emdash media folder.",
		input: CMS_PROXY_TOOL_SCHEMAS.create_media_folder.input,
		output: CMS_PROXY_TOOL_SCHEMAS.create_media_folder.output,
	},
	{
		name: "rename_media_folder",
		kind: "proxy",
		title: "Rename Media Folder",
		description:
			"Rename a native Emdash media folder without moving its media.",
		input: CMS_PROXY_TOOL_SCHEMAS.rename_media_folder.input,
		output: CMS_PROXY_TOOL_SCHEMAS.rename_media_folder.output,
	},
	{
		name: "delete_media_folder",
		kind: "proxy",
		title: "Delete Media Folder",
		description:
			"Delete a folder. Its media return to the unfiled library with their IDs and files retained.",
		input: CMS_PROXY_TOOL_SCHEMAS.delete_media_folder.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "media_create",
		kind: "proxy",
		title: "Register Uploaded Media",
		description:
			"Register a media file already uploaded to storage. For binary uploads use the signed-upload flow.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_create.input,
	},
	{
		name: "media_get",
		kind: "mediaUsageRead",
		title: "Get Media Item",
		description:
			"Get details of a single media file by ID, optionally with its coverage-aware usage count.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "get_media_usage",
		kind: "mediaUsageRead",
		title: "Get Media Usage",
		description:
			"List content references and site settings that select one media item. The index coverage is reported separately; counts are advisory and do not cover custom HTML or external references. Requires draft-read authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_media_usage.input,
		output: CMS_PROXY_TOOL_SCHEMAS.get_media_usage.output,
		annotations: { readOnlyHint: true },
		upstreamName: "media_usage_details",
	},
	{
		name: "get_media_usage_activation",
		kind: "proxy",
		title: "Get Media Usage Activation",
		description:
			"Read Emdash media usage capture activation state before interpreting index progress. Requires platform admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_media_usage_activation.input,
		annotations: { readOnlyHint: true },
		execute: async (ctx) =>
			mediaUsageAdminTool(ctx, "media_usage_activation")({}),
	},
	{
		name: "activate_media_usage",
		kind: "mediaUsageAdmin",
		title: "Activate Media Usage Capture",
		description:
			"Advance Emdash media usage capture by one collection. Only assert writersDrained after all content, schema, revision, import, and repair writers have stopped and in-flight writes have finished. Activation temporarily fences tenant writes and cannot be undone. Requires platform admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.activate_media_usage.input,
		annotations: { destructiveHint: true },
		upstreamName: "media_usage_activate",
	},
	{
		name: "get_media_usage_progress",
		kind: "proxy",
		title: "Get Media Usage Index Progress",
		description:
			"Read native Emdash media usage indexing progress after activation reaches active. Requires platform admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_media_usage_progress.input,
		annotations: { readOnlyHint: true },
		execute: async (ctx) =>
			mediaUsageAdminTool(ctx, "media_usage_progress")({}),
	},
	{
		name: "list_collection_deletions",
		kind: "mediaUsageAdmin",
		title: "List Collection Deletions",
		description:
			"Read one bounded page of native Emdash collection deletion work, including lease and error metadata. Requires platform admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_collection_deletions.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_collection_deletions.output,
		annotations: { readOnlyHint: true },
		upstreamName: "media_usage_collection_deletions",
	},
	{
		name: "advance_media_usage_index",
		kind: "proxy",
		title: "Advance Media Usage Index",
		description:
			"Run one bounded Emdash media usage maintenance step after activation begins; inspect activation, progress, and nextRequestInMs before repeating. Requires platform admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.advance_media_usage_index.input,
		execute: async (ctx) =>
			mediaUsageAdminTool(ctx, "media_usage_progress_advance")({}),
	},
	{
		name: "repair_media_usage",
		kind: "operatorRest",
		title: "Repair Media Usage Index",
		description:
			"Rebuild the native Emdash media usage index for one collection or all collections. Inspect the returned complete, partial, failed, or stale status before relying on usage protection. Requires content-write plus settings-admin, content-admin, or platform-admin authority.",
		input: CMS_PROXY_TOOL_SCHEMAS.repair_media_usage.input,
		annotations: { destructiveHint: true },
		upstreamName: "media_usage_repair",
	},
	{
		name: "media_update",
		kind: "proxy",
		title: "Update Media Metadata",
		description:
			"Update alt text, caption, dimensions, or folder of an uploaded media file. Use null or 'unfiled' to move it to the Main library.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_update.input,
	},
	{
		name: "media_delete",
		kind: "proxy",
		title: "Delete Media",
		description:
			"Permanently delete a media file. Content referencing it will have broken references.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_delete.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "media_upload",
		kind: "proxy",
		title: "Upload Media",
		description:
			"Upload media from base64 bytes. Forwards to the tenant's native Emdash MCP " +
			"media_upload (MIME allowlist, 50MB default limit, content-hash dedupe, " +
			"image enrichment) when the org's Emdash service PAT is provisioned; base64 uploads without a PAT " +
			"use the authenticated multipart REST route with the same pipeline. Returns the stable media item " +
			"for media_to_field_value.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_upload.input,
		execute: async (ctx, args) => mediaUpload(ctx, args),
	},
	{
		name: "media_search",
		kind: "proxy",
		title: "Search Media",
		description:
			"Search media with native Emdash q filtering. Optional mimeType filter (e.g. 'image/'). " +
			"Returns media items with the same shape as media_list.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_search.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_search.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "media_providers_list",
		kind: "proxy",
		title: "List Media Providers",
		description:
			"List external media providers configured for this CMS (Unsplash, Mux, Cloudinary, etc).",
		input: CMS_PROXY_TOOL_SCHEMAS.media_providers_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_providers_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "media_providers_browse",
		kind: "proxy",
		title: "Browse Media Provider",
		description:
			"Search/browse a specific external media provider. Returns provider items that can be " +
			"converted to a MediaValue via media_to_field_value (no upload required for hot-link providers).",
		input: CMS_PROXY_TOOL_SCHEMAS.media_providers_browse.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_providers_browse.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "media_to_field_value",
		kind: "proxy",
		title: "Build MediaValue for Content Field",
		description:
			"Reshape a media item (local or external) into the JSON MediaValue shape that Emdash " +
			"content fields expect. Pass mediaId for a local media item — the tool fetches it and " +
			"builds the value with provider='local'. Or pass providerId + providerItemId for an " +
			"external provider reference (no DB lookup). The returned object is ready to drop into " +
			"content_update.data.{fieldName}.",
		input: CMS_PROXY_TOOL_SCHEMAS.media_to_field_value.input,
		output: CMS_PROXY_TOOL_SCHEMAS.media_to_field_value.output,
		annotations: { readOnlyHint: true },
		execute: async (ctx, args) => mediaToFieldValue(ctx, args),
	},
	{
		name: "search",
		kind: "proxy",
		title: "Search Content",
		description:
			"Full-text search across content collections. Returns collection, item ID, title, excerpt, and relevance score.",
		input: CMS_PROXY_TOOL_SCHEMAS.search.input,
		output: CMS_PROXY_TOOL_SCHEMAS.search.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "configure_search",
		kind: "proxy",
		title: "Configure Collection Search",
		description:
			"Enable or disable native full-text search for a collection. Enable after creating searchable fields to initialize and populate the index. Disabling removes the search index, preserving content. Requires native search:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.configure_search.input,
		annotations: { readOnlyHint: false, destructiveHint: true },
	},
	{
		name: "taxonomy_list",
		kind: "proxy",
		title: "List Taxonomies",
		description: "List taxonomy definitions, optionally in one locale.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.taxonomy_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "taxonomy_get",
		kind: "proxy",
		title: "Get Taxonomy Definition",
		description:
			"Get one taxonomy definition. Pass locale when translated definitions share a name.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.taxonomy_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "taxonomy_translations",
		kind: "proxy",
		title: "List Taxonomy Translations",
		description:
			"List every locale variant of a taxonomy definition in its translation group.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_translations.input,
		output: CMS_PROXY_TOOL_SCHEMAS.taxonomy_translations.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "taxonomy_create",
		kind: "proxy",
		title: "Create Taxonomy Definition",
		description:
			"Create a taxonomy definition. Structure applies across locales; translationOf links a new locale variant to an existing definition ID.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_create.input,
	},
	{
		name: "taxonomy_update",
		kind: "proxy",
		title: "Update Taxonomy Definition",
		description:
			"Update translated labels in one locale or shared hierarchy and collection membership across every locale.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_update.input,
	},
	{
		name: "taxonomy_delete",
		kind: "proxy",
		title: "Delete Taxonomy Definition",
		description:
			"Permanently delete the taxonomy in every locale, including all terms and content assignments.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_delete.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "taxonomy_list_terms",
		kind: "proxy",
		title: "List Taxonomy Terms",
		description:
			"List the locale-aware term tree. Use resolveFallback to fill missing translations from the default locale.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_list_terms.input,
		output: CMS_PROXY_TOOL_SCHEMAS.taxonomy_list_terms.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "taxonomy_term_translations",
		kind: "proxy",
		title: "List Term Translations",
		description:
			"List locale variants of a term. Pass locale when slugs overlap across translation groups.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_term_translations.input,
		output: CMS_PROXY_TOOL_SCHEMAS.taxonomy_term_translations.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "taxonomy_create_term",
		kind: "proxy",
		title: "Create Taxonomy Term",
		description:
			"Create a new term. For hierarchical taxonomies, specify parentId for nesting.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_create_term.input,
	},
	{
		name: "taxonomy_update_term",
		kind: "proxy",
		title: "Update Taxonomy Term",
		description:
			"Update a term in one locale. Set parentId to null to detach its translation group from a parent.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_update_term.input,
	},
	{
		name: "taxonomy_delete_term",
		kind: "proxy",
		title: "Delete Taxonomy Term",
		description:
			"Permanently delete a term. Delete children first for hierarchical taxonomies.",
		input: CMS_PROXY_TOOL_SCHEMAS.taxonomy_delete_term.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "byline_list",
		kind: "proxy",
		title: "List Bylines",
		description:
			"List author bylines with optional search. Use this to find an author ID before assigning or updating a byline.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.byline_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "byline_get",
		kind: "proxy",
		title: "Get Byline",
		description: "Get a single author byline by ID.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.byline_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "byline_create",
		kind: "proxy",
		title: "Create Byline",
		description:
			"Create an author byline. Set websiteUrl to the author's profile URL when it should appear in the author bio.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_create.input,
	},
	{
		name: "byline_update",
		kind: "proxy",
		title: "Update Byline",
		description:
			"Partial update of an author byline. Omitted fields are preserved; use websiteUrl for LinkedIn or another trusted author profile.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_update.input,
	},
	{
		name: "byline_delete",
		kind: "proxy",
		title: "Delete Byline",
		description:
			"Delete an author byline. Existing content credits should be inspected before deletion.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_delete.input,
		output: CMS_PROXY_TOOL_SCHEMAS.byline_delete.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "byline_translations",
		kind: "proxy",
		title: "List Byline Translations",
		description:
			"List all locale variants for one author byline translation group.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_translations.input,
		output: CMS_PROXY_TOOL_SCHEMAS.byline_translations.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "byline_create_translation",
		kind: "proxy",
		title: "Create Byline Translation",
		description:
			"Create a locale variant for an existing byline. Use this before assigning credits to translated content, because native Emdash hydrates credits strictly per locale.",
		input: CMS_PROXY_TOOL_SCHEMAS.byline_create_translation.input,
	},
	{
		name: "list_byline_fields",
		kind: "proxy",
		title: "List Byline Fields",
		description:
			"List native Emdash byline custom-field definitions. Use before setting byline customFields.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_byline_fields.input,
		output: CMS_PROXY_TOOL_SCHEMAS.list_byline_fields.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "get_byline_field",
		kind: "proxy",
		title: "Get Byline Field",
		description: "Get one native Emdash byline custom-field definition.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_byline_field.input,
		output: CMS_PROXY_TOOL_SCHEMAS.get_byline_field.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "create_byline_field",
		kind: "proxy",
		title: "Create Byline Field",
		description:
			"Create a native Emdash byline custom-field definition. Requires Emdash schema:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.create_byline_field.input,
		output: CMS_PROXY_TOOL_SCHEMAS.create_byline_field.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "update_byline_field",
		kind: "proxy",
		title: "Update Byline Field",
		description:
			"Update a native Emdash byline custom-field definition. Slug and type are immutable upstream.",
		input: CMS_PROXY_TOOL_SCHEMAS.update_byline_field.input,
		output: CMS_PROXY_TOOL_SCHEMAS.update_byline_field.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "delete_byline_field",
		kind: "proxy",
		title: "Delete Byline Field",
		description:
			"Delete a native Emdash byline custom-field definition and its stored values. Check get_byline_field_usage first.",
		input: CMS_PROXY_TOOL_SCHEMAS.delete_byline_field.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "get_byline_field_usage",
		kind: "proxy",
		title: "Get Byline Field Usage",
		description:
			"Inspect stored value counts for a native Emdash byline custom field before deleting or changing it.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_byline_field_usage.input,
		output: CMS_PROXY_TOOL_SCHEMAS.get_byline_field_usage.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "reorder_byline_fields",
		kind: "proxy",
		title: "Reorder Byline Fields",
		description:
			"Replace the native Emdash byline custom-field display order with the exact current slug set.",
		input: CMS_PROXY_TOOL_SCHEMAS.reorder_byline_fields.input,
		output: CMS_PROXY_TOOL_SCHEMAS.reorder_byline_fields.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "menu_list",
		kind: "proxy",
		title: "List Menus",
		description:
			"List navigation menus. Pass locale on multi-locale sites to inspect one locale.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.menu_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "menu_get",
		kind: "proxy",
		title: "Get Menu with Items",
		description: "Get a menu by name with all its ordered items.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.menu_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "menu_translations",
		kind: "proxy",
		title: "List Menu Translations",
		description:
			"List every locale variant of a menu in its translation group.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_translations.input,
		output: CMS_PROXY_TOOL_SCHEMAS.menu_translations.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "menu_create",
		kind: "proxy",
		title: "Create Menu",
		description: "Create a new navigation menu. Add items with menu_set_items.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_create.input,
	},
	{
		name: "menu_update",
		kind: "proxy",
		title: "Update Menu",
		description: "Update a menu's label. The name cannot be changed.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_update.input,
	},
	{
		name: "menu_delete",
		kind: "proxy",
		title: "Delete Menu",
		description: "Delete a menu and all its items.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_delete.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "menu_set_items",
		kind: "proxy",
		title: "Set Menu Items",
		description:
			"Replace the entire item list of a menu. Atomic (single upstream transaction via the native Emdash " +
			"MCP tool) when the org's Emdash service PAT is provisioned; otherwise decomposed into delete+create " +
			"with best-effort restore. Items are ordered by array position. Use parentIndex for nesting.",
		input: CMS_PROXY_TOOL_SCHEMAS.menu_set_items.input,
		execute: async (ctx, args) => menuSetItems(ctx, args),
	},
	{
		name: "revision_list",
		kind: "proxy",
		title: "List Revisions",
		description: "List revision history for a content item. Newest first.",
		input: CMS_PROXY_TOOL_SCHEMAS.revision_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.revision_list.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "revision_restore",
		kind: "proxy",
		title: "Restore Revision",
		description:
			"Restore a content item to a previous revision. Use cms_*.content_publish after to make it live.",
		input: CMS_PROXY_TOOL_SCHEMAS.revision_restore.input,
	},
	{
		name: "settings_get",
		kind: "proxy",
		title: "Get Site Settings",
		description:
			"Get all site-wide settings (title, tagline, logo, favicon, URL, social, SEO).",
		input: CMS_PROXY_TOOL_SCHEMAS.settings_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.settings_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "settings_update",
		kind: "proxy",
		title: "Update Site Settings",
		description:
			"Partial update of native Emdash site settings. Configure tenant branding through cms_*.settings_update: upload/select local media first, then pass logo, favicon, or seo.defaultOgImage as { mediaId, alt? }.",
		input: CMS_PROXY_TOOL_SCHEMAS.settings_update.input,
	},
	{
		name: "registry_status",
		kind: "proxy",
		title: "Get Plugin Registry Status",
		description:
			"Tenant plugin inventory and signed sandbox-canary proof state. Installation capability requires separate exact-site verification.",
		input: CMS_PROXY_TOOL_SCHEMAS.registry_status.input,
		output: CMS_PROXY_TOOL_SCHEMAS.registry_status.output,
		annotations: { readOnlyHint: true },
		execute: async (ctx) => registryStatus(ctx),
	},
	{
		name: "plugin_list",
		kind: "proxy",
		title: "List Plugins",
		description:
			"List native Emdash plugins for the tenant, including configured, marketplace, and registry-source plugins.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_list.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_list.output,
		annotations: { readOnlyHint: true },
		execute: async (ctx, args) => pluginList(ctx, args),
	},
	{
		name: "plugin_get",
		kind: "proxy",
		title: "Get Plugin",
		description: "Get native Emdash plugin details by plugin id.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "plugin_updates",
		kind: "proxy",
		title: "List Plugin Updates",
		description:
			"Check native Emdash marketplace and registry plugin updates for this tenant.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_updates.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_updates.output,
		annotations: { readOnlyHint: true },
		execute: async (ctx) => pluginUpdates(ctx),
	},
	{
		name: "plugin_enable",
		kind: "proxy",
		title: "Enable Plugin",
		description:
			"Enable an installed native Emdash plugin. Requires plugins:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_enable.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_enable.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "plugin_disable",
		kind: "proxy",
		title: "Disable Plugin",
		description:
			"Disable an installed native Emdash plugin. Requires plugins:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_disable.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_disable.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "set_plugin_mcp",
		kind: "operatorRest",
		title: "Set Plugin MCP Consent",
		description:
			"Enable or revoke native plugin MCP consent after reviewing its declared tools. Requires content admin and native plugins:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.set_plugin_mcp.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "complete_existing_setup",
		kind: "proxy",
		title: "Complete Existing Site Onboarding",
		description:
			"Complete native onboarding for an already populated CMS site without applying a seed. Requires content admin and native settings:manage permission; preserves the acting human. Refuses unfinished wizard state and empty sites.",
		input: CMS_PROXY_TOOL_SCHEMAS.complete_existing_setup.input,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		execute: async (ctx) => completeExistingCmsSetup(ctx),
	},
	{
		name: "list_forms",
		kind: "proxy",
		title: "list_forms",
		description:
			"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_forms.input,
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (ctx, args) => callCmsFormsTool(ctx, "list_forms", args),
	},
	{
		name: "create_form",
		kind: "proxy",
		title: "create_form",
		description:
			"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
		input: CMS_PROXY_TOOL_SCHEMAS.create_form.input,
		annotations: { readOnlyHint: false, destructiveHint: true },
		execute: async (ctx, args) => callCmsFormsTool(ctx, "create_form", args),
	},
	{
		name: "update_form",
		kind: "proxy",
		title: "update_form",
		description:
			"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
		input: CMS_PROXY_TOOL_SCHEMAS.update_form.input,
		annotations: { readOnlyHint: false, destructiveHint: true },
		execute: async (ctx, args) => callCmsFormsTool(ctx, "update_form", args),
	},
	{
		name: "list_form_submissions",
		kind: "proxy",
		title: "list_form_submissions",
		description:
			"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
		input: CMS_PROXY_TOOL_SCHEMAS.list_form_submissions.input,
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (ctx, args) =>
			callCmsFormsTool(ctx, "list_form_submissions", args),
	},
	{
		name: "get_form_submission",
		kind: "proxy",
		title: "get_form_submission",
		description:
			"Call the fixed native Forms private REST operation with its native input contract. Requires content admin and native plugins:manage permission; preserves the acting human. Native handlers validate arguments. This does not execute via native MCP.",
		input: CMS_PROXY_TOOL_SCHEMAS.get_form_submission.input,
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (ctx, args) =>
			callCmsFormsTool(ctx, "get_form_submission", args),
	},
	{
		name: "plugin_settings_get",
		kind: "proxy",
		title: "Get Plugin Settings",
		description:
			"Read a plugin's settings schema and values. Emdash omits secret values and returns only secretsSet booleans. Requires plugins:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_settings_get.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_settings_get.output,
		annotations: { readOnlyHint: true },
	},
	{
		name: "plugin_settings_update",
		kind: "proxy",
		title: "Update Plugin Settings",
		description:
			"Update only supplied plugin settings. Set a value to null to clear it. Secret values are write-only and omitted from the Emdash response. Requires plugins:manage permission.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_settings_update.input,
		output: CMS_PROXY_TOOL_SCHEMAS.plugin_settings_update.output,
		annotations: { destructiveHint: true },
	},
	{
		name: "plugin_verify",
		kind: "proxy",
		title: "Verify Registry Plugin",
		description:
			"Verify a signed Emdash registry release and inspect its declared access, public routes, MCP tools, and record CIDs before installation.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_verify.input,
		annotations: { readOnlyHint: true },
	},
	{
		name: "plugin_install",
		kind: "proxy",
		title: "Install Registry Plugin",
		description:
			"Install a verified Emdash registry release by publisher DID and package slug. Requires native plugins:manage permission and exact acknowledgements from plugin_verify, including both signed record CIDs.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_install.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "plugin_update",
		kind: "proxy",
		title: "Update Plugin",
		description:
			"Update a marketplace or registry-source Emdash plugin. Pass source='registry' for registry plugins; use confirm flags only after reviewing returned escalation details.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_update.input,
		annotations: { destructiveHint: true },
	},
	{
		name: "plugin_uninstall",
		kind: "proxy",
		title: "Uninstall Plugin",
		description:
			"Uninstall a marketplace or registry-source Emdash plugin. Use deleteData only when plugin-owned data should be removed too.",
		input: CMS_PROXY_TOOL_SCHEMAS.plugin_uninstall.input,
		annotations: { destructiveHint: true },
	},
];

export function registerCmsProxyTools(
	server: McpServer,
	ctx: CmsProxyContext,
): void {
	registerProxyToolSpecs(server, ctx, CMS_PROXY_TOOL_SPECS);
}
