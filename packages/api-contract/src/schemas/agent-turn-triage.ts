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
