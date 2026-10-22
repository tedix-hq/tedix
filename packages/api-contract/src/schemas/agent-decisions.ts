/**
 * Agent decision journal (MCP: `record_agent_decision`,
 * `record_agent_decision_outcome`, `list_agent_decisions`).
 *
 * An agent records a decision it made on its own: the question, the options
 * it considered, what it chose and why, how reversible it is and which
 * protected effects it touched. A record is context for people and for
 * learning. It never grants authority: a decision that needs a person still
 * goes through approvals, and recording one does not approve anything.
 */

import * as z from "zod";
import { ProtectedEffectSchema } from "./decision-effects";

/** `<harness>:<session id>`, the same shape as the Agent-Session trailer. */
export const AGENT_SESSION_PATTERN =
	/^[a-z0-9][a-z0-9-]{0,39}:[A-Za-z0-9._-]{1,160}$/;
/** Dotted lowercase class, e.g. `lane.pause` or `deploy.canary`. */
export const AGENT_DECISION_CLASS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export const AGENT_DECISION_OUTCOMES = [
	"worked",
	"reverted",
	"partial",
] as const;
export type AgentDecisionOutcome = (typeof AGENT_DECISION_OUTCOMES)[number];

/** Organization policy under `decisionLearning.agentDecisions`. */
export const AgentDecisionJournalConfigSchema = z.strictObject({
	/** Decisions one Agent-Session may record per hour. */
	perSessionHourlyLimit: z.number().int().min(1).max(500).default(30),
	/** Below this confidence a decision is shown to a person in the review. */
	askBelowConfidence: z.number().min(0).max(1).default(0.6),
	/** Local hour (organization timezone) of the daily review card. */
	reviewHour: z.number().int().min(0).max(23).default(7),
	morningReview: z.boolean().default(true),
	/** Outcomes a class needs, with no correction since, to count as earned. */
	earnedAfter: z.number().int().min(1).max(100).default(5),
});
export type AgentDecisionJournalConfig = z.infer<
	typeof AgentDecisionJournalConfigSchema
>;

const OptionSchema = z.strictObject({
	id: z
		.string()
		.trim()
		.min(1)
		.max(60)
		.regex(/^[A-Za-z0-9._-]+$/, "Use a short id such as `pause` or `option-b`"),
	label: z.string().trim().min(1).max(120),
});

export const RecordAgentDecisionInputSchema = z
	.strictObject({
		agentSession: z
			.string()
			.trim()
			.regex(AGENT_SESSION_PATTERN, "Use <harness>:<session id>")
			.describe(
				"The deciding agent's Agent-Session, `<harness>:<session id>`, e.g. `claude-code:0d9b…`",
			),
		agentName: z
			.string()
			.trim()
			.min(1)
			.max(40)
			.optional()
			.describe(
				"Short role name shown in the Feed, e.g. `Lead`. Defaults to the harness.",
			),
		decisionClass: z
			.string()
			.trim()
			.regex(AGENT_DECISION_CLASS_PATTERN)
			.describe(
				"Kind of decision, dotted lowercase: `lane.pause`, `deploy.canary`, `fix.choice`, `architecture`",
			),
		question: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe("The proposal or question that was decided"),
		options: z
			.array(OptionSchema)
			.min(2)
			.max(5)
			.describe("The options considered, including the chosen one"),
		chosen: z
			.string()
			.trim()
			.min(1)
			.max(60)
			.describe("Id of the chosen option"),
		reason: z.string().trim().min(1).max(2000),
		reversibility: z.enum(["two_way", "one_way", "unknown"]),
		protectedEffects: z.array(ProtectedEffectSchema).max(7).default([]),
		tasteOrStrategy: z.boolean().default(false),
		confidence: z.number().min(0).max(1).nullable().default(null),
		workItemId: z.uuid().optional(),
		outputId: z.uuid().optional(),
		commitShas: z
			.array(z.string().trim().toLowerCase().regex(COMMIT_SHA))
			.max(10)
			.default([]),
		priorDecisionId: z
			.uuid()
			.optional()
			.describe("An earlier recorded decision this one builds on or replaces"),
		priorRelation: z.enum(["depends_on", "supersedes"]).default("depends_on"),
		approvalRef: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.optional()
			.describe(
				"The approval that authorized a decision needing a person, when one exists",
			),
		occurredAt: z.iso
			.datetime()
			.optional()
			.describe(
				"When the decision was made; defaults to now. At most 30 days back.",
			),
	})
	.refine(
		(input) =>
			new Set(input.options.map((option) => option.id)).size ===
			input.options.length,
		{ message: "Option ids must be unique", path: ["options"] },
	)
	.refine(
		(input) => input.options.some((option) => option.id === input.chosen),
		{
			message: "chosen must be one of the option ids",
			path: ["chosen"],
		},
	);
export type RecordAgentDecisionInput = z.infer<
	typeof RecordAgentDecisionInputSchema
>;

export const RecordAgentDecisionResultSchema = z.object({
	decisionId: z.uuid(),
	duplicate: z.boolean(),
	classId: z
		.string()
		.describe("Learning class `agent:<actor>:<decision class>`"),
	needsPerson: z
		.boolean()
		.describe(
			"True when this class of decision needs a person: protected effects, one-way or unknown reversibility, or taste. Recording grants nothing; ask through approvals.",
		),
	askable: z.boolean().describe("Shown to a person in the next morning review"),
	edgesWritten: z.number().int(),
	notice: z.string().nullable(),
});
export type RecordAgentDecisionResult = z.infer<
	typeof RecordAgentDecisionResultSchema
>;

export const RecordAgentDecisionOutcomeInputSchema = z.strictObject({
	decisionId: z.uuid(),
	outcome: z.enum(AGENT_DECISION_OUTCOMES),
	evidence: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe("What happened, in plain words"),
	by: z
		.enum(["agent", "person"])
		.default("agent")
		.describe(
			"`person` when a person overrode or undid the decision: recorded as a correction",
		),
	commitShas: z
		.array(z.string().trim().toLowerCase().regex(COMMIT_SHA))
		.max(10)
		.default([]),
	occurredAt: z.iso.datetime().optional(),
});
export type RecordAgentDecisionOutcomeInput = z.infer<
	typeof RecordAgentDecisionOutcomeInputSchema
>;

export const RecordAgentDecisionOutcomeResultSchema = z.object({
	decisionId: z.uuid(),
	outcomeEventId: z.uuid(),
	duplicate: z.boolean(),
	correction: z.boolean(),
	mistakeRecorded: z.boolean(),
});

export const AgentDecisionClassStandingSchema = z.object({
	classId: z.string(),
	decisions: z.number().int(),
	worked: z.number().int(),
	reverted: z.number().int(),
	partial: z.number().int(),
	corrections: z.number().int(),
	/** Outcomes that worked since the latest correction. */
	streak: z.number().int(),
	status: z.enum(["learning", "earned", "corrected"]),
	sentence: z.string(),
});
export type AgentDecisionClassStanding = z.infer<
	typeof AgentDecisionClassStandingSchema
>;

export const AgentDecisionSchema = z.object({
	id: z.uuid(),
	classId: z.string(),
	decisionClass: z.string(),
	agent: z.object({
		name: z.string(),
		harness: z.string(),
		session: z.string(),
	}),
	question: z.string(),
	chosen: z.object({ id: z.string(), label: z.string() }),
	options: z.array(z.object({ id: z.string(), label: z.string() })),
	reason: z.string(),
	reversibility: z.enum(["two_way", "one_way", "unknown"]),
	protectedEffects: z.array(z.string()),
	confidence: z.number().nullable(),
	needsPerson: z.boolean(),
	askable: z.boolean(),
	workItemId: z.string().nullable(),
	outputId: z.string().nullable(),
	commitShas: z.array(z.string()),
	priorDecisionId: z.string().nullable(),
	occurredAt: z.string(),
	outcome: z
		.object({
			outcome: z.enum(AGENT_DECISION_OUTCOMES),
			by: z.enum(["agent", "person"]),
			evidence: z.string(),
			at: z.string(),
		})
		.nullable(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const ListAgentDecisionsInputSchema = z.strictObject({
	since: z.iso.datetime().optional().describe("Defaults to 24 hours ago"),
	decisionClass: z
		.string()
		.trim()
		.regex(AGENT_DECISION_CLASS_PATTERN)
		.optional(),
	limit: z.number().int().min(1).max(100).default(50),
});

export const ListAgentDecisionsResultSchema = z.object({
	decisions: z.array(AgentDecisionSchema),
	classes: z.array(AgentDecisionClassStandingSchema),
	summary: z.string().describe("Plain-English review of these decisions"),
});
export type ListAgentDecisionsResult = z.infer<
	typeof ListAgentDecisionsResultSchema
>;
