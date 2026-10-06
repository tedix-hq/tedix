/**
 * App Catalog Queries — Upstream drift detection.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
	appCatalog,
	appCatalogMcpTools,
	upstreamDriftReports,
} from "../../schema/catalog";
import { getCatalogAppById } from "./get-app";
import {
	getCatalogMcpTools,
	projectCatalogToolsFromBaseApp,
} from "./mcp-tools";
import {
	catalogMcpToolSourceHash,
	catalogMcpToolSourceRef,
	type Database,
	jsonEqual,
	mcpToolOutputSchema,
	normalizeExecutionTaskSupport,
	normalizeMcpInputSchema,
	normalizeToolAnnotations,
	normalizeToolIcons,
	normalizeToolMeta,
	normalizeToolTitle,
	shouldProjectCatalogToolsFromBaseApp,
	type ToolDriftReportItem,
	type ToolMetadataSnapshot,
} from "./tool-source-policy";

// =============================================================================
// UPSTREAM DRIFT DETECTION
// =============================================================================

/**
 * Check upstream drift for a catalog app by connecting live to its MCP endpoint.
 *
 * Steps:
 * 1. Fetch the catalog app and its MCP endpoint
 * 2. Fetch current app_catalog_mcp_tools snapshot for this catalog app
 * 3. Connect live to the upstream MCP server and call tools/list
 * 4. Compare live tools vs snapshot (new, removed, schema, description, metadata)
 * 5. Update app_catalog_mcp_tools snapshot in-place
 * 6. Return drift summary
 *
 * Graceful failure: if upstream returns 401/auth error → healthStatus "requires_auth", skip.
 * If connection fails entirely → log and skip.
 *
 * Boundary exception: packages/db owns this single outbound tools/list probe as
 * a documented exception to the schema/queries-only rule (the fetch is
 * interleaved with the snapshot reads/upserts around it). Relocate it to the
 * apps/api caller if a second network call site appears in packages/db, or if
 * negotiated/SSE upstreams are needed — the bare response.json() here cannot
 * parse SSE-only or modern-only upstreams, so those log "connection failed"
 * and under-report drift.
 */
export async function checkUpstreamDrift(
	db: Database,
	catalogAppId: string,
): Promise<{
	addedTools: number;
	removedTools: number;
	changedTools: number;
	drifts: ToolDriftReportItem[];
}> {
	const empty = { addedTools: 0, removedTools: 0, changedTools: 0, drifts: [] };

	// 1. Fetch the catalog app
	const catalogApp = await getCatalogAppById(db, catalogAppId);
	if (!catalogApp) {
		console.warn(`[checkUpstreamDrift] Catalog app not found: ${catalogAppId}`);
		return empty;
	}

	if (shouldProjectCatalogToolsFromBaseApp(catalogApp)) {
		const projection = await projectCatalogToolsFromBaseApp(db, catalogAppId);
		console.log(`[checkUpstreamDrift] ${projection.summary}`);
		return empty;
	}

	const upstreamUrl = catalogApp.mcpEndpointNormalized || catalogApp.baseUrl;
	if (!upstreamUrl) {
		console.warn(
			`[checkUpstreamDrift] No MCP endpoint for catalog app: ${catalogAppId}`,
		);
		return empty;
	}

	// 2. Fetch current snapshot from app_catalog_mcp_tools
	const snapshot = await getCatalogMcpTools(db, catalogAppId, {
		includeRemoved: true,
	});
	const snapshotByName = new Map(snapshot.map((t) => [t.toolName, t]));

	// 3. Connect live to upstream MCP server
	let liveTools: Array<{
		name: string;
		title?: string;
		description?: string;
		inputSchema?: unknown;
		outputSchema?: unknown;
		icons?: unknown;
		execution?: unknown;
		annotations?: unknown;
		_meta?: unknown;
	}>;
	try {
		const response = await fetch(upstreamUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			}),
		});

		if (response.status === 401 || response.status === 403) {
			// Auth-required server — update healthStatus and skip
			await db
				.update(appCatalog)
				.set({
					healthStatus: "requires_auth",
					mcpMetadata: sql`json_set(
						COALESCE(${appCatalog.mcpMetadata}, '{}'),
						'$.lastScannedAt', ${new Date().toISOString()}
					)`,
				})
				.where(eq(appCatalog.id, catalogAppId));
			console.log(
				`[checkUpstreamDrift] ${catalogApp.name}: requires auth, skipping`,
			);
			return empty;
		}

		if (!response.ok) {
			console.warn(
				`[checkUpstreamDrift] ${catalogApp.name}: upstream returned ${response.status}, skipping`,
			);
			return empty;
		}

		const json = (await response.json()) as {
			result?: { tools?: unknown[] };
			error?: unknown;
		};
		if (json.error) {
			console.warn(
				`[checkUpstreamDrift] ${catalogApp.name}: MCP error response, skipping`,
			);
			return empty;
		}

		liveTools = (json.result?.tools ?? []) as typeof liveTools;
	} catch (err) {
		console.warn(
			`[checkUpstreamDrift] ${catalogApp.name}: connection failed:`,
			err,
		);
		return empty;
	}

	const liveToolsByName = new Map(liveTools.map((t) => [t.name, t]));
	const now = new Date().toISOString();

	const drifts: ToolDriftReportItem[] = [];
	let addedTools = 0;
	let removedTools = 0;
	let changedTools = 0;

	// 4a. Compare live tools against snapshot
	for (const liveTool of liveTools) {
		const snap = snapshotByName.get(liveTool.name);
		const inputSchema = normalizeMcpInputSchema(liveTool.inputSchema);
		const annotations = normalizeToolAnnotations(liveTool.annotations);
		const outputSchema = mcpToolOutputSchema(
			liveTool.outputSchema,
			annotations,
		);
		const title = normalizeToolTitle(liveTool.title);
		const icons = normalizeToolIcons(liveTool.icons);
		const executionTaskSupport = normalizeExecutionTaskSupport(
			liveTool.execution,
		);
		const meta = normalizeToolMeta(liveTool._meta);
		const upstreamMetadata: ToolMetadataSnapshot = {
			title,
			icons,
			executionTaskSupport,
			annotations,
			meta,
		};
		const schemaDialect = "json-schema-2020-12" as const;
		const schemaSource = "mcp" as const;
		const schemaSourceRef = catalogMcpToolSourceRef(
			catalogAppId,
			liveTool.name,
		);
		const schemaSourceHash = await catalogMcpToolSourceHash({
			toolName: liveTool.name,
			title,
			description: liveTool.description ?? null,
			inputSchema,
			outputSchema,
			icons,
			executionTaskSupport,
			annotations,
			meta,
		});

		if (!snap) {
			// new_upstream: tool exists live but not in snapshot
			drifts.push({
				toolName: liveTool.name,
				driftType: "new_upstream",
				upstreamSchema: inputSchema,
				upstreamOutputSchema: outputSchema,
				upstreamDescription: liveTool.description,
				upstreamMetadata,
			});
			addedTools++;

			// Upsert new row into snapshot
			await db
				.insert(appCatalogMcpTools)
				.values({
					id: crypto.randomUUID(),
					catalogAppId,
					toolName: liveTool.name,
					title,
					description: liveTool.description ?? null,
					inputSchema,
					outputSchema,
					icons,
					executionTaskSupport,
					annotations,
					meta,
					schemaDialect,
					schemaSource,
					schemaSourceRef,
					schemaSourceHash,
					schemaSyncedAt: now,
					detectedAt: now,
					lastSeenAt: now,
				})
				.onConflictDoUpdate({
					target: [
						appCatalogMcpTools.catalogAppId,
						appCatalogMcpTools.toolName,
					],
					set: {
						title,
						description: liveTool.description ?? null,
						inputSchema,
						outputSchema,
						icons,
						executionTaskSupport,
						annotations,
						meta,
						schemaDialect,
						schemaSource,
						schemaSourceRef,
						schemaSourceHash,
						schemaSyncedAt: now,
						lastSeenAt: now,
						removedAt: null,
					},
				});
			continue;
		}

		// Tool exists in snapshot — check for drift
		let toolChanged = false;

		if (snap.removedAt) {
			// Was marked removed, now back — treat as new_upstream
			drifts.push({
				toolName: liveTool.name,
				driftType: "new_upstream",
				catalogToolId: snap.id,
				upstreamSchema: inputSchema,
				upstreamOutputSchema: outputSchema,
				upstreamDescription: liveTool.description,
				upstreamMetadata,
			});
			addedTools++;
			toolChanged = true;
		} else {
			// Check schema drift
			if (
				!jsonEqual(inputSchema, snap.inputSchema) ||
				!jsonEqual(outputSchema, snap.outputSchema)
			) {
				drifts.push({
					toolName: liveTool.name,
					driftType: "schema_changed",
					catalogToolId: snap.id,
					currentSchema: (snap.inputSchema ?? undefined) as
						| Record<string, JsonValue>
						| undefined,
					upstreamSchema: inputSchema,
					currentOutputSchema: (snap.outputSchema ?? null) as Record<
						string,
						JsonValue
					> | null,
					upstreamOutputSchema: outputSchema,
				});
				changedTools++;
				toolChanged = true;
			}

			// Check description drift
			if (
				liveTool.description !== undefined &&
				liveTool.description !== snap.description
			) {
				drifts.push({
					toolName: liveTool.name,
					driftType: "description_changed",
					catalogToolId: snap.id,
					currentDescription: snap.description ?? undefined,
					upstreamDescription: liveTool.description,
				});
				if (!toolChanged) changedTools++;
				toolChanged = true;
			}

			const currentMetadata: ToolMetadataSnapshot = {
				title: snap.title ?? null,
				icons: snap.icons ?? null,
				executionTaskSupport: snap.executionTaskSupport ?? null,
				annotations: snap.annotations ?? null,
				meta: snap.meta ?? null,
			};
			if (!jsonEqual(upstreamMetadata, currentMetadata)) {
				drifts.push({
					toolName: liveTool.name,
					driftType: "metadata_changed",
					catalogToolId: snap.id,
					currentMetadata,
					upstreamMetadata,
				});
				if (!toolChanged) changedTools++;
				toolChanged = true;
			}
		}

		// Update snapshot row
		await db
			.insert(appCatalogMcpTools)
			.values({
				id: snap.id,
				catalogAppId,
				toolName: liveTool.name,
				title,
				description: liveTool.description ?? snap.description ?? null,
				inputSchema,
				outputSchema,
				icons,
				executionTaskSupport,
				annotations,
				meta,
				schemaDialect,
				schemaSource,
				schemaSourceRef,
				schemaSourceHash,
				schemaSyncedAt: now,
				detectedAt: snap.detectedAt,
				lastSeenAt: now,
			})
			.onConflictDoUpdate({
				target: [appCatalogMcpTools.catalogAppId, appCatalogMcpTools.toolName],
				set: {
					title,
					description: liveTool.description ?? snap.description ?? null,
					inputSchema,
					outputSchema,
					icons,
					executionTaskSupport,
					annotations,
					meta,
					schemaDialect,
					schemaSource,
					schemaSourceRef,
					schemaSourceHash,
					schemaSyncedAt: now,
					lastSeenAt: now,
					removedAt: null,
				},
			});
	}

	// 4b. Find tools in snapshot not in live response (removed_upstream)
	for (const snap of snapshot) {
		if (snap.removedAt) continue; // already marked removed
		if (!liveToolsByName.has(snap.toolName)) {
			drifts.push({
				toolName: snap.toolName,
				driftType: "removed_upstream",
				catalogToolId: snap.id,
				currentDescription: snap.description ?? undefined,
				currentSchema: (snap.inputSchema ?? undefined) as
					| Record<string, JsonValue>
					| undefined,
				currentOutputSchema: (snap.outputSchema ?? null) as Record<
					string,
					JsonValue
				> | null,
				currentMetadata: {
					title: snap.title ?? null,
					icons: snap.icons ?? null,
					executionTaskSupport: snap.executionTaskSupport ?? null,
					annotations: snap.annotations ?? null,
					meta: snap.meta ?? null,
				},
			});
			removedTools++;

			// Mark as removed in snapshot
			await db
				.update(appCatalogMcpTools)
				.set({ removedAt: now })
				.where(eq(appCatalogMcpTools.id, snap.id));
		}
	}

	// Update catalog app lastScannedAt
	await db
		.update(appCatalog)
		.set({
			mcpMetadata: sql`json_set(
				COALESCE(${appCatalog.mcpMetadata}, '{}'),
				'$.lastScannedAt', ${now}
			)`,
		})
		.where(eq(appCatalog.id, catalogAppId));

	if (drifts.length === 0) {
		await db
			.update(upstreamDriftReports)
			.set({ resolvedAt: now })
			.where(
				and(
					eq(upstreamDriftReports.catalogAppId, catalogAppId),
					isNull(upstreamDriftReports.resolvedAt),
				),
			);
	}

	return { addedTools, removedTools, changedTools, drifts };
}
