import "@orpc/openapi/extensions/route";
/**
 * Tedi Objectives Contract
 * oRPC contract for mission directives
 *
 * Objectives are human-set mission directives — NOT a project manager.
 *
 * Used by: Tedix OS Activity, tedi Workers (via service binding),
 * MCP objective tools
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
	gateConfig: z.record(z.string(), JsonValueSchema).nullable(),
	budgetConfig: z.record(z.string(), JsonValueSchema).nullable(),
	progress: z.record(z.string(), JsonValueSchema).nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
});

export type Objective = z.infer<typeof ObjectiveSchema>;

/** Run limits only; an objective's money limit is its credit budget. */
const ObjectiveBudgetConfigInputSchema = z
	.record(z.string(), z.unknown())
	.refine(
		(config) => !("maxCostCents" in config),
		"maxCostCents is no longer used: set an objective credit budget with put_work_budget_envelope (scopeType objective, currency credits)",
	)
	.describe(
		"Run limits such as maxTokens, maxTimeMs and maxActions. Money limits are objective credit budgets (put_work_budget_envelope), which the organization wallet enforces.",
	);

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
				summary: "Create goal (objective)",
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
					gateConfig: z.record(z.string(), z.unknown()).optional(),
					budgetConfig: ObjectiveBudgetConfigInputSchema.optional(),
				}),
			)
			.output(ObjectiveSchema),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List goals (objectives)",
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
					.strict()
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
				summary: "Get goal (objective)",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ObjectiveSchema),

		update: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update goal (objective)",
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
					gateConfig: z.record(z.string(), z.unknown()).optional(),
					budgetConfig: ObjectiveBudgetConfigInputSchema.optional(),
					progress: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(ObjectiveSchema),

		delete: oc
			.route({
				method: "DELETE",
				path: "/{id}",
				summary: "Delete goal (objective)",
			})
			.input(z.object({ id: z.uuid() }))
			.output(z.object({ success: z.literal(true), deletedId: z.string() })),
	});

export type TediObjectivesContract = typeof tediObjectivesContract;
