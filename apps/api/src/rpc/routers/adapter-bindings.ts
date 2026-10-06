/**
 * oRPC Adapter Bindings Router
 * Explicit bindings between adapter config paths and secrets
 *
 * This router enables:
 * - Explicit binding of secrets to adapter config paths
 * - Validation against ADAPTER_TYPE_SPECS
 * - Querying which secrets are used by which adapters
 *
 * Security:
 * - All endpoints require authentication
 * - Access is scoped to user's organization
 * - Secrets are never exposed (only metadata returned)
 */

import { implement } from "@orpc/server";
import { adapterBindingsContract } from "@tedix/api-contract/contracts/adapter-bindings";
import type { AdapterType } from "@tedix/api-contract/schemas/adapter-bindings";
import {
	getBindingByConfigKey,
	validateBindings,
} from "@tedix/api-contract/schemas/adapter-bindings";
import { getAdapterById } from "@tedix/db/queries/adapters";
import {
	deleteBinding,
	deleteBindingByPath,
	getBindingById,
	listAdaptersUsingSecret,
	listBindingsForAdapter,
	listBindingsForApp,
	setBinding,
} from "@tedix/db/queries/app-adapter-secret-bindings";
import { getAppById } from "@tedix/db/queries/app-records";
import { getAppSecretById } from "@tedix/db/queries/app-secrets";
import { getOrgSecretById } from "@tedix/db/queries/organization-secrets";
import type { SecretScope } from "@tedix/db/schema/app-adapter-secret-bindings";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

/**
 * Create the contract implementer with base context
 */
const adapterBindingsOs = implement(
	adapterBindingsContract,
).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 */
const authedAdapterBindingsOs = adapterBindingsOs.use(withAuth);
const readAdapterBindingsOs = authedAdapterBindingsOs.use(AUTHZ.appsRead);
const manageAdapterBindingsOs = authedAdapterBindingsOs.use(AUTHZ.appsWrite);

// Alias for logging middleware

// =============================================================================
// PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * List all bindings for an adapter
 */
export const listByAdapterProcedure =
	readAdapterBindingsOs.listByAdapter.handler(async ({ input, context }) => {
		const { db } = context;
		const { adapterId } = input;

		// Verify adapter access
		await requireAdapterAccess(context, adapterId);

		const bindings = await listBindingsForAdapter(db, adapterId);

		return {
			bindings: bindings.map((b) => ({
				id: b.id,
				adapterId: b.adapterId,
				appId: b.appId,
				configPath: b.configPath,
				secretId: b.secretId,
				secretScope: b.secretScope,
				secretName: b.secretName,
				secretHint: b.secretHint,
				createdAt: b.createdAt,
				updatedAt: b.updatedAt,
			})),
		};
	});

/**
 * List all bindings for an app (across all adapters)
 */
export const listByAppProcedure = readAdapterBindingsOs.listByApp.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		// Verify app access
		await requireAppAccess(context, appId);

		const bindings = await listBindingsForApp(db, appId);

		return {
			bindings: bindings.map((b) => ({
				id: b.id,
				adapterId: b.adapterId,
				appId: b.appId,
				configPath: b.configPath,
				secretId: b.secretId,
				secretScope: b.secretScope,
				secretName: b.secretName,
				secretHint: b.secretHint,
				createdAt: b.createdAt,
				updatedAt: b.updatedAt,
			})),
		};
	},
);

/**
 * Get a single binding by ID
 */
export const getBindingProcedure = readAdapterBindingsOs.get.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { bindingId } = input;

		const binding = await getBindingById(db, bindingId);
		if (!binding) {
			return null;
		}

		// Verify access via the adapter
		await requireAdapterAccess(context, binding.adapterId);

		// Get secret metadata via adapter query (already joined)
		const bindings = await listBindingsForAdapter(db, binding.adapterId);
		const fullBinding = bindings.find((b) => b.id === bindingId);

		if (!fullBinding) {
			return null;
		}

		return {
			id: fullBinding.id,
			adapterId: fullBinding.adapterId,
			appId: fullBinding.appId,
			configPath: fullBinding.configPath,
			secretId: fullBinding.secretId,
			secretScope: fullBinding.secretScope,
			secretName: fullBinding.secretName,
			secretHint: fullBinding.secretHint,
			createdAt: fullBinding.createdAt,
			updatedAt: fullBinding.updatedAt,
		};
	},
);

/**
 * Set a binding (create or update)
 * Upserts by adapterId + configPath
 */
export const setBindingProcedure = manageAdapterBindingsOs.set.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { adapterId, appId, configPath, secretId, secretScope } = input;

		requireAdminOrOwner(context);

		// Verify adapter and app access
		await requireAdapterAccess(context, adapterId);
		await requireAppAccess(context, appId);

		// Verify adapter belongs to the app
		const adapter = await getAdapterById(db, adapterId);
		if (!adapter || adapter.appId !== appId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Adapter does not belong to this app",
			);
		}

		// Validate configPath against ADAPTER_TYPE_SPECS
		const bindingSlot = getBindingByConfigKey(
			adapter.adapterType as AdapterType,
			configPath,
		);
		if (!bindingSlot) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid config path '${configPath}' for adapter type '${adapter.adapterType}'. ` +
					`Check ADAPTER_TYPE_SPECS for valid binding slots.`,
			);
		}

		// Validate secret scope enum value at runtime
		if (!["app", "organization"].includes(secretScope)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid secret scope: ${secretScope}. Must be 'app' or 'organization'`,
			);
		}

		// Verify secret exists and belongs to the correct scope/entity
		if (secretScope === "app") {
			const secret = await getAppSecretById(db, secretId);
			if (!secret) {
				throw createError(ErrorCodes.NOT_FOUND, "App secret not found");
			}
			if (secret.appId !== appId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Secret does not belong to this app",
				);
			}
		} else {
			// Organization scope - verify org secret exists and belongs to user's org
			const app = await getAppById(db, appId);
			const secret = await getOrgSecretById(db, secretId);
			if (!secret) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Organization secret not found",
				);
			}
			if (secret.organizationId !== app?.organizationId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Secret does not belong to your organization",
				);
			}
		}

		// Create/update the binding
		const binding = await setBinding(
			db,
			adapterId,
			appId,
			configPath,
			secretId,
			secretScope as SecretScope,
		);

		// Get full metadata for response
		const bindings = await listBindingsForAdapter(db, adapterId);
		const fullBinding = bindings.find((b) => b.id === binding.id);

		if (!fullBinding) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to create binding",
			);
		}

		return {
			id: fullBinding.id,
			adapterId: fullBinding.adapterId,
			appId: fullBinding.appId,
			configPath: fullBinding.configPath,
			secretId: fullBinding.secretId,
			secretScope: fullBinding.secretScope,
			secretName: fullBinding.secretName,
			secretHint: fullBinding.secretHint,
			createdAt: fullBinding.createdAt,
			updatedAt: fullBinding.updatedAt,
		};
	},
);

/**
 * Delete a binding by ID
 */
export const deleteBindingProcedure = manageAdapterBindingsOs.delete.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { bindingId } = input;

		requireAdminOrOwner(context);

		// Get binding to verify access
		const binding = await getBindingById(db, bindingId);
		if (!binding) {
			throw createError(ErrorCodes.NOT_FOUND, "Binding not found");
		}

		await requireAdapterAccess(context, binding.adapterId);

		const success = await deleteBinding(db, bindingId);
		return { success };
	},
);

/**
 * Delete a binding by adapter and config path
 */
export const deleteByPathProcedure =
	manageAdapterBindingsOs.deleteByPath.handler(async ({ input, context }) => {
		const { db } = context;
		const { adapterId, configPath } = input;

		requireAdminOrOwner(context);
		await requireAdapterAccess(context, adapterId);

		const success = await deleteBindingByPath(db, adapterId, configPath);
		return { success };
	});

/**
 * Validate bindings for an adapter against ADAPTER_TYPE_SPECS
 */
export const validateBindingsProcedure = readAdapterBindingsOs.validate.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { adapterId } = input;

		await requireAdapterAccess(context, adapterId);

		// Get adapter to determine type
		const adapter = await getAdapterById(db, adapterId);
		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Get current bindings
		const bindings = await listBindingsForAdapter(db, adapterId);

		// Build bindings map for validation (configPath → value placeholder)
		// We only check if bindings exist, not if values are set
		const bindingsMap: Record<string, string | undefined> = {};
		for (const binding of bindings) {
			bindingsMap[binding.configPath] = "bound"; // Placeholder - binding exists
		}

		// Validate against ADAPTER_TYPE_SPECS
		const result = validateBindings(
			adapter.adapterType as AdapterType,
			bindingsMap,
			{ includeWarnings: true },
		);

		return {
			valid: result.valid,
			missing: result.missing,
			warnings: result.warnings,
			errors: result.errors,
		};
	},
);

/**
 * List adapters using a specific secret
 */
export const listAdaptersUsingSecretProcedure =
	readAdapterBindingsOs.listAdaptersUsingSecret.handler(
		async ({ input, context }) => {
			const { db, organizationId } = context;
			const { secretId, secretScope } = input;

			if (!organizationId) {
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"Organization context required",
				);
			}

			// Verify secret exists and belongs to caller's organization
			if (secretScope === "app") {
				const secret = await getAppSecretById(db, secretId);
				if (!secret) {
					throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
				}
				const app = await getAppById(db, secret.appId);
				if (app?.organizationId !== organizationId) {
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Secret does not belong to your organization",
					);
				}
			} else {
				const secret = await getOrgSecretById(db, secretId);
				if (!secret) {
					throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
				}
				if (secret.organizationId !== organizationId) {
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Secret does not belong to your organization",
					);
				}
			}

			const adapterIds = await listAdaptersUsingSecret(
				db,
				secretId,
				secretScope as SecretScope,
			);

			return { adapterIds };
		},
	);

// =============================================================================
// CONTRACT ROUTER
// =============================================================================

/**
 * Contract-based router using os.router() pattern
 */
export const adapterBindingsContractRouter = authedAdapterBindingsOs.router({
	listByAdapter: listByAdapterProcedure,
	listByApp: listByAppProcedure,
	get: getBindingProcedure,
	set: setBindingProcedure,
	delete: deleteBindingProcedure,
	deleteByPath: deleteByPathProcedure,
	validate: validateBindingsProcedure,
	listAdaptersUsingSecret: listAdaptersUsingSecretProcedure,
});

/**
 * Type export for the adapter bindings contract router
 */
export type AdapterBindingsContractRouter =
	typeof adapterBindingsContractRouter;

// =============================================================================
// HELPERS
// =============================================================================

async function requireAppAccess(
	context: BaseContext,
	appId: string,
): Promise<void> {
	const { db, organizationId } = context;

	if (!organizationId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}

	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}

	if (app.organizationId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"App does not belong to your organization",
		);
	}
}

async function requireAdapterAccess(
	context: BaseContext,
	adapterId: string,
): Promise<void> {
	const { db, organizationId } = context;

	if (!organizationId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}

	const adapter = await getAdapterById(db, adapterId);
	if (!adapter) {
		throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
	}

	// Verify adapter's app belongs to user's organization
	const app = await getAppById(db, adapter.appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}

	if (app.organizationId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Adapter does not belong to your organization",
		);
	}
}

function requireAdminOrOwner(context: BaseContext): void {
	if (context.authType !== "user") return;

	if (context.userRole !== "admin" && context.userRole !== "owner") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only admins and owners can manage bindings",
		);
	}
}
