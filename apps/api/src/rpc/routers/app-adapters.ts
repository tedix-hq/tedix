/**
 * oRPC App Adapters Router
 * Adapter configuration management for apps (data source connectors)
 *
 * This router uses contract-first development with oRPC.
 * Shared schemas are imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import { appAdaptersContract } from "@tedix/api-contract/contracts/app-adapters";
import {
	type AdapterType,
	AdapterTypeSchema,
	validateBindings,
} from "@tedix/api-contract/schemas/adapter-bindings";
import type { DbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	deleteAdapter,
	getAdapterById,
	getAdaptersByAppId,
	toggleAdapterEnabled,
	updateAdapterPriority,
	upsertAdapter,
} from "@tedix/db/queries/adapters";
import { listBindingsForAdapter } from "@tedix/db/queries/app-adapter-secret-bindings";
import type { AdapterConfig } from "@tedix/db/schema/adapters";
import { validateAdapterConfig } from "../../services/mcp-config-validation";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

// =============================================================================
// CONTRACT IMPLEMENTER
// =============================================================================

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const appAdaptersOs = implement(appAdaptersContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all app-adapters endpoints require authentication
 */
const authedAppAdaptersOs = appAdaptersOs.use(withAuth);
const readAppAdaptersOs = authedAppAdaptersOs.use(AUTHZ.appsRead);
const manageAppAdaptersOs = authedAppAdaptersOs.use(AUTHZ.appsWrite);

type AdapterWithMaybeBool = {
	enabled: number | boolean | null;
	adapterType: string;
};

function normalizeAdapterEnabled<T extends AdapterWithMaybeBool>(
	adapter: T,
): T {
	return {
		...adapter,
		enabled: adapter.enabled === null ? null : Boolean(adapter.enabled),
	};
}

function normalizeAdapterType(adapterType: string): AdapterType {
	const parsed = AdapterTypeSchema.safeParse(adapterType);
	if (!parsed.success) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Invalid adapter type in storage: ${adapterType}`,
		);
	}
	return parsed.data;
}

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * List all adapters for an app
 * GET /apps/{appId}/adapters
 */
export const listAppAdapters = readAppAdaptersOs.list.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, limit = 20, offset = 0 } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const allAdapters = await getAdaptersByAppId(db, appId);
		const total = allAdapters.length;
		const pagedAdapters = allAdapters.slice(offset, offset + limit);

		return {
			data: pagedAdapters.map((adapter) => {
				const normalized = normalizeAdapterEnabled(adapter);
				return {
					id: normalized.id,
					appId: normalized.appId,
					name: normalized.name,
					displayName: normalized.displayName,
					adapterType: normalizeAdapterType(normalized.adapterType),
					enabled: normalized.enabled,
					priority: normalized.priority,
					createdAt: normalized.createdAt,
					updatedAt: normalized.updatedAt,
				};
			}),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	},
);

/**
 * Get adapter by ID
 * GET /apps/{appId}/adapters/{adapterId}
 */
export const getAppAdapter = readAppAdaptersOs.get.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const adapter = await getAdapterById(db, adapterId);

		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (adapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		const normalized = normalizeAdapterEnabled(adapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

/**
 * Create a new adapter
 * POST /apps/{appId}/adapters
 */
export const createAppAdapter = manageAppAdaptersOs.create.handler(
	async ({ input, context }) => {
		const { db } = context;
		const {
			appId,
			name,
			displayName,
			adapterType,
			config,
			fieldMappings,
			verticals,
			enabled,
			priority,
		} = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		console.log(`[Create] Creating adapter: ${name} for app ${appId}`);

		const validation = validateAdapterConfig(adapterType, config);
		if (!validation.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid adapter config: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
			);
		}

		const adapter = await upsertAdapter(db, {
			appId,
			name,
			displayName: displayName ?? null,
			adapterType,
			config: (config ?? null) as AdapterConfig | null,
			fieldMappings: fieldMappings ?? null,
			verticals: verticals ?? null,
			enabled: enabled ?? true,
			priority: priority ?? 0,
		});

		console.log(`[Create] Created adapter: ${adapter.name} (${adapter.id})`);

		const normalized = normalizeAdapterEnabled(adapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

/**
 * Update an existing adapter
 * PATCH /apps/{appId}/adapters/{adapterId}
 */
export const updateAppAdapter = manageAppAdaptersOs.update.handler(
	async ({ input, context }) => {
		const { db } = context;
		const {
			appId,
			adapterId,
			name,
			displayName,
			adapterType,
			config,
			fieldMappings,
			verticals,
			enabled,
			priority,
		} = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const existingAdapter = await getAdapterById(db, adapterId);

		if (!existingAdapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (existingAdapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		console.log(`[Update] Updating adapter: ${adapterId}`);

		// Build update payload with only provided fields
		const updatePayload: Partial<{
			name: string;
			displayName: string | null;
			adapterType: AdapterType;
			config: unknown;
			fieldMappings: Record<string, string> | null;
			verticals: string[] | null;
			enabled: boolean;
			priority: number;
		}> = {};

		if (name !== undefined) updatePayload.name = name;
		if (displayName !== undefined) updatePayload.displayName = displayName;
		if (adapterType !== undefined) updatePayload.adapterType = adapterType;
		if (config !== undefined) updatePayload.config = config;
		if (fieldMappings !== undefined)
			updatePayload.fieldMappings = fieldMappings;
		if (verticals !== undefined) updatePayload.verticals = verticals;
		if (enabled !== undefined) updatePayload.enabled = enabled;
		if (priority !== undefined) updatePayload.priority = priority;

		const nextAdapterType =
			updatePayload.adapterType ??
			normalizeAdapterType(existingAdapter.adapterType);
		const nextConfig = updatePayload.config ?? existingAdapter.config;

		const validation = validateAdapterConfig(nextAdapterType, nextConfig);
		if (!validation.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid adapter config: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
			);
		}

		const adapter = await upsertAdapter(db, {
			id: adapterId,
			appId: existingAdapter.appId,
			name: updatePayload.name ?? existingAdapter.name,
			displayName: updatePayload.displayName ?? existingAdapter.displayName,
			adapterType: nextAdapterType,
			config: nextConfig,
			fieldMappings:
				updatePayload.fieldMappings ?? existingAdapter.fieldMappings,
			verticals: updatePayload.verticals ?? existingAdapter.verticals,
			enabled: updatePayload.enabled ?? existingAdapter.enabled,
			priority: updatePayload.priority ?? existingAdapter.priority,
		});

		console.log(`[Update] Updated adapter: ${adapter.name} (${adapterId})`);

		const normalized = normalizeAdapterEnabled(adapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

/**
 * Delete an adapter
 * DELETE /apps/{appId}/adapters/{adapterId}
 */
export const deleteAppAdapter = manageAppAdaptersOs.delete.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const adapter = await getAdapterById(db, adapterId);

		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (adapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		await deleteAdapter(db, adapterId);

		console.log(`[Delete] Removed adapter: ${adapter.name} (${adapterId})`);

		return {
			success: true as const,
			message: `Adapter "${adapter.name}" deleted successfully`,
		};
	},
);

/**
 * Enable an adapter
 * POST /apps/{appId}/adapters/{adapterId}/enable
 */
export const enableAppAdapter = manageAppAdaptersOs.enable.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const adapter = await getAdapterById(db, adapterId);

		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (adapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		// Validate required bindings before enabling
		const bindings = await listBindingsForAdapter(db, adapterId);
		const bindingsMap: Record<string, string | undefined> = {};
		for (const binding of bindings) {
			bindingsMap[binding.configPath] = "bound"; // Placeholder - binding exists
		}

		const validationResult = validateBindings(
			normalizeAdapterType(adapter.adapterType),
			bindingsMap,
			{ includeWarnings: false },
		);

		if (!validationResult.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Cannot enable adapter: missing required bindings: ${validationResult.missing.join(", ")}`,
			);
		}

		await toggleAdapterEnabled(db, adapterId, true);

		console.log(`[Enable] Enabled adapter: ${adapter.name} (${adapterId})`);

		const updatedAdapter = await getAdapterById(db, adapterId);

		if (!updatedAdapter) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to enable adapter",
			);
		}

		const normalized = normalizeAdapterEnabled(updatedAdapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

/**
 * Disable an adapter
 * POST /apps/{appId}/adapters/{adapterId}/disable
 */
export const disableAppAdapter = manageAppAdaptersOs.disable.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const adapter = await getAdapterById(db, adapterId);

		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (adapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		await toggleAdapterEnabled(db, adapterId, false);

		console.log(`[Disable] Disabled adapter: ${adapter.name} (${adapterId})`);

		const updatedAdapter = await getAdapterById(db, adapterId);

		if (!updatedAdapter) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to disable adapter",
			);
		}

		const normalized = normalizeAdapterEnabled(updatedAdapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

/**
 * Set adapter priority
 * POST /apps/{appId}/adapters/{adapterId}/priority
 */
export const setAppAdapterPriority = manageAppAdaptersOs.setPriority.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterId, priority } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const adapter = await getAdapterById(db, adapterId);

		if (!adapter) {
			throw createError(ErrorCodes.NOT_FOUND, "Adapter not found");
		}

		// Verify adapter belongs to the app
		if (adapter.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Adapter does not belong to this app",
			);
		}

		await updateAdapterPriority(db, adapterId, priority);

		console.log(
			`[Priority] Set adapter priority to ${priority}: ${adapter.name} (${adapterId})`,
		);

		const updatedAdapter = await getAdapterById(db, adapterId);

		if (!updatedAdapter) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update adapter priority",
			);
		}

		const normalized = normalizeAdapterEnabled(updatedAdapter);
		return {
			id: normalized.id,
			appId: normalized.appId,
			name: normalized.name,
			displayName: normalized.displayName,
			adapterType: normalizeAdapterType(normalized.adapterType),
			config: normalized.config,
			fieldMappings: normalized.fieldMappings,
			verticals: normalized.verticals,
			enabled: normalized.enabled,
			priority: normalized.priority,
			createdAt: normalized.createdAt,
			updatedAt: normalized.updatedAt,
		};
	},
);

export const preflightAppAdapterConfig = manageAppAdaptersOs.preflight.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId, adapterType, config, operation } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const validation = validateAdapterConfig(adapterType, config);
		const requiredBindingsValidation = validateBindings(
			adapterType,
			{},
			{
				includeWarnings: false,
			},
		);

		return {
			valid: validation.valid,
			errors: validation.errors,
			warnings: validation.warnings,
			simulation: {
				operation,
				wouldPersist: validation.valid,
				requiresMcpRefresh: true as const,
				adapterType,
				requiredBindings: requiredBindingsValidation.missing,
			},
		};
	},
);

// =============================================================================
// CONTRACT-BASED ROUTER
// =============================================================================

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const appAdaptersContractRouter = appAdaptersOs.router({
	list: listAppAdapters,
	get: getAppAdapter,
	create: createAppAdapter,
	update: updateAppAdapter,
	delete: deleteAppAdapter,
	enable: enableAppAdapter,
	disable: disableAppAdapter,
	setPriority: setAppAdapterPriority,
	preflight: preflightAppAdapterConfig,
});

// =============================================================================
// HELPERS
// =============================================================================

async function requireAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

// =============================================================================
// CONTRACT EXPORT
// =============================================================================

// =============================================================================
// TYPE EXPORT
// =============================================================================
