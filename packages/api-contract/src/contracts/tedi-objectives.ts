import "@orpc/openapi/extensions/route";
/**
 * Tedi Objectives & Tasks Contract
 * oRPC contract for mission directives and execution log
 *
 * Objectives are human-set mission directives — NOT a project manager.
 * Tasks are a thin execution log for explainability (like Claude Code's task list).
 *
 * Used by: Tedix OS Activity, tedi Workers (via service binding),
 * MCP tools (create_objective, update_task, etc.)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

const ObjectiveTypeSchema = z.enum(["one_time", "standing", "reactive"]);
const ObjectiveStatusSchema = z.enum([
	"active",
	"paused",
	"completed",
	"failed",
]);
const ObjectiveRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const TaskStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	"failed",
	"blocked",
	"abandoned",
]);
const TaskKindSchema = z.enum([
	"general",
	"inspect",
	"change",
	"validate",
	"deploy",
	"verify",
	"cleanup",
	"research",
	"communicate",
]);

// =============================================================================
// GATE CONFIG — Autonomy graduation model
// =============================================================================

const AutonomyLevelSchema = z.enum(["manual", "supervised", "autonomous"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/**
 * GateConfig — stored as JSON string in the `gate_config` TEXT column.
 *
 * Drives the autonomy dial: manual → supervised → autonomous.
 * Empty `{}` is treated as "manual" (no gates = full human control).
 *
 * Gate types:
 * - "always"    → every action requires approval, never auto-promotes
 * - "first_n"   → first N require approval, then auto-promotes to autonomous
 * - "threshold" → cost/impact above limit requires approval
 */
export const GateConfigSchema = z.object({
	/** Current autonomy level. Default: "manual" for empty/missing config */
	autonomyLevel: AutonomyLevelSchema.default("manual"),

	/** Gate type governing this objective */
	gateType: z.enum(["always", "first_n", "threshold"]).default("first_n"),

	/** Graduation criteria — conditions to promote autonomy level */
	graduationCriteria: z
		.object({
			/** Consecutive successful rationale completions needed to graduate */
			consecutiveSuccesses: z.number().min(1).max(100).default(5),
			/**
			 * Complexity floor for streak-eligible successes (P5 scorecard
			 * discipline — Goodhart guard). A success whose episode complexity is
			 * below this floor completes normally but neither advances nor resets
			 * the streak, so a tedi cannot graduate to autonomy on trivial tasks.
			 * Episode complexity is derived mechanically from execution links:
			 * `toolCallCount + workItemLink(1) + durationPoints(0|1|2)` — see
			 * `computeEpisodeComplexity()` in `apps/api/src/services/mission-os.ts`.
			 * Optional for stored-config compatibility; absent means
			 * `DEFAULT_GATE_MIN_COMPLEXITY` applies.
			 */
			minComplexity: z.number().min(0).max(100).optional(),
		})
		.default({ consecutiveSuccesses: 5 }),

	/** Current streak of consecutive successes (reset on failure) */
	currentStreak: z.number().min(0).default(0),

	/** ISO timestamp of the last graduation event */
	lastGraduatedAt: z.string().nullable().default(null),
});

export type GateConfig = z.infer<typeof GateConfigSchema>;

/**
 * Default graduation complexity floor applied when
 * `graduationCriteria.minComplexity` is absent (legacy stored configs).
 * Conservative: with the mechanical complexity formula
 * (`toolCallCount + workItemLink + durationPoints`), a floor of 2 means a
 * streak-eligible success needs at least two tool calls, or one tool call
 * plus a linked work item, or one tool call plus ≥1 minute of execution —
 * zero-execution or single-trivial-call successes are graduation-inert.
 */
export const DEFAULT_GATE_MIN_COMPLEXITY = 2;

/**
 * Default gate auto-applied when a standing objective is created without a
 * gate config (WS6 gate↔objective coupling: gate graduation must govern real
 * work, so standing objectives are gated by default rather than rejected).
 * `first_n` with n=3 — a sane default, layer-scaled later. Applied in
 * `createObjective()` (`packages/db/src/queries/tedi-objectives.ts`); backfill
 * for pre-existing ungated objectives:
 * the retired backfill-objective-gates script.
 */
export const DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG: GateConfig = {
	autonomyLevel: "supervised",
	gateType: "first_n",
	graduationCriteria: {
		consecutiveSuccesses: 3,
		minComplexity: DEFAULT_GATE_MIN_COMPLEXITY,
	},
	currentStreak: 0,
	lastGraduatedAt: null,
};

/**
 * Parse a raw gateConfig JSON string into a validated GateConfig.
 * Returns sensible defaults for empty/invalid JSON.
 */
export function parseGateConfig(
	raw: Record<string, unknown> | string | null | undefined,
): GateConfig {
	if (!raw) return GateConfigSchema.parse({});
	if (typeof raw === "string") {
		if (raw === "{}") return GateConfigSchema.parse({});
		try {
			return GateConfigSchema.parse(JSON.parse(raw));
		} catch {
			return GateConfigSchema.parse({});
		}
	}
	try {
		return GateConfigSchema.parse(raw);
	} catch {
		return GateConfigSchema.parse({});
	}
}

export const ObjectiveSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	orgId: z.string(),
	purposeCharterId: z.uuid().nullable(),
	title: z.string(),
	description: z.string().nullable(),
	approach: z.string().nullable(),
	successCriteria: z.string().nullable(),
	constraints: z.string().nullable(),
	type: ObjectiveTypeSchema,
	status: ObjectiveStatusSchema,
	riskLevel: ObjectiveRiskLevelSchema,
	priority: z.number(),
	linkedDomains: z.array(z.string()).nullable(),
	gateConfig: z.record(z.string(), JsonValueSchema).nullable(),
	budgetConfig: z.record(z.string(), JsonValueSchema).nullable(),
	progress: z.record(z.string(), JsonValueSchema).nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
});

export type Objective = z.infer<typeof ObjectiveSchema>;

export const TaskSchema = z.object({
	id: z.string(),
	objectiveId: z.string().nullable(),
	tediId: z.string(),
	orgId: z.string(),
	title: z.string(),
	kind: TaskKindSchema,
	status: TaskStatusSchema,
	blocker: z.string().nullable(),
	evidence: z.array(z.string()).nullable(),
	toolingUsed: z.array(z.string()).nullable(),
	estimatedCost: z.record(z.string(), JsonValueSchema).nullable(),
	result: z.string().nullable(),
	actualCost: z.record(z.string(), JsonValueSchema).nullable(),
	budgetUsed: z.record(z.string(), JsonValueSchema).nullable(),
	failCount: z.number(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
});

export type Task = z.infer<typeof TaskSchema>;

// =============================================================================
// CONTRACT
// =============================================================================

export const tediObjectivesContract = oc
	.route({ tags: ["tedi-objectives"], prefix: "/tedi-objectives" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create objective",
				description:
					"Create a mission directive for a tedi. Available to authenticated operators and internal tedis.",
				tags: ["tedi-objectives"],
				successStatus: 201,
			})
			.input(
				z.object({
					tediId: z.uuid(),
					orgId: z.uuid(),
					purposeCharterId: z.uuid().nullable().optional(),
					title: z.string().min(1).max(500),
					description: z.string().max(5000).optional(),
					approach: z.string().max(5000).optional(),
					successCriteria: z.string().max(5000).optional(),
					constraints: z.string().max(5000).optional(),
					type: ObjectiveTypeSchema.default("standing"),
					riskLevel: ObjectiveRiskLevelSchema.default("medium"),
					priority: z.number().min(0).max(999).default(0),
					linkedDomains: z.array(z.string()).optional(),
					gateConfig: z.record(z.string(), z.unknown()).optional(),
					budgetConfig: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(ObjectiveSchema),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List objectives",
				description:
					"List objectives for the current organization with optional filters.",
			})
			.input(
				z
					.object({
						tediId: z.uuid().optional(),
						status: ObjectiveStatusSchema.optional(),
						type: ObjectiveTypeSchema.optional(),
						riskLevel: ObjectiveRiskLevelSchema.optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(ObjectiveSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		getById: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get objective",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ObjectiveSchema),

		update: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update objective",
				description: "Partial update of objective fields. Used by OS and tedi.",
			})
			.input(
				z.object({
					id: z.uuid(),
					purposeCharterId: z.uuid().nullable().optional(),
					title: z.string().min(1).max(500).optional(),
					description: z.string().max(5000).optional(),
					approach: z.string().max(5000).optional(),
					successCriteria: z.string().max(5000).optional(),
					constraints: z.string().max(5000).optional(),
					status: ObjectiveStatusSchema.optional(),
					riskLevel: ObjectiveRiskLevelSchema.optional(),
					priority: z.number().min(0).max(999).optional(),
					linkedDomains: z.array(z.string()).optional(),
					gateConfig: z.record(z.string(), z.unknown()).optional(),
					budgetConfig: z.record(z.string(), z.unknown()).optional(),
					progress: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(ObjectiveSchema),

		delete: oc
			.route({
				method: "DELETE",
				path: "/{id}",
				summary: "Delete objective",
			})
			.input(z.object({ id: z.uuid() }))
			.output(z.object({ success: z.literal(true), deletedId: z.string() })),

		createTask: oc
			.route({
				method: "POST",
				path: "/tasks",
				summary: "Create task",
				description:
					"Log a remediation or execution task for a tedi. Available to authenticated operators and internal tedis.",
				tags: ["tedi-objectives"],
				successStatus: 201,
			})
			.input(
				z.object({
					tediId: z.uuid(),
					orgId: z.uuid(),
					objectiveId: z.uuid().optional(),
					title: z.string().min(1).max(500),
					kind: TaskKindSchema.default("general"),
					blocker: z.string().max(5000).optional(),
					evidence: z.array(z.string()).optional(),
					toolingUsed: z.array(z.string()).optional(),
					estimatedCost: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(TaskSchema),

		listTasks: oc
			.route({
				method: "GET",
				path: "/tasks",
				summary: "List tasks",
				description:
					"List tasks with optional filters. Powers the execution log view.",
			})
			.input(
				z
					.object({
						tediId: z.uuid().optional(),
						objectiveId: z.uuid().optional(),
						status: TaskStatusSchema.optional(),
						kind: TaskKindSchema.optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(TaskSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		updateTask: oc
			.route({
				method: "PATCH",
				path: "/tasks/{id}",
				summary: "Update task",
				description:
					"Update task status and result. Called by tedi during execution.",
				tags: ["tedi-objectives", "internal"],
			})
			.input(
				z.object({
					id: z.uuid(),
					objectiveId: z.uuid().nullable().optional(),
					kind: TaskKindSchema.optional(),
					status: TaskStatusSchema.optional(),
					blocker: z.string().max(5000).optional(),
					evidence: z.array(z.string()).optional(),
					toolingUsed: z.array(z.string()).optional(),
					estimatedCost: z.record(z.string(), z.unknown()).optional(),
					result: z.string().max(5000).optional(),
					actualCost: z.record(z.string(), z.unknown()).optional(),
					budgetUsed: z.record(z.string(), z.unknown()).optional(),
					failCount: z.number().min(0).optional(),
				}),
			)
			.output(TaskSchema),

		deleteTask: oc
			.route({
				method: "DELETE",
				path: "/tasks/{id}",
				summary: "Delete task",
				tags: ["tedi-objectives", "internal"],
			})
			.input(z.object({ id: z.uuid() }))
			.output(z.object({ success: z.literal(true), deletedId: z.string() })),

		getActiveTasks: oc
			.route({
				method: "GET",
				path: "/tasks/active/{tediId}",
				summary: "Get active tasks",
				description:
					"Get what the tedi is currently working on — in_progress and pending tasks.",
			})
			.input(z.object({ tediId: z.uuid() }))
			.output(
				z.object({
					data: z.array(TaskSchema),
				}),
			),
	});

export type TediObjectivesContract = typeof tediObjectivesContract;
