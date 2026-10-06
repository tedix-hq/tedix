/**
 * App Catalog Queries — MCP tools operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ToolSchemaSource } from "@tedix/api-contract/schemas/tools";
import type { BatchItem } from "drizzle-orm/batch";
import {
	and,
	asc,
	count,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	type CatalogMcpTool,
	type CatalogToolSource,
	type ConnectorType,
	type HealthStatus,
	upstreamDriftReports,
} from "../../schema/catalog";
import { apps, appTools } from "../../schema/index";
import { batchNonEmpty, chunkForBoundParams } from "../../utils/batch";
import { prefixedColumns } from "../../utils/select";
import {
	extractVendorDomain,
	normalizeVendorName,
} from "./endpoint-normalization";
import { getCatalogAppById } from "./get-app";
import {
	type CatalogMcpToolSyncInput,
	catalogMcpToolSourceHash,
	catalogMcpToolSourceRef,
	type Database,
	inferExternalToolAnnotations,
	inferExternalToolOutputSchema,
	isTedixCatalogToolSource,
	jsonEqual,
	mcpToolOutputSchema,
	normalizeExecutionTaskSupport,
	normalizeMcpInputSchema,
	normalizeMcpOutputSchema,
	normalizeToolAnnotations,
	normalizeToolIcons,
	normalizeToolMeta,
	type ToolDriftReportItem,
	type ToolMetadataSnapshot,
} from "./tool-source-policy";

// =============================================================================
// MCP TOOLS OPERATIONS
// =============================================================================

/**
 * Get MCP tools for a catalog app
 */
export async function getCatalogMcpTools(
	db: Database,
	catalogAppId: string,
	options: { includeRemoved?: boolean } = {},
): Promise<CatalogMcpTool[]> {
	const { includeRemoved = false } = options;

	const conditions = [eq(appCatalogMcpTools.catalogAppId, catalogAppId)];

	if (!includeRemoved) {
		conditions.push(isNull(appCatalogMcpTools.removedAt));
	}

	return db
		.select()
		.from(appCatalogMcpTools)
		.where(and(...conditions))
		.orderBy(appCatalogMcpTools.toolName);
}

/**
 * Sync MCP tools for a catalog app (from health check results)
 * - Upserts tools that exist
 * - Marks tools as removed if not in current set
 */
export async function syncCatalogMcpTools(
	db: Database,
	catalogAppId: string,
	tools: CatalogMcpToolSyncInput[],
	options: { mode?: "full" | "partial" } = {},
): Promise<{
	added: number;
	updated: number;
	removed: number;
	drifts: ToolDriftReportItem[];
}> {
	const now = new Date().toISOString();
	const mode = options.mode ?? "full";
	let added = 0;
	let updated = 0;
	let removed = 0;
	const drifts: ToolDriftReportItem[] = [];
	const writes: BatchItem<"sqlite">[] = [];

	// Get existing tools
	const existingTools = await getCatalogMcpTools(db, catalogAppId, {
		includeRemoved: false,
	});
	const existingToolNames = new Set(existingTools.map((t) => t.toolName));
	const existingToolsByName = new Map(
		existingTools.map((t) => [t.toolName, t]),
	);
	const incomingToolNames = new Set(tools.map((t) => t.name));

	// Upsert incoming tools
	for (const tool of tools) {
		const isNew = !existingToolNames.has(tool.name);
		const existingTool = existingToolsByName.get(tool.name);
		const inputSchema =
			mode === "partial" && existingTool
				? existingTool.inputSchema
				: normalizeMcpInputSchema(tool.inputSchema);
		const outputSchema =
			mode === "partial" && existingTool
				? existingTool.outputSchema
				: normalizeMcpOutputSchema(tool.outputSchema);
		const title =
			tool.title ?? (mode === "partial" ? existingTool?.title : null) ?? null;
		const description =
			tool.description ??
			(mode === "partial" ? existingTool?.description : null) ??
			null;
		const icons =
			mode === "partial" ? (existingTool?.icons ?? null) : (tool.icons ?? null);
		const executionTaskSupport =
			mode === "partial"
				? (existingTool?.executionTaskSupport ?? null)
				: (tool.execution?.taskSupport ?? null);
		const annotations =
			mode === "partial"
				? (existingTool?.annotations ?? null)
				: (tool.annotations ?? null);
		const meta =
			mode === "partial"
				? (existingTool?.meta ?? null)
				: normalizeToolMeta(tool._meta);
		const schemaDialect =
			tool.schemaDialect ??
			(mode === "partial" ? existingTool?.schemaDialect : null) ??
			"json-schema-2020-12";
		const schemaSource =
			tool.schemaSource ??
			(mode === "partial" ? existingTool?.schemaSource : null) ??
			"mcp";
		const schemaSourceRef =
			tool.schemaSourceRef ??
			(mode === "partial" ? existingTool?.schemaSourceRef : null) ??
			catalogMcpToolSourceRef(catalogAppId, tool.name);
		const schemaSourceHash =
			tool.schemaSourceHash ??
			(mode === "partial" ? existingTool?.schemaSourceHash : null) ??
			(await catalogMcpToolSourceHash({
				toolName: tool.name,
				title,
				description,
				inputSchema,
				outputSchema,
				icons,
				executionTaskSupport,
				annotations,
				meta,
			}));
		const schemaSyncedAt =
			tool.schemaSyncedAt ??
			(mode === "partial" ? existingTool?.schemaSyncedAt : null) ??
			now;
		const upstreamMetadata: ToolMetadataSnapshot = {
			title,
			icons,
			executionTaskSupport,
			annotations,
			meta,
		};
		const provenanceChanged = existingTool
			? existingTool.schemaDialect !== schemaDialect ||
				existingTool.schemaSource !== schemaSource ||
				existingTool.schemaSourceRef !== schemaSourceRef ||
				existingTool.schemaSourceHash !== schemaSourceHash
			: false;
		const changed = existingTool
			? !jsonEqual(existingTool.inputSchema, inputSchema) ||
				!jsonEqual(existingTool.outputSchema, outputSchema) ||
				existingTool.description !== description ||
				existingTool.title !== title ||
				!jsonEqual(existingTool.icons, icons) ||
				existingTool.executionTaskSupport !== executionTaskSupport ||
				!jsonEqual(existingTool.annotations, annotations) ||
				!jsonEqual(existingTool.meta, meta) ||
				provenanceChanged
			: false;

		if (isNew) {
			drifts.push({
				toolName: tool.name,
				driftType: "new_upstream",
				upstreamSchema: inputSchema,
				upstreamOutputSchema: outputSchema,
				upstreamDescription: description ?? undefined,
				upstreamMetadata,
			});
		} else if (changed && existingTool) {
			if (
				!jsonEqual(existingTool.inputSchema, inputSchema) ||
				!jsonEqual(existingTool.outputSchema, outputSchema)
			) {
				drifts.push({
					toolName: tool.name,
					driftType: "schema_changed",
					catalogToolId: existingTool.id,
					currentSchema: existingTool.inputSchema as Record<string, JsonValue>,
					upstreamSchema: inputSchema,
					currentOutputSchema: existingTool.outputSchema as Record<
						string,
						JsonValue
					> | null,
					upstreamOutputSchema: outputSchema,
				});
			}
			if (existingTool.description !== description) {
				drifts.push({
					toolName: tool.name,
					driftType: "description_changed",
					catalogToolId: existingTool.id,
					currentDescription: existingTool.description ?? undefined,
					upstreamDescription: description ?? undefined,
				});
			}
			const currentMetadata: ToolMetadataSnapshot = {
				title: existingTool.title ?? null,
				icons: existingTool.icons ?? null,
				executionTaskSupport: existingTool.executionTaskSupport ?? null,
				annotations: existingTool.annotations ?? null,
				meta: existingTool.meta ?? null,
			};
			if (!jsonEqual(currentMetadata, upstreamMetadata) || provenanceChanged) {
				drifts.push({
					toolName: tool.name,
					driftType: "metadata_changed",
					catalogToolId: existingTool.id,
					currentMetadata,
					upstreamMetadata,
				});
			}
		}

		writes.push(
			db
				.insert(appCatalogMcpTools)
				.values({
					id: crypto.randomUUID(),
					catalogAppId,
					toolName: tool.name,
					title,
					description,
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
					schemaSyncedAt,
					detectedAt: now,
					lastSeenAt: now,
					removedAt: null, // Clear removed flag if re-added
				})
				.onConflictDoUpdate({
					target: [
						appCatalogMcpTools.catalogAppId,
						appCatalogMcpTools.toolName,
					],
					set: {
						title,
						description,
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
						schemaSyncedAt,
						lastSeenAt: now,
						removedAt: null, // Clear removed flag
					},
				}),
		);

		if (isNew) {
			added++;
		} else if (changed) {
			updated++;
		}
	}

	if (mode === "full") {
		// Mark tools as removed if not in incoming set. Partial store hints are not
		// authoritative enough to remove scanner-provided MCP snapshots.
		for (const existingTool of existingTools) {
			if (!incomingToolNames.has(existingTool.toolName)) {
				drifts.push({
					toolName: existingTool.toolName,
					driftType: "removed_upstream",
					catalogToolId: existingTool.id,
					currentDescription: existingTool.description ?? undefined,
					currentSchema: existingTool.inputSchema as Record<string, JsonValue>,
					currentOutputSchema: existingTool.outputSchema as Record<
						string,
						JsonValue
					> | null,
					currentMetadata: {
						title: existingTool.title ?? null,
						icons: existingTool.icons ?? null,
						executionTaskSupport: existingTool.executionTaskSupport ?? null,
						annotations: existingTool.annotations ?? null,
						meta: existingTool.meta ?? null,
					},
				});
				writes.push(
					db
						.update(appCatalogMcpTools)
						.set({ removedAt: now })
						.where(eq(appCatalogMcpTools.id, existingTool.id)),
				);
				removed++;
			}
		}
	}

	// A large official MCP surface can expose dozens or hundreds of tools. Each
	// sequential D1 write consumes an invocation subrequest, so the old loop
	// failed partway through DataForSEO's inventory. D1 batch is the supported
	// transaction primitive and collapses the entire reconciliation to one
	// database round trip.
	if (writes.length > 0) {
		await db.batch(batchNonEmpty(writes));
	}

	// Derive labels from the active snapshot, including rows retained by a
	// partial sync. Missing readOnlyHint means potentially mutating in MCP.
	const [inventory] = await db
		.select({
			toolCount: count(),
			writeCount: sql<number>`coalesce(sum(case when json_extract(${appCatalogMcpTools.annotations}, '$.readOnlyHint') = 1 then 0 else 1 end), 0)`,
		})
		.from(appCatalogMcpTools)
		.where(
			and(
				eq(appCatalogMcpTools.catalogAppId, catalogAppId),
				isNull(appCatalogMcpTools.removedAt),
			),
		);
	await db
		.update(appCatalog)
		.set({
			mcpToolCount: inventory?.toolCount ?? 0,
			hasWrites: (inventory?.writeCount ?? 0) > 0,
		})
		.where(eq(appCatalog.id, catalogAppId));

	return { added, updated, removed, drifts };
}

export interface ProjectCatalogToolsFromBaseAppResult {
	catalogAppId: string;
	catalogAppName: string;
	sourceAppId: string;
	sourceAppSlug: string;
	toolSource: CatalogToolSource;
	activeTools: number;
	added: number;
	updated: number;
	removed: number;
	summary: string;
}

export interface BackfillCatalogToolProvenanceOptions {
	catalogAppId?: string;
	limit?: number;
	dryRun?: boolean;
}

export interface BackfillCatalogToolProvenanceItem {
	catalogAppId: string;
	catalogAppName: string;
	toolName: string;
	schemaSource: ToolSchemaSource;
	schemaSourceRef: string;
	schemaSourceHash: string;
	sourceCopiedFromAppTool: boolean;
	action: "would_update" | "updated";
}

export interface BackfillCatalogToolProvenanceResult {
	dryRun: boolean;
	catalogAppId: string | null;
	totalMissing: number;
	planned: number;
	updated: number;
	remaining: number;
	items: BackfillCatalogToolProvenanceItem[];
	summary: string;
}

export interface CheckCatalogIntegrityOptions {
	catalogAppId?: string;
	limit?: number;
	apply?: boolean;
}

export type CatalogIntegrityIssueSeverity = "error" | "warning";

export type CatalogIntegrityIssueCode =
	| "missing_base_app"
	| "missing_mcp_endpoint"
	| "empty_tool_snapshot"
	| "tool_count_mismatch"
	| "missing_schema_provenance"
	| "missing_output_schema"
	| "missing_annotations"
	| "unresolved_drift"
	| "brokered_service_connector";

export interface CatalogIntegrityIssue {
	catalogAppId: string;
	catalogAppName: string;
	catalogAppSlug: string | null;
	toolSource: CatalogToolSource;
	code: CatalogIntegrityIssueCode;
	severity: CatalogIntegrityIssueSeverity;
	count: number;
	summary: string;
	repairAction:
		| "backfill_provenance"
		| "update_tool_count"
		| "reconcile_app"
		| "none";
}

export interface CheckCatalogIntegrityResult {
	apply: boolean;
	catalogAppId: string | null;
	checkedApps: number;
	issueCount: number;
	errorCount: number;
	warningCount: number;
	repaired: {
		provenanceRows: number;
		toolCounts: number;
	};
	issues: CatalogIntegrityIssue[];
	summary: string;
}

interface CatalogIntegritySnapshot {
	apps: Array<{
		id: string;
		slug: string | null;
		name: string;
		toolSource: CatalogToolSource;
		healthStatus: HealthStatus | null;
		connectorType: ConnectorType;
		mcpToolCount: number | null;
		baseUrl: string | null;
		mcpEndpointNormalized: string | null;
		website: string | null;
	}>;
	statsByCatalogId: Map<
		string,
		{
			activeTools: number;
			missingProvenance: number;
			missingOutputSchema: number;
			missingAnnotations: number;
		}
	>;
	baseAppCountByCatalogId: Map<string, number>;
	unresolvedDriftCountByCatalogId: Map<string, number>;
	/**
	 * Vendor identity keys (`domain|normalizedName`) that already have a runnable
	 * (endpoint-backed) canonical catalog row. Used to tell a brokered connector
	 * that can be merged onto an existing official row (same vendor AND name)
	 * apart from one that merely shares a domain (e.g. BigQuery vs Gmail, both
	 * `google.com`) or has no runnable counterpart at all.
	 */
	canonicalVendorKeys: Set<string>;
}

function fallbackCatalogSchemaSource(
	toolSource: CatalogToolSource,
): ToolSchemaSource {
	if (toolSource === "openapi" || toolSource === "google-discovery") {
		return toolSource;
	}
	return "mcp";
}

function isKnownUnavailableUpstreamSnapshot(
	toolSource: CatalogToolSource,
	healthStatus: HealthStatus | null,
): boolean {
	return (
		toolSource === "upstream_mcp" &&
		(healthStatus === "requires_auth" ||
			healthStatus === "blocked" ||
			healthStatus === "unsupported" ||
			healthStatus === "unhealthy")
	);
}

type CatalogToolSourcePolicy = {
	requiresBaseApp: boolean;
	requiresMcpEndpoint: boolean;
	emptySnapshotIsIntegrityIssue: boolean;
	generatedSnapshotRequiresMetadata: boolean;
};

export function catalogToolSourcePolicy(app: {
	toolSource: CatalogToolSource;
	healthStatus: HealthStatus | null;
	connectorType: ConnectorType;
	mcpToolCount: number | null;
}): CatalogToolSourcePolicy {
	const generated = isTedixCatalogToolSource(app.toolSource);
	const listingOnly =
		app.connectorType === "FIRST_PARTY_ECOSYSTEM" ||
		(app.connectorType !== "MCP" && (app.mcpToolCount ?? 0) === 0);
	return {
		requiresBaseApp: generated && !listingOnly,
		requiresMcpEndpoint: app.toolSource === "upstream_mcp" && !listingOnly,
		emptySnapshotIsIntegrityIssue:
			!listingOnly &&
			(generated ||
				!isKnownUnavailableUpstreamSnapshot(app.toolSource, app.healthStatus)),
		generatedSnapshotRequiresMetadata: generated && !listingOnly,
	};
}

function toNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}

function buildCatalogIntegrityIssues(
	snapshot: CatalogIntegritySnapshot,
): CatalogIntegrityIssue[] {
	const issues: CatalogIntegrityIssue[] = [];

	for (const app of snapshot.apps) {
		const stats = snapshot.statsByCatalogId.get(app.id) ?? {
			activeTools: 0,
			missingProvenance: 0,
			missingOutputSchema: 0,
			missingAnnotations: 0,
		};
		const baseAppCount = snapshot.baseAppCountByCatalogId.get(app.id) ?? 0;
		const unresolvedDriftCount =
			snapshot.unresolvedDriftCountByCatalogId.get(app.id) ?? 0;
		const expectedToolCount = app.mcpToolCount ?? 0;
		const label = app.slug ?? app.name;
		const policy = catalogToolSourcePolicy(app);

		if (policy.requiresBaseApp && baseAppCount === 0) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "missing_base_app",
				severity: "error",
				count: 1,
				summary: `${label} is ${app.toolSource} but has no linked platform base app.`,
				repairAction: "reconcile_app",
			});
		}

		if (
			policy.requiresMcpEndpoint &&
			!app.mcpEndpointNormalized &&
			!app.baseUrl
		) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "missing_mcp_endpoint",
				severity: "error",
				count: 1,
				summary: `${label} is upstream_mcp but has no MCP endpoint.`,
				repairAction: "none",
			});
		}

		if (stats.activeTools === 0 && policy.emptySnapshotIsIntegrityIssue) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "empty_tool_snapshot",
				severity: "warning",
				count: 1,
				summary: `${label} has no active catalog tool snapshot rows.`,
				repairAction: "reconcile_app",
			});
		}

		if (expectedToolCount !== stats.activeTools) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "tool_count_mismatch",
				severity: "warning",
				count: Math.abs(expectedToolCount - stats.activeTools),
				summary: `${label} stores mcpToolCount=${expectedToolCount}, but ${stats.activeTools} active snapshot rows exist.`,
				repairAction: "update_tool_count",
			});
		}

		if (stats.missingProvenance > 0) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "missing_schema_provenance",
				severity: "error",
				count: stats.missingProvenance,
				summary: `${label} has ${stats.missingProvenance} active tool snapshots missing schema provenance.`,
				repairAction: "backfill_provenance",
			});
		}

		if (policy.generatedSnapshotRequiresMetadata) {
			if (stats.missingOutputSchema > 0) {
				issues.push({
					catalogAppId: app.id,
					catalogAppName: app.name,
					catalogAppSlug: app.slug,
					toolSource: app.toolSource,
					code: "missing_output_schema",
					severity: "warning",
					count: stats.missingOutputSchema,
					summary: `${label} has ${stats.missingOutputSchema} generated tool snapshots without outputSchema.`,
					repairAction: "reconcile_app",
				});
			}

			if (stats.missingAnnotations > 0) {
				issues.push({
					catalogAppId: app.id,
					catalogAppName: app.name,
					catalogAppSlug: app.slug,
					toolSource: app.toolSource,
					code: "missing_annotations",
					severity: "warning",
					count: stats.missingAnnotations,
					summary: `${label} has ${stats.missingAnnotations} generated tool snapshots without MCP annotations.`,
					repairAction: "reconcile_app",
				});
			}
		}

		if (unresolvedDriftCount > 0) {
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "unresolved_drift",
				severity: "warning",
				count: unresolvedDriftCount,
				summary: `${label} has ${unresolvedDriftCount} unresolved drift report(s).`,
				repairAction: "reconcile_app",
			});
		}

		// Store-brokered connector with no public MCP endpoint (e.g. GitHub's
		// ChatGPT SERVICE connector). These can never be installed through Tedix
		// MCP. Read-only advisory: if the vendor already has a runnable canonical
		// row it is a merge candidate; otherwise it is discovery-only evidence.
		const isBrokeredConnector =
			(app.connectorType === "SERVICE" || app.connectorType === "NATIVE") &&
			!app.mcpEndpointNormalized &&
			!app.baseUrl &&
			(app.mcpToolCount ?? 0) === 0;
		if (isBrokeredConnector) {
			const domain = extractVendorDomain(app.website);
			// Require BOTH domain AND name to match a runnable row — a shared
			// domain alone (BigQuery vs Gmail, both google.com) is not a real
			// merge target.
			const hasCanonical = domain
				? snapshot.canonicalVendorKeys.has(
						`${domain}|${normalizeVendorName(app.name)}`,
					)
				: false;
			issues.push({
				catalogAppId: app.id,
				catalogAppName: app.name,
				catalogAppSlug: app.slug,
				toolSource: app.toolSource,
				code: "brokered_service_connector",
				severity: "warning",
				count: 1,
				summary: hasCanonical
					? `${label} is a store-brokered connector with no MCP endpoint, but a runnable official row exists for its vendor — merge it in as a store listing.`
					: `${label} is a store-brokered connector with no public MCP endpoint and no runnable counterpart — keep as discovery-only listing evidence.`,
				repairAction: "none",
			});
		}
	}

	return issues;
}

async function getCatalogIntegritySnapshot(
	db: Database,
	options: Pick<CheckCatalogIntegrityOptions, "catalogAppId" | "limit">,
): Promise<CatalogIntegritySnapshot> {
	const limit = Math.min(Math.max(options.limit ?? 1000, 1), 10_000);
	const appWhere = and(
		eq(appCatalog.status, "ENABLED"),
		options.catalogAppId ? eq(appCatalog.id, options.catalogAppId) : undefined,
	);
	const catalogApps = await db
		.select({
			id: appCatalog.id,
			slug: appCatalog.slug,
			name: appCatalog.name,
			toolSource: appCatalog.toolSource,
			healthStatus: appCatalog.healthStatus,
			connectorType: appCatalog.connectorType,
			mcpToolCount: appCatalog.mcpToolCount,
			baseUrl: appCatalog.baseUrl,
			mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
			website: appCatalog.website,
		})
		.from(appCatalog)
		.where(appWhere)
		.orderBy(asc(appCatalog.name))
		.limit(limit);

	// Vendor identity keys (domain|name) that already have a runnable
	// (endpoint-backed) canonical catalog row. Computed over ALL enabled apps
	// (not just the snapshot window) so a single-app integrity check can still
	// detect a sibling official entry. Keyed by domain AND name so a mere
	// shared-domain coincidence (BigQuery vs Gmail) is not treated as a target.
	const canonicalVendorRows = await db
		.select({ website: appCatalog.website, name: appCatalog.name })
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				isNotNull(appCatalog.mcpEndpointNormalized),
			),
		);
	const canonicalVendorKeys = new Set<string>();
	for (const row of canonicalVendorRows) {
		const domain = extractVendorDomain(row.website);
		if (domain)
			canonicalVendorKeys.add(`${domain}|${normalizeVendorName(row.name)}`);
	}

	if (catalogApps.length === 0) {
		return {
			apps: [],
			statsByCatalogId: new Map(),
			baseAppCountByCatalogId: new Map(),
			unresolvedDriftCountByCatalogId: new Map(),
			canonicalVendorKeys,
		};
	}

	const catalogAppIds = catalogApps.map((app) => app.id);
	const idChunks = chunkForBoundParams(catalogAppIds, 50);
	const toolStats: Array<{
		catalogAppId: string;
		activeTools: number;
		missingProvenance: number;
		missingOutputSchema: number;
		missingAnnotations: number;
	}> = [];
	const baseAppCounts: Array<{
		catalogAppId: string | null;
		value: number;
	}> = [];
	const unresolvedDriftCounts: Array<{
		catalogAppId: string;
		value: number;
	}> = [];

	for (const ids of idChunks) {
		const chunkToolStats = await db
			.select({
				catalogAppId: appCatalogMcpTools.catalogAppId,
				activeTools: count(),
				missingProvenance: sql<number>`sum(case when ${appCatalogMcpTools.schemaDialect} is null or ${appCatalogMcpTools.schemaSource} is null or ${appCatalogMcpTools.schemaSourceRef} is null or ${appCatalogMcpTools.schemaSourceHash} is null or ${appCatalogMcpTools.schemaSyncedAt} is null then 1 else 0 end)`,
				missingOutputSchema: sql<number>`sum(case when ${appCatalogMcpTools.outputSchema} is null then 1 else 0 end)`,
				missingAnnotations: sql<number>`sum(case when ${appCatalogMcpTools.annotations} is null then 1 else 0 end)`,
			})
			.from(appCatalogMcpTools)
			.where(
				and(
					inArray(appCatalogMcpTools.catalogAppId, ids),
					isNull(appCatalogMcpTools.removedAt),
				),
			)
			.groupBy(appCatalogMcpTools.catalogAppId);
		toolStats.push(...chunkToolStats);

		const chunkBaseAppCounts = await db
			.select({
				catalogAppId: apps.catalogAppId,
				value: count(),
			})
			.from(apps)
			.where(and(inArray(apps.catalogAppId, ids), isNull(apps.sourceAppId)))
			.groupBy(apps.catalogAppId);
		baseAppCounts.push(...chunkBaseAppCounts);

		const chunkUnresolvedDriftCounts = await db
			.select({
				catalogAppId: upstreamDriftReports.catalogAppId,
				value: count(),
			})
			.from(upstreamDriftReports)
			.where(
				and(
					inArray(upstreamDriftReports.catalogAppId, ids),
					isNull(upstreamDriftReports.resolvedAt),
				),
			)
			.groupBy(upstreamDriftReports.catalogAppId);
		unresolvedDriftCounts.push(...chunkUnresolvedDriftCounts);
	}

	return {
		apps: catalogApps,
		statsByCatalogId: new Map(
			toolStats.map((row) => [
				row.catalogAppId,
				{
					activeTools: toNumber(row.activeTools),
					missingProvenance: toNumber(row.missingProvenance),
					missingOutputSchema: toNumber(row.missingOutputSchema),
					missingAnnotations: toNumber(row.missingAnnotations),
				},
			]),
		),
		baseAppCountByCatalogId: new Map(
			baseAppCounts.flatMap((row) =>
				row.catalogAppId ? [[row.catalogAppId, toNumber(row.value)]] : [],
			),
		),
		unresolvedDriftCountByCatalogId: new Map(
			unresolvedDriftCounts.map((row) => [
				row.catalogAppId,
				toNumber(row.value),
			]),
		),
		canonicalVendorKeys,
	};
}

/**
 * Fill provenance columns for catalog tool snapshot rows created before schema
 * provenance was added. New scans/projections already write these fields.
 */
export async function backfillCatalogToolProvenance(
	db: Database,
	options: BackfillCatalogToolProvenanceOptions = {},
): Promise<BackfillCatalogToolProvenanceResult> {
	const dryRun = options.dryRun ?? true;
	const limit = Math.min(Math.max(options.limit ?? 500, 1), 10_000);
	const missingWhere = and(
		isNull(appCatalogMcpTools.removedAt),
		options.catalogAppId
			? eq(appCatalogMcpTools.catalogAppId, options.catalogAppId)
			: undefined,
		or(
			isNull(appCatalogMcpTools.schemaDialect),
			isNull(appCatalogMcpTools.schemaSource),
			isNull(appCatalogMcpTools.schemaSourceRef),
			isNull(appCatalogMcpTools.schemaSourceHash),
			isNull(appCatalogMcpTools.schemaSyncedAt),
		),
	);

	const totalRows = await db
		.select({ value: count() })
		.from(appCatalogMcpTools)
		.innerJoin(appCatalog, eq(appCatalogMcpTools.catalogAppId, appCatalog.id))
		.where(missingWhere);
	const totalMissing = Number(totalRows[0]?.value ?? 0);

	// The tool columns are prefixed because `app_catalog_mcp_tools.id` and
	// `app_catalog.id` are both emitted as plain `id`: D1 collapsed them, so
	// `tool.id` read back the *catalog* id and every catalog field shifted left
	// (`catalog.id` held the name, `catalog.toolSource` was undefined). The
	// backfill then updated `where id = <catalogAppId>`, matching no tool row,
	// and still reported those rows as repaired.
	const rows = await db
		.select({
			tool: prefixedColumns(appCatalogMcpTools, "tool"),
			catalog: {
				id: appCatalog.id,
				name: appCatalog.name,
				toolSource: appCatalog.toolSource,
			},
		})
		.from(appCatalogMcpTools)
		.innerJoin(appCatalog, eq(appCatalogMcpTools.catalogAppId, appCatalog.id))
		.where(missingWhere)
		.orderBy(asc(appCatalog.name), asc(appCatalogMcpTools.toolName))
		.limit(limit);

	const projectableCatalogIds = [
		...new Set(
			rows
				.filter(({ catalog }) => isTedixCatalogToolSource(catalog.toolSource))
				.map(({ catalog }) => catalog.id),
		),
	];
	const baseAppByCatalogId = new Map<string, typeof apps.$inferSelect>();
	// Each catalog id lives in exactly one chunk, so the per-app
	// first-created-wins pick below is unaffected by chunking.
	for (const chunk of chunkForBoundParams(projectableCatalogIds, 50)) {
		const baseApps = await db
			.select()
			.from(apps)
			.where(and(inArray(apps.catalogAppId, chunk), isNull(apps.sourceAppId)))
			.orderBy(asc(apps.catalogAppId), asc(apps.createdAt));
		for (const baseApp of baseApps) {
			if (!baseApp.catalogAppId) continue;
			if (baseAppByCatalogId.has(baseApp.catalogAppId)) continue;
			baseAppByCatalogId.set(baseApp.catalogAppId, baseApp);
		}
	}

	const baseAppIds = [
		...new Set([...baseAppByCatalogId.values()].map((app) => app.id)),
	];
	const baseAppToolByKey = new Map<string, typeof appTools.$inferSelect>();
	const catalogIdByBaseAppId = new Map(
		[...baseAppByCatalogId.entries()].map(([catalogAppId, app]) => [
			app.id,
			catalogAppId,
		]),
	);
	for (const chunk of chunkForBoundParams(baseAppIds, 50)) {
		const sourceTools = await db
			.select()
			.from(appTools)
			.where(inArray(appTools.appId, chunk));
		for (const sourceTool of sourceTools) {
			const catalogAppId = catalogIdByBaseAppId.get(sourceTool.appId);
			if (!catalogAppId) continue;
			baseAppToolByKey.set(`${catalogAppId}:${sourceTool.toolId}`, sourceTool);
		}
	}

	const now = new Date().toISOString();
	const planned: Array<{
		toolId: string;
		set: Partial<typeof appCatalogMcpTools.$inferInsert>;
		item: BackfillCatalogToolProvenanceItem;
	}> = [];

	for (const { tool, catalog } of rows) {
		const sourceTool = baseAppToolByKey.get(`${catalog.id}:${tool.toolName}`);
		const inputSchema = normalizeMcpInputSchema(tool.inputSchema);
		const annotations = normalizeToolAnnotations(tool.annotations);
		const outputSchema = mcpToolOutputSchema(tool.outputSchema, annotations);
		const schemaSourceRef =
			sourceTool?.schemaSourceRef ??
			catalogMcpToolSourceRef(catalog.id, tool.toolName);
		const schemaSourceHash =
			sourceTool?.schemaSourceHash ??
			(await catalogMcpToolSourceHash({
				toolName: tool.toolName,
				title: tool.title,
				description: tool.description,
				inputSchema,
				outputSchema,
				icons: normalizeToolIcons(tool.icons),
				executionTaskSupport: normalizeExecutionTaskSupport({
					taskSupport: tool.executionTaskSupport,
				}),
				annotations,
				meta: normalizeToolMeta(tool.meta),
			}));
		const schemaSource =
			sourceTool?.schemaSource ??
			fallbackCatalogSchemaSource(catalog.toolSource);
		const schemaDialect = sourceTool?.schemaDialect ?? "json-schema-2020-12";
		const schemaSyncedAt = sourceTool?.schemaSyncedAt ?? now;
		const item = {
			catalogAppId: catalog.id,
			catalogAppName: catalog.name,
			toolName: tool.toolName,
			schemaSource,
			schemaSourceRef,
			schemaSourceHash,
			sourceCopiedFromAppTool: Boolean(sourceTool),
			action: dryRun ? "would_update" : "updated",
		} satisfies BackfillCatalogToolProvenanceItem;

		planned.push({
			toolId: tool.id,
			set: {
				schemaDialect,
				schemaSource,
				schemaSourceRef,
				schemaSourceHash,
				schemaSyncedAt,
			},
			item,
		});
	}

	if (!dryRun) {
		for (const mutation of planned) {
			await db
				.update(appCatalogMcpTools)
				.set(mutation.set)
				.where(eq(appCatalogMcpTools.id, mutation.toolId));
		}
	}

	const remaining = Math.max(totalMissing - (dryRun ? 0 : planned.length), 0);
	const updated = dryRun ? 0 : planned.length;

	return {
		dryRun,
		catalogAppId: options.catalogAppId ?? null,
		totalMissing,
		planned: planned.length,
		updated,
		remaining,
		items: planned.slice(0, 50).map((mutation) => mutation.item),
		summary: dryRun
			? `Would backfill ${planned.length} of ${totalMissing} catalog tool provenance rows.`
			: `Backfilled ${updated} catalog tool provenance rows; ${remaining} remaining.`,
	};
}

export async function checkCatalogIntegrity(
	db: Database,
	options: CheckCatalogIntegrityOptions = {},
): Promise<CheckCatalogIntegrityResult> {
	const apply = options.apply ?? false;
	const initialSnapshot = await getCatalogIntegritySnapshot(db, options);
	const initialIssues = buildCatalogIntegrityIssues(initialSnapshot);
	const repaired = {
		provenanceRows: 0,
		toolCounts: 0,
	};

	if (apply && initialIssues.length > 0) {
		const provenanceIssue = initialIssues.some(
			(issue) => issue.repairAction === "backfill_provenance",
		);
		if (provenanceIssue) {
			const result = await backfillCatalogToolProvenance(db, {
				catalogAppId: options.catalogAppId,
				limit: 10_000,
				dryRun: false,
			});
			repaired.provenanceRows = result.updated;
		}

		const toolCountIssues = initialIssues.filter(
			(issue) => issue.repairAction === "update_tool_count",
		);
		for (const issue of toolCountIssues) {
			const stats = initialSnapshot.statsByCatalogId.get(issue.catalogAppId);
			await db
				.update(appCatalog)
				.set({
					// GROUP BY yields no row when the active snapshot is empty.
					mcpToolCount: stats?.activeTools ?? 0,
					updatedAt: sql`datetime('now')`,
				})
				.where(eq(appCatalog.id, issue.catalogAppId));
			repaired.toolCounts++;
		}
	}

	const snapshot = apply
		? await getCatalogIntegritySnapshot(db, options)
		: initialSnapshot;
	const allIssues = buildCatalogIntegrityIssues(snapshot);
	const errorCount = allIssues.filter(
		(issue) => issue.severity === "error",
	).length;
	const warningCount = allIssues.length - errorCount;

	return {
		apply,
		catalogAppId: options.catalogAppId ?? null,
		checkedApps: snapshot.apps.length,
		issueCount: allIssues.length,
		errorCount,
		warningCount,
		repaired,
		issues: allIssues.slice(0, 200),
		summary: `${snapshot.apps.length} catalog app(s) checked: ${errorCount} error(s), ${warningCount} warning(s). Repaired ${repaired.provenanceRows} provenance row(s) and ${repaired.toolCounts} tool count(s).`,
	};
}

/**
 * Project a Tedix-owned catalog entry from its linked platform base app.
 *
 * This is the canonical snapshot path for Tedix-built MCP catalog apps. We do
 * not call the public `*.mcp.tedix.dev` endpoint from the scanner, because that
 * endpoint is an authenticated runtime surface and its vendor API key is not a
 * Tedix MCP OAuth credential. The catalog snapshot is a projection of the base
 * app's D1 `app_tools` rows.
 */
export async function projectCatalogToolsFromBaseApp(
	db: Database,
	catalogAppId: string,
): Promise<ProjectCatalogToolsFromBaseAppResult> {
	const catalogApp = await getCatalogAppById(db, catalogAppId);
	if (!catalogApp) {
		throw new Error(`Catalog app not found: ${catalogAppId}`);
	}

	const baseApps = await db
		.select()
		.from(apps)
		.where(and(eq(apps.catalogAppId, catalogAppId), isNull(apps.sourceAppId)))
		.orderBy(
			sql`CASE WHEN ${apps.slug} = ${catalogApp.slug} THEN 0 ELSE 1 END`,
			asc(apps.createdAt),
		)
		.limit(1);
	const baseApp = baseApps[0];
	if (!baseApp) {
		throw new Error(
			`Catalog app "${catalogApp.name}" (${catalogAppId}) has tool_source=${catalogApp.toolSource} but no linked base app`,
		);
	}

	const sourceTools = await db
		.select()
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, baseApp.id),
				eq(appTools.enabled, true),
				sql`coalesce(${appTools.visibility}, 'public') != 'disabled'`,
			),
		)
		.orderBy(asc(appTools.sortOrder), asc(appTools.toolId));

	const result = await syncCatalogMcpTools(
		db,
		catalogAppId,
		sourceTools.map((tool) => ({
			name: tool.toolId,
			title: tool.title,
			description: tool.description ?? undefined,
			inputSchema: tool.inputSchema,
			outputSchema:
				tool.outputSchema ??
				inferExternalToolOutputSchema(tool.config) ??
				undefined,
			icons: tool.icons ?? undefined,
			annotations:
				tool.annotations ??
				inferExternalToolAnnotations(tool.config) ??
				undefined,
			execution: tool.executionTaskSupport
				? { taskSupport: tool.executionTaskSupport }
				: undefined,
			_meta: tool.meta ?? undefined,
			schemaDialect: tool.schemaDialect,
			schemaSource: tool.schemaSource,
			schemaSourceRef: tool.schemaSourceRef,
			schemaSourceHash: tool.schemaSourceHash,
			schemaSyncedAt: tool.schemaSyncedAt,
		})),
	);

	const now = new Date().toISOString();
	await db
		.update(appCatalog)
		.set({
			mcpToolCount: sourceTools.length,
			mcpMetadata: sql`json_set(
				COALESCE(${appCatalog.mcpMetadata}, '{}'),
				'$.lastScannedAt', ${now},
				'$.serverName', ${baseApp.name}
			)`,
			healthData: {
				...catalogApp.healthData,
				lastCheckedAt: now,
				errorMessage: null,
			},
			lastSyncedAt: now,
			updatedAt: sql`datetime('now')`,
		})
		.where(eq(appCatalog.id, catalogAppId));

	const summary = `Projected ${sourceTools.length} tools from base app ${baseApp.slug}: ${result.added} added, ${result.updated} updated, ${result.removed} removed`;

	return {
		catalogAppId,
		catalogAppName: catalogApp.name,
		sourceAppId: baseApp.id,
		sourceAppSlug: baseApp.slug,
		toolSource: catalogApp.toolSource,
		activeTools: sourceTools.length,
		added: result.added,
		updated: result.updated,
		removed: result.removed,
		summary,
	};
}

/**
 * Sync MCP resources for a catalog app (from scan results)
 */
export async function syncCatalogMcpResources(
	db: Database,
	catalogAppId: string,
	resources: Array<{
		uri: string;
		name?: string;
		title?: string;
		description?: string;
		mimeType?: string;
		icons?: Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}>;
		annotations?: {
			audience?: string[];
			priority?: number;
			lastModified?: string;
		};
		_meta?: Record<string, JsonValue>;
	}>,
): Promise<{ added: number; updated: number; removed: number }> {
	const now = new Date().toISOString();
	let added = 0;
	let updated = 0;
	let removed = 0;

	const existing = await db
		.select()
		.from(appCatalogMcpResources)
		.where(
			and(
				eq(appCatalogMcpResources.catalogAppId, catalogAppId),
				isNull(appCatalogMcpResources.removedAt),
			),
		);
	const existingUris = new Set(existing.map((r) => r.uri));
	const incomingUris = new Set(resources.map((r) => r.uri));

	for (const res of resources) {
		const isNew = !existingUris.has(res.uri);
		await db
			.insert(appCatalogMcpResources)
			.values({
				id: crypto.randomUUID(),
				catalogAppId,
				uri: res.uri,
				name: res.name ?? null,
				title: res.title ?? null,
				description: res.description ?? null,
				mimeType: res.mimeType ?? null,
				icons: res.icons ?? null,
				annotations: res.annotations ?? null,
				meta: res._meta ?? null,
				detectedAt: now,
				lastSeenAt: now,
				removedAt: null,
			})
			.onConflictDoUpdate({
				target: [
					appCatalogMcpResources.catalogAppId,
					appCatalogMcpResources.uri,
				],
				set: {
					name: res.name ?? null,
					title: res.title ?? null,
					description: res.description ?? null,
					mimeType: res.mimeType ?? null,
					icons: res.icons ?? null,
					annotations: res.annotations ?? null,
					meta: res._meta ?? null,
					lastSeenAt: now,
					removedAt: null,
				},
			});
		if (isNew) added++;
		else updated++;
	}

	for (const ex of existing) {
		if (!incomingUris.has(ex.uri)) {
			await db
				.update(appCatalogMcpResources)
				.set({ removedAt: now })
				.where(eq(appCatalogMcpResources.id, ex.id));
			removed++;
		}
	}

	return { added, updated, removed };
}

/**
 * Sync MCP resource templates for a catalog app (from scan results)
 */
export async function syncCatalogMcpResourceTemplates(
	db: Database,
	catalogAppId: string,
	templates: Array<{
		name: string;
		title?: string;
		uriTemplate: string;
		description?: string;
		mimeType?: string;
		icons?: Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}>;
		annotations?: {
			audience?: string[];
			priority?: number;
			lastModified?: string;
		};
		_meta?: Record<string, JsonValue>;
	}>,
): Promise<{ added: number; updated: number; removed: number }> {
	const now = new Date().toISOString();
	let added = 0;
	let updated = 0;
	let removed = 0;

	const existing = await db
		.select()
		.from(appCatalogMcpResourceTemplates)
		.where(
			and(
				eq(appCatalogMcpResourceTemplates.catalogAppId, catalogAppId),
				isNull(appCatalogMcpResourceTemplates.removedAt),
			),
		);
	const existingNames = new Set(existing.map((t) => t.name));
	const incomingNames = new Set(templates.map((t) => t.name));

	for (const tpl of templates) {
		const isNew = !existingNames.has(tpl.name);
		await db
			.insert(appCatalogMcpResourceTemplates)
			.values({
				id: crypto.randomUUID(),
				catalogAppId,
				name: tpl.name,
				title: tpl.title ?? null,
				uriTemplate: tpl.uriTemplate,
				description: tpl.description ?? null,
				mimeType: tpl.mimeType ?? null,
				icons: tpl.icons ?? null,
				annotations: tpl.annotations ?? null,
				meta: tpl._meta ?? null,
				detectedAt: now,
				lastSeenAt: now,
				removedAt: null,
			})
			.onConflictDoUpdate({
				target: [
					appCatalogMcpResourceTemplates.catalogAppId,
					appCatalogMcpResourceTemplates.name,
				],
				set: {
					title: tpl.title ?? null,
					uriTemplate: tpl.uriTemplate,
					description: tpl.description ?? null,
					mimeType: tpl.mimeType ?? null,
					icons: tpl.icons ?? null,
					annotations: tpl.annotations ?? null,
					meta: tpl._meta ?? null,
					lastSeenAt: now,
					removedAt: null,
				},
			});
		if (isNew) added++;
		else updated++;
	}

	for (const ex of existing) {
		if (!incomingNames.has(ex.name)) {
			await db
				.update(appCatalogMcpResourceTemplates)
				.set({ removedAt: now })
				.where(eq(appCatalogMcpResourceTemplates.id, ex.id));
			removed++;
		}
	}

	return { added, updated, removed };
}

/**
 * Sync MCP prompts for a catalog app (from scan results)
 */
export async function syncCatalogMcpPrompts(
	db: Database,
	catalogAppId: string,
	prompts: Array<{
		name: string;
		title?: string;
		description?: string;
		arguments?: Array<{
			name: string;
			description?: string;
			required?: boolean;
		}>;
		icons?: Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}>;
		annotations?: {
			audience?: string[];
			priority?: number;
			lastModified?: string;
		};
		_meta?: Record<string, JsonValue>;
	}>,
): Promise<{ added: number; updated: number; removed: number }> {
	const now = new Date().toISOString();
	let added = 0;
	let updated = 0;
	let removed = 0;

	const existing = await db
		.select()
		.from(appCatalogMcpPrompts)
		.where(
			and(
				eq(appCatalogMcpPrompts.catalogAppId, catalogAppId),
				isNull(appCatalogMcpPrompts.removedAt),
			),
		);
	const existingNames = new Set(existing.map((p) => p.promptName));
	const incomingNames = new Set(prompts.map((p) => p.name));

	for (const prompt of prompts) {
		const isNew = !existingNames.has(prompt.name);
		await db
			.insert(appCatalogMcpPrompts)
			.values({
				id: crypto.randomUUID(),
				catalogAppId,
				promptName: prompt.name,
				title: prompt.title ?? null,
				description: prompt.description ?? null,
				arguments: prompt.arguments ?? null,
				icons: prompt.icons ?? null,
				annotations: prompt.annotations ?? null,
				meta: prompt._meta ?? null,
				detectedAt: now,
				lastSeenAt: now,
				removedAt: null,
			})
			.onConflictDoUpdate({
				target: [
					appCatalogMcpPrompts.catalogAppId,
					appCatalogMcpPrompts.promptName,
				],
				set: {
					title: prompt.title ?? null,
					description: prompt.description ?? null,
					arguments: prompt.arguments ?? null,
					icons: prompt.icons ?? null,
					annotations: prompt.annotations ?? null,
					meta: prompt._meta ?? null,
					lastSeenAt: now,
					removedAt: null,
				},
			});
		if (isNew) added++;
		else updated++;
	}

	for (const ex of existing) {
		if (!incomingNames.has(ex.promptName)) {
			await db
				.update(appCatalogMcpPrompts)
				.set({ removedAt: now })
				.where(eq(appCatalogMcpPrompts.id, ex.id));
			removed++;
		}
	}

	return { added, updated, removed };
}
