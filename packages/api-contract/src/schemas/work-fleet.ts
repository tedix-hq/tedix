import * as z from "zod";

const CountSchema = z.number().int().nonnegative();
const CountMapSchema = z.record(z.string(), CountSchema);
const BudgetScopeProjectionSchema = z.strictObject({
	envelopeCount: CountSchema,
	limitMicros: CountSchema,
	activeReservedMicros: CountSchema,
	consumedMicros: CountSchema,
	availableMicros: CountSchema,
	exhaustedEnvelopeCount: CountSchema,
});

const WORK_FLEET_ATTENTION_ACTION_KEYS = [
	"exhausted_budgets",
	"stale_attempt_leases",
	"rejected_admissions",
	"saturated_resources",
	"overdue_interactions",
	"approval_backlog",
	"interaction_backlog",
] as const;

export const WorkFleetAttentionActionSchema = z.strictObject({
	key: z.enum(WORK_FLEET_ATTENTION_ACTION_KEYS),
	severity: z.enum(["critical", "high", "medium"]),
	count: CountSchema.positive(),
	label: z.string().min(1),
	rationale: z.string().min(1),
	href: z.enum([
		"/work/attempts",
		"/work/admission",
		"/work/approvals",
		"/work/interactions",
		"/work/capacity",
	]),
});

export const WorkFleetControlTowerSchema = z.strictObject({
	observedAt: z.iso.datetime(),
	workItems: z.strictObject({
		total: CountSchema,
		byDisposition: CountMapSchema,
	}),
	attempts: z.strictObject({
		total: CountSchema,
		byRuntimeState: CountMapSchema,
		active: CountSchema,
		staleLeases: CountSchema,
		withoutAdmission: CountSchema,
	}),
	admissions: z.strictObject({
		total: CountSchema,
		byEffectiveState: CountMapSchema,
		latestRejected: CountSchema,
	}),
	approvals: z.strictObject({
		total: CountSchema,
		byEffectiveStatus: CountMapSchema,
		awaitingDecision: CountSchema,
	}),
	interactions: z.strictObject({
		total: CountSchema,
		byEffectiveState: CountMapSchema,
		awaitingResponse: CountSchema,
		overdue: CountSchema,
	}),
	resources: z.strictObject({
		poolCount: CountSchema,
		totalCapacity: CountSchema,
		activeReserved: CountSchema,
		consumed: CountSchema,
		saturatedPoolCount: CountSchema,
		saturatedResourceKeys: z.array(z.string()),
	}),
	budgets: z.strictObject({
		envelopeCount: CountSchema,
		byScope: z.strictObject({
			organization: BudgetScopeProjectionSchema,
			project: BudgetScopeProjectionSchema,
			case: BudgetScopeProjectionSchema,
			work_item: BudgetScopeProjectionSchema,
		}),
	}),
	attention: z.strictObject({
		staleAttemptLeases: CountSchema,
		rejectedAdmissions: CountSchema,
		approvalBacklog: CountSchema,
		interactionBacklog: CountSchema,
		saturatedResources: CountSchema,
		exhaustedBudgets: CountSchema,
		actions: z
			.array(WorkFleetAttentionActionSchema)
			.max(WORK_FLEET_ATTENTION_ACTION_KEYS.length),
	}),
});

export type WorkFleetControlTower = z.infer<typeof WorkFleetControlTowerSchema>;
