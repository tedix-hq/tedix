import "@orpc/openapi/extensions/route";
/**
 * Templates Contract for oRPC
 * Type-safe API contract for App Template endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { AppCapabilitiesSchema, VerticalSchema } from "../schemas/app";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";
import {
	AppCapabilitiesConfigSchema,
	AppConfigAdapterSchema,
	AppConfigToolSchema,
} from "../schemas/config";
import { ExtractionConfigExpandedSchema } from "../schemas/extraction-config";

// =============================================================================
// TEMPLATE SCHEMAS
// =============================================================================

/**
 * Template ID path parameter
 */
export const TemplateIdParamSchema = z.object({
	templateId: z.uuid({ message: "Template ID must be a valid UUID" }),
});

export type TemplateIdParam = z.infer<typeof TemplateIdParamSchema>;

/**
 * Template response schema for contracts
 */
export const TemplateResponseSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable(),
	vertical: z.string(),
	version: z.number(),
	capabilities: AppCapabilitiesSchema.nullable().optional(),
	adapters: z.array(JsonValueSchema).nullable().optional(),
	tools: z.array(JsonValueSchema).nullable().optional(),
	fieldMappings: z.record(z.string(), z.string()).nullable().optional(),
	extractionConfig: ExtractionConfigExpandedSchema.nullable().optional(),
	requiredFields: z.array(z.string()).nullable().optional(),
	optionalFields: z.array(z.string()).nullable().optional(),
	isActive: z.boolean(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

export type TemplateResponse = z.infer<typeof TemplateResponseSchema>;

/**
 * Create template input schema
 */
export const CreateTemplateInputSchema = z.object({
	name: z.string().min(1, "Template name is required"),
	slug: z
		.string()
		.min(1, "Slug is required")
		.regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
	description: z.string().optional().nullable(),
	vertical: VerticalSchema,
	version: z.number().int().positive().optional(),
	capabilities: AppCapabilitiesConfigSchema.optional().nullable(),
	adapters: z.array(AppConfigAdapterSchema).optional().nullable(),
	tools: z.array(AppConfigToolSchema).optional().nullable(),
	fieldMappings: z.record(z.string(), z.string()).optional().nullable(),
	extractionConfig: ExtractionConfigExpandedSchema.optional().nullable(),
	requiredFields: z.array(z.string()).optional().nullable(),
	optionalFields: z.array(z.string()).optional().nullable(),
	isActive: z.boolean().optional(),
});

export type CreateTemplateInput = z.infer<typeof CreateTemplateInputSchema>;

/**
 * Update template input schema (all fields optional except templateId)
 */
export const UpdateTemplateInputSchema = TemplateIdParamSchema.extend({
	name: z.string().min(1, "Template name is required").optional(),
	slug: z
		.string()
		.min(1, "Slug is required")
		.regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes")
		.optional(),
	description: z.string().optional().nullable(),
	vertical: VerticalSchema.optional(),
	version: z.number().int().positive().optional(),
	capabilities: AppCapabilitiesConfigSchema.optional().nullable(),
	adapters: z.array(AppConfigAdapterSchema).optional().nullable(),
	tools: z.array(AppConfigToolSchema).optional().nullable(),
	fieldMappings: z.record(z.string(), z.string()).optional().nullable(),
	extractionConfig: ExtractionConfigExpandedSchema.optional().nullable(),
	requiredFields: z.array(z.string()).optional().nullable(),
	optionalFields: z.array(z.string()).optional().nullable(),
	isActive: z.boolean().optional(),
});

export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInputSchema>;

// =============================================================================
// RESPONSE SCHEMAS
// =============================================================================

export const TemplateListResponseSchema = z.object({
	data: z.array(TemplateResponseSchema),
	pagination: PaginationMetaSchema,
});

export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

export const TemplateGetResponseSchema = z.object({
	success: z.literal(true),
	template: TemplateResponseSchema,
});

export type TemplateGetResponse = z.infer<typeof TemplateGetResponseSchema>;

export const TemplateDeleteResponseSchema = z.object({
	success: z.literal(true),
	message: z.string(),
	deletedId: z.string(),
});

export type TemplateDeleteResponse = z.infer<
	typeof TemplateDeleteResponseSchema
>;

/**
 * Export templates response schema
 */
export const TemplateExportResponseSchema = z.object({
	success: z.literal(true),
	templates: z.array(TemplateResponseSchema),
	exportedAt: z.string(),
	count: z.number(),
});

export type TemplateExportResponse = z.infer<
	typeof TemplateExportResponseSchema
>;

/**
 * Apply template input schema - creates app from template
 */
export const ApplyTemplateInputSchema = TemplateIdParamSchema.extend({
	organizationId: z.uuid({ message: "Organization ID must be a valid UUID" }),
	name: z.string().min(1, "App name is required"),
	slug: z
		.string()
		.min(1, "Slug is required")
		.regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
	primaryDomain: z.string().min(1, "Primary domain is required"),
	description: z.string().optional(),
	logoUrl: z.url().optional(),
	visibility: z.enum(["public", "private", "disabled"]).optional(),
	metadataOverrides: z
		.record(z.string(), JsonValueSchema)
		.superRefine((metadata, ctx) => {
			if (metadata.extractionConfig === undefined) return;
			const parsed = ExtractionConfigExpandedSchema.safeParse(
				metadata.extractionConfig,
			);
			if (!parsed.success)
				for (const issue of parsed.error.issues)
					ctx.addIssue({ ...issue, path: ["extractionConfig", ...issue.path] });
		})
		.optional(),
	capabilitiesOverrides: AppCapabilitiesSchema.partial().optional(),
	extractionConfigOverrides:
		ExtractionConfigExpandedSchema.partial().optional(),
	adapterOverrides: z.record(z.string(), JsonValueSchema).optional(),
	toolConfigOverrides: z.record(z.string(), JsonValueSchema).optional(),
});

export type ApplyTemplateInput = z.infer<typeof ApplyTemplateInputSchema>;

/**
 * Apply template response schema
 */
export const ApplyTemplateResponseSchema = z.object({
	success: z.literal(true),
	app: z.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
		primaryDomain: z.string(),
	}),
	adaptersCreated: z.number(),
	toolsCreated: z.number(),
});

export type ApplyTemplateResponse = z.infer<typeof ApplyTemplateResponseSchema>;

// =============================================================================
// CONTRACT DEFINITION
// =============================================================================

/**
 * Templates Contract - defines the shape of all template-related endpoints
 *
 * @openapi
 * tags:
 *   - name: templates
 *     description: App template management
 */
export const templatesContract = oc
	.route({ tags: ["templates"], prefix: "/templates" })
	.router({
		/**
		 * GET /templates - List all active templates
		 */
		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "List templates",
				description: "List all active app templates",
			})
			.input(PaginationSchema)
			.output(TemplateListResponseSchema),

		/**
		 * GET /templates/{templateId} - Get template by ID
		 */
		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{templateId}",
				summary: "Get template by ID",
				description: "Get detailed information about a specific template",
			})
			.input(TemplateIdParamSchema)
			.output(TemplateGetResponseSchema),

		/**
		 * POST /templates - Create new template
		 */
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create template",
				description: "Create a new app template (admin only)",
				successStatus: 201,
			})
			.input(CreateTemplateInputSchema)
			.output(TemplateGetResponseSchema),

		/**
		 * PATCH /templates/{templateId} - Update template
		 */
		update: oc
			.route({
				method: "PATCH",
				path: "/{templateId}",
				summary: "Update template",
				description: "Update an existing template",
			})
			.input(UpdateTemplateInputSchema)
			.output(TemplateGetResponseSchema),

		/**
		 * DELETE /templates/{templateId} - Soft delete template
		 */
		delete: oc
			.route({
				method: "DELETE",
				path: "/{templateId}",
				summary: "Delete template",
				description: "Soft delete a template (sets isActive = false)",
			})
			.input(TemplateIdParamSchema)
			.output(TemplateDeleteResponseSchema),

		/**
		 * GET /templates/export - Export all templates as JSON
		 */
		export: oc
			.route({
				method: "GET",
				path: "/export",
				summary: "Export templates",
				description:
					"Export all active templates as JSON. D1 is the source of truth - use this to create local snapshots.",
			})
			.input(z.object({}))
			.output(TemplateExportResponseSchema),

		/**
		 * POST /templates/apply - Create app from template
		 */
		apply: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/apply",
				summary: "Apply template",
				description:
					"Create a new app from a template with custom configuration. Replaces placeholders like {siteName}, {siteContext}, etc.",
				successStatus: 201,
			})
			.input(ApplyTemplateInputSchema)
			.output(ApplyTemplateResponseSchema),
	});

export type TemplatesContract = typeof templatesContract;
