import "@orpc/openapi/extensions/route";
/**
 * App Tools Contract for oRPC
 * Type-safe API contract for app tool management endpoints
 *
 * Manages MCP tool configurations for apps in the unified multi-tenant engine.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { AppToolSchema } from "../schemas/app";
import {
	AppIdParamSchema,
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
	SuccessResponseSchema,
} from "../schemas/common";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	TOOL_EXECUTION_TASK_SUPPORT_VALUES,
	TOOL_SCHEMA_DIALECT_VALUES,
	TOOL_SCHEMA_SOURCE_VALUES,
	ToolAnnotationsSchema,
	ToolIconSchema,
	ToolInputJsonSchemaSchema,
	ToolInvocationStatusSchema,
	ToolJsonSchemaSchema,
	ToolMetaSchema,
	ToolWriteCapabilitySchema,
} from "../schemas/tools";

// =============================================================================
// PARAMETER SCHEMAS
// =============================================================================

/**
 * Tool ID parameter schema
 */
export const ToolIdParamSchema = z.object({
	toolId: z.uuid("Tool ID must be a valid UUID"),
});

export type ToolIdParam = z.infer<typeof ToolIdParamSchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

/**
 * Create app tool input schema
 *
 * Create is an upsert. The transport contract therefore accepts any bounded
 * stored id; apps/api applies the strict ToolIdSchema verdict only after it can
 * distinguish a new id from an existing grandfathered D1 row.
 */
export const CreateAppToolInputSchema = z.object({
	toolId: z.string().min(1).max(100),
	toolTypeId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(1000).nullable().optional(),
	inputSchema: ToolInputJsonSchemaSchema.default(EMPTY_TOOL_INPUT_SCHEMA),
	outputSchema: ToolJsonSchemaSchema.nullable().optional(),
	adapterScope: z.string().default("primary"),
	resultStrategy: z
		.enum(["parallel_all", "first_success", "merge"])
		.default("merge"),
	outputTemplate: z.string().nullable().optional(),
	widgetRoute: z.string().nullable().optional(),
	widgetKey: z.string().nullable().optional(),
	widgetAccessible: z.boolean().default(true),
	authRequired: z.boolean().default(false),
	visibility: z.string().default("public"),
	icons: z.array(ToolIconSchema).nullable().optional(),
	executionTaskSupport: z
		.enum(TOOL_EXECUTION_TASK_SUPPORT_VALUES)
		.nullable()
		.optional(),
	annotations: ToolAnnotationsSchema.nullable().optional(),
	writeCapability: ToolWriteCapabilitySchema.nullable()
		.optional()
		.describe(
			"Explicit write-capability declaration. Omit to derive it from `annotations`; send null to clear it back to UNDECLARED. The manual path exists for upstream MCP servers that never send annotations at all, whose tools can otherwise never be classified.",
		),
	meta: ToolMetaSchema.nullable().optional(),
	invocationStatus: ToolInvocationStatusSchema.nullable().optional(),
	fileParams: z.array(z.string().min(1)).nullable().optional(),
	widgetDescription: z.string().nullable().optional(),
	widgetPrefersBorder: z.boolean().default(true),
	widgetDomain: z.string().nullable().optional(),
	config: z.record(z.string(), JsonValueSchema).nullable().optional(),
	schemaDialect: z.enum(TOOL_SCHEMA_DIALECT_VALUES).nullable().optional(),
	schemaSource: z.enum(TOOL_SCHEMA_SOURCE_VALUES).nullable().optional(),
	schemaSourceRef: z.string().nullable().optional(),
	schemaSourceHash: z.string().nullable().optional(),
	schemaSyncedAt: z.string().nullable().optional(),
	sortOrder: z.number().int().default(0),
	enabled: z.boolean().default(true),
});

export type CreateAppToolInput = z.infer<typeof CreateAppToolInputSchema>;

/**
 * Update app tool input schema
 * NOTE: toolId is a path param (from ToolIdParamSchema), not included here.
 * The logical tool name (`app_tools.tool_id`) is deliberately absent: it is
 * immutable on update (the router preserves the existing row's toolId), which
 * is what makes renames to a non-conforming id impossible — an unchanged
 * grandfathered id keeps working, and any renamed id must go through create,
 * where the state-aware router enforces the naming rule.
 */
export const UpdateAppToolInputSchema = z.object({
	toolTypeId: z.string().min(1).optional(),
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).nullable().optional(),
	inputSchema: ToolInputJsonSchemaSchema.optional(),
	outputSchema: ToolJsonSchemaSchema.nullable().optional(),
	adapterScope: z.string().optional(),
	resultStrategy: z.enum(["parallel_all", "first_success", "merge"]).optional(),
	outputTemplate: z.string().nullable().optional(),
	widgetRoute: z.string().nullable().optional(),
	widgetKey: z.string().nullable().optional(),
	widgetAccessible: z.boolean().optional(),
	authRequired: z.boolean().optional(),
	visibility: z.string().optional(),
	icons: z.array(ToolIconSchema).nullable().optional(),
	executionTaskSupport: z
		.enum(TOOL_EXECUTION_TASK_SUPPORT_VALUES)
		.nullable()
		.optional(),
	annotations: ToolAnnotationsSchema.nullable().optional(),
	writeCapability: ToolWriteCapabilitySchema.nullable()
		.optional()
		.describe(
			"Explicit write-capability declaration. Omit to derive it from `annotations`; send null to clear it back to UNDECLARED. The manual path exists for upstream MCP servers that never send annotations at all, whose tools can otherwise never be classified.",
		),
	meta: ToolMetaSchema.nullable().optional(),
	invocationStatus: ToolInvocationStatusSchema.nullable().optional(),
	fileParams: z.array(z.string().min(1)).nullable().optional(),
	widgetDescription: z.string().nullable().optional(),
	widgetPrefersBorder: z.boolean().optional(),
	widgetDomain: z.string().nullable().optional(),
	config: z.record(z.string(), JsonValueSchema).nullable().optional(),
	schemaDialect: z.enum(TOOL_SCHEMA_DIALECT_VALUES).nullable().optional(),
	schemaSource: z.enum(TOOL_SCHEMA_SOURCE_VALUES).nullable().optional(),
	schemaSourceRef: z.string().nullable().optional(),
	schemaSourceHash: z.string().nullable().optional(),
	schemaSyncedAt: z.string().nullable().optional(),
	sortOrder: z.number().int().optional(),
	enabled: z.boolean().optional(),
});

export type UpdateAppToolInput = z.infer<typeof UpdateAppToolInputSchema>;

/**
 * Reorder tools input schema
 */
export const ReorderToolsInputSchema = z.object({
	/** Array of tool IDs in the desired order */
	toolIds: z.array(z.uuid()),
});

export type ReorderToolsInput = z.infer<typeof ReorderToolsInputSchema>;

export const AppConfigValidationIssueSchema = z.object({
	path: z.string(),
	message: z.string(),
});

export const ToolPreflightInputSchema = z.object({
	/**
	 * Deliberately NOT ToolIdSchema: preflight is the dry-run advisory surface,
	 * so a non-conforming id must reach the handler and come back as a
	 * structured `errors[]` entry (via validateToolIdStyle) instead of a
	 * contract-level 400.
	 */
	toolId: z.string().min(1).max(100).optional(),
	toolTypeId: z.string().min(1).optional(),
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).nullable().optional(),
	inputSchema: ToolInputJsonSchemaSchema.optional(),
	outputSchema: ToolJsonSchemaSchema.nullable().optional(),
	adapterScope: z.string().optional(),
	resultStrategy: z.enum(["parallel_all", "first_success", "merge"]).optional(),
	authRequired: z.boolean().default(false),
	config: z.record(z.string(), JsonValueSchema).nullable().optional(),
	operation: z.enum(["create", "update"]).default("update"),
	dryRun: z.boolean().default(true),
});

export const ToolPreflightResponseSchema = z.object({
	valid: z.boolean(),
	errors: z.array(AppConfigValidationIssueSchema),
	warnings: z.array(AppConfigValidationIssueSchema),
	simulation: z.object({
		operation: z.enum(["create", "update"]),
		wouldPersist: z.boolean(),
		requiresMcpRefresh: z.literal(true),
		adapterScope: z.object({
			mode: z.enum(["all", "primary", "ids", "invalid"]),
			requestedIds: z.array(z.string()),
			resolvedIds: z.array(z.string()),
			totalAvailable: z.number().int().nonnegative(),
		}),
		authRequired: z.boolean(),
	}),
});

// =============================================================================
// APP TOOLS CONTRACT
// =============================================================================

/**
 * App Tools contract defining all app tool management endpoints
 *
 * All endpoints are org-scoped via JWT context
 */
export const appToolsContract = oc
	.route({ tags: ["app-tools"], prefix: "/apps/{appId}/tools" })
	.router({
		/**
		 * List all tools for an app
		 * GET /apps/{appId}/tools
		 */
		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "List app tools",
				description: "List all MCP tools configured for an app with pagination",
			})
			.input(
				AppIdParamSchema.extend({
					...PaginationSchema.shape,
					limit: z.coerce.number().min(1).max(500).default(50),
					query: z
						.string()
						.trim()
						.max(200)
						.optional()
						.describe(
							"Optional normalized all-term search across tool id, title, and description. Omit to list the unfiltered app inventory.",
						),
				}),
			)
			.output(
				z.object({
					data: z.array(AppToolSchema),
					pagination: PaginationMetaSchema,
					/** Exact unfiltered inventory size, even while `pagination.total` is filtered. */
					inventoryTotal: z.number().int().nonnegative(),
				}),
			),

		/**
		 * Get tool by ID
		 * GET /apps/{appId}/tools/{toolId}
		 */
		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{toolId}",
				summary: "Get app tool by ID",
				description: "Get detailed information about a specific app tool",
			})
			.input(AppIdParamSchema.extend(ToolIdParamSchema.shape))
			.output(AppToolSchema),

		/**
		 * Create a new tool
		 * POST /apps/{appId}/tools
		 */
		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create app tool",
				description: "Create a new MCP tool for an app",
				successStatus: 201,
			})
			.input(AppIdParamSchema.extend(CreateAppToolInputSchema.shape))
			.output(AppToolSchema),

		/**
		 * Update an existing tool
		 * PATCH /apps/{appId}/tools/{toolId}
		 */
		update: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{toolId}",
				summary: "Update app tool",
				description: "Update an existing app tool configuration",
			})
			.input(
				AppIdParamSchema.extend({
					...ToolIdParamSchema.shape,
					...UpdateAppToolInputSchema.shape,
				}),
			)
			.output(AppToolSchema),

		/**
		 * Delete a tool
		 * DELETE /apps/{appId}/tools/{toolId}
		 */
		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{toolId}",
				summary: "Delete app tool",
				description: "Permanently delete an app tool",
				successStatus: 200,
			})
			.input(AppIdParamSchema.extend(ToolIdParamSchema.shape))
			.output(SuccessResponseSchema),

		/**
		 * RPC-only convenience action. Public REST callers PATCH `enabled` on the
		 * canonical tool resource instead of using a verb path.
		 */
		enable: oc
			.route({
				method: "POST",
				path: "/{toolId}/enable",
				tags: ["internal"],
				summary: "Enable app tool",
				description: "Enable a disabled app tool",
			})
			.input(AppIdParamSchema.extend(ToolIdParamSchema.shape))
			.output(AppToolSchema),

		/**
		 * RPC-only convenience action. Public REST callers PATCH `enabled` on the
		 * canonical tool resource instead of using a verb path.
		 */
		disable: oc
			.route({
				method: "POST",
				path: "/{toolId}/disable",
				tags: ["internal"],
				summary: "Disable app tool",
				description: "Disable an enabled app tool",
			})
			.input(AppIdParamSchema.extend(ToolIdParamSchema.shape))
			.output(AppToolSchema),

		/**
		 * Reorder tools
		 * PUT /apps/{appId}/tools/order
		 */
		reorder: oc
			.route({
				tags: ["REST"],
				method: "PUT",
				path: "/order",
				summary: "Reorder app tools",
				description: "Update the display order of app tools",
			})
			.input(AppIdParamSchema.extend(ReorderToolsInputSchema.shape))
			.output(
				z.object({
					success: z.literal(true),
					updated: z.number(),
				}),
			),

		/**
		 * Preflight tool config update/create
		 * POST /apps/{appId}/tools/preflight
		 */
		preflight: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/preflight",
				summary: "Preflight tool config",
				description:
					"Validate tool config and simulate write-time outcome without persisting changes",
			})
			.input(AppIdParamSchema.extend(ToolPreflightInputSchema.shape))
			.output(ToolPreflightResponseSchema),
	});

export type AppToolsContract = typeof appToolsContract;
