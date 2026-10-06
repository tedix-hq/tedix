import "@orpc/openapi/extensions/route";
/**
 * Adapter Bindings Contract
 *
 * API endpoints for managing adapter-to-secret bindings.
 * Enables explicit binding of secrets to adapter config paths.
 *
 * @module @tedix/api-contract/contracts/adapter-bindings
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SecretScopeSchema } from "../schemas/adapter-bindings";

export { SecretScopeSchema } from "../schemas/adapter-bindings";

// =============================================================================
// SCHEMAS
// =============================================================================

/**
 * Binding for list/get responses (safe metadata only)
 */
export const BindingMetadataSchema = z.object({
	id: z.uuid(),
	adapterId: z.string().min(1), // Not .uuid() — some adapters have non-UUID IDs
	appId: z.uuid(),
	configPath: z.string(),
	secretId: z.uuid(),
	secretScope: SecretScopeSchema,
	secretName: z.string().nullable(),
	secretHint: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/**
 * Input for creating/updating a binding
 */
export const SetBindingInputSchema = z.object({
	adapterId: z.string().min(1), // Not .uuid() — some adapters have non-UUID IDs
	configPath: z.string().min(1),
	secretId: z.uuid(),
	secretScope: SecretScopeSchema,
});

/**
 * Binding validation result
 */
export const BindingValidationResultSchema = z.object({
	valid: z.boolean(),
	missing: z.array(z.string()),
	warnings: z.array(z.string()),
	errors: z.array(
		z.object({
			configKey: z.string(),
			message: z.string(),
		}),
	),
});

// =============================================================================
// CONTRACT
// =============================================================================

export const adapterBindingsContract = oc
	.route({ tags: ["adapter-bindings"] })
	.router({
		/**
		 * List all bindings for an adapter
		 */
		listByAdapter: oc
			.route({
				method: "GET",
				path: "/adapters/{adapterId}/bindings",
				summary: "List an adapter's secret bindings",
				description:
					"Return safe secret metadata, never secret values, for every config-path binding on an adapter after verifying organization access.",
			})
			.input(
				z.object({
					adapterId: z.string().min(1),
				}),
			)
			.output(
				z.object({
					bindings: z.array(BindingMetadataSchema),
				}),
			),

		/**
		 * List all bindings for an app (across all adapters)
		 */
		listByApp: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/adapter-bindings",
				summary: "List an app's secret bindings",
				description:
					"Return safe secret metadata, never secret values, for bindings across every adapter owned by an app after verifying organization access.",
			})
			.input(
				z.object({
					appId: z.uuid(),
				}),
			)
			.output(
				z.object({
					bindings: z.array(BindingMetadataSchema),
				}),
			),

		/**
		 * Get a single binding by ID
		 */
		get: oc
			.route({
				method: "GET",
				path: "/adapter-bindings/{bindingId}",
				summary: "Get an adapter binding",
				description:
					"Return safe secret metadata for one binding when its adapter belongs to the caller's organization, or null when no binding exists.",
			})
			.input(
				z.object({
					bindingId: z.uuid(),
				}),
			)
			.output(BindingMetadataSchema.nullable()),

		/**
		 * Set a binding (create or update)
		 * Upserts by adapterId + configPath
		 */
		set: oc
			.route({
				method: "PUT",
				path: "/adapters/{adapterId}/bindings",
				summary: "Set an adapter binding",
				description:
					"Organization owner or admin: create or replace a config-path binding after validating app ownership, the adapter slot, and the secret's scope and ownership.",
			})
			.input(
				z.object({
					adapterId: z.string().min(1),
					appId: z.uuid(),
					configPath: z.string().min(1),
					secretId: z.uuid(),
					secretScope: SecretScopeSchema,
				}),
			)
			.output(BindingMetadataSchema),

		/**
		 * Delete a binding by ID
		 */
		delete: oc
			.route({
				method: "DELETE",
				path: "/adapter-bindings/{bindingId}",
				summary: "Delete an adapter binding",
				description:
					"Organization owner or admin: delete a binding by ID after verifying access through its adapter.",
			})
			.input(
				z.object({
					bindingId: z.uuid(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
				}),
			),

		/**
		 * Delete a binding by adapter and config path
		 */
		deleteByPath: oc
			.route({
				method: "DELETE",
				path: "/adapters/{adapterId}/bindings/{configPath}",
				summary: "Delete an adapter binding by config path",
				description:
					"Organization owner or admin: delete an adapter's binding for a config path after verifying organization access.",
			})
			.input(
				z.object({
					adapterId: z.string().min(1),
					configPath: z.string(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
				}),
			),

		/**
		 * Validate bindings for an adapter against ADAPTER_TYPE_SPECS
		 * Returns validation result with missing required bindings
		 */
		validate: oc
			.route({
				method: "GET",
				path: "/adapters/{adapterId}/bindings/validate",
				summary: "Validate an adapter's secret bindings",
				description:
					"Check the adapter's current config-path bindings against its adapter-type specification and report missing required slots, warnings, and errors.",
			})
			.input(
				z.object({
					adapterId: z.string().min(1),
				}),
			)
			.output(BindingValidationResultSchema),

		/**
		 * List adapters using a specific secret
		 * Useful for showing "secret in use by X adapters" in an operator UI
		 */
		listAdaptersUsingSecret: oc
			.route({
				method: "GET",
				path: "/secrets/{secretId}/adapters",
				summary: "List adapters using a secret",
				description:
					"Return the adapter IDs that reference an app or organization secret after verifying that the secret belongs to the caller's organization.",
			})
			.input(
				z.object({
					secretId: z.uuid(),
					secretScope: SecretScopeSchema,
				}),
			)
			.output(
				z.object({
					adapterIds: z.array(z.string()),
				}),
			),
	});

export type AdapterBindingsContract = typeof adapterBindingsContract;
