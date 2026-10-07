/**
 * Workflows oRPC Router
 * Clean oRPC endpoints for Cloudflare Workflows
 *
 * This router uses contract-first development with oRPC.
 * Contracts are imported from @tedix/api-contract package.
 *
 * Contract-based endpoints:
 *   GET  /workflows/{workflowId}/status     - Get workflow status
 */

import { implement } from "@orpc/server";
import { dynamicSkillDefinitionId } from "@tedix/api-contract/constants/workflow-definition-keys";
import {
	type WorkflowDefinition,
	type WorkflowDefinitionDriftStatus,
	type WorkflowDefinitionHealth,
	type WorkflowDefinitionHealthStatus,
	type WorkflowStatus,
	type WorkflowType,
	workflowsContract,
} from "@tedix/api-contract/contracts/workflows";
import { listExecutableSkillWorkflowsForOrg } from "@tedix/db/queries/cognitive/skill-inventory";
import {
	listLatestSkillRunsForSkills,
	type SkillRunSummaryRow,
} from "@tedix/db/queries/skill-runs";
import {
	getLatestWorkflowRunRecordsByTypes,
	getRecentWorkflowRunRecords,
} from "@tedix/db/queries/workflow-runs";
import type { WorkflowRunLedger } from "@tedix/db/schema/workflow-runs";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";

// =============================================================================
// CONTRACT IMPLEMENTATION
// =============================================================================

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const workflowsOs = implement(workflowsContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all workflows endpoints require authentication
 */
const authedWorkflowsOs = workflowsOs.use(withAuth);

// =============================================================================
// CONTRACT MIDDLEWARE
// =============================================================================

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Map Cloudflare Workflow status to our simplified status
 */
function mapWorkflowStatus(status: string): WorkflowStatus {
	const statusMap: Record<string, WorkflowStatus> = {
		running: "processing",
		complete: "completed",
		errored: "failed",
		terminated: "failed",
		queued: "queued",
		waiting: "waiting",
		waitingForSleep: "waiting",
	};
	return statusMap[status] || "processing";
}

// =============================================================================
// SHARED HANDLER LOGIC
// =============================================================================

type WorkflowStatusBinding = {
	get(id: string): Promise<{
		status(): Promise<{ status: string; output?: unknown }>;
	}>;
};

type StaticWorkflowDefinition = Extract<
	WorkflowDefinition,
	{ kind: "static_platform" }
>;

function staticWorkflowDefinition(input: {
	workflowType: WorkflowType;
	title: string;
	description: string;
	binding: string;
	entrypoint: string;
	triggers: string[];
	lifecycleState?: "active" | "dormant";
}): StaticWorkflowDefinition {
	return {
		id: `static:${input.workflowType}`,
		kind: "static_platform",
		scope: "platform",
		ownerKind: "platform",
		sourceKind: "deployed_entrypoint",
		engine: "cloudflare_workflows",
		workflowType: input.workflowType,
		title: input.title,
		description: input.description,
		binding: input.binding,
		entrypoint: input.entrypoint,
		triggers: input.triggers,
		lifecycleState: input.lifecycleState ?? "active",
		operatorSurface: {
			namespace: "workflows",
			runTool: null,
			statusTool: "get_workflow_status",
			historyTool: "list_workflow_runs",
			revisionsTool: null,
			mutationMode: "deploy_main",
			mutationTool: null,
		},
	};
}

/** One canonical inventory drives both definition discovery and status lookup. */
export const STATIC_WORKFLOW_DEFINITIONS: readonly StaticWorkflowDefinition[] =
	[
		staticWorkflowDefinition({
			workflowType: "import",
			title: "Import",
			description: "Batch item import and normalization.",
			binding: "IMPORT_WORKFLOW",
			entrypoint: "ImportWorkflow",
			triggers: ["api"],
		}),
		staticWorkflowDefinition({
			workflowType: "mcp_eval",
			title: "MCP evaluation",
			description: "Asynchronous model-powered MCP routing evaluation.",
			binding: "MCP_EVAL_WORKFLOW",
			entrypoint: "McpEvalWorkflow",
			triggers: ["operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "tool_schema_sync",
			title: "Tool schema sync",
			description: "Regenerates app tool schemas from source contracts.",
			binding: "TOOL_SCHEMA_SYNC_WORKFLOW",
			entrypoint: "ToolSchemaSyncWorkflow",
			triggers: ["deploy", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "openapi_sync",
			title: "OpenAPI sync",
			description: "Refreshes generated REST tools and catalog snapshots.",
			binding: "OPENAPI_SYNC_WORKFLOW",
			entrypoint: "OpenApiSyncWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "catalog_sync",
			title: "Catalog sync",
			description: "Synchronizes catalog sources and supplemental registries.",
			binding: "CATALOG_SYNC_WORKFLOW",
			entrypoint: "CatalogSyncWorkflow",
			triggers: ["cron", "api"],
		}),
		staticWorkflowDefinition({
			workflowType: "catalog_integrity",
			title: "Catalog integrity",
			description: "Audits and safely repairs catalog integrity.",
			binding: "CATALOG_INTEGRITY_WORKFLOW",
			entrypoint: "CatalogIntegrityWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "catalog_drift",
			title: "Catalog drift",
			description: "Detects upstream catalog drift and gates synchronization.",
			binding: "CATALOG_DRIFT_WORKFLOW",
			entrypoint: "CatalogDriftWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "catalog_enrichment",
			title: "Catalog enrichment",
			description: "Repairs and enriches catalog assets and metadata.",
			binding: "CATALOG_ENRICHMENT_WORKFLOW",
			entrypoint: "CatalogEnrichmentWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "mcp_scan",
			title: "MCP scan",
			description: "Scans MCP endpoint health and schemas.",
			binding: "MCP_SCAN_WORKFLOW",
			entrypoint: "McpScanWorkflow",
			triggers: ["cron"],
		}),
		staticWorkflowDefinition({
			workflowType: "tool_test",
			title: "MCP tool test",
			description: "Validates tool execution after catalog scans.",
			binding: "TOOL_TEST_WORKFLOW",
			entrypoint: "McpToolTestWorkflow",
			triggers: ["cron"],
		}),
		staticWorkflowDefinition({
			workflowType: "tedi_mcp_access_health",
			title: "Tedi MCP access health",
			description: "Detects and optionally repairs tedi MCP assignment drift.",
			binding: "TEDI_MCP_ACCESS_HEALTH_WORKFLOW",
			entrypoint: "TediMcpAccessHealthWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "memory_reflection",
			title: "Memory reflection",
			description: "Runs memory reflection, decay, and edge discovery.",
			binding: "MEMORY_REFLECTION_WORKFLOW",
			entrypoint: "MemoryReflectionWorkflow",
			triggers: ["cron"],
		}),
		staticWorkflowDefinition({
			workflowType: "graph_projection",
			title: "Graph projection drain",
			description:
				"Drains the ordered D1 graph outbox, cleans prior generations, and certifies Neo4j readiness.",
			binding: "GRAPH_PROJECTION_DRAIN_WORKFLOW",
			entrypoint: "GraphProjectionDrainWorkflow",
			triggers: ["cron", "operator"],
		}),
		staticWorkflowDefinition({
			workflowType: "graph_gds_refresh",
			title: "Graph GDS refresh",
			description:
				"Durably refreshes Neo4j GDS properties and stamps the exact D1 projection epoch and watermark.",
			binding: "GRAPH_GDS_REFRESH_WORKFLOW",
			entrypoint: "GraphGdsRefreshWorkflow",
			triggers: ["operator", "mcp"],
		}),
		staticWorkflowDefinition({
			workflowType: "approval",
			title: "Approval",
			description: "Processes durable human approval queues.",
			binding: "APPROVAL_WORKFLOW",
			entrypoint: "ApprovalWorkflow",
			triggers: ["api"],
		}),
		staticWorkflowDefinition({
			workflowType: "content_sync",
			title: "Content sync",
			description: "Synchronizes content across configured sources.",
			binding: "CONTENT_SYNC_WORKFLOW",
			entrypoint: "ContentSyncWorkflow",
			triggers: ["api", "internal"],
		}),
		staticWorkflowDefinition({
			workflowType: "content_ingestion",
			title: "Content ingestion",
			description: "Ingests URL, sitemap, RSS, and PDF sources.",
			binding: "CONTENT_INGESTION_WORKFLOW",
			entrypoint: "ContentIngestionWorkflow",
			triggers: ["api", "internal"],
		}),
		staticWorkflowDefinition({
			workflowType: "goal_loop",
			title: "Kernel goal loop",
			description: "Runs the governed durable Home goal loop.",
			binding: "KERNEL_GOAL_LOOP_WORKFLOW",
			entrypoint: "KernelGoalLoopWorkflow",
			triggers: ["home", "operator"],
		}),
	];

function workflowStatusBinding(
	env: CloudflareEnv,
	bindingName: string,
): WorkflowStatusBinding | undefined {
	return (env as unknown as Record<string, WorkflowStatusBinding | undefined>)[
		bindingName
	];
}

function workflowStatusBindings(env: CloudflareEnv): Array<{
	type: WorkflowType;
	binding: WorkflowStatusBinding | undefined;
}> {
	return STATIC_WORKFLOW_DEFINITIONS.map((definition) => ({
		type: definition.workflowType,
		binding: workflowStatusBinding(env, definition.binding),
	}));
}

/**
 * Core logic for getting workflow status across platform Workflow bindings.
 */
async function handleGetStatus(workflowId: string, context: BaseContext) {
	const { env } = context;

	for (const candidate of workflowStatusBindings(env)) {
		if (!candidate.binding) continue;
		try {
			const instance = await candidate.binding.get(workflowId);
			const status = await instance.status();
			return {
				id: workflowId,
				status: mapWorkflowStatus(status.status),
				workflowType: candidate.type,
				output: status.status === "complete" ? status.output : null,
			};
		} catch {}
	}

	throw createError(
		ErrorCodes.NOT_FOUND,
		`Workflow ${workflowId} not found in any platform workflow binding`,
	);
}

async function handleListDefinitions(
	input: {
		kind?: "static_platform" | "dynamic_skill";
		lifecycleState?:
			| "draft"
			| "active"
			| "proven"
			| "crystallized"
			| "stale"
			| "archived";
		limit: number;
		offset: number;
		query?: string;
	},
	context: BaseContext,
) {
	const orgId = requireOrgId(context);
	const includeStatic =
		input.kind !== "dynamic_skill" && input.lifecycleState == null;
	const includeDynamic = input.kind !== "static_platform";
	const query = input.query?.trim().toLowerCase();
	const staticDefinitions = includeStatic
		? STATIC_WORKFLOW_DEFINITIONS.filter((definition) =>
				query
					? [definition.title, definition.description, definition.workflowType]
							.filter(Boolean)
							.join(" ")
							.toLowerCase()
							.includes(query)
					: true,
			)
		: [];
	const staticPage = staticDefinitions.slice(
		input.offset,
		input.offset + input.limit,
	);
	const remaining = input.limit - staticPage.length;
	const dynamicOffset = Math.max(0, input.offset - staticDefinitions.length);

	let dynamicTotal = 0;
	let dynamicDefinitions: WorkflowDefinition[] = [];
	if (includeDynamic) {
		const dynamic = await listExecutableSkillWorkflowsForOrg(
			context.db,
			orgId,
			{
				lifecycleState: input.lifecycleState,
				limit: Math.max(1, remaining),
				offset: remaining > 0 ? dynamicOffset : 0,
				query,
			},
		);
		dynamicTotal = dynamic.total;
		if (remaining > 0) {
			dynamicDefinitions = dynamic.entries.map((skill) => ({
				id: dynamicSkillDefinitionId(skill.id),
				kind: "dynamic_skill" as const,
				scope: "organization" as const,
				ownerKind: "tenant" as const,
				sourceKind: "revisioned_skill_source" as const,
				engine: "cloudflare_workflows" as const,
				skillId: skill.id,
				skillSlug: skill.slug ?? null,
				skillRevision: skill.revision,
				tediId: skill.tediId ?? null,
				title: skill.title,
				description: skill.description ?? null,
				binding: "WORKFLOWS",
				entrypoint: "SkillWorkflow",
				triggers: ["operator", "skill_schedule"],
				lifecycleState: skill.lifecycleState ?? null,
				updatedAt: skill.updatedAt ?? null,
				operatorSurface: {
					namespace: "skills" as const,
					runTool: "run_skill_workflow",
					statusTool: "get_skill_workflow_status",
					historyTool: "list_skill_workflow_history",
					revisionsTool: "list_skill_workflow_revisions",
					mutationMode: "governed_skill_revision" as const,
					mutationTool: "propose_skill_workflow_improvement",
				},
			}));
		}
	}

	const definitions: WorkflowDefinition[] = [
		...staticPage,
		...dynamicDefinitions,
	];
	const counts = {
		staticPlatform: staticDefinitions.length,
		dynamicSkill: dynamicTotal,
		total: staticDefinitions.length + dynamicTotal,
	};
	const nextOffset = input.offset + definitions.length;

	return {
		definitions,
		counts,
		offset: input.offset,
		limit: input.limit,
		truncated: nextOffset < counts.total,
		nextOffset: nextOffset < counts.total ? nextOffset : null,
	};
}

type DefinitionRunEvidence = WorkflowDefinitionHealth["latestRun"];

type DefinitionHealthEvidence = {
	surfaceAvailable: boolean;
	checkedAt: string;
	latestRun: DefinitionRunEvidence;
};

/**
 * Evidence-honest health classification shared by the API handler and tests.
 * Missing history is unknown, not unhealthy; a failed dynamic run needs
 * outcome inspection because some skills intentionally expect failure.
 */
export function deriveWorkflowDefinitionHealth(
	definition: WorkflowDefinition,
	evidence: DefinitionHealthEvidence,
): WorkflowDefinitionHealth {
	const currentRevision =
		definition.kind === "dynamic_skill" ? definition.skillRevision : null;
	const lifecycleState = definition.lifecycleState ?? null;
	const executionSurface = {
		kind:
			definition.kind === "static_platform"
				? ("platform_workflow_binding" as const)
				: ("skill_runtime_service" as const),
		binding:
			definition.kind === "static_platform"
				? definition.binding
				: "SKILL_RUNTIME",
		available: evidence.surfaceAvailable,
		checkedAt: evidence.checkedAt,
	};
	const notes: string[] = [];

	let driftStatus: WorkflowDefinitionDriftStatus;
	if (
		definition.lifecycleState === "dormant" ||
		definition.lifecycleState === "archived"
	) {
		driftStatus = "not_applicable";
	} else if (!evidence.surfaceAvailable) {
		driftStatus = "missing_execution_surface";
	} else if (!evidence.latestRun) {
		driftStatus = "unobserved";
	} else if (definition.kind === "static_platform") {
		driftStatus = "in_sync";
	} else if (evidence.latestRun.observedRevision == null) {
		driftStatus = "unknown_revision";
	} else if (evidence.latestRun.observedRevision < definition.skillRevision) {
		driftStatus = "unexecuted_revision";
	} else if (evidence.latestRun.observedRevision > definition.skillRevision) {
		driftStatus = "revision_mismatch";
	} else {
		driftStatus = "in_sync";
	}

	let healthStatus: WorkflowDefinitionHealthStatus;
	if (
		definition.lifecycleState === "dormant" ||
		definition.lifecycleState === "archived"
	) {
		healthStatus = "dormant";
		notes.push("lifecycle_not_expected_to_run");
	} else if (!evidence.surfaceAvailable) {
		healthStatus = "degraded";
		notes.push("execution_surface_unavailable");
	} else if (
		definition.kind === "dynamic_skill" &&
		(definition.lifecycleState === "draft" ||
			definition.lifecycleState === "stale")
	) {
		healthStatus = "attention";
		notes.push("lifecycle_requires_operator_review");
	} else if (!evidence.latestRun) {
		healthStatus = "unknown";
		notes.push("no_durable_run_evidence");
	} else if (driftStatus === "revision_mismatch") {
		healthStatus = "degraded";
		notes.push("observed_revision_ahead_of_definition");
	} else if (driftStatus === "unexecuted_revision") {
		healthStatus = "attention";
		notes.push("current_revision_not_yet_observed");
	} else if (driftStatus === "unknown_revision") {
		healthStatus = "attention";
		notes.push("legacy_run_missing_revision_evidence");
	} else if (
		evidence.latestRun.status === "queued" ||
		evidence.latestRun.status === "running" ||
		evidence.latestRun.status === "paused"
	) {
		healthStatus = "active";
		notes.push("run_snapshot_is_non_terminal");
	} else if (evidence.latestRun.status === "completed") {
		healthStatus = "healthy";
		notes.push("latest_current_evidence_completed");
	} else {
		healthStatus = "attention";
		notes.push("latest_terminal_outcome_needs_inspection");
	}

	return {
		definitionId: definition.id,
		title: definition.title,
		kind: definition.kind,
		lifecycleState,
		currentRevision,
		healthStatus,
		driftStatus,
		executionSurface,
		latestRun: evidence.latestRun,
		notes,
	};
}

function staticRunEvidence(
	run: WorkflowRunLedger | undefined,
): DefinitionRunEvidence {
	if (!run) return null;
	return {
		id: run.workflowId,
		status: run.status,
		startedAt: run.startedAt,
		completedAt: run.completedAt ?? null,
		observedRevision: null,
		lastReconciledAt: null,
		source: "workflow_run_ledger",
	};
}

function dynamicRunEvidence(
	run: SkillRunSummaryRow | undefined,
): DefinitionRunEvidence {
	if (!run) return null;
	return {
		id: run.id,
		status: run.status,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		observedRevision: run.skillRevision,
		lastReconciledAt: run.lastReconciledAt,
		source: "skill_runs_snapshot",
	};
}

async function probeSkillRuntimeSurface(env: CloudflareEnv): Promise<boolean> {
	const binding = (env as { SKILL_RUNTIME?: Fetcher }).SKILL_RUNTIME;
	if (!binding) return false;
	try {
		const response = await binding.fetch("https://skill-runtime/health");
		if (!response.ok) return false;
		const payload = (await response.json()) as { ok?: unknown };
		return payload.ok === true;
	} catch {
		return false;
	}
}

async function handleListDefinitionHealth(
	input: {
		kind?: "static_platform" | "dynamic_skill";
		lifecycleState?:
			| "draft"
			| "active"
			| "proven"
			| "crystallized"
			| "stale"
			| "archived";
		limit: number;
		offset: number;
		query?: string;
	},
	context: BaseContext,
) {
	const orgId = requireOrgId(context);
	const catalog = await handleListDefinitions(input, context);
	const evaluatedAt = new Date().toISOString();
	const staticDefinitions = catalog.definitions.filter(
		(
			definition,
		): definition is Extract<WorkflowDefinition, { kind: "static_platform" }> =>
			definition.kind === "static_platform",
	);
	const dynamicDefinitions = catalog.definitions.filter(
		(
			definition,
		): definition is Extract<WorkflowDefinition, { kind: "dynamic_skill" }> =>
			definition.kind === "dynamic_skill",
	);

	const [staticRuns, dynamicRuns, dynamicSurfaceAvailable] = await Promise.all([
		getLatestWorkflowRunRecordsByTypes(
			context.db,
			staticDefinitions.map((definition) => definition.workflowType),
		),
		listLatestSkillRunsForSkills(
			context.db,
			orgId,
			dynamicDefinitions.map((definition) => definition.skillId),
			context.env.ENVIRONMENT,
		),
		dynamicDefinitions.length > 0
			? probeSkillRuntimeSurface(context.env)
			: Promise.resolve(false),
	]);
	const staticRunsByType = new Map(
		staticRuns.map((run) => [run.workflowType, run]),
	);
	const dynamicRunsBySkill = new Map(
		dynamicRuns.map((run) => [run.skillId, run]),
	);

	const health = catalog.definitions.map((definition) =>
		deriveWorkflowDefinitionHealth(definition, {
			surfaceAvailable:
				definition.kind === "static_platform"
					? workflowStatusBinding(context.env, definition.binding) != null
					: dynamicSurfaceAvailable,
			checkedAt: evaluatedAt,
			latestRun:
				definition.kind === "static_platform"
					? staticRunEvidence(staticRunsByType.get(definition.workflowType))
					: dynamicRunEvidence(dynamicRunsBySkill.get(definition.skillId)),
		}),
	);
	const pageCounts: Record<WorkflowDefinitionHealthStatus, number> = {
		healthy: 0,
		active: 0,
		attention: 0,
		unknown: 0,
		degraded: 0,
		dormant: 0,
	};
	for (const entry of health) pageCounts[entry.healthStatus]++;

	return {
		health,
		definitionCounts: catalog.counts,
		pageCounts,
		evaluatedAt,
		offset: catalog.offset,
		limit: catalog.limit,
		truncated: catalog.truncated,
		nextOffset: catalog.nextOffset,
	};
}

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based getStatus procedure implementation
 * Uses workflowsContract.getStatus schema enforcement
 */
export const getStatusContract = authedWorkflowsOs.getStatus
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { workflowId } = input;
		const workflow = await handleGetStatus(workflowId, context);

		return {
			data: workflow,
		};
	});

export const listDefinitionsContract = authedWorkflowsOs.listDefinitions
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => handleListDefinitions(input, context));

export const listDefinitionHealthContract =
	authedWorkflowsOs.listDefinitionHealth
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) =>
			handleListDefinitionHealth(input, context),
		);

export const listRunsContract = authedWorkflowsOs.listRuns
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const runs = await getRecentWorkflowRunRecords(context.db, {
			workflowType: input.workflowType,
			limit: input.limit,
		});

		return {
			runs: runs.map((run) => ({
				id: run.id,
				workflowType: run.workflowType,
				workflowId: run.workflowId,
				trigger: run.trigger,
				target: run.target ?? null,
				status: run.status,
				startedAt: run.startedAt,
				completedAt: run.completedAt ?? null,
				totalCount: run.totalCount ?? null,
				successCount: run.successCount ?? null,
				errorCount: run.errorCount ?? null,
				output: run.output ?? null,
				error: run.error ?? null,
			})),
		};
	});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const workflowsContractRouter = authedWorkflowsOs.router({
	getStatus: getStatusContract,
	listDefinitions: listDefinitionsContract,
	listDefinitionHealth: listDefinitionHealthContract,
	listRuns: listRunsContract,
});
