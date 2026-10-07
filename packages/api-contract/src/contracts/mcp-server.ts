import "@orpc/openapi/extensions/route";
/**
 * MCP Server Contract for oRPC
 * Type-safe API contract for Descope MCP Server registration and scope sync
 *
 * These endpoints manage the lifecycle of Descope Agentic Identity Hub
 * MCP Servers for apps that enable OAuth-based tool access control.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { AppIdParamSchema } from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

export const McpServerRegistrationOutputSchema = z.object({
	descopeResourceId: z.string(),
	discoveryUrl: z.string(),
	status: z.enum(["created", "already_exists"]),
});

export const McpServerAdoptionInputSchema = AppIdParamSchema.extend({
	descopeResourceId: z.string().regex(/^RS[A-Za-z0-9]+$/),
});

export const McpServerAdoptionOutputSchema = z.object({
	descopeResourceId: z.string(),
	previousDescopeResourceId: z
		.string()
		.nullable()
		.describe("Previous D1 reference, or null when the app was unregistered"),
	discoveryUrl: z.string(),
});

export const McpServerSyncScopesOutputSchema = z.object({
	synced: z.boolean(),
	scopeCount: z.number(),
	strategy: z.enum(["descope-api", "resource-metadata"]),
	message: z.string(),
});

export const McpServerStatusOutputSchema = z.object({
	registered: z.boolean(),
	descopeResourceId: z.string().nullable(),
	scopesSynced: z.boolean(),
	lastSyncedAt: z.string().nullable(),
	scopeSyncStrategy: z.enum(["descope-api", "resource-metadata"]),
	lastSyncError: z.string().nullable(),
});

/**
 * Output schema for the previewToolScopes procedure.
 *
 * Every scope here is resolved by the same function the MCP edge gates on, not
 * derived from the tool name. So a tool can map to `[]` — the app enforcing
 * nothing on it — and the grouped views bucket those under the literal key
 * `"(none)"`.
 *
 * ONE CAVEAT, and it only under-reports. The resolver takes a
 * `fallbackOnAuthenticatedAuthMode` flag, and the edge has THREE call sites,
 * not two: `tools/list` passes no options and `tools/call` passes `false` —
 * which are identical, because the flag is tested with `=== true` — but Code
 * Mode's inner-tool gate (`resolveCodeModeInnerToolScopes`) passes `true`. This
 * preview matches the first two. For an app with NO `toolScopes` key at all,
 * Code Mode can therefore enforce a namespace fallback where this reports `[]`.
 * Any `toolScopes` value — even `{}` — collapses the difference, so it affects
 * only never-configured apps, and it errs toward showing LESS enforcement than
 * exists rather than more.
 *
 * Namespace resolution is shared with Code Mode and native MCP dispatch: D1
 * `config.endpoint`, aggregate prefixes, tool type, and
 * `mcpConfig.codeModeNamespaces` are evaluated in the same order. Deriving the
 * namespace from the first word of `tool_id` is forbidden because it turns
 * `apps/get` into the meaningless `get` namespace.
 *
 * - `toolScopes`: enforced scopes per tool, in apps.metadata.mcpConfig.toolScopes shape
 * - `grouped`: tools grouped by enforced scope for easy review
 * - `granularToolScopes`: read/write/admin refinement of the enforced scopes
 * - `granularGrouped`: granular mapping grouped by scope
 * - `sources`: own/aggregated same-zone apps included in the preview
 * - `skippedSources`: external or missing sources that could not be previewed
 * - `complete`: false when skippedSources means the mapping is partial
 * - `unmappedTools`: tools the edge hides because no capability mapping
 *   resolves; they fail closed for every caller until mapped
 */
export const McpServerPreviewToolScopesOutputSchema = z.object({
	toolScopes: z.record(z.string(), z.array(z.string())),
	grouped: z.record(z.string(), z.array(z.string())),
	granularToolScopes: z.record(z.string(), z.array(z.string())),
	granularGrouped: z.record(z.string(), z.array(z.string())),
	toolCount: z.number(),
	complete: z.boolean(),
	unmappedTools: z.array(z.string()).optional(),
	scopeSummary: z.record(z.string(), z.number()),
	granularScopeSummary: z.record(z.string(), z.number()),
	sources: z.array(
		z.object({
			slug: z.string(),
			appId: z.string(),
			prefix: z.string().nullable(),
			toolCount: z.number(),
		}),
	),
	skippedSources: z.array(
		z.object({
			slug: z.string(),
			reason: z.string(),
			upstreamMcpUrl: z.string().nullable().optional(),
		}),
	),
});

// =============================================================================
// CONTRACT
// =============================================================================

/**
 * MCP Server contract for Descope Agentic Identity Hub integration
 *
 * Manages registration of MCP Servers in Descope and syncing of tool scopes.
 * Each app can have one MCP Server registered in Descope, identified by
 * descopeResourceId stored in apps.metadata.mcpConfig.
 */
export const mcpServerContract = oc
	.route({ tags: ["mcp-server"], prefix: "/apps/{appId}/mcp-server" })
	.errors(baseErrors)
	.router({
		/**
		 * Register an MCP Server in Descope for this app
		 * POST /apps/{appId}/mcp-server/register
		 *
		 * Creates a new MCP Server resource in Descope's Agentic Identity Tedix OS.
		 * If already registered, returns existing resource ID.
		 * Stores descopeResourceId in apps.metadata.mcpConfig.
		 */
		register: oc
			.route({
				method: "POST",
				path: "/register",
				summary: "Register Descope MCP Server",
				description:
					"Register an MCP Server in Descope Agentic Identity Hub for OAuth-based tool access control",
			})
			.input(AppIdParamSchema)
			.output(McpServerRegistrationOutputSchema),

		/**
		 * Adopt an existing current Descope Resource for an app.
		 * Platform-admin only at the implementation boundary. The Resource must
		 * already expose the app's exact canonical audience.
		 */
		adoptResource: oc
			.route({
				method: "POST",
				path: "/adopt-resource",
				summary: "Adopt an existing Descope MCP Resource",
				description:
					"Replace an app's legacy Descope MCP server reference with a validated current Resource",
			})
			.input(McpServerAdoptionInputSchema)
			.output(McpServerAdoptionOutputSchema),

		/**
		 * Sync tool scopes to the Descope MCP Server
		 * POST /apps/{appId}/mcp-server/sync-scopes
		 *
		 * Reads toolScopes and scopeDescriptions from mcpConfig,
		 * then updates the Descope MCP Server with current scopes.
		 */
		syncScopes: oc
			.route({
				method: "POST",
				path: "/sync-scopes",
				summary: "Sync MCP Server scopes",
				description:
					"Sync tool scope definitions from app mcpConfig to the Descope MCP Server",
			})
			.input(AppIdParamSchema)
			.output(McpServerSyncScopesOutputSchema),

		/**
		 * Get Descope MCP Server registration status
		 * GET /apps/{appId}/mcp-server/status
		 *
		 * Returns whether the app has a registered Descope MCP Server
		 * and the current sync state.
		 */
		getStatus: oc
			.route({
				method: "GET",
				path: "/status",
				summary: "Get MCP Server status",
				description:
					"Check Descope MCP Server registration and scope sync status for this app",
			})
			.input(AppIdParamSchema)
			.output(McpServerStatusOutputSchema),

		/**
		 * Preview capability scope mapping for all tools exposed by this app
		 * GET /apps/{appId}/mcp-server/preview-tool-scopes
		 *
		 * Loads enabled D1 app_tools for the app plus same-zone aggregateApps
		 * sources, resolves each through the edge's own scope resolver against
		 * this app's mcpConfig, and returns:
		 *   - `toolScopes`: the enforced scopes, in mcpConfig.toolScopes shape
		 *   - `granularToolScopes`: read/write/admin refinement of those scopes
		 *   - `grouped` / `granularGrouped`: tools grouped by scope for review,
		 *     with unenforced tools under `"(none)"`
		 *   - `sources` / `skippedSources`: preview coverage diagnostics
		 *   - `complete`: false when operators should not copy the mapping as-is
		 *
		 * Use this to see what the app enforces TODAY before changing toolScopes
		 * in D1. Does NOT write any data — read-only preview only.
		 */
		previewToolScopes: oc
			.route({
				method: "GET",
				path: "/preview-tool-scopes",
				summary: "Preview tool capability scope mapping",
				description:
					"Preview how this app's own and same-zone aggregated tools map to broad and granular capability scopes. Returns D1-ready toolScopes JSON and grouped breakdowns for review. Read-only — does not modify any data.",
			})
			.input(AppIdParamSchema)
			.output(McpServerPreviewToolScopesOutputSchema),
	});

export type McpServerContract = typeof mcpServerContract;
