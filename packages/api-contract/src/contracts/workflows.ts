import "@orpc/openapi/extensions/route";
/**
 * Workflows Contract for oRPC
 * Type-safe API contract for Cloudflare Workflow endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SkillLifecycleStateSchema } from "../schemas/cognitive";
import { JsonValueSchema } from "../schemas/common";

// =============================================================================
// LOCAL SCHEMAS
// =============================================================================

/**
 * Workflow ID parameter for contract paths
 */
export const WorkflowIdParamSchema = z.object({
	workflowId: z.string().min(1, "Workflow ID is required"),
});
export type WorkflowIdParam = z.infer<typeof WorkflowIdParamSchema>;

/**
 * Workflow status mapping
 */
export const WorkflowStatusSchema = z.enum([
	"queued",
	"processing",
	"waiting",
	"completed",
	"failed",
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

/**
 * Workflow type discriminator
 */
export const WorkflowTypeSchema = z.enum([
	"import",
	"mcp_eval",
	"tool_schema_sync",
	"openapi_sync",
	"catalog_sync",
	"catalog_integrity",
	"catalog_drift",
	"catalog_enrichment",
	"mcp_scan",
	"tool_test",
	"tedi_mcp_access_health",
	"memory_reflection",
	"graph_projection",
	"graph_gds_refresh",
	"approval",
	"content_sync",
	"content_ingestion",
	"goal_loop",
]);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

/**
 * Canonical workflow-definition boundary.
 *
 * A static platform workflow is deployed code. A dynamic skill workflow is a
 * tenant-owned, revisioned definition interpreted by the one deployed
 * SkillWorkflow entrypoint. Both use Cloudflare Workflows for durable engine
 * semantics; `kind` describes code ownership and mutation, not a second engine.
 */
export const WorkflowDefinitionKindSchema = z.enum([
	"static_platform",
	"dynamic_skill",
]);
export type WorkflowDefinitionKind = z.infer<
	typeof WorkflowDefinitionKindSchema
>;

const WorkflowOperatorSurfaceSchema = z.object({
	namespace: z.enum(["workflows", "skills"]),
	runTool: z.string().nullable(),
	statusTool: z.string(),
	historyTool: z.string(),
	revisionsTool: z.string().nullable(),
	mutationMode: z.enum(["deploy_main", "governed_skill_revision"]),
	mutationTool: z.string().nullable(),
});

const WorkflowDefinitionBaseSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().nullable(),
	engine: z.literal("cloudflare_workflows"),
	binding: z.string(),
	entrypoint: z.string(),
	triggers: z.array(z.string()),
	operatorSurface: WorkflowOperatorSurfaceSchema,
});

export const StaticPlatformWorkflowDefinitionSchema =
	WorkflowDefinitionBaseSchema.extend({
		kind: z.literal("static_platform"),
		scope: z.literal("platform"),
		ownerKind: z.literal("platform"),
		sourceKind: z.literal("deployed_entrypoint"),
		workflowType: WorkflowTypeSchema,
		lifecycleState: z.enum(["active", "dormant"]),
	});

export const DynamicSkillWorkflowDefinitionSchema =
	WorkflowDefinitionBaseSchema.extend({
		kind: z.literal("dynamic_skill"),
		scope: z.literal("organization"),
		ownerKind: z.literal("tenant"),
		sourceKind: z.literal("revisioned_skill_source"),
		skillId: z.string(),
		skillSlug: z.string().nullable(),
		skillRevision: z.number().int().positive(),
		tediId: z.string().nullable(),
		lifecycleState: SkillLifecycleStateSchema.nullable(),
		updatedAt: z.string().nullable(),
	});

export const WorkflowDefinitionSchema = z.discriminatedUnion("kind", [
	StaticPlatformWorkflowDefinitionSchema,
	DynamicSkillWorkflowDefinitionSchema,
]);
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

const WorkflowDefinitionsInputSchema = z
	.object({
		kind: WorkflowDefinitionKindSchema.optional(),
		lifecycleState: SkillLifecycleStateSchema.optional().describe(
			"Dynamic-skill lifecycle filter; static definitions are omitted when set",
		),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
		query: z
			.string()
			.trim()
			.max(120)
			.optional()
			.describe("Optional title, description, type, or skill metadata search"),
	})
	.superRefine((value, ctx) => {
		if (value.kind === "static_platform" && value.lifecycleState) {
			ctx.addIssue({
				code: "custom",
				path: ["lifecycleState"],
				message:
					"lifecycleState applies only to dynamic_skill workflow definitions",
			});
		}
	});

const WorkflowDefinitionsOutputSchema = z.object({
	definitions: z.array(WorkflowDefinitionSchema),
	counts: z.object({
		staticPlatform: z.number().int().nonnegative(),
		dynamicSkill: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	offset: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	truncated: z.boolean(),
	nextOffset: z.number().int().nonnegative().nullable(),
});

export const WorkflowDefinitionHealthStatusSchema = z.enum([
	"healthy",
	"active",
	"attention",
	"unknown",
	"degraded",
	"dormant",
]);
export type WorkflowDefinitionHealthStatus = z.infer<
	typeof WorkflowDefinitionHealthStatusSchema
>;

export const WorkflowDefinitionDriftStatusSchema = z.enum([
	"in_sync",
	"unobserved",
	"unexecuted_revision",
	"unknown_revision",
	"revision_mismatch",
	"missing_execution_surface",
	"not_applicable",
]);
export type WorkflowDefinitionDriftStatus = z.infer<
	typeof WorkflowDefinitionDriftStatusSchema
>;

const WorkflowDefinitionRunEvidenceSchema = z.object({
	id: z.string(),
	status: z.enum([
		"queued",
		"running",
		"paused",
		"completed",
		"failed",
		"canceled",
	]),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	observedRevision: z.number().int().positive().nullable(),
	lastReconciledAt: z.string().nullable(),
	source: z.enum(["workflow_run_ledger", "skill_runs_snapshot"]),
});

const WorkflowExecutionSurfaceHealthSchema = z.object({
	kind: z.enum(["platform_workflow_binding", "skill_runtime_service"]),
	binding: z.string(),
	available: z.boolean(),
	checkedAt: z.string(),
});

export const WorkflowDefinitionHealthSchema = z.object({
	definitionId: z.string(),
	title: z.string(),
	kind: WorkflowDefinitionKindSchema,
	lifecycleState: z.string().nullable(),
	currentRevision: z.number().int().positive().nullable(),
	healthStatus: WorkflowDefinitionHealthStatusSchema,
	driftStatus: WorkflowDefinitionDriftStatusSchema,
	executionSurface: WorkflowExecutionSurfaceHealthSchema,
	latestRun: WorkflowDefinitionRunEvidenceSchema.nullable(),
	notes: z.array(z.string()),
});
export type WorkflowDefinitionHealth = z.infer<
	typeof WorkflowDefinitionHealthSchema
>;

const WorkflowDefinitionHealthOutputSchema = z.object({
	health: z.array(WorkflowDefinitionHealthSchema),
	definitionCounts: z.object({
		staticPlatform: z.number().int().nonnegative(),
		dynamicSkill: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	pageCounts: z.object({
		healthy: z.number().int().nonnegative(),
		active: z.number().int().nonnegative(),
		attention: z.number().int().nonnegative(),
		unknown: z.number().int().nonnegative(),
		degraded: z.number().int().nonnegative(),
		dormant: z.number().int().nonnegative(),
	}),
	evaluatedAt: z.string(),
	offset: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	truncated: z.boolean(),
	nextOffset: z.number().int().nonnegative().nullable(),
});

/** Shared MCP UI projection for the definition catalog's output contract. */
export const WORKFLOW_DEFINITIONS_WIDGET = {
	layoutId: "workflow-definitions",
	description: "Static platform and dynamic tenant workflow ownership catalog.",
	layoutSpec: {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 4 },
				children: ["summary", "definitions"],
			},
			summary: {
				type: "KeyValuePanel",
				props: {
					variant: "plain",
					columns: 3,
					items: [
						{
							label: "Static platform",
							value: { $state: "/counts/staticPlatform" },
						},
						{
							label: "Dynamic skill",
							value: { $state: "/counts/dynamicSkill" },
						},
						{ label: "Total", value: { $state: "/counts/total" } },
					],
				},
				children: [],
			},
			definitions: {
				type: "DataTable",
				props: {
					data: { $state: "/definitions" },
					columns: [
						{
							field: "title",
							header: "Workflow",
							format: "text",
							sortable: true,
						},
						{
							field: "kind",
							header: "Kind",
							format: "badge",
							sortable: true,
						},
						{
							field: "ownerKind",
							header: "Owner",
							format: "badge",
							sortable: true,
						},
						{
							field: "sourceKind",
							header: "Source",
							format: "badge",
							sortable: true,
						},
						{
							field: "lifecycleState",
							header: "Lifecycle",
							format: "badge",
							sortable: true,
						},
						{
							field: "binding",
							header: "Binding",
							format: "text",
							sortable: true,
						},
					],
					pageSize: 20,
					compact: true,
					striped: true,
				},
				children: [],
			},
		},
	},
} satisfies {
	layoutId: string;
	description: string;
	layoutSpec: Record<string, unknown>;
};

/** Shared MCP UI projection for operational workflow health and drift. */
export const WORKFLOW_HEALTH_WIDGET = {
	layoutId: "workflow-health",
	description:
		"Tenant-safe execution-surface, run-evidence, and definition-drift health.",
	layoutSpec: {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 4 },
				children: ["summary", "health"],
			},
			summary: {
				type: "KeyValuePanel",
				props: {
					variant: "plain",
					columns: 3,
					items: [
						{ label: "Healthy", value: { $state: "/pageCounts/healthy" } },
						{ label: "Active", value: { $state: "/pageCounts/active" } },
						{
							label: "Attention",
							value: { $state: "/pageCounts/attention" },
						},
						{ label: "Unknown", value: { $state: "/pageCounts/unknown" } },
						{
							label: "Degraded",
							value: { $state: "/pageCounts/degraded" },
						},
						{ label: "Dormant", value: { $state: "/pageCounts/dormant" } },
					],
				},
				children: [],
			},
			health: {
				type: "DataTable",
				props: {
					data: { $state: "/health" },
					columns: [
						{
							field: "title",
							header: "Workflow",
							format: "text",
							sortable: true,
						},
						{
							field: "kind",
							header: "Kind",
							format: "badge",
							sortable: true,
						},
						{
							field: "healthStatus",
							header: "Health",
							format: "badge",
							sortable: true,
						},
						{
							field: "driftStatus",
							header: "Drift",
							format: "badge",
							sortable: true,
						},
						{
							field: "lifecycleState",
							header: "Lifecycle",
							format: "badge",
							sortable: true,
						},
						{
							field: "currentRevision",
							header: "Revision",
							format: "number",
							sortable: true,
						},
					],
					pageSize: 20,
					compact: true,
					striped: true,
				},
				children: [],
			},
		},
	},
} satisfies {
	layoutId: string;
	description: string;
	layoutSpec: Record<string, unknown>;
};

/**
 * Workflow status response schema
 */
const WorkflowStatusResponseSchema = z.object({
	id: z.string(),
	status: WorkflowStatusSchema,
	workflowType: WorkflowTypeSchema,
	output: JsonValueSchema.nullable(),
});

// Ledger history preserves data-owned types after an executable is retired.
const WorkflowRunRecordSchema = z.object({
	id: z.string(),
	workflowType: z.string().min(1),
	workflowId: z.string(),
	trigger: z.string(),
	target: z.string().nullable(),
	status: z.enum(["queued", "running", "completed", "failed"]),
	startedAt: z.string(),
	completedAt: z.string().nullable(),
	totalCount: z.number().nullable(),
	successCount: z.number().nullable(),
	errorCount: z.number().nullable(),
	output: JsonValueSchema.nullable(),
	error: z.string().nullable(),
});

const WorkflowRunsInputSchema = z.object({
	workflowType: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

const WorkflowRunsOutputSchema = z.object({
	runs: z.array(WorkflowRunRecordSchema),
});

// =============================================================================
// CONTRACT DEFINITION
// =============================================================================

/**
 * Workflows contract defining all workflow-related endpoints
 * Tagged as 'internal' since these are background operations
 *
 * Endpoints:
 * - GET /workflows/{workflowId}/status - Get workflow status
 */
export const workflowsContract = oc
	.route({ tags: ["workflows", "internal"] })
	.router({
		/**
		 * GET /workflows/{workflowId}/status - Get workflow status
		 */
		getStatus: oc
			.route({
				method: "GET",
				path: "/workflows/{workflowId}/status",
				summary: "Get workflow status",
				description:
					"Get the current status of a Cloudflare Workflow by instance ID",
			})
			.input(WorkflowIdParamSchema)
			.output(
				z.object({
					data: WorkflowStatusResponseSchema,
				}),
			),

		listDefinitions: oc
			.route({
				method: "GET",
				path: "/workflows/definitions",
				summary: "List static and dynamic workflow definitions",
				description:
					"List the platform's deployed WorkflowEntrypoints and the current tenant's revisioned executable skill workflows with explicit ownership, source, mutation, and operator surfaces",
			})
			.input(WorkflowDefinitionsInputSchema)
			.output(WorkflowDefinitionsOutputSchema),

		listDefinitionHealth: oc
			.route({
				method: "GET",
				path: "/workflows/definition-health",
				summary: "List workflow definition health and drift",
				description:
					"Evaluate the current tenant's static and dynamic workflow definitions against executable runtime surfaces and latest durable run evidence without treating missing history as failure",
			})
			.input(WorkflowDefinitionsInputSchema)
			.output(WorkflowDefinitionHealthOutputSchema),

		listRuns: oc
			.route({
				method: "GET",
				path: "/workflows/runs",
				summary: "List workflow run ledger records",
				description:
					"List recent platform workflow run records created by scheduled and operator workflows",
			})
			.input(WorkflowRunsInputSchema)
			.output(WorkflowRunsOutputSchema),
	});

export type WorkflowsContract = typeof workflowsContract;
