import "@orpc/openapi/extensions/route";
/**
 * App Adapters Contract for oRPC
 * Type-safe API contract for App Adapter endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	AdapterTypeSchema,
	AppAdapterSchema as CanonicalAppAdapterSchema,
} from "../schemas/adapters";
import {
	AppIdParamSchema,
	JsonValueSchema,
	PaginationMetaSchema,
	SuccessResponseSchema,
} from "../schemas/common";

// =============================================================================
// ADAPTER SCHEMAS
// =============================================================================

/**
 * Adapter ID parameter schema
 */
export const AdapterIdParamSchema = z.object({
	adapterId: z.string().min(1, "Adapter ID is required"),
});
export type AdapterIdParam = z.infer<typeof AdapterIdParamSchema>;

/**
 * App Adapter schema for API responses.
 * Derives from the canonical schema in schemas/adapters.ts but loosens `config`
 * to JsonValueSchema because API responses serialize adapter config as arbitrary JSON,
 * and tightens `appId` to .uuid() for API-level validation.
 */
export const AppAdapterSchema = CanonicalAppAdapterSchema.extend({
	appId: z.uuid(),
	config: JsonValueSchema.nullable(),
});
export type AppAdapter = z.infer<typeof AppAdapterSchema>;

/**
 * App Adapter list item schema (simplified for list views)
 */
export const AppAdapterListItemSchema = z.object({
	id: z.string(), // Not .uuid() — some adapters have non-UUID IDs (e.g., "mobile-de-adapter-...")
	appId: z.uuid(),
	name: z.string(),
	displayName: z.string().nullable(),
	adapterType: AdapterTypeSchema,
	enabled: z.boolean().nullable(),
	priority: z.number().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type AppAdapterListItem = z.infer<typeof AppAdapterListItemSchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

/**
 * Create adapter input schema
 */
export const CreateAppAdapterInputSchema = z.object({
	name: z.string().min(1, "Name is required").max(100),
	displayName: z.string().max(200).optional(),
	adapterType: AdapterTypeSchema,
	config: JsonValueSchema.optional(),
	fieldMappings: z.record(z.string(), z.string()).optional(),
	verticals: z.array(z.string()).optional(),
	enabled: z.boolean().optional().default(true),
	priority: z.number().optional().default(0),
});
export type CreateAppAdapterInput = z.infer<typeof CreateAppAdapterInputSchema>;

/**
 * Update adapter input schema
 */
export const UpdateAppAdapterInputSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	displayName: z.string().max(200).nullable().optional(),
	adapterType: AdapterTypeSchema.optional(),
	config: JsonValueSchema.optional(),
	fieldMappings: z.record(z.string(), z.string()).optional(),
	verticals: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	priority: z.number().optional(),
});
export type UpdateAppAdapterInput = z.infer<typeof UpdateAppAdapterInputSchema>;

/**
 * Set priority input schema
 */
export const SetAdapterPriorityInputSchema = z.object({
	priority: z.number().int().min(0).max(1000),
});
export type SetAdapterPriorityInput = z.infer<
	typeof SetAdapterPriorityInputSchema
>;

export const AppConfigValidationIssueSchema = z.object({
	path: z.string(),
	message: z.string(),
});

export const AdapterPreflightInputSchema = z.object({
	adapterType: AdapterTypeSchema,
	config: JsonValueSchema.nullable().optional(),
	fieldMappings: z.record(z.string(), z.string()).optional(),
	verticals: z.array(z.string()).optional(),
	operation: z.enum(["create", "update"]).default("update"),
	dryRun: z.boolean().default(true),
});

export const AdapterPreflightResponseSchema = z.object({
	valid: z.boolean(),
	errors: z.array(AppConfigValidationIssueSchema),
	warnings: z.array(AppConfigValidationIssueSchema),
	simulation: z.object({
		operation: z.enum(["create", "update"]),
		wouldPersist: z.boolean(),
		requiresMcpRefresh: z.literal(true),
		adapterType: AdapterTypeSchema,
		requiredBindings: z.array(z.string()),
	}),
});

// =============================================================================
// APP ADAPTERS CONTRACT
// =============================================================================

/**
 * App Adapters contract defining all adapter-related endpoints
 *
 * All endpoints are org-scoped via JWT context and app-scoped via appId
 */
export const appAdaptersContract = oc
	.route({ tags: ["app-adapters"], prefix: "/apps/{appId}/adapters" })
	.router({
		/**
		 * List all adapters for an app
		 * GET /apps/{appId}/adapters
		 */
		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "List app adapters",
				description: "List all adapters configured for a specific app",
			})
			.input(
				z.object({
					appId: z.uuid(),
					limit: z.coerce.number().default(50),
					offset: z.coerce.number().default(0),
				}),
			)
			.output(
				z.object({
					data: z.array(AppAdapterListItemSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get adapter by ID
		 * GET /apps/{appId}/adapters/{adapterId}
		 */
		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{adapterId}",
				summary: "Get adapter by ID",
				description: "Get detailed information about a specific adapter",
			})
			.input(AppIdParamSchema.extend(AdapterIdParamSchema.shape))
			.output(AppAdapterSchema),

		/**
		 * Create a new adapter
		 * POST /apps/{appId}/adapters
		 */
		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create adapter",
				description: "Create a new adapter for the app",
				successStatus: 201,
			})
			.input(AppIdParamSchema.extend(CreateAppAdapterInputSchema.shape))
			.output(AppAdapterSchema),

		/**
		 * Update an existing adapter
		 * PATCH /apps/{appId}/adapters/{adapterId}
		 */
		update: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{adapterId}",
				summary: "Update adapter",
				description: "Update an existing adapter configuration",
			})
			.input(
				AppIdParamSchema.extend({
					...AdapterIdParamSchema.shape,
					...UpdateAppAdapterInputSchema.shape,
				}),
			)
			.output(AppAdapterSchema),

		/**
		 * Delete an adapter
		 * DELETE /apps/{appId}/adapters/{adapterId}
		 */
		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{adapterId}",
				summary: "Delete adapter",
				description: "Permanently delete an adapter configuration",
				successStatus: 200,
			})
			.input(AppIdParamSchema.extend(AdapterIdParamSchema.shape))
			.output(SuccessResponseSchema),

		/**
		 * RPC-only convenience action. Public REST callers PATCH `enabled` on the
		 * canonical adapter resource instead of using a verb path.
		 */
		enable: oc
			.route({
				method: "POST",
				path: "/{adapterId}/enable",
				tags: ["internal"],
				summary: "Enable adapter",
				description: "Enable an adapter to make it active",
			})
			.input(AppIdParamSchema.extend(AdapterIdParamSchema.shape))
			.output(AppAdapterSchema),

		/**
		 * RPC-only convenience action. Public REST callers PATCH `enabled` on the
		 * canonical adapter resource instead of using a verb path.
		 */
		disable: oc
			.route({
				method: "POST",
				path: "/{adapterId}/disable",
				tags: ["internal"],
				summary: "Disable adapter",
				description: "Disable an adapter to make it inactive",
			})
			.input(AppIdParamSchema.extend(AdapterIdParamSchema.shape))
			.output(AppAdapterSchema),

		/**
		 * RPC-only convenience action. Public REST callers PATCH `priority` on the
		 * canonical adapter resource instead of using a verb path.
		 */
		setPriority: oc
			.route({
				method: "POST",
				path: "/{adapterId}/priority",
				tags: ["internal"],
				summary: "Set adapter priority",
				description:
					"Update adapter priority for fallback chain ordering (higher = preferred)",
			})
			.input(
				AppIdParamSchema.extend({
					...AdapterIdParamSchema.shape,
					...SetAdapterPriorityInputSchema.shape,
				}),
			)
			.output(AppAdapterSchema),

		/**
		 * Preflight adapter config update/create
		 * POST /apps/{appId}/adapters/preflight
		 */
		preflight: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/preflight",
				summary: "Preflight adapter config",
				description:
					"Validate adapter config and simulate write-time outcome without persisting changes",
			})
			.input(AppIdParamSchema.extend(AdapterPreflightInputSchema.shape))
			.output(AdapterPreflightResponseSchema),
	});

export type AppAdaptersContract = typeof appAdaptersContract;
