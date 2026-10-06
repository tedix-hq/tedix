/**
 * Cognitive Stack Zod Schemas
 * Validation schemas for knowledge entries, skill entries, and muscle memory.
 */

import * as z from "zod";
import { MUSCLE_KIND, MUSCLE_ORIGIN } from "../constants/enums";
import { JsonValueSchema } from "./common";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

export const KnowledgeEntryTypeSchema = z.enum([
	"insight",
	"pattern",
	"anti_pattern",
	"convention",
	"opinion",
	"decision",
]);
export type KnowledgeEntryType = z.infer<typeof KnowledgeEntryTypeSchema>;

export const CognitiveVisibilitySchema = z.enum(["private", "shared", "org"]);
export type CognitiveVisibility = z.infer<typeof CognitiveVisibilitySchema>;

export const MuscleMemoryKindSchema = z.enum(MUSCLE_KIND);
export type MuscleMemoryKind = z.infer<typeof MuscleMemoryKindSchema>;

export const MuscleMemoryOriginSchema = z.enum(MUSCLE_ORIGIN);
export type MuscleMemoryOrigin = z.infer<typeof MuscleMemoryOriginSchema>;

export const SkillLifecycleStateSchema = z.enum([
	"draft",
	"active",
	"proven",
	"crystallized",
	"stale",
	"archived",
]);
export type SkillLifecycleState = z.infer<typeof SkillLifecycleStateSchema>;

/**
 * Pace-layer classification (WS6): strategic role drives governance rigor.
 * Auto-derived from lifecycle at write time (draft/stale/archived →
 * innovation, active/proven → differentiation, crystallized → record);
 * manual override only via the human/operator force path.
 */
export const SkillPaceLayerSchema = z.enum([
	"innovation",
	"differentiation",
	"record",
]);
export type SkillPaceLayer = z.infer<typeof SkillPaceLayerSchema>;

/**
 * Optional catalog-only hierarchy. It deliberately excludes the skill slug:
 * moving a skill does not change its SEP-2640 resource identity.
 */
export const SkillFolderPathSchema = z
	.string()
	.min(1)
	.max(255)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/,
		"Folder paths must be slash-separated lowercase kebab-case segments",
	);
export type SkillFolderPath = z.infer<typeof SkillFolderPathSchema>;

// =============================================================================
// OBJECT SCHEMAS
// =============================================================================

export const KnowledgeEntrySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable().optional(),
	domainId: z.string().nullable().optional(),
	title: z.string(),
	content: z.string(),
	entryType: KnowledgeEntryTypeSchema,
	sourceFactIds: z.array(z.string()).nullable().optional(),
	sourceCount: z.number(),
	confidence: z.number(),
	revision: z.number(),
	revisionReasoning: z.string().nullable().optional(),
	supersedesId: z.string().nullable().optional(),
	visibility: CognitiveVisibilitySchema,
	tags: z.array(z.string()).nullable().optional(),
	lastValidatedAt: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export const SkillPreconditionsSchema = z.object({
	requires: z.array(z.string()).optional(),
	notWhen: z.array(z.string()).optional(),
	validUntil: z.string().optional(),
	staleSince: z.string().optional(),
});
export type SkillPreconditions = z.infer<typeof SkillPreconditionsSchema>;

export const SkillEntrySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable().optional(),
	/**
	 * Provenance: the tedi that PROPOSED this entry (disposer separation).
	 * The DB column rides every skill_entries row the listing endpoints return
	 * verbatim, and the MCP edge validates structuredContent against this schema
	 * with additionalProperties:false — an unlisted column here hard-fails the
	 * whole tool call (this one broke list_skills_by_org/find_skills live).
	 */
	proposedByTediId: z.string().nullable().optional(),
	domainId: z.string().nullable().optional(),
	title: z.string(),
	slug: z.string().nullable().optional(),
	folderPath: SkillFolderPathSchema.nullable().optional(),
	description: z.string().nullable().optional(),
	content: z.string(),
	/** Optional supporting files for folder-style skills (SEP-2640 directory model). */
	files: z.record(z.string(), z.string()).nullable().optional(),
	inputSchema: z.record(z.string(), JsonValueSchema).nullable().optional(),
	successCount: z.number(),
	failureCount: z.number(),
	lastUsedAt: z.string().nullable().optional(),
	avgDurationMs: z.number().nullable().optional(),
	revision: z.number(),
	revisionReasoning: z.string().nullable().optional(),
	supersedesId: z.string().nullable().optional(),
	sourceSkillId: z.string().nullable().optional(),
	sourceRevision: z.number().nullable().optional(),
	visibility: CognitiveVisibilitySchema,
	agentSkillsFormat: z.string().nullable().optional(),
	r2Path: z.string().nullable().optional(),
	appId: z.string().nullable().optional(),
	toolIds: z.array(z.string()).nullable().optional(),
	summary: z.string().nullable().optional(),
	tags: z.array(z.string()).nullable().optional(),
	audience: z.array(z.string()).nullable().optional(),
	preconditions: SkillPreconditionsSchema.nullable().optional(),
	lifecycleState: SkillLifecycleStateSchema.nullable().optional(),
	/** Crystallized skill recorded a failure — flagged for human review. */
	reviewFlaggedAt: z.string().nullable().optional(),
	reviewFlagReason: z.string().nullable().optional(),
	/** Pace layer — auto-derived from lifecycle and always persisted. */
	paceLayer: SkillPaceLayerSchema,
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const SkillSummarySchema = z.object({
	id: z.string(),
	title: z.string(),
	slug: z.string().nullable().optional(),
	summary: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	tags: z.array(z.string()).nullable().optional(),
	toolIds: z.array(z.string()).nullable().optional(),
	successCount: z.number(),
	revision: z.number(),
	audience: z.array(z.string()).nullable().optional(),
	appId: z.string().nullable().optional(),
	r2Path: z.string().nullable().optional(),
	lifecycleState: SkillLifecycleStateSchema.nullable().optional(),
	paceLayer: SkillPaceLayerSchema,
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillPromotionCandidateSchema = SkillSummarySchema.extend({
	tediId: z.string().nullable().optional(),
	domainId: z.string().nullable().optional(),
	failureCount: z.number(),
	lastUsedAt: z.string().nullable().optional(),
	avgDurationMs: z.number().nullable().optional(),
	visibility: CognitiveVisibilitySchema,
	preconditions: SkillPreconditionsSchema.nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
const SkillPortfolioLayerStatSchema = z.object({
	count: z.number().int().min(0),
	/** Share of the non-archived portfolio (0 when empty). */
	share: z.number().min(0).max(1),
	healthyShare: z.number().min(0).max(1),
	/** share − healthyShare; positive = over-weighted vs the envelope. */
	deviation: z.number().min(-1).max(1),
});

/**
 * Pace-layer portfolio balance (WS6): layer distribution vs the ~75/20/5
 * healthy envelope (record/differentiation/innovation), with a mechanical
 * stagnation flag — all-innovation = churn without compounding, all-record =
 * rigidity without learning.
 */
export const SkillPortfolioBalanceSchema = z.object({
	totalSkills: z.number().int().min(0),
	layers: z.object({
		innovation: SkillPortfolioLayerStatSchema,
		differentiation: SkillPortfolioLayerStatSchema,
		record: SkillPortfolioLayerStatSchema,
	}),
	healthyEnvelope: z.object({
		innovation: z.number(),
		differentiation: z.number(),
		record: z.number(),
	}),
	stagnation: z.boolean(),
	stagnationKind: z.enum(["all_innovation", "all_record"]).nullable(),
});
export type SkillPortfolioBalance = z.infer<typeof SkillPortfolioBalanceSchema>;

export const SkillRunStatusSchema = z.enum([
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"canceled",
]);
export type SkillRunStatus = z.infer<typeof SkillRunStatusSchema>;

const SkillRunRuntimeEnvironmentSchema = z.enum([
	"development",
	"staging",
	"production",
]);
export type SkillRunRuntimeEnvironment = z.infer<
	typeof SkillRunRuntimeEnvironmentSchema
>;

/**
 * Best-effort per-run cost/effort rollup computed from the current execution
 * epoch's durable step evidence at its first terminal observation
 * (completed/failed). Null until that terminal state has been reconciled once.
 */
export const SkillRunCostSummarySchema = z.object({
	schemaVersion: z.literal(1),
	/** Distinct durable steps observed (unique name/count identities in the current epoch). */
	steps: z.number().int().min(0),
	/** Total step attempt records, including first attempts. */
	attempts: z.number().int().min(0),
	/** Attempt records beyond a step's first attempt (attempt > 1). */
	retries: z.number().int().min(0),
	/** Durable MCP tool-call records (calls/** evidence paths). */
	toolCalls: z.number().int().min(0),
	/** Tool-call counts grouped by MCP namespace ("unknown" when unrecorded). */
	toolCallsByNamespace: z.record(z.string(), z.number().int().min(0)),
	/** Sum of recorded step-attempt durations in milliseconds. */
	stepDurationMs: z.number().min(0),
	/** Current-epoch wall-clock completedAt - startedAt in milliseconds (null if unknown). */
	wallMs: z.number().min(0).nullable(),
});
export type SkillRunCostSummary = z.infer<typeof SkillRunCostSummarySchema>;

export const SkillRunSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	skillId: z.string(),
	tediId: z.string(),
	workflowInstanceId: z.string(),
	// Cloudflare reconciliation evidence: the workflow binding namespace this
	// instance was dispatched into.
	runtimeEnvironment: SkillRunRuntimeEnvironmentSchema,
	lastReconciledAt: z
		.string()
		.nullable()
		.optional()
		.describe(
			"When the reconciler last compared the stored row against the Cloudflare Workflows engine. Null until a run has been reconciled once; absent only on projections that predate this field.",
		),
	executionEpoch: z.number().int().min(0).default(0),
	restartRequestedAt: z.string().nullable().optional(),
	workflowRetiredAt: z.string().nullable().optional(),
	status: SkillRunStatusSchema,
	params: z.record(z.string(), JsonValueSchema).nullable().optional(),
	result: z.unknown().nullable().optional(),
	error: z.string().nullable().optional(),
	capabilityManifest: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	pausedAt: z.string().nullable().optional(),
	createdBy: z.string().nullable().optional(),
	workItemId: z.string().nullable().optional(),
	// Populated best-effort at the first terminal (completed/failed)
	// observation; null for in-flight runs and legacy terminal rows that were
	// never re-observed.
	costSummary: SkillRunCostSummarySchema.nullable().optional(),
	// Live engine snapshot from Cloudflare Workflows (only populated by
	// runWorkflowStatus for in-flight runs). Shape varies by engine version
	// — at minimum has `status` and (when finished) `output` / `error`.
	// Treat as an opaque lifecycle snapshot; step/call evidence comes from the
	// dedicated workflow inspection procedures.
	engine: z.record(z.string(), JsonValueSchema).nullable().optional(),
});
export type SkillRun = z.infer<typeof SkillRunSchema>;

export const SkillRunSummarySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	skillId: z.string(),
	tediId: z.string(),
	workflowInstanceId: z.string(),
	runtimeEnvironment: SkillRunRuntimeEnvironmentSchema,
	lastReconciledAt: z.string().nullable(),
	executionEpoch: z.number().int().min(0).default(0),
	restartRequestedAt: z.string().nullable().optional(),
	workflowRetiredAt: z.string().nullable().optional(),
	status: SkillRunStatusSchema,
	skillSlug: z.string().nullable().optional(),
	skillRevision: z.number().nullable().optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	pausedAt: z.string().nullable().optional(),
	createdBy: z.string().nullable().optional(),
	hasResult: z.boolean().default(false),
	hasError: z.boolean().default(false),
	outcome: z
		.enum(["delivered", "progressed", "blocked", "no_action"])
		.nullable()
		.optional(),
	workItemId: z.string().nullable().optional(),
});
export type SkillRunSummary = z.infer<typeof SkillRunSummarySchema>;

export const SkillWorkflowRetryCandidateSchema = z.object({
	runId: z.string(),
	tediId: z.string(),
	skillId: z.string(),
	skillSlug: z.string().nullable(),
	status: z.literal("failed"),
	executionEpoch: z.number().int().min(0),
	restartId: z.string().min(1).max(128),
	failedAt: z.string().nullable(),
	error: z.string().nullable(),
});
export type SkillWorkflowRetryCandidate = z.infer<
	typeof SkillWorkflowRetryCandidateSchema
>;

export const SkillScheduleSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	skillId: z.string(),
	tediId: z.string(),
	cron: z.string(),
	params: z.record(z.string(), JsonValueSchema),
	enabled: z.boolean(),
	nextFireAt: z.string(),
	lastFireAt: z.string().nullable().optional(),
	lastRunId: z.string().nullable().optional(),
	lastError: z.string().nullable().optional(),
	lastBudgetBlockedAt: z.string().nullable().optional(),
	lastBudgetBlockedReason: z.string().nullable().optional(),
	lastBudgetResetAt: z.string().nullable().optional(),
	lastBudgetAdmissionClass: z
		.enum(["background", "governed_learning"])
		.nullable()
		.optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type SkillSchedule = z.infer<typeof SkillScheduleSchema>;

/** Agent-readable projection of one durable Cloudflare Workflow step record. */
export const SkillWorkflowStepSchema = z.object({
	path: z.string(),
	name: z.string(),
	count: z.number().int().min(1),
	executionEpoch: z.number().int().min(0).default(0),
	stepId: z.string().nullable().optional(),
	kind: z.enum([
		"attempt",
		"rollback",
		"tool_call",
		"sleep",
		"sleep_until",
		"wait_for_event",
		"other",
	]),
	attempt: z.number().int().min(1).nullable().optional(),
	ordinal: z.number().int().min(1).nullable().optional(),
	outcome: z.enum(["pending", "success", "failure"]),
	status: z
		.enum(["started", "succeeded", "failed", "waiting", "resolved"])
		.nullable()
		.optional(),
	durationMs: z.number().min(0).nullable().optional(),
	retryable: z.boolean().nullable().optional(),
	sensitiveOutput: z.boolean().nullable().optional(),
	outputArtifactPath: z.string().nullable().optional(),
	error: z.unknown().nullable().optional(),
	provenance: z.literal("step_artifact"),
	mimeType: z.string(),
	sizeBytes: z.number().int().min(0),
	createdAt: z.string().nullable().optional(),
	data: z.unknown().nullable().optional(),
	// Present when `kind` is `tool_call`. Keep these fields on the base step
	// projection because run inspection intentionally includes tool calls in its
	// unified step timeline as well as in the dedicated `toolCalls` collection.
	phase: z.string().nullable().optional(),
	namespace: z.string().nullable().optional(),
	method: z.string().nullable().optional(),
	callId: z.string().nullable().optional(),
	idempotencyKey: z.string().nullable().optional(),
	idempotencyRequested: z.boolean().nullable().optional(),
	providerConfirmation: z.string().nullable().optional(),
});
export type SkillWorkflowStep = z.infer<typeof SkillWorkflowStepSchema>;

export const SkillWorkflowToolCallSchema = SkillWorkflowStepSchema.extend({
	kind: z.literal("tool_call"),
	phase: z.string().nullable().optional(),
	namespace: z.string().nullable().optional(),
	method: z.string().nullable().optional(),
	callId: z.string().nullable().optional(),
	idempotencyKey: z.string().nullable().optional(),
	idempotencyRequested: z.boolean().nullable().optional(),
	providerConfirmation: z.string().nullable().optional(),
});
export type SkillWorkflowToolCall = z.infer<typeof SkillWorkflowToolCallSchema>;

/**
 * A revision observed on an executed workflow run. This is intentionally not
 * presented as the complete skill edit history: unexecuted edits have no run
 * snapshot and therefore do not appear here.
 */
const SkillWorkflowRuntimeProvenanceSchema = z.object({
	workerVersionId: z.string().nullable(),
	workerVersionTag: z.string().nullable(),
	workerVersionTimestamp: z.string().nullable(),
	executionCompatibilityHash: z.string().nullable(),
	dispatchShimVersion: z.string().nullable(),
	compatibilityDate: z.string().nullable(),
	dynamicWorkflowsVersion: z.string().nullable(),
	loaderConfigHash: z.string().nullable(),
	tenantCpuMs: z.number().int().min(0).nullable(),
	tenantSubRequests: z.number().int().min(0).nullable(),
});

export const SkillWorkflowRuntimeVariantSchema =
	SkillWorkflowRuntimeProvenanceSchema.extend({
		runId: z.string(),
		executionEpoch: z.number().int().min(0),
		observation: z.enum(["executed", "compatible", "blocked"]),
		manifestPath: z.string(),
		observedAt: z.string().nullable(),
	});
export type SkillWorkflowRuntimeVariant = z.infer<
	typeof SkillWorkflowRuntimeVariantSchema
>;

export const SkillWorkflowRevisionSchema = z
	.object({
		runId: z.string(),
		skillId: z.string(),
		tediId: z.string(),
		skillSlug: z.string().nullable().optional(),
		revision: z.number().int().nullable().optional(),
		status: SkillRunStatusSchema,
		observedAt: z.string().nullable().optional(),
		observedRunCount: z.number().int().min(1),
		firstObservedAt: z.string().nullable(),
		lastObservedAt: z.string().nullable(),
		completedCount: z.number().int().min(0),
		failedCount: z.number().int().min(0),
		canceledCount: z.number().int().min(0),
		workflowSourceSha256: z.string().nullable(),
		skillDocSha256: z.string().nullable(),
		runtimeVariants: z.array(SkillWorkflowRuntimeVariantSchema),
		runtimeDriftObserved: z.boolean(),
		runtimeDriftBlocked: z.boolean(),
	})
	.extend(SkillWorkflowRuntimeProvenanceSchema.shape);
export type SkillWorkflowRevision = z.infer<typeof SkillWorkflowRevisionSchema>;

export const SkillWorkflowArtifactSummarySchema = z.object({
	path: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().int().min(0),
	outcome: z.enum(["pending", "success", "failure"]),
	attempt: z.number().int().min(1),
	storage: z.enum(["inline", "r2"]),
	createdAt: z.string().nullable().optional(),
	/**
	 * Hex SHA-256 of the stored artifact bytes — re-hash the content and compare
	 * to prove the evidence was not altered. Null for artifacts written before
	 * content-addressing.
	 */
	sha256: z.string().nullable().optional(),
});
export type SkillWorkflowArtifactSummary = z.infer<
	typeof SkillWorkflowArtifactSummarySchema
>;

export const SkillWorkflowReliabilitySchema = z.object({
	scope: z.object({
		skillId: z.string().nullable(),
		tediId: z.string().nullable(),
	}),
	runCount: z.number().int().min(0),
	completedCount: z.number().int().min(0),
	failedCount: z.number().int().min(0),
	canceledCount: z.number().int().min(0),
	activeCount: z.number().int().min(0),
	/** Outcome-aware success: actual terminal status matched the pinned policy. */
	successRate: z.number().min(0).max(1).nullable(),
	/** Raw completed / terminal ratio, independent of expected-outcome policy. */
	completionRate: z.number().min(0).max(1).nullable(),
	expectedOutcomes: z.object({
		evaluatedCount: z.number().int().min(0),
		matchedCount: z.number().int().min(0),
		unexpectedCount: z.number().int().min(0),
		expectedCompletedCount: z.number().int().min(0),
		expectedFailedCount: z.number().int().min(0),
		expectedCanceledCount: z.number().int().min(0),
		unexpectedRuns: z.array(
			z.object({
				runId: z.string(),
				expected: z.enum(["completed", "failed", "canceled"]),
				actual: z.enum(["completed", "failed", "canceled"]),
			}),
		),
	}),
	averageDurationMs: z.number().min(0).nullable(),
	retryAttemptCount: z.number().int().min(0),
	rollbackCount: z.number().int().min(0),
	toolCallCount: z.number().int().min(0),
	failedSteps: z.array(
		z.object({
			name: z.string(),
			count: z.number().int().min(1),
			failures: z.number().int().min(1),
		}),
	),
	warnings: z.array(z.string()),
});
export type SkillWorkflowReliability = z.infer<
	typeof SkillWorkflowReliabilitySchema
>;

export const MuscleMemorySchema = z.object({
	id: z.string(),
	tediId: z.string(),
	organizationId: z.string(),
	kind: MuscleMemoryKindSchema,
	name: z.string(),
	description: z.string().nullable().optional(),
	r2Path: z.string().nullable().optional(),
	usageCount: z.number(),
	successCount: z.number(),
	failureCount: z.number(),
	lastUsedAt: z.string().nullable().optional(),
	origin: MuscleMemoryOriginSchema,
	version: z.number().default(1),
	sourceSkillId: z.string().nullable().optional(),
	codeModule: z.string().nullable().optional(),
	allowedNamespaces: z.array(z.string()).nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type MuscleMemory = z.infer<typeof MuscleMemorySchema>;
