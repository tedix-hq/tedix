/**
 * App Catalog Queries — Custom fork propagation.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { eq, inArray } from "drizzle-orm";
import { apps, appTools } from "../../schema/index";
import { chunkForBoundParams } from "../../utils/batch";
import {
	CatalogProxyAppToolMutationError,
	type Database,
	hasAggregateAppOverlay,
	jsonEqual,
} from "./tool-source-policy";

// =============================================================================
// CUSTOM FORK PROPAGATION (base app → explicit custom forks)
// =============================================================================

export interface PropagateToolsOptions {
	sourceAppId: string;
	appIds: string[];
	applyTypes?: (
		| "schema_changed"
		| "description_changed"
		| "metadata_changed"
		| "new_tool"
		| "removed_tool"
	)[];
	preserveFields?: string[]; // dot-notation config paths to preserve on target
	dryRun: boolean;
}

export interface PropagateToolsResultItem {
	targetAppId: string;
	targetAppName: string;
	toolName: string;
	action:
		| "created"
		| "updated_schema"
		| "updated_description"
		| "updated_metadata"
		| "skipped"
		| "would_create"
		| "would_update";
	reason?: string;
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Split a caller-supplied dot-notation path, refusing prototype-reaching
 * segments so preserved config can never read from or write to a prototype.
 */
function safePathParts(path: string): string[] | null {
	const parts = path.split(".");
	return parts.some((part) => UNSAFE_PATH_SEGMENTS.has(part)) ? null : parts;
}

/**
 * Helper to get a nested value from an object by dot-notation path.
 */
function getNestedValue(obj: unknown, path: string): unknown {
	const parts = safePathParts(path);
	if (!parts) return undefined;
	let current: unknown = obj;
	for (let i = 0; i < parts.length; i++) {
		if (current == null || typeof current !== "object") return undefined;
		const part = parts[i] as string;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Helper to set a nested value on an object by dot-notation path.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = safePathParts(path);
	if (!parts) return;
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i] as string;
		if (current[part] == null || typeof current[part] !== "object") {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastPart = parts[parts.length - 1] as string;
	current[lastPart] = value;
}

/**
 * Propagate tool definitions from a reference (source) app to one or more target apps.
 *
 * Matches tools between source and target by `tool_id` (the string identifier).
 * Supports dry-run preview, selective drift types, and config field preservation.
 */
export async function propagateTools(
	db: Database,
	options: PropagateToolsOptions,
): Promise<{
	sourceAppId: string;
	sourceAppName: string;
	dryRun: boolean;
	results: PropagateToolsResultItem[];
	summary: string;
}> {
	const { sourceAppId, appIds, applyTypes, preserveFields, dryRun } = options;

	// Default apply types if not specified
	const typesToApply = new Set(
		applyTypes ?? [
			"schema_changed",
			"description_changed",
			"metadata_changed",
			"new_tool",
			"removed_tool",
		],
	);

	// 1. Get source app
	const sourceAppRows = await db
		.select()
		.from(apps)
		.where(eq(apps.id, sourceAppId))
		.limit(1);
	const sourceApp = sourceAppRows[0];
	if (!sourceApp) {
		throw new Error(`Source app not found: ${sourceAppId}`);
	}

	// 2. Get source tools
	const sourceTools = await db
		.select()
		.from(appTools)
		.where(eq(appTools.appId, sourceAppId));
	const sourceToolsByToolId = new Map(sourceTools.map((t) => [t.toolId, t]));

	// 3. Get all target apps and their tools (eliminates N+1 per-target
	// queries). The id lists are chunked: D1 caps bound parameters at 100 per
	// statement.
	const targetApps: (typeof apps.$inferSelect)[] = [];
	const allTargetTools: (typeof appTools.$inferSelect)[] = [];
	for (const chunk of chunkForBoundParams([...new Set(appIds)], 50)) {
		const [chunkApps, chunkTools] = await Promise.all([
			db.select().from(apps).where(inArray(apps.id, chunk)),
			db.select().from(appTools).where(inArray(appTools.appId, chunk)),
		]);
		targetApps.push(...chunkApps);
		allTargetTools.push(...chunkTools);
	}
	const targetAppsById = new Map(targetApps.map((a) => [a.id, a]));
	const proxyTargets = targetApps.filter(hasAggregateAppOverlay);
	if (proxyTargets.length > 0) {
		const labels = proxyTargets
			.map((app) => `${app.name} (${app.id})`)
			.join(", ");
		throw new CatalogProxyAppToolMutationError(
			`Refusing to propagate copied tool rows into proxy app(s): ${labels}. ` +
				`Proxy apps must keep zero app_tools rows and inherit tools through mcpConfig.aggregateApps. ` +
				`Propagate only to explicit custom forks without aggregateApps.`,
		);
	}

	// Group target tools by appId
	const targetToolsByAppId = new Map<string, typeof allTargetTools>();
	for (const tool of allTargetTools) {
		const existing = targetToolsByAppId.get(tool.appId);
		if (existing) {
			existing.push(tool);
		} else {
			targetToolsByAppId.set(tool.appId, [tool]);
		}
	}

	const results: PropagateToolsResultItem[] = [];

	// 4. Process each target app
	for (const targetAppId of appIds) {
		const targetApp = targetAppsById.get(targetAppId);
		if (!targetApp) {
			results.push({
				targetAppId,
				targetAppName: "unknown",
				toolName: "*",
				action: "skipped",
				reason: `Target app not found: ${targetAppId}`,
			});
			continue;
		}

		const targetTools = targetToolsByAppId.get(targetAppId) ?? [];
		const targetToolsByToolId = new Map(targetTools.map((t) => [t.toolId, t]));

		// Determine default auth scopes to preserve from target's existing tools
		// (take from the first existing tool that has config.auth.scopes)
		let defaultTargetAuthScopes: unknown;
		for (const tt of targetTools) {
			const cfg = tt.config as Record<string, unknown> | null;
			if (cfg) {
				const auth = cfg.auth as Record<string, unknown> | undefined;
				if (auth?.scopes !== undefined) {
					defaultTargetAuthScopes = auth.scopes;
					break;
				}
			}
		}

		// Check each source tool against target
		for (const [sourceToolId, sourceTool] of sourceToolsByToolId) {
			const targetTool = targetToolsByToolId.get(sourceToolId);

			if (!targetTool) {
				// New tool — exists in source but not in target
				if (!typesToApply.has("new_tool")) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "skipped",
						reason: "new_tool not in applyTypes",
					});
					continue;
				}

				if (dryRun) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "would_create",
						reason: "New tool from source",
					});
				} else {
					// Build config for new tool, preserving target auth scopes
					const sourceConfig =
						(sourceTool.config as Record<string, unknown>) ?? {};
					const newConfig = { ...sourceConfig };

					// Preserve auth.scopes from target's existing tools
					if (defaultTargetAuthScopes !== undefined) {
						setNestedValue(newConfig, "auth.scopes", defaultTargetAuthScopes);
					}

					// Preserve any explicitly listed fields
					if (preserveFields) {
						for (const field of preserveFields) {
							// For new tools, preserve from existing target tools' first match
							for (const tt of targetTools) {
								const ttConfig = tt.config as Record<string, unknown> | null;
								if (ttConfig) {
									const val = getNestedValue(ttConfig, field);
									if (val !== undefined) {
										setNestedValue(newConfig, field, val);
										break;
									}
								}
							}
						}
					}

					const newId = crypto.randomUUID();
					const now = new Date().toISOString();
					await db.insert(appTools).values({
						id: newId,
						appId: targetAppId,
						toolTypeId: sourceTool.toolTypeId,
						toolId: sourceTool.toolId,
						title: sourceTool.title,
						description: sourceTool.description,
						inputSchema: sourceTool.inputSchema,
						outputSchema: sourceTool.outputSchema,
						config: newConfig as typeof appTools.$inferInsert.config,
						icons: sourceTool.icons,
						executionTaskSupport: sourceTool.executionTaskSupport,
						annotations: sourceTool.annotations,
						writeCapability: sourceTool.writeCapability,
						meta: sourceTool.meta,
						invocationStatus: sourceTool.invocationStatus,
						fileParams: sourceTool.fileParams,
						schemaDialect: sourceTool.schemaDialect,
						schemaSource: sourceTool.schemaSource,
						schemaSourceRef: sourceTool.schemaSourceRef,
						schemaSourceHash: sourceTool.schemaSourceHash,
						schemaSyncedAt: sourceTool.schemaSyncedAt,
						enabled: sourceTool.enabled,
						sortOrder: sourceTool.sortOrder,
						adapterScope: sourceTool.adapterScope,
						resultStrategy: sourceTool.resultStrategy,
						outputTemplate: sourceTool.outputTemplate,
						widgetRoute: sourceTool.widgetRoute,
						widgetKey: sourceTool.widgetKey,
						visibility: sourceTool.visibility,
						authRequired: sourceTool.authRequired,
						createdAt: now,
						updatedAt: now,
					});

					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "created",
					});
				}
				continue;
			}

			// Tool exists in both — compare fields
			const schemaChanged = !jsonEqual(
				sourceTool.inputSchema,
				targetTool.inputSchema,
			);
			const outputSchemaChanged = !jsonEqual(
				sourceTool.outputSchema,
				targetTool.outputSchema,
			);
			const descriptionChanged =
				sourceTool.description !== targetTool.description;
			const metadataChanged =
				sourceTool.title !== targetTool.title ||
				!jsonEqual(sourceTool.icons, targetTool.icons) ||
				sourceTool.executionTaskSupport !== targetTool.executionTaskSupport ||
				!jsonEqual(sourceTool.annotations, targetTool.annotations) ||
				(sourceTool.writeCapability ?? null) !==
					(targetTool.writeCapability ?? null) ||
				!jsonEqual(sourceTool.meta, targetTool.meta);
			const provenanceChanged =
				sourceTool.schemaDialect !== targetTool.schemaDialect ||
				sourceTool.schemaSource !== targetTool.schemaSource ||
				sourceTool.schemaSourceRef !== targetTool.schemaSourceRef ||
				sourceTool.schemaSourceHash !== targetTool.schemaSourceHash ||
				sourceTool.schemaSyncedAt !== targetTool.schemaSyncedAt;

			if (
				(schemaChanged || outputSchemaChanged || provenanceChanged) &&
				typesToApply.has("schema_changed")
			) {
				if (dryRun) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "would_update",
						reason: provenanceChanged
							? "Schema provenance differs from source"
							: "Schema differs from source",
					});
				} else {
					await db
						.update(appTools)
						.set({
							inputSchema: sourceTool.inputSchema,
							outputSchema: sourceTool.outputSchema,
							schemaDialect: sourceTool.schemaDialect,
							schemaSource: sourceTool.schemaSource,
							schemaSourceRef: sourceTool.schemaSourceRef,
							schemaSourceHash: sourceTool.schemaSourceHash,
							schemaSyncedAt: sourceTool.schemaSyncedAt,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(appTools.id, targetTool.id));

					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "updated_schema",
					});
				}
			}

			if (descriptionChanged && typesToApply.has("description_changed")) {
				if (dryRun) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "would_update",
						reason: "Description differs from source",
					});
				} else {
					await db
						.update(appTools)
						.set({
							description: sourceTool.description,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(appTools.id, targetTool.id));

					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "updated_description",
					});
				}
			}

			if (metadataChanged && typesToApply.has("metadata_changed")) {
				if (dryRun) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "would_update",
						reason: "MCP metadata differs from source",
					});
				} else {
					await db
						.update(appTools)
						.set({
							title: sourceTool.title,
							icons: sourceTool.icons,
							executionTaskSupport: sourceTool.executionTaskSupport,
							annotations: sourceTool.annotations,
							writeCapability: sourceTool.writeCapability,
							meta: sourceTool.meta,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(appTools.id, targetTool.id));

					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: sourceToolId,
						action: "updated_metadata",
					});
				}
			}

			if (
				!schemaChanged &&
				!outputSchemaChanged &&
				!provenanceChanged &&
				!descriptionChanged &&
				!metadataChanged
			) {
				results.push({
					targetAppId,
					targetAppName: targetApp.name,
					toolName: sourceToolId,
					action: "skipped",
					reason: "Already in sync",
				});
			}
		}

		// Check for tools that exist in target but not in source (removed_tool)
		if (typesToApply.has("removed_tool")) {
			for (const [targetToolId] of targetToolsByToolId) {
				if (!sourceToolsByToolId.has(targetToolId)) {
					results.push({
						targetAppId,
						targetAppName: targetApp.name,
						toolName: targetToolId,
						action: "skipped",
						reason:
							"Tool exists in target but not in source — manual review needed",
					});
				}
			}
		}
	}

	// Build summary
	const prefix = dryRun ? "[DRY RUN] " : "";
	const created = results.filter(
		(r) => r.action === "created" || r.action === "would_create",
	).length;
	const updated = results.filter(
		(r) =>
			r.action === "updated_schema" ||
			r.action === "updated_description" ||
			r.action === "updated_metadata" ||
			r.action === "would_update",
	).length;
	const skippedCount = results.filter((r) => r.action === "skipped").length;

	const parts: string[] = [];
	if (created)
		parts.push(`${created} tool(s) ${dryRun ? "would be " : ""}created`);
	if (updated)
		parts.push(`${updated} tool(s) ${dryRun ? "would be " : ""}updated`);
	if (skippedCount) parts.push(`${skippedCount} skipped`);
	if (parts.length === 0) parts.push("Nothing to propagate");

	return {
		sourceAppId,
		sourceAppName: sourceApp.name,
		dryRun,
		results,
		summary: `${prefix}${parts.join(", ")} across ${appIds.length} target app(s).`,
	};
}
