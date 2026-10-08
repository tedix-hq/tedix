/**
 * Urgency triage of agent turns.
 *
 * An agent's final message to its operator is scored by a Workers AI Clef
 * decision model against an organization-configurable set of yes/no
 * questions. A turn is urgent (`now`) when any question's probability reaches
 * that question's `urgentWhen.gte` threshold; otherwise it can wait (`later`).
 *
 * The question set is configuration, not code: a stored policy row wins, and
 * a missing row falls back to the versioned default asset shipped with the
 * API. Nothing about the triaged text is persisted.
 */

import * as z from "zod";

export const AGENT_TURN_TRIAGE_MODELS = [
	"@cf/cloudflare/clef-flash",
	"@cf/cloudflare/clef",
] as const;
export const AgentTurnTriageModelSchema = z.enum(AGENT_TURN_TRIAGE_MODELS);
export type AgentTurnTriageModel = z.infer<typeof AgentTurnTriageModelSchema>;

/** Clef question ids: letters, digits, `_`, `.`, `-`; at most 100 chars. */
const ClefQuestionIdSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_.-]+$/, "Use letters, digits, '_', '.', or '-'");

export const AgentTurnTriageQuestionSchema = z.strictObject({
	id: ClefQuestionIdSchema.describe(
		"Stable label id; the key under which the probability is reported",
	),
	instructions: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe("The yes/no question the model answers about the agent turn"),
	urgentWhen: z.strictObject({
		gte: z
			.number()
			.min(0)
			.max(1)
			.describe("The turn is urgent when this label's probability is ≥ gte"),
	}),
});
export type AgentTurnTriageQuestion = z.infer<
	typeof AgentTurnTriageQuestionSchema
>;

/**
 * Few-shot examples in the drafting prompt: the target user's own recent
 * answers to similar decision-capture questions (same repository first, then
 * lexical similarity; answers that edited or replaced a draft rank higher).
 */
export const AgentReplyDraftExamplesPolicySchema = z.strictObject({
	enabled: z
		.boolean()
		.describe(
			"When false, the drafting prompt carries none of the user's past replies",
		),
	count: z
		.number()
		.int()
		.min(1)
		.max(10)
		.describe("How many past replies the drafting prompt carries at most"),
});
export type AgentReplyDraftExamplesPolicy = z.infer<
	typeof AgentReplyDraftExamplesPolicySchema
>;
export const DEFAULT_AGENT_REPLY_DRAFT_EXAMPLES: AgentReplyDraftExamplesPolicy =
	{ enabled: true, count: 5 };

/**
 * Tedi-drafted replies to quiet (`later`) decision-capture questions. Drafts
 * are proposals the human accepts, edits, or replaces unless `autoSend`
 * delivers a reversible one. Disabled unless a drafting tedi is named.
 */
export const AgentReplyDraftingPolicySchema = z.strictObject({
	enabled: z
		.boolean()
		.describe("When false, request_agent_reply_draft answers `ineligible`"),
	tediId: z
		.uuid()
		.optional()
		.describe(
			"The active tedi that drafts replies; the only principal allowed to call propose_agent_reply_draft",
		),
	skillSlug: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.optional()
		.describe(
			"Optional skill the drafting tedi loads before drafting (for example the operator's reply-style skill)",
		),
	examples: AgentReplyDraftExamplesPolicySchema.default(
		DEFAULT_AGENT_REPLY_DRAFT_EXAMPLES,
	).describe(
		"The user's own past replies to similar agent turns, shown to the drafting tedi as examples; on by default",
	),
});
export type AgentReplyDraftingPolicy = z.infer<
	typeof AgentReplyDraftingPolicySchema
>;

/**
 * Auto-send guardrails. A drafted reply is delivered `auto` (sent without the
 * human's review) only when this is enabled, the drafting tedi asserted the
 * proposed next step is reversible, the question is quiet (triage `ok`,
 * `later`, no urgent labels) and fewer than `maxConsecutive` earlier questions
 * of the same agent session were auto-answered since the user last replied
 * there themselves, and every `deliveryGate` check passes. Otherwise the
 * draft waits for review. Off by default.
 */
export const AgentReplyAutoSendPolicySchema = z.strictObject({
	enabled: z
		.boolean()
		.describe("When false, every draft is delivered `review`"),
	maxConsecutive: z
		.number()
		.int()
		.min(0)
		.max(10)
		.describe(
			"Per agent session: at most this many auto-sent replies in a row before the user must reply themselves; 0 never auto-sends",
		),
});
export type AgentReplyAutoSendPolicy = z.infer<
	typeof AgentReplyAutoSendPolicySchema
>;

/**
 * One yes/no check of the auto-send delivery gate. Clef scores it over the
 * agent's message and the drafted reply; the check passes when the
 * probability is ≥ `autoWhen.gte` or ≤ `autoWhen.lte`.
 */
export const AgentReplyDeliveryGateQuestionSchema = z.strictObject({
	id: ClefQuestionIdSchema.describe(
		"Stable check id; the key under which the probability is recorded",
	),
	instructions: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe(
			"The yes/no question the model answers about the agent message and the drafted reply",
		),
	autoWhen: z
		.union([
			z.strictObject({
				gte: z
					.number()
					.min(0)
					.max(1)
					.describe("Passes when the probability is ≥ gte"),
			}),
			z.strictObject({
				lte: z
					.number()
					.min(0)
					.max(1)
					.describe("Passes when the probability is ≤ lte"),
			}),
		])
		.describe("The pass condition; every check must pass for `auto`"),
});
export type AgentReplyDeliveryGateQuestion = z.infer<
	typeof AgentReplyDeliveryGateQuestionSchema
>;

/**
 * Independent Clef review of a draft before it may be sent without review.
 * Reached only after every other autoSend guardrail holds; a failed check, a
 * model error, or a timeout delivers `review` (fail closed).
 */
export const AgentReplyDeliveryGatePolicySchema = z.strictObject({
	model: AgentTurnTriageModelSchema,
	questions: z
		.array(AgentReplyDeliveryGateQuestionSchema)
		.min(1)
		.max(16)
		.refine(
			(questions) =>
				new Set(questions.map((question) => question.id)).size ===
				questions.length,
			{ message: "Check ids must be unique" },
		),
});
export type AgentReplyDeliveryGatePolicy = z.infer<
	typeof AgentReplyDeliveryGatePolicySchema
>;

/** The stored audit of one delivery-gate evaluation. */
export const AgentReplyDeliveryGateResultSchema = z.object({
	status: z
		.enum(["pass", "fail", "unavailable"])
		.describe(
			"`pass`: every check passed; `fail`: at least one did not; `unavailable`: the model failed or timed out (delivered `review`)",
		),
	model: z.string(),
	checks: z.array(
		z.object({
			id: z.string(),
			p: z.number().min(0).max(1),
			pass: z.boolean(),
		}),
	),
	latencyMs: z.number().min(0),
});
export type AgentReplyDeliveryGateResult = z.infer<
	typeof AgentReplyDeliveryGateResultSchema
>;

/**
 * When a turn type has earned trust. Measurement only: eligibility does not
 * change delivery, which `autoSend` governs.
 */
export const AgentReplyDraftEligibilitySchema = z.strictObject({
	minRate: z
		.number()
		.min(0)
		.max(1)
		.describe("Minimum accepted / decided ratio for a turn type"),
	minDrafts: z
		.number()
		.int()
		.min(1)
		.max(100_000)
		.describe("Minimum decided drafts before a turn type can be eligible"),
});
export type AgentReplyDraftEligibility = z.infer<
	typeof AgentReplyDraftEligibilitySchema
>;

export const DEFAULT_AGENT_REPLY_DRAFTING: AgentReplyDraftingPolicy = {
	enabled: false,
	examples: DEFAULT_AGENT_REPLY_DRAFT_EXAMPLES,
};
export const DEFAULT_AGENT_REPLY_DRAFT_ELIGIBILITY: AgentReplyDraftEligibility =
	{ minRate: 0.9, minDrafts: 50 };
export const DEFAULT_AGENT_REPLY_AUTO_SEND: AgentReplyAutoSendPolicy = {
	enabled: false,
	maxConsecutive: 3,
};

const policyFields = {
	enabled: z
		.boolean()
		.describe("When false, triage answers `later` without a model call"),
	model: AgentTurnTriageModelSchema,
	questions: z
		.array(AgentTurnTriageQuestionSchema)
		.min(1)
		.max(32)
		.refine(
			(questions) =>
				new Set(questions.map((question) => question.id)).size ===
				questions.length,
			{ message: "Question ids must be unique" },
		),
	turnTypeChoices: z
		.array(z.string().trim().min(1).max(64))
		.min(2)
		.max(64)
		.optional()
		.describe("Optional turn-type vocabulary for classifying agent turns"),
	drafting: AgentReplyDraftingPolicySchema.default(
		DEFAULT_AGENT_REPLY_DRAFTING,
	).describe("Tedi-drafted replies to quiet questions; off by default"),
	eligibility: AgentReplyDraftEligibilitySchema.default(
		DEFAULT_AGENT_REPLY_DRAFT_ELIGIBILITY,
	).describe("Acceptance thresholds reported per turn type"),
	autoSend: AgentReplyAutoSendPolicySchema.default(
		DEFAULT_AGENT_REPLY_AUTO_SEND,
	).describe(
		"Guardrails for sending a reversible draft without review; off by default",
	),
	deliveryGate: AgentReplyDeliveryGatePolicySchema.optional().describe(
		"Clef checks every auto-send candidate must pass; absent, the shipped default gate applies",
	),
};

export const AgentTurnTriagePolicySchema = z.strictObject({
	...policyFields,
	version: z
		.number()
		.int()
		.min(1)
		.describe(
			"Policy version. Server-owned: incremented on every stored update",
		),
});
export type AgentTurnTriagePolicy = z.infer<typeof AgentTurnTriagePolicySchema>;

/** The writable part of a policy; `version` is assigned by the server. */
export const AgentTurnTriagePolicyInputSchema = z.strictObject(policyFields);
/** Input shape: defaulted fields may be omitted. */
export type AgentTurnTriagePolicyInput = z.input<
	typeof AgentTurnTriagePolicyInputSchema
>;

export const AgentTurnTriagePolicyStateSchema = z.object({
	policy: AgentTurnTriagePolicySchema,
	source: z
		.enum(["default", "stored"])
		.describe("`default` when no usable row is stored for this organization"),
	revision: z
		.number()
		.int()
		.min(0)
		.describe(
			"Compare-and-swap token. 0 means nothing is stored; pass it back as expectedRevision on the next write.",
		),
	updatedAt: z.string().nullable(),
});
export type AgentTurnTriagePolicyState = z.infer<
	typeof AgentTurnTriagePolicyStateSchema
>;

export const UpdateAgentTurnTriagePolicyInputSchema = z.object({
	policy: AgentTurnTriagePolicyInputSchema,
	expectedRevision: z
		.number()
		.int()
		.min(0)
		.describe(
			"The revision returned by get_agent_turn_triage_policy. 0 creates the row.",
		),
});

export const TriageAgentTurnInputSchema = z.object({
	text: z
		.string()
		.min(1)
		.max(20_000)
		.describe("The agent's final message to its operator"),
});

/**
 * SHARED CONTRACT — consumed by the runtime and OS surfaces. Do not change
 * its shape without updating every consumer.
 */
export const TriageResultSchema = z.object({
	status: z
		.enum(["ok", "unavailable"])
		.describe(
			"`unavailable` when the model failed or timed out (or triage is disabled); urgency is then `later`",
		),
	urgency: z.enum(["now", "later"]),
	labels: z
		.record(z.string(), z.number().min(0).max(1))
		.describe("Probability per policy question id"),
	urgentLabels: z
		.array(z.string())
		.describe("Question ids whose probability reached urgentWhen.gte"),
	model: z.string(),
	policyVersion: z.number().int(),
	latencyMs: z.number().min(0),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

export const AGENT_REPLY_LABELS = [
	"continue",
	"approve",
	"ship",
	"fan-out",
	"simplify",
	"verify",
	"challenge",
	"correction",
	"plain-english",
	"status",
	"frustration",
	"question",
	"instruction",
] as const;
export const AgentReplyLabelSchema = z.enum(AGENT_REPLY_LABELS);
export type AgentReplyLabel = z.infer<typeof AgentReplyLabelSchema>;

export const LabelAgentReplyInputSchema = z.object({
	turnText: z
		.string()
		.max(20_000)
		.describe("The agent message the operator replied to (context only)"),
	replyText: z
		.string()
		.min(1)
		.max(20_000)
		.describe("The operator's reply to classify"),
});

export const LabelAgentReplyResultSchema = z.object({
	status: z.enum(["ok", "unavailable"]),
	label: AgentReplyLabelSchema.nullable().describe(
		"Highest-probability reply class; null when unavailable",
	),
	p: z
		.number()
		.min(0)
		.max(1)
		.nullable()
		.describe("Probability of `label`; null when unavailable"),
	model: z.string(),
});
export type LabelAgentReplyResult = z.infer<typeof LabelAgentReplyResultSchema>;

export const RequestAgentReplyDraftInputSchema = z.strictObject({
	requestId: z
		.uuid()
		.describe(
			"The open decision-capture question (Work Interaction) to draft a reply for",
		),
});

export const AGENT_REPLY_DRAFT_INELIGIBLE_REASONS = [
	"not_open",
	"not_question",
	"not_decision_capture",
	"untriaged",
	"urgent",
	"drafting_disabled",
	"no_drafting_tedi",
	"attempts_exhausted",
] as const;
export const AgentReplyDraftIneligibleReasonSchema = z.enum(
	AGENT_REPLY_DRAFT_INELIGIBLE_REASONS,
);
export type AgentReplyDraftIneligibleReason = z.infer<
	typeof AgentReplyDraftIneligibleReasonSchema
>;

export const RequestAgentReplyDraftResultSchema = z.object({
	status: z
		.enum(["queued", "ineligible"])
		.describe(
			"`queued`: a drafting turn was started, or one is in flight or already drafted (repeat requests are no-ops); `ineligible`: nothing was started",
		),
	reason: AgentReplyDraftIneligibleReasonSchema.optional().describe(
		"Why the question cannot be drafted; present only when ineligible",
	),
});
export type RequestAgentReplyDraftResult = z.infer<
	typeof RequestAgentReplyDraftResultSchema
>;

export const ProposeAgentReplyDraftInputSchema = z.strictObject({
	requestId: z.uuid().describe("The question being drafted for"),
	body: z
		.string()
		.trim()
		.min(1)
		.max(6_000)
		.describe("The proposed reply, written as the user would send it"),
	rationale: z
		.string()
		.trim()
		.min(1)
		.max(2_000)
		.describe(
			"Short evidence for the draft: priorities, preferences, or sessions it relies on",
		),
	turnType: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe(
			"Turn-type label, preferably from the policy's turnTypeChoices; acceptance is measured per type",
		),
	reversible: z
		.boolean()
		.describe(
			"Your assertion that the next step this reply leads to is reversible: no deploy, publish or release, no deleting data, no force-push, no messages to other people, no payments or credentials. Committing and pushing reviewed code to main counts as reversible. Only `true` lets the reply be sent without review.",
		),
});

export const AGENT_REPLY_DRAFT_DELIVERIES = ["review", "auto"] as const;
export const AgentReplyDraftDeliverySchema = z
	.enum(AGENT_REPLY_DRAFT_DELIVERIES)
	.describe(
		"`review`: the user accepts, edits, or replaces it in Tedix OS; `auto`: it may be sent without review (policy autoSend on, reversible, quiet question, session budget not exhausted, every delivery-gate check passed)",
	);
export type AgentReplyDraftDelivery = z.infer<
	typeof AgentReplyDraftDeliverySchema
>;

export const ProposeAgentReplyDraftResultSchema = z.object({
	draftId: z.uuid(),
	delivery: AgentReplyDraftDeliverySchema,
});

export const GetAgentReplyDraftAcceptanceInputSchema = z.strictObject({
	since: z.iso
		.datetime()
		.optional()
		.describe("Only count drafts created at or after this time"),
});

export const AgentReplyDraftAcceptanceRowSchema = z.object({
	turnType: z.string().nullable(),
	drafts: z.number().int().min(0).describe("Drafts proposed"),
	decided: z
		.number()
		.int()
		.min(0)
		.describe(
			"Drafts the user answered with and cited (accepted + edited + replaced)",
		),
	accepted: z.number().int().min(0),
	edited: z.number().int().min(0),
	replaced: z.number().int().min(0),
	rate: z
		.number()
		.min(0)
		.max(1)
		.describe("accepted / decided; 0 when none decided"),
	eligible: z
		.boolean()
		.describe(
			"decided ≥ minDrafts and rate ≥ minRate. Measurement only; delivery is governed by policy autoSend",
		),
	autoSent: z.number().int().min(0).describe("Drafts delivered `auto`"),
	autoFollowedUp: z
		.number()
		.int()
		.min(0)
		.describe(
			"Auto drafts with a user follow-up: the earliest answer by the user with metadata.source `user-reply` on the draft's question or on the same session's next decision-capture question",
		),
	overridden: z
		.number()
		.int()
		.min(0)
		.describe(
			"Auto drafts whose follow-up replyClass is missing or not one of continue, approve, ship, fan-out, question (the user redirected the agent), or that the agent's next turn declined (a later question's metadata.priorDraft.draftOutcome `rejected`)",
		),
	overrideRate: z
		.number()
		.min(0)
		.max(1)
		.describe("overridden / autoSent; 0 when nothing was auto-sent"),
});

export const GetAgentReplyDraftAcceptanceResultSchema = z.object({
	byTurnType: z.array(AgentReplyDraftAcceptanceRowSchema),
	policy: AgentReplyDraftEligibilitySchema,
});

export const GetAgentReplyDraftLeaderboardInputSchema = z.strictObject({
	since: z.iso
		.datetime()
		.describe(
			"Start of the period (e.g. this week); drafts created at or after it",
		),
	todaySince: z.iso
		.datetime()
		.describe("Start of today, in the caller's time zone"),
});

const AgentReplyDraftScoreSchema = z.object({
	answered: z
		.number()
		.int()
		.min(0)
		.describe("Drafts written (knocks answered)"),
	autoSent: z.number().int().min(0).describe("Drafts delivered `auto`"),
	stood: z
		.number()
		.int()
		.min(0)
		.describe(
			"Auto drafts not overridden plus review drafts accepted as written",
		),
	corrected: z
		.number()
		.int()
		.min(0)
		.describe("Edited or replaced drafts plus overridden auto drafts"),
	avgReplySeconds: z
		.number()
		.int()
		.min(0)
		.nullable()
		.describe("Mean seconds from the question to the draft"),
});

export const GetAgentReplyDraftLeaderboardResultSchema = z.object({
	tedis: z.array(
		z.object({
			tediId: z.string(),
			name: z.string(),
			avatar: z.string().nullable().describe("URL or emoji"),
			week: AgentReplyDraftScoreSchema,
			today: AgentReplyDraftScoreSchema,
		}),
	),
});

/**
 * Whether a captured agent turn needs its user, stored by the server on the
 * question as `metadata.attention`. `fyi`: the turn asks nothing of the user
 * (a status update); it is acknowledged for them and never counts as needing
 * them. `needs_you`: the turn asks for a decision, fact, approval or action
 * only the user can give; `need` says what in one plain line (null when the
 * model could not write it).
 */
export const AGENT_TURN_ATTENTION_KINDS = ["needs_you", "fyi"] as const;
export const AgentTurnAttentionKindSchema = z.enum(AGENT_TURN_ATTENTION_KINDS);
export type AgentTurnAttentionKind = z.infer<
	typeof AgentTurnAttentionKindSchema
>;
export const AgentTurnAttentionSchema = z.object({
	kind: AgentTurnAttentionKindSchema,
	need: z
		.string()
		.max(240)
		.nullable()
		.describe("What is needed from the user, in one plain line"),
	asks: z
		.number()
		.min(0)
		.max(1)
		.nullable()
		.describe("Probability that the turn asks the user for something"),
	decidedAt: z.string(),
});
export type AgentTurnAttention = z.infer<typeof AgentTurnAttentionSchema>;

export const RetriageAgentTurnQuestionsInputSchema = z.strictObject({
	apply: z
		.boolean()
		.default(false)
		.describe(
			"false previews the verdicts; true stores them and expires the updates",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.default(25)
		.describe("At most this many of the caller's open questions, newest first"),
});

export const RetriageAgentTurnQuestionsResultSchema = z.object({
	scanned: z.number().int().min(0),
	needsYou: z.number().int().min(0),
	updates: z.number().int().min(0),
	unavailable: z
		.number()
		.int()
		.min(0)
		.describe("Questions the model could not judge; left unchanged"),
	expired: z
		.number()
		.int()
		.min(0)
		.describe("Updates closed by expiring them (only with apply)"),
	items: z.array(
		z.object({
			requestId: z.uuid(),
			kind: AgentTurnAttentionKindSchema.nullable(),
			need: z.string().nullable(),
			expired: z.boolean(),
		}),
	),
});
