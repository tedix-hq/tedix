import * as z from "zod";

export const WorkSchedulerExecutorSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("tedi"),
		id: z.string().min(1),
	}),
	z.strictObject({
		type: z.literal("external_agent"),
		id: z.string().min(1),
		sessionId: z.string().min(1),
	}),
]);

export const WorkSchedulerFactorSchema = z.strictObject({
	factor: z.enum([
		"priority",
		"urgency",
		"aging_fairness",
		"downstream_impact",
		"critical_path",
		"risk",
		"estimated_cost",
		"verification_backpressure",
	]),
	value: z.number(),
	contribution: z.number().int(),
	explanation: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Prose rationale for this factor. Present only under verbosity=full; the factor name, value, and contribution are always emitted so the ranking stays inspectable.",
		),
});

export const WorkSchedulerReadyItemSchema = z.strictObject({
	workItemId: z.string().min(1),
	title: z.string().min(1),
	workKind: z.enum([
		"coding",
		"research",
		"document",
		"design",
		"browser",
		"operations",
		"communication",
		"finance",
		"legal",
		"stewardship",
		"incident",
		"other",
	]),
	priority: z.enum(["critical", "high", "medium", "low"]),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	projectId: z
		.string()
		.nullable()
		.describe(
			"Nullable for organization-scoped Work that is not filed in a project.",
		),
	parentWorkItemId: z
		.string()
		.nullable()
		.describe("Nullable for top-level Work without a coordination parent."),
	dueDate: z
		.string()
		.nullable()
		.describe("Nullable when no preferred completion date has been assigned."),
	deadline: z
		.string()
		.nullable()
		.describe("Nullable when Work has no hard execution deadline."),
	score: z.number().int(),
	factors: z.array(WorkSchedulerFactorSchema).length(8),
	eligibility: z.strictObject({
		state: z.literal("ready"),
		explanation: z
			.string()
			.min(1)
			.optional()
			.describe("Prose rationale; present only under verbosity=full."),
	}),
	taskGuidance: z.strictObject({
		taskClass: z.enum(["atomic", "verification_heavy"]),
		fanout: z.literal("single_executor"),
		recommendedMaxParallelism: z.literal(1),
		explanation: z
			.string()
			.min(1)
			.optional()
			.describe("Prose rationale; present only under verbosity=full."),
	}),
});

export const WorkSchedulerVerbositySchema = z
	.enum(["compact", "full"])
	.describe(
		"Receipt verbosity. `compact` (default) omits every prose `explanation` string while keeping all eight factor values and contributions; `full` restores the prose.",
	);

export const WorkSchedulerReadyQueueSchema = z.strictObject({
	policyRevision: z.literal("work-scheduler/v1"),
	verbosity: WorkSchedulerVerbositySchema,
	observedAt: z.iso.datetime(),
	evaluatedCandidates: z.number().int().nonnegative(),
	ineligibleByReason: z.record(
		z.enum([
			"not_accepted",
			"already_running",
			"already_admitted",
			"purpose_blocked",
			"dependencies_blocked",
			"capability_blocked",
			"approval_blocked",
			"budget_blocked",
			"resource_blocked",
			"evaluation_required",
			"coordination_parent",
			"cost_blocked",
		]),
		z.number().int().nonnegative(),
	),
	items: z.array(WorkSchedulerReadyItemSchema),
	nextCursor: z
		.string()
		.max(500)
		.nullable()
		.describe("Null when no further eligible scheduler page remains."),
	boundedCandidateLimit: z.number().int().min(1).max(500),
	graphTruncated: z
		.boolean()
		.describe(
			"True when bounded dependency traversal can only provide a partial ranking.",
		),
	factsTruncated: z
		.boolean()
		.describe(
			"True when a bounded hard-gate fact set overflowed; affected candidates fail closed as evaluation_required.",
		),
	truncatedFacts: z
		.array(
			z.enum([
				"dependencies",
				"capabilities",
				"approvals",
				"resources",
				"budgets",
				"cases",
			]),
		)
		.max(6)
		.describe(
			"Hard admission-fact categories whose bounded reads overflowed. Affected candidates are withheld under evaluation_required.",
		),
});

export const WorkExecutionClusterSchema = z.strictObject({
	index: z.number().int().positive(),
	items: z.array(WorkSchedulerReadyItemSchema).min(1).max(50),
	recommendedMaxParallelism: z.number().int().positive().max(50),
	resourceKeys: z.array(z.string().min(1)).max(500),
	explanation: z
		.string()
		.min(1)
		.optional()
		.describe("Prose rationale; present only under verbosity=full."),
});

export const WorkExecutionClusterPlanSchema =
	WorkSchedulerReadyQueueSchema.omit({
		items: true,
		nextCursor: true,
	}).extend({
		policyRevision: z.literal("work-clusters/v1"),
		clusters: z.array(WorkExecutionClusterSchema).max(100),
		totalReadyItems: z.number().int().nonnegative().max(100),
		maxParallelism: z.number().int().positive().max(50),
		advisory: z.literal(true),
	});

export type WorkSchedulerReadyQueue = z.infer<
	typeof WorkSchedulerReadyQueueSchema
>;
export type WorkExecutionClusterPlan = z.infer<
	typeof WorkExecutionClusterPlanSchema
>;
