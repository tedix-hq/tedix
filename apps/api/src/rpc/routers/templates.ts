/**
 * App Templates oRPC Router
 * CRUD operations for template management
 *
 * This router uses contract-first development with oRPC.
 * Contracts are defined in @tedix/api-contract package.
 *
 * REST Endpoints:
 * GET    /templates                - List all active templates (paginated)
 * GET    /templates/{templateId}   - Get template by ID
 * POST   /templates                - Create new template (admin)
 * PATCH  /templates/{templateId}   - Update template
 * DELETE /templates/{templateId}   - Soft delete template
 */

import { implement } from "@orpc/server";
import { templatesContract } from "@tedix/api-contract/contracts/templates";
import {
	applyTemplate,
	createTemplate,
	deleteTemplate,
	getTemplateById,
	getTemplateBySlug,
	getTemplates,
	updateTemplate,
} from "@tedix/db/queries/templates";
import { requireOrganizationAccess } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

/**
 * Create the contract implementer with base context
 */
const templatesOs = implement(templatesContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all templates endpoints require authentication
 */
const authedTemplatesOs = templatesOs.use(withAuth);
const fleetTemplatesOs = authedTemplatesOs.use(withFleetAuthority);

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based list procedure - GET /templates
 */
export const listTemplatesContract = fleetTemplatesOs.list
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { limit, offset } = input;

		try {
			const templates = await getTemplates(db);

			// Apply pagination
			const paginatedTemplates = templates.slice(offset, offset + limit);
			const total = templates.length;
			const hasMore = offset + limit < total;

			return {
				data: paginatedTemplates.map((t) => ({
					...t,
					createdAt: t.createdAt ?? null,
					updatedAt: t.updatedAt ?? null,
				})),
				pagination: {
					limit,
					offset,
					total,
					hasMore,
				},
			};
		} catch (error) {
			console.error("[Templates List] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to list templates",
				error,
			);
		}
	});

/**
 * Contract-based get procedure - GET /templates/{templateId}
 */
export const getTemplateContract = fleetTemplatesOs.get
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { templateId } = input;

		try {
			const template = await getTemplateById(db, templateId);

			if (!template) {
				throw createError(ErrorCodes.NOT_FOUND, "Template not found");
			}

			return {
				success: true as const,
				template: {
					...template,
					createdAt: template.createdAt ?? null,
					updatedAt: template.updatedAt ?? null,
				},
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Template not found") {
				throw error;
			}
			console.error("[Templates Get] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to get template",
				error,
			);
		}
	});

/**
 * Contract-based create procedure - POST /templates
 */
export const createTemplateContract = fleetTemplatesOs.create
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;

		try {
			// Check if slug already exists
			const existing = await getTemplateBySlug(db, input.slug);
			if (existing) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Template with this slug already exists",
				);
			}

			// Transform data for createTemplate function
			const template = await createTemplate(db, {
				name: input.name,
				slug: input.slug,
				vertical: input.vertical,
				description: input.description ?? undefined,
				version: input.version,
				capabilities: (input.capabilities ?? undefined) as Parameters<
					typeof createTemplate
				>[1]["capabilities"],
				adapters: (input.adapters ?? undefined) as Parameters<
					typeof createTemplate
				>[1]["adapters"],
				tools: (input.tools ?? undefined) as Parameters<
					typeof createTemplate
				>[1]["tools"],
				fieldMappings: input.fieldMappings ?? undefined,
				extractionConfig: (input.extractionConfig ?? undefined) as Parameters<
					typeof createTemplate
				>[1]["extractionConfig"],
				requiredFields: input.requiredFields ?? undefined,
				optionalFields: input.optionalFields ?? undefined,
				isActive: input.isActive,
			});

			console.log(
				`[Templates] Created template: ${template.name} (${template.id})`,
			);

			return {
				success: true as const,
				template: {
					...template,
					createdAt: template.createdAt ?? null,
					updatedAt: template.updatedAt ?? null,
				},
			};
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("Template with this slug already exists")
			) {
				throw error;
			}
			console.error("[Templates Create] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to create template",
				error,
			);
		}
	});

/**
 * Contract-based update procedure - PATCH /templates/{templateId}
 */
export const updateTemplateContract = fleetTemplatesOs.update
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { templateId, ...data } = input;

		try {
			// Check if template exists
			const existing = await getTemplateById(db, templateId);
			if (!existing) {
				throw createError(ErrorCodes.NOT_FOUND, "Template not found");
			}

			// If slug is being changed, check for conflicts
			if (data.slug && data.slug !== existing.slug) {
				const conflicting = await getTemplateBySlug(db, data.slug);
				if (conflicting) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Template with this slug already exists",
					);
				}
			}

			// Transform data for updateTemplate function
			type UpdateTemplateParams = Parameters<typeof updateTemplate>[2];
			const updateData: UpdateTemplateParams = {};

			if (data.name !== undefined) updateData.name = data.name;
			if (data.slug !== undefined) updateData.slug = data.slug;
			if (data.vertical !== undefined) updateData.vertical = data.vertical;
			if (data.description !== undefined)
				updateData.description = data.description ?? undefined;
			if (data.version !== undefined) updateData.version = data.version;
			if (data.capabilities !== undefined)
				updateData.capabilities = (data.capabilities ??
					undefined) as UpdateTemplateParams["capabilities"];
			if (data.adapters !== undefined)
				updateData.adapters = (data.adapters ??
					undefined) as UpdateTemplateParams["adapters"];
			if (data.tools !== undefined)
				updateData.tools = (data.tools ??
					undefined) as UpdateTemplateParams["tools"];
			if (data.fieldMappings !== undefined)
				updateData.fieldMappings = data.fieldMappings ?? undefined;
			if (data.extractionConfig !== undefined)
				updateData.extractionConfig = (data.extractionConfig ??
					undefined) as UpdateTemplateParams["extractionConfig"];
			if (data.requiredFields !== undefined)
				updateData.requiredFields = data.requiredFields ?? undefined;
			if (data.optionalFields !== undefined)
				updateData.optionalFields = data.optionalFields ?? undefined;
			if (data.isActive !== undefined) updateData.isActive = data.isActive;

			const template = await updateTemplate(db, templateId, updateData);

			console.log(
				`[Templates] Updated template: ${template?.name} (${templateId})`,
			);

			return {
				success: true as const,
				template: {
					...template!,
					createdAt: template?.createdAt ?? null,
					updatedAt: template?.updatedAt ?? null,
				},
			};
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "Template not found" ||
					error.message.includes("Template with this slug already exists"))
			) {
				throw error;
			}
			console.error("[Templates Update] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update template",
				error,
			);
		}
	});

/**
 * Contract-based delete procedure - DELETE /templates/{templateId}
 */
export const deleteTemplateContract = fleetTemplatesOs.delete
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { templateId } = input;

		try {
			// Check if template exists
			const existing = await getTemplateById(db, templateId);
			if (!existing) {
				throw createError(ErrorCodes.NOT_FOUND, "Template not found");
			}

			await deleteTemplate(db, templateId);

			console.log(
				`[Templates] Soft deleted template: ${existing.name} (${templateId})`,
			);

			return {
				success: true as const,
				message: `Template "${existing.name}" has been deactivated`,
				deletedId: templateId,
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Template not found") {
				throw error;
			}
			console.error("[Templates Delete] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to delete template",
				error,
			);
		}
	});

/**
 * Contract-based export procedure - GET /templates/export
 * Exports all active templates as JSON (D1 is source of truth)
 */
export const exportTemplatesContract = fleetTemplatesOs.export
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		const { db } = context;

		try {
			const templates = await getTemplates(db);
			const exportedAt = new Date().toISOString();

			console.log(`[Templates] Exported ${templates.length} templates`);

			return {
				success: true as const,
				templates: templates.map((t) => ({
					...t,
					createdAt: t.createdAt ?? null,
					updatedAt: t.updatedAt ?? null,
				})),
				exportedAt,
				count: templates.length,
			};
		} catch (error) {
			console.error("[Templates Export] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to export templates",
				error,
			);
		}
	});

/**
 * Contract-based apply procedure - POST /templates/{templateId}/apply
 * Creates a new app from a template with custom configuration
 */
export const applyTemplateContract = fleetTemplatesOs.apply
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { templateId, ...appData } = input;
		requireOrganizationAccess(context, appData.organizationId);

		try {
			// Check if template exists
			const template = await getTemplateById(db, templateId);
			if (!template) {
				throw createError(ErrorCodes.NOT_FOUND, "Template not found");
			}

			// Apply template to create app
			const result = await applyTemplate(db, templateId, appData);

			console.log(
				`[Templates] Applied template ${template.name} to create app: ${result.app.name} (${result.app.id})`,
			);
			console.log(
				`[Templates] Created ${result.adapters.length} adapters and ${result.tools.length} tools`,
			);

			return {
				success: true as const,
				app: {
					id: result.app.id,
					name: result.app.name,
					slug: result.app.slug,
					primaryDomain: appData.primaryDomain,
				},
				adaptersCreated: result.adapters.length,
				toolsCreated: result.tools.length,
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Template not found") {
				throw error;
			}
			console.error("[Templates Apply] Error:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to apply template",
				error,
			);
		}
	});

/**
 * Contract-based router using os.router() pattern
 */
export const templatesContractRouter = authedTemplatesOs.router({
	list: listTemplatesContract,
	get: getTemplateContract,
	create: createTemplateContract,
	update: updateTemplateContract,
	delete: deleteTemplateContract,
	export: exportTemplatesContract,
	apply: applyTemplateContract,
});

/**
 * Type export for the contract router
 */
