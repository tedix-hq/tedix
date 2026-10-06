/**
 * oRPC App Tools Router
 * MCP tool configuration management for apps in the unified multi-tenant engine
 *
 * This router uses contract-first development with oRPC.
 * Shared schemas are imported from @tedix/api-contract package.
 */

import { autoFixSpec, isNonEmptySpec, validateSpec } from "@json-render/core";
import { implement } from "@orpc/server";
import { appToolsContract } from "@tedix/api-contract/contracts/app-tools";
import {
	deriveToolWriteCapability,
	parseAdapterScopeStrict,
} from "@tedix/api-contract/schemas/tools";
import type { DbClient } from "@tedix/db/client";
import { getAdaptersByAppId } from "@tedix/db/queries/adapters";
import { getAppById, getAppMetadataJson } from "@tedix/db/queries/app-records";
import {
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { normalizeAppMetadata } from "./app-metadata";
import {
	bulkUpdateToolSortOrders,
	deleteTool,
	getToolByAppAndToolId,
	getToolById,
	listToolsPage,
	toggleToolEnabled,
	upsertTool,
} from "@tedix/db/queries/tools";
import { toJsonRecord } from "@tedix/db/utils/json";
import { publishMcpListChangedEventsSoon } from "../../lib/mcp-subscriptions";
import {
	mergeValidationResults,
	validateAdapterScopeString,
	validateToolIdStyle,
	validateToolIdWriteState,
	validateToolSchema,
} from "../../services/mcp-config-validation";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";

// =============================================================================
// CONTRACT-BASED IMPLEMENTER
// =============================================================================

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const appToolsOs = implement(appToolsContract).$context<BaseContext>();

/**
 * Every app_tools mutation changes tools/list AND the derived ui:// widget
 * resource list (each row projects a widget-template resource); prompt-type
 * rows (toolTypeId "prompt") additionally surface in prompts/list.
 */
function publishToolInventoryEventsSoon(
	context: BaseContext,
	app: { id: string; slug: string; customMcpDomain: string | null },
	orgId: string,
	promptListChanged: boolean,
): void {
	publishMcpListChangedEventsSoon(
		context.waitUntil,
		context.env,
		{
			appId: app.id,
			organizationId: orgId,
			appResolutionKeys: [
				`mcp-subdomain:${app.slug}`,
				...(app.customMcpDomain ? [`custom:${app.customMcpDomain}`] : []),
			],
		},
		[
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
			...(promptListChanged
				? (["notifications/prompts/list_changed"] as const)
				: []),
		],
	);
}

/**
 * Enforce naming only for a new logical app/tool key. Create is an upsert and
 * production contains upstream-generated names that predate Tedix's naming
 * rule, so a static allowlist would become stale whenever an import adds a new
 * upstream tool. Existing rows remain writable and surface an advisory warning;
 * a genuinely new non-conforming id is rejected.
 */
async function validateToolIdForWrite(
	db: DbClient,
	appId: string,
	toolId: string,
	operation: "create" | "update",
) {
	const strict = validateToolIdStyle(toolId);
	if (strict.valid) return strict;
	const exists =
		operation === "update" ||
		(await getToolByAppAndToolId(db, appId, toolId)) !== undefined;
	return validateToolIdWriteState(toolId, { operation, exists });
}

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all app tools endpoints require authentication
 */
const authedAppToolsOs = appToolsOs.use(withAuth);

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * List all tools for an app
 * GET /apps/{appId}/tools
 */
export const listAppTools = authedAppToolsOs.list
	.use(AUTHZ.toolsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, limit, offset, query } = input;

		// `requireAppContext` already loads the app row for the ownership check and
		// this handler used to discard it. Reusing it makes the scope derivation
		// cost zero extra D1 queries.
		const { app } = await requireAppContext(db, context, appId);
		const mcpConfig = readMcpConfig(app);

		const page = await listToolsPage(db, appId, { limit, offset, query });

		return {
			data: page.rows.map((tool) => ({
				...mapToolToSchema(tool),
				...resolveScopeMetadata(tool, mcpConfig),
			})),
			pagination: {
				limit,
				offset,
				total: page.total,
				hasMore: offset + limit < page.total,
			},
			inventoryTotal: page.inventoryTotal,
		};
	});

/**
 * Get a specific tool by ID
 * GET /apps/{appId}/tools/{toolId}
 */
export const getAppTool = authedAppToolsOs.get
	.use(AUTHZ.toolsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, toolId } = input;

		// Same free app row as the list path — requireToolForApp already loads it.
		const { app, tool } = await requireToolForApp(db, context, appId, toolId);

		return {
			...mapToolToSchema(tool),
			...resolveScopeMetadata(tool, readMcpConfig(app)),
		};
	});

/**
 * Create a new tool
 * POST /apps/{appId}/tools
 */
export const createAppTool = authedAppToolsOs.create
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, ...toolData } = input;

		const { orgId, app } = await requireAppContext(db, context, appId);
		const toolIdValidation = await validateToolIdForWrite(
			db,
			appId,
			toolData.toolId,
			"create",
		);

		const validation = mergeValidationResults(
			validateToolSchema(toolData.inputSchema, "inputSchema"),
			validateToolSchema(toolData.outputSchema, "outputSchema"),
			validateAdapterScopeString(toolData.adapterScope),
			toolIdValidation,
		);
		const adapterScopeValidation = await validateToolAdapterScopeForApp(
			db,
			appId,
			toolData.adapterScope,
		);
		const mergedValidation = mergeValidationResults(
			validation,
			adapterScopeValidation,
		);
		if (!mergedValidation.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid tool config: ${mergedValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
			);
		}
		if (mergedValidation.warnings.length > 0) {
			console.warn(
				`[app-tools.create] ${appId}/${toolData.toolId}: ${mergedValidation.warnings
					.map((warning) => `${warning.path}: ${warning.message}`)
					.join("; ")}`,
			);
		}

		// Validate json-render layout spec if present
		const validatedConfig = validateAndFixLayoutSpec(
			toolData.widgetKey,
			toolData.config as Record<string, unknown> | null | undefined,
		);

		// Create the tool using upsertTool (it will create if not exists)
		// Cast JSON values to DB schema types
		const tool = await upsertTool(db, {
			appId,
			toolId: toolData.toolId,
			toolTypeId: toolData.toolTypeId,
			title: toolData.title,
			description: toolData.description,
			inputSchema: toolData.inputSchema,
			outputSchema: toolData.outputSchema,
			adapterScope: toolData.adapterScope,
			resultStrategy: toolData.resultStrategy,
			outputTemplate: toolData.outputTemplate,
			widgetRoute: toolData.widgetRoute,
			widgetKey: toolData.widgetKey,
			widgetAccessible: toolData.widgetAccessible,
			authRequired: toolData.authRequired,
			visibility: toolData.visibility,
			icons: toolData.icons,
			executionTaskSupport: toolData.executionTaskSupport,
			annotations: toolData.annotations,
			// Declaration wins when supplied; otherwise derive it from the
			// annotations so a hand-created tool is never born UNDECLARED when it
			// already carries hints that say what it does.
			writeCapability:
				toolData.writeCapability !== undefined
					? toolData.writeCapability
					: deriveToolWriteCapability(toolData.annotations),
			meta: toolData.meta == null ? toolData.meta : toJsonRecord(toolData.meta),
			invocationStatus: toolData.invocationStatus,
			fileParams: toolData.fileParams,
			widgetDescription: toolData.widgetDescription,
			widgetPrefersBorder: toolData.widgetPrefersBorder,
			widgetDomain: toolData.widgetDomain,
			config:
				validatedConfig == null
					? validatedConfig
					: toJsonRecord(validatedConfig),
			schemaDialect: toolData.schemaDialect,
			schemaSource: toolData.schemaSource,
			schemaSourceRef: toolData.schemaSourceRef,
			schemaSourceHash: toolData.schemaSourceHash,
			schemaSyncedAt: toolData.schemaSyncedAt,
			sortOrder: toolData.sortOrder,
			enabled: toolData.enabled,
		});

		publishToolInventoryEventsSoon(
			context,
			app,
			orgId,
			tool.toolTypeId === "prompt",
		);

		return mapToolToSchema(tool);
	});

/**
 * Update an existing tool
 * PATCH /apps/{appId}/tools/{toolId}
 */
export const updateAppTool = authedAppToolsOs.update
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const toolUuid = input.toolId; // UUID from path (always present)
		const appId = input.appId;

		if (!toolUuid) {
			throw createError(ErrorCodes.BAD_REQUEST, "Tool ID is required");
		}

		const {
			orgId,
			app,
			tool: existingTool,
		} = await requireToolForApp(db, context, appId, toolUuid);

		const nextInputSchema =
			input.inputSchema !== undefined
				? input.inputSchema
				: existingTool.inputSchema;
		const nextOutputSchema =
			input.outputSchema !== undefined
				? input.outputSchema
				: existingTool.outputSchema;
		const nextAdapterScope =
			input.adapterScope !== undefined
				? input.adapterScope
				: existingTool.adapterScope;

		const validation = mergeValidationResults(
			validateToolSchema(nextInputSchema, "inputSchema"),
			validateToolSchema(nextOutputSchema, "outputSchema"),
			validateAdapterScopeString(nextAdapterScope),
		);
		const adapterScopeValidation = await validateToolAdapterScopeForApp(
			db,
			appId,
			nextAdapterScope,
		);
		const mergedValidation = mergeValidationResults(
			validation,
			adapterScopeValidation,
		);
		if (!mergedValidation.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Invalid tool config: ${mergedValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
			);
		}

		// Validate json-render layout spec if present
		const nextWidgetKey =
			input.widgetKey !== undefined ? input.widgetKey : existingTool.widgetKey;
		const nextConfig =
			input.config !== undefined
				? (input.config as Record<string, unknown> | null)
				: (existingTool.config as Record<string, unknown> | null);
		const validatedUpdateConfig = validateAndFixLayoutSpec(
			nextWidgetKey,
			nextConfig,
		);

		// Update the tool using upsertTool with existing ID
		// Cast JSON values to the DB schema types
		const tool = await upsertTool(db, {
			id: toolUuid,
			appId,
			// toolId (logical identifier) is immutable — never overwrite from path UUID
			toolId: existingTool.toolId,
			toolTypeId:
				input.toolTypeId !== undefined
					? input.toolTypeId
					: existingTool.toolTypeId,
			title: input.title !== undefined ? input.title : existingTool.title,
			description:
				input.description !== undefined
					? input.description
					: existingTool.description,
			inputSchema: nextInputSchema,
			outputSchema: nextOutputSchema,
			adapterScope: nextAdapterScope,
			resultStrategy:
				input.resultStrategy !== undefined
					? input.resultStrategy
					: existingTool.resultStrategy,
			outputTemplate:
				input.outputTemplate !== undefined
					? input.outputTemplate
					: existingTool.outputTemplate,
			widgetRoute:
				input.widgetRoute !== undefined
					? input.widgetRoute
					: existingTool.widgetRoute,
			widgetKey:
				input.widgetKey !== undefined
					? input.widgetKey
					: existingTool.widgetKey,
			widgetAccessible:
				input.widgetAccessible !== undefined
					? input.widgetAccessible
					: existingTool.widgetAccessible,
			authRequired:
				input.authRequired !== undefined
					? input.authRequired
					: (existingTool.authRequired ?? false),
			visibility:
				input.visibility !== undefined
					? input.visibility
					: existingTool.visibility,
			icons: input.icons !== undefined ? input.icons : existingTool.icons,
			executionTaskSupport:
				input.executionTaskSupport !== undefined
					? input.executionTaskSupport
					: existingTool.executionTaskSupport,
			annotations:
				input.annotations !== undefined
					? input.annotations
					: existingTool.annotations,
			// An explicit declaration wins. Otherwise, changing the annotations
			// re-derives the column (they are the same statement in two shapes),
			// and leaving both alone keeps whatever is stored.
			writeCapability:
				input.writeCapability !== undefined
					? input.writeCapability
					: input.annotations !== undefined
						? deriveToolWriteCapability(input.annotations)
						: existingTool.writeCapability,
			meta:
				input.meta !== undefined
					? input.meta === null
						? null
						: toJsonRecord(input.meta)
					: existingTool.meta,
			invocationStatus:
				input.invocationStatus !== undefined
					? input.invocationStatus
					: existingTool.invocationStatus,
			fileParams:
				input.fileParams !== undefined
					? input.fileParams
					: existingTool.fileParams,
			widgetDescription:
				input.widgetDescription !== undefined
					? input.widgetDescription
					: existingTool.widgetDescription,
			widgetPrefersBorder:
				input.widgetPrefersBorder !== undefined
					? input.widgetPrefersBorder
					: existingTool.widgetPrefersBorder,
			widgetDomain:
				input.widgetDomain !== undefined
					? input.widgetDomain
					: existingTool.widgetDomain,
			config:
				validatedUpdateConfig == null
					? validatedUpdateConfig
					: toJsonRecord(validatedUpdateConfig),
			schemaDialect:
				input.schemaDialect !== undefined
					? input.schemaDialect
					: existingTool.schemaDialect,
			schemaSource:
				input.schemaSource !== undefined
					? input.schemaSource
					: existingTool.schemaSource,
			schemaSourceRef:
				input.schemaSourceRef !== undefined
					? input.schemaSourceRef
					: existingTool.schemaSourceRef,
			schemaSourceHash:
				input.schemaSourceHash !== undefined
					? input.schemaSourceHash
					: existingTool.schemaSourceHash,
			schemaSyncedAt:
				input.schemaSyncedAt !== undefined
					? input.schemaSyncedAt
					: existingTool.schemaSyncedAt,
			sortOrder:
				input.sortOrder !== undefined
					? input.sortOrder
					: existingTool.sortOrder,
			enabled:
				input.enabled !== undefined ? input.enabled : existingTool.enabled,
		});

		publishToolInventoryEventsSoon(
			context,
			app,
			orgId,
			tool.toolTypeId === "prompt" || existingTool.toolTypeId === "prompt",
		);

		return mapToolToSchema(tool);
	});

/**
 * Delete a tool
 * DELETE /apps/{appId}/tools/{toolId}
 */
export const deleteAppTool = authedAppToolsOs.delete
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, toolId } = input;

		const {
			orgId,
			app,
			tool: existingTool,
		} = await requireToolForApp(db, context, appId, toolId);

		await deleteTool(db, toolId);
		publishToolInventoryEventsSoon(
			context,
			app,
			orgId,
			existingTool.toolTypeId === "prompt",
		);

		return {
			success: true as const,
			message: `Tool "${existingTool.title}" deleted successfully`,
		};
	});

/**
 * Enable a tool
 * POST /apps/{appId}/tools/{toolId}/enable
 */
export const enableAppTool = authedAppToolsOs.enable
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, toolId } = input;

		const { orgId, app } = await requireToolForApp(db, context, appId, toolId);

		await toggleToolEnabled(db, toolId, true);

		const tool = await getToolById(db, toolId);
		if (!tool) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to enable tool",
			);
		}
		publishToolInventoryEventsSoon(
			context,
			app,
			orgId,
			tool.toolTypeId === "prompt",
		);

		return mapToolToSchema(tool);
	});

/**
 * Disable a tool
 * POST /apps/{appId}/tools/{toolId}/disable
 */
export const disableAppTool = authedAppToolsOs.disable
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, toolId } = input;

		const { orgId, app } = await requireToolForApp(db, context, appId, toolId);

		await toggleToolEnabled(db, toolId, false);

		const tool = await getToolById(db, toolId);
		if (!tool) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to disable tool",
			);
		}
		publishToolInventoryEventsSoon(
			context,
			app,
			orgId,
			tool.toolTypeId === "prompt",
		);

		return mapToolToSchema(tool);
	});

/**
 * Reorder tools
 * PUT /apps/{appId}/tools/order
 */
export const reorderAppTools = authedAppToolsOs.reorder
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, toolIds } = input;

		const { orgId, app } = await requireAppContext(db, context, appId);

		// Verify all tools exist and belong to the app
		let promptListChanged = false;
		for (const toolId of toolIds) {
			const tool = await getToolById(db, toolId);
			if (!tool) {
				throw createError(ErrorCodes.NOT_FOUND, `Tool ${toolId} not found`);
			}
			if (tool.appId !== appId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					`Tool ${toolId} does not belong to this app`,
				);
			}
			if (tool.toolTypeId === "prompt") promptListChanged = true;
		}

		// Build updates array with new sort orders
		const updates = toolIds.map((toolId: string, index: number) => ({
			toolId,
			sortOrder: index,
		}));

		await bulkUpdateToolSortOrders(db, updates);
		publishToolInventoryEventsSoon(context, app, orgId, promptListChanged);

		return {
			success: true as const,
			updated: updates.length,
		};
	});

export const preflightAppToolConfig = authedAppToolsOs.preflight
	.use(AUTHZ.toolsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			appId,
			toolId,
			inputSchema,
			outputSchema,
			adapterScope,
			operation,
		} = input;

		await requireAppContext(db, context, appId);
		const toolIdValidation =
			toolId === undefined
				? undefined
				: await validateToolIdForWrite(db, appId, toolId, operation);

		const validation = mergeValidationResults(
			validateToolSchema(inputSchema, "inputSchema"),
			validateToolSchema(outputSchema, "outputSchema"),
			validateAdapterScopeString(adapterScope),
			...(toolIdValidation ? [toolIdValidation] : []),
		);
		const adapterScopeValidation = await validateToolAdapterScopeForApp(
			db,
			appId,
			adapterScope,
		);
		const mergedValidation = mergeValidationResults(
			validation,
			adapterScopeValidation,
		);
		const adapterScopeSimulation = await simulateAdapterScope(
			db,
			appId,
			adapterScope,
		);

		return {
			valid: mergedValidation.valid,
			errors: mergedValidation.errors,
			warnings: [
				...mergedValidation.warnings,
				...adapterScopeSimulation.warnings,
			],
			simulation: {
				operation,
				wouldPersist: mergedValidation.valid,
				requiresMcpRefresh: true as const,
				adapterScope: adapterScopeSimulation.adapterScope,
				authRequired: input.authRequired,
			},
		};
	});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const appToolsContractRouter = appToolsOs.router({
	list: skipOutputValidation(listAppTools),
	get: skipOutputValidation(getAppTool),
	create: createAppTool,
	update: updateAppTool,
	delete: deleteAppTool,
	enable: enableAppTool,
	disable: disableAppTool,
	reorder: reorderAppTools,
	preflight: preflightAppToolConfig,
});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Validate and auto-fix json-render layout specs before persisting to D1.
 * Only applies when widgetKey is 'render' and config.layoutSpec is present.
 */
function validateAndFixLayoutSpec(
	widgetKey: string | null | undefined,
	config: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
	if (widgetKey !== "render" || !config || !isNonEmptySpec(config.layoutSpec)) {
		return config;
	}

	const { valid } = validateSpec(config.layoutSpec as never);
	if (valid) return config;

	// Lossless fixes only. json-render's autofix defaults to `lossy: true`,
	// which prunes dangling child references — on a persistence path that
	// silently deletes a branch of the tenant's UI and reports success. We
	// relocate misplaced fields and reject anything that would only validate by
	// dropping content, so the caller regenerates instead of losing it.
	const { spec: fixedSpec } = autoFixSpec(config.layoutSpec as never, {
		lossy: false,
	});
	const recheck = validateSpec(fixedSpec);
	if (!recheck.valid) {
		const msgs = (recheck.issues ?? [])
			.map((i: { message: string }) => i.message)
			.join(", ");
		// Name what a lossy pass WOULD have discarded, so the error explains why
		// a spec that used to persist no longer does.
		const lossy = autoFixSpec(config.layoutSpec as never)
			.fixDetails.filter((fix) => fix.lossy)
			.map((fix) => fix.message);
		const suffix =
			lossy.length > 0 ? ` (refusing to discard: ${lossy.join(", ")})` : "";
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Invalid layout spec: ${msgs}${suffix}`,
		);
	}

	// Lossless repairs only relocate misplaced fields, so persisting the fixed
	// spec cannot change what renders.
	return { ...config, layoutSpec: fixedSpec };
}

async function validateToolAdapterScopeForApp(
	db: DbClient,
	appId: string,
	adapterScope: string | null | undefined,
) {
	const parsed = parseAdapterScopeStrict(adapterScope);
	if (!parsed.success || parsed.value.mode !== "ids") {
		return { valid: true, errors: [], warnings: [] };
	}

	const adapters = await getAdaptersByAppId(db, appId);
	const existingAdapterIds = new Set(adapters.map((adapter) => adapter.id));
	const missing = parsed.value.adapterIds.filter(
		(id) => !existingAdapterIds.has(id),
	);

	if (missing.length > 0) {
		return {
			valid: false,
			errors: [
				{
					path: "adapterScope",
					message: `adapterScope references unknown adapters for this app: ${missing.join(", ")}`,
				},
			],
			warnings: [],
		};
	}

	return { valid: true, errors: [], warnings: [] };
}

async function simulateAdapterScope(
	db: DbClient,
	appId: string,
	adapterScope: string | null | undefined,
) {
	const parsed = parseAdapterScopeStrict(adapterScope);
	if (!parsed.success) {
		return {
			adapterScope: {
				mode: "invalid" as const,
				requestedIds: [] as string[],
				resolvedIds: [] as string[],
				totalAvailable: 0,
			},
			warnings: [],
		};
	}

	const adapters = await getAdaptersByAppId(db, appId);
	const totalAvailable = adapters.length;
	const adapterIdsByPriority = adapters
		.slice()
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
		.map((adapter) => adapter.id);

	if (parsed.value.mode === "all") {
		return {
			adapterScope: {
				mode: "all" as const,
				requestedIds: [] as string[],
				resolvedIds: adapterIdsByPriority,
				totalAvailable,
			},
			warnings: [],
		};
	}

	if (parsed.value.mode === "primary") {
		return {
			adapterScope: {
				mode: "primary" as const,
				requestedIds: [] as string[],
				resolvedIds: adapterIdsByPriority.slice(0, 1),
				totalAvailable,
			},
			warnings:
				totalAvailable === 0
					? [
							{
								path: "adapterScope",
								message:
									"No adapters are configured for this app; execution will fail until an adapter is added.",
							},
						]
					: [],
		};
	}

	const existingAdapterIds = new Set(adapters.map((adapter) => adapter.id));
	const resolvedIds = parsed.value.adapterIds.filter((id) =>
		existingAdapterIds.has(id),
	);
	const missingIds = parsed.value.adapterIds.filter(
		(id) => !existingAdapterIds.has(id),
	);

	return {
		adapterScope: {
			mode: "ids" as const,
			requestedIds: parsed.value.adapterIds,
			resolvedIds,
			totalAvailable,
		},
		warnings:
			missingIds.length > 0
				? [
						{
							path: "adapterScope",
							message: `Some adapter IDs are not present on this app and would fail at write time: ${missingIds.join(", ")}`,
						},
					]
				: [],
	};
}

/**
 * Map DB tool to contract schema
 * AppToolSchema doesn't include appId field
 */
/**
 * The capability scope each tool actually requires, resolved by the SAME
 * function the MCP edge enforces with (`resolveMcpToolRequiredScopes`, now in
 * packages/mcp) rather than re-derived here.
 *
 * Two things make this honest rather than approximate:
 *
 *  - The mcpConfig is read the way the EDGE reads it —
 *    `normalizeAppMetadata(getAppMetadataJson(app))` — not raw off the column.
 *    `getAppMetadataJson` parses metadata that was stored as a JSON string, and
 *    `normalizeAppMetadata` normalizes mcpConfig; reading the raw column would
 *    silently disagree with enforcement for exactly the legacy rows that most
 *    need explaining.
 *  - No options object is passed, matching both edge call sites. `tools/list`
 *    passes none and `tools/call` passes `fallbackOnAuthenticatedAuthMode:
 *    false`, and the flag is tested with `=== true`, so the two resolve
 *    identically.
 *  - Namespace resolution reads the persisted endpoint/aggregate metadata and
 *    D1 Code Mode overrides through the shared edge resolver. Tool verbs are
 *    not namespaces.
 *
 * The list returns persisted rows whether enabled or disabled, while the edge
 * serves only `enabled: true` tools. A disabled row reports the scope it WOULD
 * require if enabled.
 */
function resolveRequiredScopes(
	tool: {
		toolId: string;
		toolTypeId?: string | null;
		config?: Record<string, unknown> | null;
		authRequired?: boolean | null;
		visibility?: string | null;
		annotations?: unknown;
		writeCapability?: unknown;
	},
	mcpConfig: Record<string, unknown> | undefined,
): string[] {
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	return resolveMcpToolRequiredScopes(
		{
			toolId: tool.toolId,
			toolTypeId: tool.toolTypeId,
			config: tool.config,
			authRequired: tool.authRequired ?? undefined,
			visibility: tool.visibility ?? undefined,
			annotations: tool.annotations as never,
			writeCapability: tool.writeCapability as never,
		},
		resolveMcpToolNamespace(tool, namespaceOverrides),
		mcpConfig,
	);
}

function resolveScopeMetadata(
	tool: Parameters<typeof resolveRequiredScopes>[0],
	mcpConfig: Record<string, unknown> | undefined,
): { requiredScopes: string[] } | { scopeMappingMissing: true } {
	try {
		return { requiredScopes: resolveRequiredScopes(tool, mcpConfig) };
	} catch (error) {
		if (
			error instanceof Error &&
			error.message ===
				`Missing MCP capability mapping for tool: ${tool.toolId}`
		)
			return { scopeMappingMissing: true };
		throw error;
	}
}

function readMcpConfig(app: unknown): Record<string, unknown> | undefined {
	const metadata = normalizeAppMetadata(getAppMetadataJson(app as never));
	return (metadata?.mcpConfig ?? undefined) as
		| Record<string, unknown>
		| undefined;
}

function mapToolToSchema(tool: Awaited<ReturnType<typeof getToolById>>) {
	if (!tool) {
		throw createError(ErrorCodes.INTERNAL_SERVER_ERROR, "Tool is null");
	}

	return {
		id: tool.id,
		toolId: tool.toolId,
		toolTypeId: tool.toolTypeId,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema,
		adapterScope: tool.adapterScope,
		resultStrategy: tool.resultStrategy,
		outputTemplate: tool.outputTemplate,
		widgetRoute: tool.widgetRoute,
		widgetKey: tool.widgetKey,
		widgetAccessible: tool.widgetAccessible,
		authRequired: tool.authRequired ?? false,
		visibility: tool.visibility,
		icons: tool.icons,
		executionTaskSupport: tool.executionTaskSupport,
		annotations: tool.annotations,
		meta: tool.meta,
		invocationStatus: tool.invocationStatus,
		fileParams: tool.fileParams,
		widgetDescription: tool.widgetDescription,
		widgetPrefersBorder: tool.widgetPrefersBorder,
		widgetDomain: tool.widgetDomain,
		config: tool.config,
		schemaDialect: tool.schemaDialect,
		schemaSource: tool.schemaSource,
		schemaSourceRef: tool.schemaSourceRef,
		schemaSourceHash: tool.schemaSourceHash,
		schemaSyncedAt: tool.schemaSyncedAt,
		sortOrder: tool.sortOrder,
		enabled: tool.enabled,
		createdAt: tool.createdAt,
		updatedAt: tool.updatedAt,
	};
}

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

/**
 * Shared helper: validate org context + app ownership.
 * Use for handlers that operate on an app but not a specific tool.
 */
async function requireAppContext(
	db: DbClient,
	context: BaseContext,
	appId: string,
) {
	const orgId = requireOrgId(context);
	const app = await requireAppForOrg(db, orgId, appId);
	return { orgId, app };
}

/**
 * Shared helper: validate org context + app ownership + tool existence & ownership.
 * Use for handlers that operate on a specific tool within an app.
 */
async function requireToolForApp(
	db: DbClient,
	context: BaseContext,
	appId: string,
	toolId: string,
) {
	const orgId = requireOrgId(context);
	const app = await requireAppForOrg(db, orgId, appId);
	const tool = await getToolById(db, toolId);
	if (!tool) {
		throw createError(ErrorCodes.NOT_FOUND, "Tool not found");
	}
	if (tool.appId !== appId) {
		throw createError(ErrorCodes.FORBIDDEN, "Tool does not belong to this app");
	}
	return { orgId, app, tool };
}

// =============================================================================
// EXPORTS
// =============================================================================
