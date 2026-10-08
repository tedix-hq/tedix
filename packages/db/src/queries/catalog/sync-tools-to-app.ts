/**
 * App Catalog Queries — Sync catalog tools to app.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { ConnectionCredentialProfile } from "@tedix/api-contract/schemas/connection-provider-templates";
import type {
	ToolAnnotations,
	ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import { deriveToolWriteCapability } from "@tedix/api-contract/schemas/tools";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { apps, appTools, skillEntries } from "../../schema/index";
import { batchNonEmpty } from "../../utils/batch";
import { getConnectionProviderByDescopeAppId } from "../connection-providers";
import { getCatalogAppById } from "./get-app";
import { getCatalogMcpTools } from "./mcp-tools";
import {
	CatalogProxyAppToolMutationError,
	type ConnectionScope,
	catalogMcpToolSourceHash,
	catalogMcpToolSourceRef,
	type Database,
	hasAggregateAppOverlay,
	inferCatalogConnectionScope,
	jsonEqual,
	mcpToolOutputSchema,
	normalizeMcpInputSchema,
	normalizeToolAnnotations,
	ownsCatalogMcpTool,
	readAppMcpConfig,
	titleFromToolName,
} from "./tool-source-policy";

// =============================================================================
// SYNC CATALOG TOOLS TO APP (catalog → app tool rows)
// =============================================================================

export interface SyncCatalogToolsToAppOptions {
	catalogAppId: string;
	appId: string;
	mcpServerUrl: string;
	connectionProviderId?: string;
	connectionScope?: ConnectionScope;
	connectionScopes?: string[];
	dryRun: boolean;
	disableRemoved?: boolean;
	/** Internal dry-run support for createBaseAppFromCatalog planning. */
	targetAppOverride?: typeof apps.$inferSelect;
	/** Internal dry-run support for createBaseAppFromCatalog planning. */
	existingToolsOverride?: Array<typeof appTools.$inferSelect>;
}

interface SyncCatalogToolsToAppResultItem {
	toolName: string;
	action:
		| "created"
		| "updated"
		| "disabled"
		| "skipped"
		| "would_create"
		| "would_update"
		| "would_disable";
	reason?: string;
}

export function buildCatalogMcpConnectionAuth(input: {
	connectionProviderId?: string;
	connectionScope: ConnectionScope;
	connectionScopes?: string[];
	credentialProfile?: ConnectionCredentialProfile;
	clientCredentialsTokenUrl?: string | null;
}): ToolConfig["auth"] | undefined {
	if (!input.connectionProviderId) return undefined;

	return {
		type: "connection",
		connectionId: input.connectionProviderId,
		scope: input.connectionScope,
		credentialScope: input.connectionScope,
		...(input.connectionScope === "hybrid"
			? { credentialPreference: "user-first" as const }
			: {}),
		...(input.connectionScopes?.length
			? { scopes: input.connectionScopes }
			: {}),
		...(input.credentialProfile?.authHeader
			? { header: input.credentialProfile.authHeader }
			: {}),
		...(input.credentialProfile?.authTemplate
			? { template: input.credentialProfile.authTemplate }
			: {}),
		...(input.credentialProfile?.authEncoding
			? { encoding: input.credentialProfile.authEncoding }
			: {}),
		...(input.clientCredentialsTokenUrl
			? {
					clientCredentials: {
						tokenUrl: input.clientCredentialsTokenUrl,
					},
				}
			: {}),
	};
}

export async function syncCatalogToolsToApp(
	db: Database,
	options: SyncCatalogToolsToAppOptions,
): Promise<{
	catalogAppId: string;
	catalogAppName: string;
	appId: string;
	appName: string;
	mcpServerUrl: string;
	dryRun: boolean;
	results: SyncCatalogToolsToAppResultItem[];
	summary: string;
}> {
	const {
		catalogAppId,
		appId,
		mcpServerUrl,
		connectionProviderId,
		connectionScope,
		connectionScopes,
		dryRun,
		disableRemoved = true,
		targetAppOverride,
		existingToolsOverride,
	} = options;

	const catalogApp = await getCatalogAppById(db, catalogAppId);
	if (!catalogApp) {
		throw new Error(`Catalog app not found: ${catalogAppId}`);
	}

	if ((targetAppOverride || existingToolsOverride) && !dryRun) {
		throw new Error("Internal sync overrides are only valid for dry runs");
	}

	const targetAppRows = targetAppOverride
		? [targetAppOverride]
		: await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	const targetApp = targetAppRows[0];
	if (!targetApp) {
		throw new Error(`Base/custom app not found: ${appId}`);
	}
	if (hasAggregateAppOverlay(targetApp)) {
		throw new CatalogProxyAppToolMutationError(
			`Refusing to sync catalog tools into proxy app "${targetApp.name}" (${appId}). ` +
				`Proxy apps must keep zero app_tools rows and inherit tools through mcpConfig.aggregateApps. ` +
				`Sync the platform base app or create an explicit custom fork without aggregateApps.`,
		);
	}
	const targetMcpConfig = readAppMcpConfig(targetApp);
	const targetMetadata =
		typeof targetApp.metadata === "object" && targetApp.metadata !== null
			? (targetApp.metadata as Record<string, unknown>)
			: {};
	const targetStoredMcpConfig =
		typeof targetMetadata.mcpConfig === "object" &&
		targetMetadata.mcpConfig !== null
			? (targetMetadata.mcpConfig as Record<string, unknown>)
			: {};
	const effectiveConnectionProviderId =
		connectionProviderId ?? targetMcpConfig.connectionProviderId;
	const effectiveConnectionScope = inferCatalogConnectionScope(
		catalogApp,
		connectionScope,
		targetMcpConfig.connectionScope,
	);
	const effectiveConnectionScopes =
		connectionScopes ?? targetMcpConfig.connectionScopes;
	const connectionProvider = effectiveConnectionProviderId
		? await getConnectionProviderByDescopeAppId(
				db,
				effectiveConnectionProviderId,
			)
		: undefined;

	const catalogTools = await getCatalogMcpTools(db, catalogAppId, {
		includeRemoved: false,
	});
	if (catalogTools.length === 0) {
		return {
			catalogAppId,
			catalogAppName: catalogApp.name,
			appId,
			appName: targetApp.name,
			mcpServerUrl,
			dryRun,
			results: [],
			summary: "No active catalog tools found",
		};
	}

	const existingTools =
		existingToolsOverride ??
		(await db.select().from(appTools).where(eq(appTools.appId, appId)));
	const existingByToolId = new Map(existingTools.map((t) => [t.toolId, t]));

	const catalogToolNames = new Set(catalogTools.map((t) => t.toolName));
	const results: SyncCatalogToolsToAppResultItem[] = [];
	const now = new Date().toISOString();

	const authConfig = buildCatalogMcpConnectionAuth({
		connectionProviderId: effectiveConnectionProviderId,
		connectionScope: effectiveConnectionScope,
		connectionScopes: effectiveConnectionScopes,
		credentialProfile: connectionProvider?.credentialProfile,
		// Catalog apps backed by a client_credentials M2M provider
		// need the raw connection credential exchanged for a bearer at request
		// time. Re-derive this from the catalog row on every sync so a re-sync
		// never silently drops it (previously wiped by the auth-overwrite below).
		clientCredentialsTokenUrl: catalogApp.scanClientCredentialsTokenUrl,
	});

	// Collect all planned mutations, then execute atomically in a transaction
	const plannedInserts: (typeof appTools.$inferInsert)[] = [];
	const plannedUpdates: Array<{
		id: string;
		set: Partial<typeof appTools.$inferInsert>;
	}> = [];
	const plannedDisables: string[] = [];

	for (const ct of catalogTools) {
		const existing = existingByToolId.get(ct.toolName);
		const inputSchema = normalizeMcpInputSchema(ct.inputSchema);
		const title = ct.title ?? titleFromToolName(ct.toolName);
		const icons = ct.icons ?? null;
		const executionTaskSupport = ct.executionTaskSupport ?? null;
		const annotations = normalizeToolAnnotations(ct.annotations);
		// Declarative classification, derived ONCE from the upstream annotations
		// and persisted alongside them. Everything downstream (the Kernel write
		// planner, the apps/mcp destructive gate) reads a column instead of
		// re-inferring capability from the tool NAME. NULL stays NULL: an upstream
		// server that sends no annotations leaves the tool UNDECLARED, which is
		// gated and shows up in the unclassified report.
		const derivedWriteCapability = deriveToolWriteCapability(
			annotations as ToolAnnotations | null,
		);
		const outputSchema = mcpToolOutputSchema(
			ct.outputSchema,
			annotations as ToolAnnotations | null,
		);
		const meta = ct.meta ?? null;
		const schemaSourceRef = catalogMcpToolSourceRef(catalogAppId, ct.toolName);
		const schemaSourceHash = await catalogMcpToolSourceHash({
			toolName: ct.toolName,
			title,
			description: ct.description,
			inputSchema,
			outputSchema,
			icons,
			executionTaskSupport,
			annotations: (annotations as ToolAnnotations | null) ?? null,
			meta,
		});

		const toolConfig = {
			transport: "mcp" as const,
			mcpServerUrl,
			mcpToolName: ct.toolName,
			mcpServerId: catalogAppId,
			...(authConfig ? { auth: authConfig } : {}),
		};

		if (existing && !ownsCatalogMcpTool(existing, catalogAppId)) {
			const reason = `Tool id conflict: "${ct.toolName}" already exists on ${targetApp.name} but is not owned by catalog app ${catalogAppId}`;
			if (dryRun) {
				results.push({
					toolName: ct.toolName,
					action: "skipped",
					reason,
				});
				continue;
			}
			throw new Error(reason);
		}

		if (!existing) {
			if (dryRun) {
				results.push({ toolName: ct.toolName, action: "would_create" });
			} else {
				plannedInserts.push({
					id: crypto.randomUUID(),
					appId,
					toolTypeId: "mcp",
					toolId: ct.toolName,
					title,
					description: ct.description,
					inputSchema: inputSchema,
					outputSchema: outputSchema,
					config: toolConfig,
					icons,
					executionTaskSupport,
					annotations: (annotations as ToolAnnotations | null) ?? null,
					// Insert: no existing row, so nothing to preserve.
					writeCapability: derivedWriteCapability,
					meta,
					schemaDialect: "json-schema-2020-12",
					schemaSource: "mcp",
					schemaSourceRef,
					schemaSourceHash,
					schemaSyncedAt: now,
					enabled: true,
					sortOrder: 0,
					visibility: "public",
					createdAt: now,
					updatedAt: now,
				} as typeof appTools.$inferInsert);
				results.push({ toolName: ct.toolName, action: "created" });
			}
			continue;
		}

		// Existing tool — detect what changed
		const existingConfig =
			(existing.config as Record<string, unknown> | null) ?? {};
		const transportMatch =
			existingConfig.transport === "mcp" &&
			existingConfig.mcpToolName === ct.toolName;
		const urlMatch = existingConfig.mcpServerUrl === mcpServerUrl;
		const schemaChanged = !jsonEqual(existing.inputSchema, inputSchema);
		const outputSchemaChanged = !jsonEqual(existing.outputSchema, outputSchema);
		const descChanged = existing.description !== ct.description;
		const titleChanged = existing.title !== title;
		const iconsChanged = !jsonEqual(existing.icons, icons);
		const executionChanged =
			existing.executionTaskSupport !== executionTaskSupport;
		const annotationsChanged = !jsonEqual(existing.annotations, annotations);
		// Separate from annotationsChanged: rows written before the column
		// existed carry correct annotations and a NULL declaration, and would
		// otherwise never be re-synced into a classified state.
		// An upstream server that sends NO annotations derives `null`, which
		// carries no information — it cannot contradict anything. Overwriting a
		// declaration with it destroyed the ONLY remediation available to the ~52
		// third-party tools whose upstream never sends annotations: an operator
		// declared the capability by hand, and the next routine catalog sync
		// silently erased it, reported as an unremarkable "1 updated". The
		// unclassified report could therefore never shrink for exactly the rows it
		// exists to surface, and at the apps/mcp destructive gate the swing was
		// GATED -> UNGATED, not fail-safe.
		//
		// Upstream still wins whenever it actually speaks, so a tool that changes
		// from read-only to destructive re-derives correctly.
		const writeCapability =
			derivedWriteCapability ?? existing?.writeCapability ?? null;
		const writeCapabilityChanged =
			(existing.writeCapability ?? null) !== (writeCapability ?? null);
		const metaChanged = !jsonEqual(existing.meta, meta);
		const metadataChanged =
			titleChanged ||
			iconsChanged ||
			executionChanged ||
			annotationsChanged ||
			writeCapabilityChanged ||
			metaChanged;
		const provenanceChanged =
			existing.schemaDialect !== "json-schema-2020-12" ||
			existing.schemaSource !== "mcp" ||
			existing.schemaSourceRef !== schemaSourceRef ||
			existing.schemaSourceHash !== schemaSourceHash;

		const typeMatch = existing.toolTypeId === "mcp";
		// Preserve custom fields (timeout, paramMap, staticParams, etc.) while
		// refreshing every catalog-owned transport/auth field. The old equality
		// gate checked URL + tool name but ignored auth, so changing a provider
		// from the default connection header to DataForSEO's Basic template left
		// existing rows permanently stale.
		const refreshedConfig = {
			...existingConfig,
			transport: "mcp" as const,
			mcpServerUrl,
			mcpToolName: ct.toolName,
			mcpServerId: catalogAppId,
			...(authConfig ? { auth: authConfig } : {}),
		};
		// A review covers this exact execution contract. Never carry it forward
		// when a refresh changes behavior, origin, credentials or source identity.
		const reviewInvalidated =
			existingConfig.connectionReadOnly === true &&
			(schemaChanged ||
				outputSchemaChanged ||
				descChanged ||
				executionChanged ||
				annotationsChanged ||
				writeCapabilityChanged ||
				metaChanged ||
				provenanceChanged ||
				!typeMatch ||
				!jsonEqual(existingConfig, refreshedConfig));
		const mergedConfig = {
			...refreshedConfig,
			...(reviewInvalidated ? { connectionReadOnly: false } : {}),
		};
		const configChanged = !jsonEqual(existingConfig, mergedConfig);

		if (
			transportMatch &&
			urlMatch &&
			!configChanged &&
			!schemaChanged &&
			!outputSchemaChanged &&
			!descChanged &&
			!metadataChanged &&
			!provenanceChanged &&
			typeMatch
		) {
			results.push({
				toolName: ct.toolName,
				action: "skipped",
				reason: "Already in sync",
			});
			continue;
		}

		if (dryRun) {
			const reasons = [];
			if (!typeMatch) reasons.push("toolTypeId missing");
			if (!transportMatch) reasons.push("config needs update to mcp transport");
			if (!urlMatch) reasons.push("mcpServerUrl changed");
			if (configChanged) reasons.push("managed config changed");
			if (schemaChanged) reasons.push("schema changed");
			if (outputSchemaChanged) reasons.push("output schema changed");
			if (descChanged) reasons.push("description changed");
			if (titleChanged) reasons.push("title changed");
			if (iconsChanged) reasons.push("icons changed");
			if (executionChanged) reasons.push("execution.taskSupport changed");
			if (annotationsChanged) reasons.push("annotations changed");
			if (writeCapabilityChanged) reasons.push("write capability changed");
			if (metaChanged) reasons.push("_meta changed");
			if (provenanceChanged) reasons.push("schema provenance changed");
			results.push({
				toolName: ct.toolName,
				action: "would_update",
				reason: reasons.join(", "),
			});
		} else {
			plannedUpdates.push({
				id: existing.id,
				set: {
					toolTypeId: "mcp",
					config: mergedConfig,
					inputSchema: inputSchema,
					outputSchema: outputSchema,
					title,
					description: ct.description,
					icons,
					executionTaskSupport,
					annotations: (annotations as ToolAnnotations | null) ?? null,
					writeCapability,
					meta,
					schemaDialect: "json-schema-2020-12",
					schemaSource: "mcp",
					schemaSourceRef,
					schemaSourceHash,
					schemaSyncedAt: now,
					updatedAt: now,
				} as Partial<typeof appTools.$inferInsert>,
			});
			results.push({ toolName: ct.toolName, action: "updated" });
		}
	}

	if (disableRemoved) {
		// Check for app_tools owned by this catalog app that are no longer in the
		// catalog snapshot. Do not disable same-name tools from other upstreams or
		// local/custom app tools.
		for (const existing of existingTools) {
			if (!ownsCatalogMcpTool(existing, catalogAppId)) continue;
			if (catalogToolNames.has(existing.toolId)) continue;

			if (dryRun) {
				results.push({
					toolName: existing.toolId,
					action: "would_disable",
					reason: "Not in catalog (removed upstream)",
				});
			} else {
				plannedDisables.push(existing.id);
				results.push({
					toolName: existing.toolId,
					action: "disabled",
					reason: "Not in catalog (removed upstream)",
				});
			}
		}
	}

	const mutationStatements: BatchItem<"sqlite">[] = [];

	// Materialized base/custom apps execute through app_tools rows. Keep the
	// upstream endpoint on tool config only so preview/scope code does not treat
	// the app shell as an unresolved upstream proxy.
	if (typeof targetStoredMcpConfig.upstreamMcpUrl === "string" && !dryRun) {
		const materializedMcpConfig = { ...targetStoredMcpConfig };
		delete materializedMcpConfig.upstreamMcpUrl;
		mutationStatements.push(
			db
				.update(apps)
				.set({
					metadata: {
						...targetMetadata,
						mcpConfig: materializedMcpConfig,
					},
					updatedAt: now,
				})
				.where(eq(apps.id, appId)),
		);
	}

	if (!dryRun) {
		for (const values of plannedInserts) {
			mutationStatements.push(db.insert(appTools).values(values));
		}
		for (const { id, set } of plannedUpdates) {
			mutationStatements.push(
				db.update(appTools).set(set).where(eq(appTools.id, id)),
			);
		}
		for (const id of plannedDisables) {
			mutationStatements.push(
				db
					.update(appTools)
					.set({ enabled: false, updatedAt: now })
					.where(eq(appTools.id, id)),
			);
		}
	}

	// Official MCP servers can expose dozens or hundreds of tools. Sequential
	// writes consume one Worker subrequest per tool and previously left the
	// DataForSEO base app with 2 of 89 rows when the request deadline fired.
	// D1 batch is the supported transaction primitive and makes the app-shell
	// materialization plus all tool mutations one database round trip.
	if (mutationStatements.length > 0) {
		await db.batch(batchNonEmpty(mutationStatements));
	}

	// Repair orphaned skill→tool references: when tools are recreated with new UUIDs,
	// skills scoped to this app may still reference the old UUIDs.
	if (!dryRun) {
		const currentTools = await db
			.select()
			.from(appTools)
			.where(eq(appTools.appId, appId));
		const currentUUIDs = new Set(currentTools.map((t) => t.id));
		const toolIdToUUID = new Map(currentTools.map((t) => [t.toolId, t.id]));

		const appSkills = await db
			.select()
			.from(skillEntries)
			.where(eq(skillEntries.appId, appId));

		const oldUUIDToToolId = new Map(existingTools.map((t) => [t.id, t.toolId]));

		const skillRepairStatements: BatchItem<"sqlite">[] = [];
		for (const skill of appSkills) {
			const refs = skill.toolIds;
			if (!refs || refs.length === 0) continue;
			const hasOrphan = refs.some((uuid) => !currentUUIDs.has(uuid));
			if (!hasOrphan) continue;

			const repaired = refs.map((uuid) => {
				if (currentUUIDs.has(uuid)) return uuid;
				const logicalId = oldUUIDToToolId.get(uuid);
				if (logicalId && toolIdToUUID.has(logicalId))
					return toolIdToUUID.get(logicalId)!;
				return uuid;
			});
			if (JSON.stringify(repaired) !== JSON.stringify(refs)) {
				skillRepairStatements.push(
					db
						.update(skillEntries)
						.set({
							toolIds: repaired,
							updatedAt: now,
						})
						.where(eq(skillEntries.id, skill.id)),
				);
			}
		}
		if (skillRepairStatements.length > 0) {
			await db.batch(batchNonEmpty(skillRepairStatements));
		}
	}

	const created = results.filter(
		(r) => r.action === "created" || r.action === "would_create",
	).length;
	const updated = results.filter(
		(r) => r.action === "updated" || r.action === "would_update",
	).length;
	const disabled = results.filter(
		(r) => r.action === "disabled" || r.action === "would_disable",
	).length;
	const skipped = results.filter((r) => r.action === "skipped").length;
	const prefix = dryRun ? "[DRY RUN] " : "";
	const summary = `${prefix}${created} created, ${updated} updated, ${disabled} disabled, ${skipped} skipped (${catalogTools.length} catalog tools)`;

	return {
		catalogAppId,
		catalogAppName: catalogApp.name,
		appId,
		appName: targetApp.name,
		mcpServerUrl,
		dryRun,
		results,
		summary,
	};
}
