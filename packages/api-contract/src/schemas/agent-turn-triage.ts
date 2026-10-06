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
 * there themselves. Otherwise the draft waits for review. Off by default.
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
export type AgentTurnTriagePolicyInput = z.infer<
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
			"`queued`: a drafting turn was queued (redelivery and repeat requests are no-ops); `ineligible`: nothing was queued",
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
		"`review`: the user accepts, edits, or replaces it in Tedix OS; `auto`: it may be sent without review (policy autoSend on, reversible, quiet question, session budget not exhausted)",
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
			"Auto drafts whose follow-up replyClass is missing or not one of continue, approve, ship, fan-out (the user redirected the agent)",
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
