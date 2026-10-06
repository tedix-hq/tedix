import "@orpc/openapi/extensions/route";
/**
 * Secrets Contracts for oRPC
 * Type-safe API contracts for Organization and App secrets endpoints
 *
 * These contracts define encrypted secrets management for:
 * - Organization-level API keys and credentials
 * - App-level API keys and credentials
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	AppIdParamSchema,
	OrgIdParamSchema,
	PaginationMetaSchema,
} from "../schemas/common";

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

/**
 * Secret ID parameter schema
 */
export const SecretIdParamSchema = z.object({
	secretId: z.uuid("Secret ID must be a valid UUID"),
});

/**
 * Secret name validation schema
 * Must be uppercase with underscores (e.g., SHOPIFY_TOKEN)
 */
export const SecretNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^[A-Z][A-Z0-9_]*$/,
		"Secret name must be uppercase with underscores (e.g., SHOPIFY_TOKEN)",
	);

/**
 * Secret list item (safe for dashboard display - no decrypted value)
 */
export const SecretListItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	hint: z.string().nullable(),
	keyVersion: z.number(),
	createdBy: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/**
 * Full secret (with decrypted value - only returned on explicit request)
 */
export const SecretWithValueSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	hint: z.string().nullable(),
	keyVersion: z.number(),
	createdBy: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/**
 * Secrets list response with standard pagination
 */
export const SecretsListResponseSchema = z.object({
	data: z.array(SecretListItemSchema),
	pagination: PaginationMetaSchema,
});

/**
 * Success response for delete operations
 */
export const SecretDeleteResponseSchema = z.object({
	success: z.boolean(),
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type SecretIdParam = z.infer<typeof SecretIdParamSchema>;
export type SecretName = z.infer<typeof SecretNameSchema>;
export type SecretListItem = z.infer<typeof SecretListItemSchema>;
export type SecretWithValue = z.infer<typeof SecretWithValueSchema>;
export type SecretsListResponse = z.infer<typeof SecretsListResponseSchema>;
export type SecretDeleteResponse = z.infer<typeof SecretDeleteResponseSchema>;

// =============================================================================
// ORGANIZATION SECRETS CONTRACT
// =============================================================================

/**
 * Organization Secrets Contract - defines the shape of all organization secrets endpoints
 * Tagged as internal since these are sensitive operations
 */
export const organizationSecretsContract = {
	/**
	 * GET /organizations/{organizationId}/secrets - List all secrets for an organization
	 */
	list: oc
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/secrets",
			tags: ["organization-secrets", "internal"],
			summary: "List organization secrets",
			description:
				"List all secrets for an organization (without decrypted values)",
		})
		.input(OrgIdParamSchema)
		.output(SecretsListResponseSchema),

	/**
	 * GET /organizations/{organizationId}/secrets/{secretId} - Get a secret by ID (with decrypted value)
	 */
	get: oc
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/secrets/{secretId}",
			tags: ["organization-secrets", "internal"],
			summary: "Get organization secret",
			description: "Get a secret by ID with its decrypted value",
		})
		.input(OrgIdParamSchema.extend(SecretIdParamSchema.shape))
		.output(SecretWithValueSchema),

	/**
	 * PUT /organizations/{organizationId}/secrets - Create or update a secret
	 */
	set: oc
		.route({
			method: "PUT",
			path: "/organizations/{organizationId}/secrets",
			tags: ["organization-secrets", "internal"],
			summary: "Set organization secret",
			description: "Create or update a secret (upsert by name)",
		})
		.input(
			OrgIdParamSchema.extend({
				name: SecretNameSchema,
				value: z.string().min(1).max(10000),
			}),
		)
		.output(SecretListItemSchema),

	/**
	 * DELETE /organizations/{organizationId}/secrets/{secretId} - Delete a secret
	 */
	delete: oc
		.route({
			method: "DELETE",
			path: "/organizations/{organizationId}/secrets/{secretId}",
			tags: ["organization-secrets", "internal"],
			summary: "Delete organization secret",
			description: "Permanently delete a secret",
		})
		.input(OrgIdParamSchema.extend(SecretIdParamSchema.shape))
		.output(SecretDeleteResponseSchema),
};

export type OrganizationSecretsContract = typeof organizationSecretsContract;

// =============================================================================
// APP SECRETS CONTRACT
// =============================================================================

/**
 * App Secrets Contract - defines the shape of all app secrets endpoints
 * Tagged as internal since these are sensitive operations
 */
export const appSecretsContract = {
	/**
	 * GET /apps/{appId}/secrets - List all secrets for an app
	 */
	list: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/secrets",
			tags: ["app-secrets", "internal"],
			summary: "List app secrets",
			description: "List all secrets for an app (without decrypted values)",
		})
		.input(AppIdParamSchema)
		.output(SecretsListResponseSchema),

	/**
	 * GET /apps/{appId}/secrets/{secretId} - Get a secret by ID (with decrypted value)
	 */
	get: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/secrets/{secretId}",
			tags: ["app-secrets", "internal"],
			summary: "Get app secret",
			description: "Get a secret by ID with its decrypted value",
		})
		.input(AppIdParamSchema.extend(SecretIdParamSchema.shape))
		.output(SecretWithValueSchema),

	/**
	 * PUT /apps/{appId}/secrets - Create or update a secret
	 */
	set: oc
		.route({
			method: "PUT",
			path: "/apps/{appId}/secrets",
			tags: ["app-secrets", "internal"],
			summary: "Set app secret",
			description: "Create or update a secret (upsert by name)",
		})
		.input(
			AppIdParamSchema.extend({
				name: SecretNameSchema,
				value: z.string().min(1).max(10000),
			}),
		)
		.output(SecretListItemSchema),

	/**
	 * DELETE /apps/{appId}/secrets/{secretId} - Delete a secret
	 */
	delete: oc
		.route({
			method: "DELETE",
			path: "/apps/{appId}/secrets/{secretId}",
			tags: ["app-secrets", "internal"],
			summary: "Delete app secret",
			description: "Permanently delete a secret",
		})
		.input(AppIdParamSchema.extend(SecretIdParamSchema.shape))
		.output(SecretDeleteResponseSchema),
};

export type AppSecretsContract = typeof appSecretsContract;
