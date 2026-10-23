import attentionAppViews from "@tedix/api-contract/assets/attention-app-views.v2.json";
import type {
	ToolSchemaSyncInput,
	ToolSchemaSyncResult,
} from "@tedix/api-contract/contracts/tool-schema-sync";
import {
	type ResolvedContractEndpoint,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";
import type { DbClient } from "@tedix/db/client";
import { getAppBySlug } from "@tedix/db/queries/apps";
import {
	deleteTool,
	listToolContractHashesForSchemaSync,
	listToolIdsForSchemaSync,
	listToolsForSchemaSync,
	listToolsForSchemaSyncScoped,
	recordToolContractHashes,
	refreshToolSchemaProvenance,
	updateToolSchemaProjection,
	upsertTool,
} from "@tedix/db/queries/tools";
import type { AppTool } from "@tedix/db/schema";
import { toJsonRecord } from "@tedix/db/utils/json";
import { publishMcpListChangedEvents } from "../lib/mcp-subscriptions";
import {
	AGENT_TURN_TRIAGE_KIND_OVERRIDES,
	AGENT_TURN_TRIAGE_TOOL_ID_OVERRIDES,
	CAPABILITY_KIND_OVERRIDES,
	CAPABILITY_TOOL_ID_OVERRIDES,
	CATALOG_TOOL_ID_OVERRIDES,
	EARNED_DELEGATION_KIND_OVERRIDES,
	EARNED_DELEGATION_TOOL_ID_OVERRIDES,
	EXTERNAL_AGENT_KIND_OVERRIDES,
	EXTERNAL_AGENT_TOOL_ID_OVERRIDES,
	GOVERNANCE_KIND_OVERRIDES,
	GOVERNANCE_TOOL_ID_OVERRIDES,
	GRAPH_GOVERNANCE_KIND_OVERRIDES,
	GRAPH_GOVERNANCE_TOOL_ID_OVERRIDES,
	MEMORY_GRAPH_KIND_OVERRIDES,
	MUSCLE_MEMORY_KIND_OVERRIDES,
	MUSCLE_MEMORY_TOOL_ID_OVERRIDES,
	ORG_INJECT_ROUTERS,
	ORGANIZATION_PURPOSE_KIND_OVERRIDES,
	ORGANIZATION_PURPOSE_TOOL_ID_OVERRIDES,
	OS_KIND_OVERRIDES,
	OS_TOOL_ID_OVERRIDES,
	ROLE_TEMPLATE_KIND_OVERRIDES,
	ROLE_TEMPLATE_TOOL_ID_OVERRIDES,
	SEO_RESEARCH_KIND_OVERRIDES,
	SEO_RESEARCH_TOOL_ID_OVERRIDES,
	SITE_KIND_OVERRIDES,
	SITE_TOOL_ID_OVERRIDES,
	SKILL_WORKFLOW_KIND_OVERRIDES,
	SKILL_WORKFLOW_TOOL_ID_OVERRIDES,
	WORK_HIERARCHY_KIND_OVERRIDES,
	WORK_HIERARCHY_TOOL_ID_OVERRIDES,
	WORKFLOW_CATALOG_KIND_OVERRIDES,
	WORKFLOW_CATALOG_TOOL_ID_OVERRIDES,
	WORKFLOW_CATALOG_WIDGET_OVERRIDES,
} from "./tool-schema-overrides";
import {
	asRpcEndpoint,
	buildProjectedTool,
	changedProjectionColumns,
	compareEndpointPath,
	endpointPathOf,
	generatedToolIdForEndpoint,
	generateToolIdMap,
	hasObjectProperty,
	type JsonObject,
	type ProjectionOptions,
	projectionCandidates,
	projectionContractHash,
	projectSchemas,
	sha256,
	stableStringify,
	type SyncColumn,
	targetColumns,
} from "./tool-schema-projection";

export const TEDIX_ADMIN_APP_SLUG = "tedix";

/**
 * The admin app is a D1 row addressed by slug; its id differs per database,
 * so callers resolve it once per operation instead of baking one in.
 */
export async function resolveTedixAdminAppId(db: DbClient): Promise<string> {
	const app = await getAppBySlug(db, TEDIX_ADMIN_APP_SLUG);
	if (!app) {
		throw new Error(
			`Tedix admin app "${TEDIX_ADMIN_APP_SLUG}" is not provisioned`,
		);
	}
	return app.id;
}

async function runToolProjectionSync(
	db: DbClient,
	rows: AppTool[],
	endpoints: ResolvedContractEndpoint[],
	resolvedToolIds: Map<string, string>,
	options: ToolSchemaSyncInput & {
		appId: string;
		mode: "projection";
		source: "rpc";
		target: "input" | "output" | "both";
		apply: boolean;
		regenerateToolIds?: boolean;
	},
): Promise<ToolSchemaSyncResult> {
	const existingByEndpoint = new Map<string, AppTool>();
	const existingByToolId = new Map<string, AppTool>();
	for (const row of rows) {
		existingByToolId.set(row.toolId, row);
		const endpoint = asRpcEndpoint(row);
		if (endpoint) existingByEndpoint.set(endpoint, row);
	}

	const onlyToolIds = options.toolIds ? new Set(options.toolIds) : null;
	const items: ToolSchemaSyncResult["items"] = [];
	let planned = 0;
	let created = 0;
	let updated = 0;
	// Projection mode NEVER deletes, and must never learn to. This run may be a
	// single batch of a batched sync, so "rows in the DB that this run did not
	// visit" is not a stale set — it is every other batch's work. A full-set
	// diff here would delete the entire tool surface except the current batch.
	// `tool-schema-sync-batching.test.ts` fails if this becomes a mutable
	// counter that a set-difference can drive.
	const deleted = 0;
	let inSync = 0;
	let skipped = 0;
	let failed = 0;
	// In-sync rows that predate their contract hash (or carry an older one).
	// Recording it is bookkeeping, not a change: one batched write, no
	// `updated_at` bump, no list_changed.
	const contractHashes: Array<{ id: string; contractHash: string }> = [];

	for (const endpoint of endpoints) {
		const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
		const resolvedToolId =
			resolvedToolIds.get(endpointPath) ?? generatedToolIdForEndpoint(endpoint);
		const existing =
			existingByEndpoint.get(endpointPath) ??
			existingByToolId.get(resolvedToolId);

		let projected: Awaited<ReturnType<typeof buildProjectedTool>>;
		try {
			const projectionOptions: ProjectionOptions = {
				toolIdOverrides: options.toolIdOverrides,
				kindOverrides: options.kindOverrides,
				widgetOverrides: options.widgetOverrides,
				resolvedToolId,
				regenerateToolIds: options.regenerateToolIds,
				schemas: projectSchemas(endpoint),
			};
			const contractHash = await projectionContractHash(
				endpoint,
				projectionOptions,
			);
			projected = await buildProjectedTool(options.appId, endpoint, existing, {
				...projectionOptions,
				contractHash,
			});
		} catch (error) {
			skipped++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: existing?.toolId ?? resolvedToolId,
				endpoint: endpointPath,
				status: "converterUnsupported",
				changed: [],
				message: (error as Error).message,
			});
			continue;
		}

		if (onlyToolIds && !onlyToolIds.has(projected.tool.toolId)) continue;

		const changed = existing
			? changedProjectionColumns(existing, projected.tool)
			: ([
					"title",
					"description",
					"inputSchema",
					"outputSchema",
					"config",
					"annotations",
					"meta",
					"authRequired",
					"visibility",
					"schemaSource",
				] satisfies SyncColumn[]);

		if (existing && changed.length === 0) {
			inSync++;
			if (existing.contractHash !== projected.tool.contractHash) {
				contractHashes.push({
					id: existing.id,
					contractHash: projected.tool.contractHash as string,
				});
			}
			items.push({
				toolUuid: existing.id,
				toolId: existing.toolId,
				endpoint: endpointPath,
				status: "inSync",
				changed: [],
			});
			continue;
		}

		planned++;
		if (options.limit !== undefined && planned > options.limit) {
			planned--;
			skipped++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: "skipped",
				changed,
				message: "Limit reached",
			});
			continue;
		}

		if (!options.apply) {
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: existing ? "wouldUpdate" : "wouldCreate",
				changed,
			});
			continue;
		}

		try {
			const saved = await upsertTool(db, projected.tool);
			if (existing) updated++;
			else created++;
			items.push({
				toolUuid: saved.id,
				toolId: saved.toolId,
				endpoint: endpointPath,
				status: existing ? "updated" : "created",
				changed,
			});
		} catch (error) {
			failed++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: "failed",
				changed,
				message: (error as Error).message,
			});
		}
	}

	if (options.apply) await recordToolContractHashes(db, contractHashes);

	return {
		appId: options.appId,
		mode: options.mode,
		source: options.source,
		target: options.target,
		apply: options.apply,
		total: endpoints.length,
		planned,
		created,
		updated,
		deleted,
		inSync,
		skipped,
		failed,
		items,
	};
}

/**
 * After an applied (non-dry-run) sync that changed rows, nudge live MCP
 * subscribers on the synced app: tool rows changed, so tools/list and the
 * derived ui:// widget resource list are stale. No-op without an env (test
 * and CLI callers) — publishMcpListChangedEvents itself no-ops when the
 * MCP_SERVICE binding is absent.
 *
 * A batched sync therefore calls `runToolSchemaSync` WITHOUT an env per batch
 * and invokes this once, after every batch succeeded, so subscribers are never
 * told to re-read a half-projected tool surface.
 */
export async function publishToolSchemaSyncEvents(
	env: CloudflareEnv | undefined,
	result: ToolSchemaSyncResult,
): Promise<void> {
	if (!env || !result.apply) return;
	if (result.created + result.updated + result.deleted === 0) return;
	await publishMcpListChangedEvents(env, { appId: result.appId }, [
		"notifications/tools/list_changed",
		"notifications/resources/list_changed",
	]);
}

/**
 * Merge the Tedix admin app's built-in projection overrides into the caller's
 * options. Extracted so the batch planner resolves tool ids from exactly the
 * same override set a batch run will use — a planner that missed an override
 * would hand batches a different id map than the one the collision guard
 * validated.
 */
export function resolveEffectiveToolSchemaSyncOptions(
	options: ToolSchemaSyncInput,
	appId: string,
	adminAppId: string | undefined,
): ToolSchemaSyncInput {
	return appId === adminAppId
		? {
				...options,
				toolIdOverrides: {
					...CATALOG_TOOL_ID_OVERRIDES,
					...SITE_TOOL_ID_OVERRIDES,
					...SKILL_WORKFLOW_TOOL_ID_OVERRIDES,
					...MUSCLE_MEMORY_TOOL_ID_OVERRIDES,
					...WORKFLOW_CATALOG_TOOL_ID_OVERRIDES,
					...CAPABILITY_TOOL_ID_OVERRIDES,
					...GOVERNANCE_TOOL_ID_OVERRIDES,
					...SEO_RESEARCH_TOOL_ID_OVERRIDES,
					...GRAPH_GOVERNANCE_TOOL_ID_OVERRIDES,
					...WORK_HIERARCHY_TOOL_ID_OVERRIDES,
					...ROLE_TEMPLATE_TOOL_ID_OVERRIDES,
					...AGENT_TURN_TRIAGE_TOOL_ID_OVERRIDES,
					...ORGANIZATION_PURPOSE_TOOL_ID_OVERRIDES,
					...EARNED_DELEGATION_TOOL_ID_OVERRIDES,
					...EXTERNAL_AGENT_TOOL_ID_OVERRIDES,
					...OS_TOOL_ID_OVERRIDES,
					...options.toolIdOverrides,
				},
				kindOverrides: {
					...SITE_KIND_OVERRIDES,
					...SKILL_WORKFLOW_KIND_OVERRIDES,
					...MUSCLE_MEMORY_KIND_OVERRIDES,
					...MEMORY_GRAPH_KIND_OVERRIDES,
					...WORKFLOW_CATALOG_KIND_OVERRIDES,
					...CAPABILITY_KIND_OVERRIDES,
					...GOVERNANCE_KIND_OVERRIDES,
					...SEO_RESEARCH_KIND_OVERRIDES,
					...GRAPH_GOVERNANCE_KIND_OVERRIDES,
					...WORK_HIERARCHY_KIND_OVERRIDES,
					...ROLE_TEMPLATE_KIND_OVERRIDES,
					...AGENT_TURN_TRIAGE_KIND_OVERRIDES,
					...ORGANIZATION_PURPOSE_KIND_OVERRIDES,
					...EARNED_DELEGATION_KIND_OVERRIDES,
					...EXTERNAL_AGENT_KIND_OVERRIDES,
					...OS_KIND_OVERRIDES,
					...options.kindOverrides,
				},
				widgetOverrides: {
					...WORKFLOW_CATALOG_WIDGET_OVERRIDES,
					...attentionAppViews.views,
					...options.widgetOverrides,
				},
			}
		: options;
}

export interface ToolSchemaSyncProjectionPlan {
	appId: string;
	/** Endpoint paths in deterministic codepoint order. Frozen batch input. */
	endpoints: string[];
	/** endpointPath -> tool id, collision-resolved across the WHOLE plan. */
	toolIds: Record<string, string>;
}

/**
 * Enumerate the projection work list without generating a single JSON Schema.
 *
 * Walking the contract registry costs ~2 ms and allocates nothing beyond the
 * already-resident zod graph; the memory that exhausted the unscoped Worker run
 * is spent inside `buildProjectedTool` (`z.toJSONSchema` + re-validation +
 * `stableStringify` + `sha256` per endpoint). Planning is therefore cheap enough
 * to run whole, which is what makes deterministic batching possible.
 *
 * The tool id map MUST be resolved here, over the complete candidate set, and
 * sliced per batch. `generateToolIdMap` disambiguates colliding ids across the
 * set it is given, and `upsertTool` matches on `(app_id, tool_id)` — so a map
 * recomputed per batch would emit the same bare id for two endpoints in
 * different batches and let the later batch silently clobber the earlier
 * batch's row, with the residual-collision guard seeing only one member and
 * staying quiet.
 */
export function planToolSchemaSyncProjection(
	options: ToolSchemaSyncInput,
	adminAppId: string,
): ToolSchemaSyncProjectionPlan {
	const { appId, candidates, resolved } = resolveProjectionPlan(
		options,
		adminAppId,
	);
	const toolIds: Record<string, string> = {};
	const endpoints: string[] = [];
	for (const candidate of candidates) {
		const path = endpointPathOf(candidate);
		endpoints.push(path);
		const resolvedToolId = resolved.get(path);
		if (resolvedToolId) toolIds[path] = resolvedToolId;
	}
	return { appId, endpoints, toolIds };
}

function resolveProjectionPlan(
	options: ToolSchemaSyncInput,
	adminAppId: string,
) {
	const appId = options.appId ?? adminAppId;
	const effective = resolveEffectiveToolSchemaSyncOptions(
		options,
		appId,
		adminAppId,
	);
	const candidates = projectionCandidates(effective).sort(compareEndpointPath);
	const resolved = generateToolIdMap(candidates, effective.toolIdOverrides);
	return { appId, effective, candidates, resolved };
}

export interface ToolSchemaSyncIncrementalPlan extends ToolSchemaSyncProjectionPlan {
	/** Endpoints skipped because their stored row carries the current hash. */
	unchanged: number;
	/** Endpoints whose schemas cannot be generated; no batch could project them. */
	unsupported: string[];
}

/**
 * Projection plan narrowed to endpoints whose code-derived projection changed.
 *
 * Every candidate's contract hash is computed here, one endpoint at a time so
 * no generated schema outlives its hash (~1,000 endpoints is well under a
 * second), and compared with the hash stored on the row a batch would match
 * — by `config.endpoint` for rpc rows, else by the resolved tool id, the same
 * lookup `runToolProjectionSync` uses. A missing row or a missing or different
 * hash plans the endpoint; an unchanged deploy plans nothing.
 *
 * The tool id map is still resolved over the whole candidate set, then sliced
 * to the planned endpoints, so collision handling is identical to a full walk.
 */
export async function planIncrementalToolSchemaSyncProjection(
	db: DbClient,
	options: ToolSchemaSyncInput,
	adminAppId: string,
): Promise<ToolSchemaSyncIncrementalPlan> {
	const { appId, effective, candidates, resolved } = resolveProjectionPlan(
		options,
		adminAppId,
	);
	const rows = await listToolContractHashesForSchemaSync(db, appId);
	const byEndpoint = new Map<string, string | null>();
	const byToolId = new Map<string, string | null>();
	for (const row of rows) {
		byToolId.set(row.toolId, row.contractHash);
		if (row.transport === "rpc" && typeof row.endpoint === "string") {
			byEndpoint.set(row.endpoint, row.contractHash);
		}
	}

	const endpoints: string[] = [];
	const toolIds: Record<string, string> = {};
	const unsupported: string[] = [];
	let unchanged = 0;
	for (const candidate of candidates) {
		const path = endpointPathOf(candidate);
		const resolvedToolId =
			resolved.get(path) ?? generatedToolIdForEndpoint(candidate);
		let contractHash: string;
		try {
			contractHash = await projectionContractHash(candidate, {
				toolIdOverrides: effective.toolIdOverrides,
				kindOverrides: effective.kindOverrides,
				widgetOverrides: effective.widgetOverrides,
				resolvedToolId,
				regenerateToolIds: effective.regenerateToolIds,
			});
		} catch {
			unsupported.push(path);
			continue;
		}
		const stored = byEndpoint.has(path)
			? byEndpoint.get(path)
			: byToolId.get(resolvedToolId);
		if (stored === contractHash) {
			unchanged++;
			continue;
		}
		endpoints.push(path);
		const planned = resolved.get(path);
		if (planned) toolIds[path] = planned;
	}
	return { appId, endpoints, toolIds, unchanged, unsupported };
}

export interface ToolSchemaSyncRowPlan {
	appId: string;
	/** Stored tool ids in deterministic order. Frozen batch input. */
	toolIds: string[];
}

/**
 * Schema-mode work list: the app's stored tool ids, ordered by the same stable
 * key the sync reads rows with. Reads one column per row so planning never
 * materializes the ~3 MB of schema/config JSON that the batches page in.
 */
export async function planToolSchemaSyncRows(
	db: DbClient,
	options: ToolSchemaSyncInput,
): Promise<ToolSchemaSyncRowPlan> {
	const appId = options.appId ?? (await resolveTedixAdminAppId(db));
	const stored = await listToolIdsForSchemaSync(db, appId);
	const requested = options.toolIds ? new Set(options.toolIds) : null;
	const toolIds = (
		requested ? stored.filter((toolId) => requested.has(toolId)) : stored
	).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return { appId, toolIds };
}

export async function runToolSchemaSync(
	db: DbClient,
	options: ToolSchemaSyncInput,
	env?: CloudflareEnv,
): Promise<ToolSchemaSyncResult> {
	const appId = options.appId ?? (await resolveTedixAdminAppId(db));
	// A tenant projection names its own app and must not require the platform
	// admin app: a fresh local database has none, and first-run onboarding
	// projects workspace tools into the new tenant gateway.
	const adminAppId = options.appId
		? (await getAppBySlug(db, TEDIX_ADMIN_APP_SLUG))?.id
		: appId;
	const effectiveOptions = resolveEffectiveToolSchemaSyncOptions(
		options,
		appId,
		adminAppId,
	);
	const mode = options.mode ?? "schema";
	const source = options.source ?? "rpc";
	const target = options.target ?? "both";
	const apply = options.apply ?? false;
	const pruneStale = options.pruneStale ?? true;
	const columns = targetColumns(target);
	const onlyToolIds = options.toolIds ? new Set(options.toolIds) : null;

	if (source !== "rpc") {
		throw new Error(`Unsupported tool schema source: ${source}`);
	}

	if (mode === "projection") {
		// Resolve the work list and the tool id map BEFORE touching D1 so the
		// row read can be scoped to exactly the rows this run can match.
		const endpoints = projectionCandidates(effectiveOptions);
		const resolvedToolIds = generateToolIdMap(
			endpoints,
			effectiveOptions.toolIdOverrides,
		);
		// An explicitly scoped run (one batch of a batched sync) reads only the
		// rows it can possibly match. `runToolProjectionSync` looks an existing
		// row up by exactly two keys — the endpoint path and the resolved tool id
		// — so scoping the read to those two key sets returns the same rows the
		// unscoped read would have matched. Anything wider is memory the batch
		// does not need: the Tedix admin app carries ~3 MB of schema/config JSON.
		const projectionRows = options.endpoints?.length
			? await listToolsForSchemaSyncScoped(db, appId, {
					endpoints: endpoints.map(endpointPathOf),
					toolIds: [...resolvedToolIds.values(), ...(options.toolIds ?? [])],
				})
			: await listToolsForSchemaSync(db, appId);
		const projectionResult = await runToolProjectionSync(
			db,
			projectionRows,
			endpoints,
			resolvedToolIds,
			{
				...effectiveOptions,
				appId,
				source,
				target,
				apply,
				mode,
			},
		);
		await publishToolSchemaSyncEvents(env, projectionResult);
		return projectionResult;
	}

	// Schema mode batches over stored tool ids, so the same scoping rule applies:
	// only the batch's rows are read, and every row outside the batch is
	// untouched — including by `pruneStale`, which can only delete a row it read.
	const rows = options.toolIds?.length
		? await listToolsForSchemaSyncScoped(db, appId, {
				toolIds: options.toolIds,
			})
		: await listToolsForSchemaSync(db, appId);

	const rpcTools = rows.filter((tool) => {
		if (onlyToolIds && !onlyToolIds.has(tool.toolId)) return false;
		const endpoint = asRpcEndpoint(tool);
		if (!endpoint) return false;
		if (!options.router) return true;
		return resolveContractEndpoint(endpoint)?.router === options.router;
	});

	const items: ToolSchemaSyncResult["items"] = [];
	let planned = 0;
	const created = 0;
	let updated = 0;
	let deleted = 0;
	let inSync = 0;
	let skipped = 0;
	let failed = 0;
	// Rows whose regenerated content matched the stored row but whose sync
	// bookkeeping is stale. They are reported `inSync` (nothing the sync owns
	// changed, so `updatedAt` must not move and tools/list_changed must not
	// fire) and refreshed in one batched round trip after the loop.
	const provenanceTouchIds: string[] = [];
	const provenanceCertify: Array<{
		id: string;
		schemaSourceRef: string;
		schemaSourceHash: string;
	}> = [];
	const provenanceItems: ToolSchemaSyncResult["items"] = [];

	for (const tool of rpcTools) {
		const endpoint = asRpcEndpoint(tool);
		if (!endpoint) continue;

		const lookup = resolveContractEndpoint(endpoint);
		if (!lookup) {
			if (!pruneStale) {
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "noContract",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
				continue;
			}

			planned++;
			if (options.limit !== undefined && planned > options.limit) {
				planned--;
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "skipped",
					changed: [],
					message: "Limit reached",
				});
				continue;
			}

			if (!apply) {
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "wouldDelete",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
				continue;
			}

			try {
				await deleteTool(db, tool.id);
				deleted++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "deleted",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
			} catch (error) {
				failed++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "failed",
					changed: [],
					message: (error as Error).message,
				});
			}
			continue;
		}
		const patch: Partial<Pick<AppTool, "inputSchema" | "outputSchema">> = {};
		let nextInputSchema: AppTool["inputSchema"] | null = null;
		const changed: SyncColumn[] = [];
		let conversionFailed = false;

		for (const column of columns) {
			const zodSchema =
				column === "inputSchema" ? lookup.inputSchema : lookup.outputSchema;
			if (column === "outputSchema" && !zodSchema) continue;

			let nextSchema: AppTool["inputSchema"] | AppTool["outputSchema"];
			try {
				nextSchema =
					column === "inputSchema"
						? zodToToolInputJsonSchema(zodSchema)
						: zodToStructuredOutputJsonSchema(zodSchema);
			} catch (error) {
				conversionFailed = true;
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "converterUnsupported",
					changed: [],
					message: `${column}: ${(error as Error).message}`,
				});
				continue;
			}
			if (!nextSchema) continue;
			if (column === "inputSchema") {
				nextInputSchema = nextSchema as AppTool["inputSchema"];
			}

			const currentSchema = tool[column];
			if (stableStringify(currentSchema) !== stableStringify(nextSchema)) {
				if (column === "inputSchema") {
					patch.inputSchema = nextSchema as AppTool["inputSchema"];
				} else {
					patch.outputSchema = nextSchema as AppTool["outputSchema"];
				}
				changed.push(column);
			}
		}
		// Never certify stale provenance using a schema we could not regenerate.
		if (conversionFailed) continue;

		const currentConfig = (tool.config ?? {}) as JsonObject;
		const nextConfig = { ...currentConfig };
		const effectiveInputSchema = nextInputSchema ?? tool.inputSchema;
		if (
			hasObjectProperty(effectiveInputSchema, "tediId") &&
			nextConfig.allowExplicitTediId !== true
		) {
			nextConfig.allowExplicitTediId = true;
		}
		if (
			hasObjectProperty(effectiveInputSchema, "appId") &&
			nextConfig.allowExplicitAppId !== true
		) {
			nextConfig.allowExplicitAppId = true;
		}
		// Inject the caller's org for caller-org-scoped sub-collection routes (e.g.
		// `members` → `/{organizationId}/members`) so forwarded MCP users don't
		// pass/spoof their own org UUID. Gated on an explicit router allowlist
		// (NOT a path heuristic) so platform-admin cross-org procs like
		// organizations.cancel (also `/{organizationId}/...`) is never
		// auto-rescoped. The path check still excludes non-org routes in an
		// allowlisted router (e.g. members.acceptInvitation).
		if (
			ORG_INJECT_ROUTERS.has(lookup.router) &&
			lookup.route?.path?.includes("{organizationId}/") &&
			nextConfig.injectOrganizationId !== true
		) {
			nextConfig.injectOrganizationId = true;
		}
		if (stableStringify(currentConfig) !== stableStringify(nextConfig)) {
			changed.push("config");
		}

		// Configuration-only updates (including nativeDirect) advance updatedAt.
		// Revalidate the actual projection rather than calling an unchanged JSON
		// schema fresh while its provenance still describes the previous config.
		const schemaSourceHash = await sha256({
			endpoint,
			inputSchema: patch.inputSchema ?? tool.inputSchema,
			outputSchema: patch.outputSchema ?? tool.outputSchema,
			config: changed.includes("config") ? nextConfig : currentConfig,
		});
		const syncedAt = Date.parse(tool.schemaSyncedAt ?? "");
		const updatedAt = Date.parse(tool.updatedAt ?? "");
		const provenanceMatches =
			tool.schemaDialect === "json-schema-2020-12" &&
			tool.schemaSource === "orpc" &&
			tool.schemaSourceRef === endpoint &&
			tool.schemaSourceHash === schemaSourceHash;
		const provenanceStale =
			!provenanceMatches ||
			!Number.isFinite(syncedAt) ||
			!Number.isFinite(updatedAt) ||
			updatedAt > syncedAt;
		if (provenanceStale) changed.push("schemaSource");

		if (changed.length === 0) {
			inSync++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "inSync",
				changed: [],
			});
			continue;
		}

		if (changed.length === 1 && provenanceStale) {
			// Bookkeeping only: the schemas and config regenerated identically, so
			// the row is in sync. Rewriting it in full (and bumping updatedAt) is
			// what made every post-deploy reconcile rewrite the whole surface.
			inSync++;
			const item: ToolSchemaSyncResult["items"][number] = {
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "inSync",
				changed,
			};
			items.push(item);
			if (apply) {
				if (provenanceMatches) provenanceTouchIds.push(tool.id);
				else {
					provenanceCertify.push({
						id: tool.id,
						schemaSourceRef: endpoint,
						schemaSourceHash,
					});
				}
				provenanceItems.push(item);
			}
			continue;
		}

		planned++;
		if (options.limit !== undefined && planned > options.limit) {
			planned--;
			skipped++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "skipped",
				changed,
				message: "Limit reached",
			});
			continue;
		}

		if (!apply) {
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "wouldUpdate",
				changed,
			});
			continue;
		}

		try {
			const now = new Date().toISOString();
			await updateToolSchemaProjection(db, {
				toolId: tool.id,
				patch: { ...patch, schemaSourceRef: endpoint },
				config: changed.includes("config")
					? toJsonRecord(nextConfig)
					: undefined,
				schemaSourceHash,
				now,
			});

			updated++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "updated",
				changed,
			});
		} catch (error) {
			failed++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "failed",
				changed,
				message: (error as Error).message,
			});
		}
	}

	if (provenanceItems.length > 0) {
		try {
			await refreshToolSchemaProvenance(db, {
				touchIds: provenanceTouchIds,
				certify: provenanceCertify,
				now: new Date().toISOString(),
			});
		} catch (error) {
			for (const item of provenanceItems) {
				item.status = "failed";
				item.message = (error as Error).message;
			}
			inSync -= provenanceItems.length;
			failed += provenanceItems.length;
		}
	}

	const result: ToolSchemaSyncResult = {
		appId,
		mode,
		source,
		target,
		apply,
		total: rpcTools.length,
		planned,
		created,
		updated,
		deleted,
		inSync,
		skipped,
		failed,
		items,
	};
	await publishToolSchemaSyncEvents(env, result);
	return result;
}
