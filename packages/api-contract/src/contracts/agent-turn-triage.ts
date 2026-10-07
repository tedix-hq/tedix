import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	GetAgentSessionLessonsInputSchema,
	GetAgentSessionLessonsResultSchema,
	MineAgentSessionLessonsInputSchema,
	MineAgentSessionLessonsResultSchema,
} from "../schemas/agent-session-lessons";
import {
	AgentTurnTriagePolicyStateSchema,
	GetAgentReplyDraftAcceptanceInputSchema,
	GetAgentReplyDraftAcceptanceResultSchema,
	LabelAgentReplyInputSchema,
	LabelAgentReplyResultSchema,
	ProposeAgentReplyDraftInputSchema,
	ProposeAgentReplyDraftResultSchema,
	RequestAgentReplyDraftInputSchema,
	RequestAgentReplyDraftResultSchema,
	TriageAgentTurnInputSchema,
	TriageResultSchema,
	UpdateAgentTurnTriagePolicyInputSchema,
} from "../schemas/agent-turn-triage";

/**
 * Urgency triage of agent turns (MCP: `triage_agent_turn`,
 * `label_agent_reply`, `get_agent_turn_triage_policy`,
 * `update_agent_turn_triage_policy`) and tedi-drafted replies to quiet
 * decision-capture questions (MCP: `request_agent_reply_draft`,
 * `propose_agent_reply_draft`, `get_agent_reply_draft_acceptance`), and the
 * approved team lessons a local agent session receives
 * (MCP: `get_agent_session_lessons`, learned on demand by
 * `mine_agent_session_lessons`).
 *
 * Triage and reply labelling are stateless model reads: nothing about the
 * submitted text is stored. A model failure or timeout is reported as
 * `status: "unavailable"`, never as an error, so callers can always fall back
 * to treating the turn as not urgent.
 */

const policyConflictErrors = {
	CONFLICT: {
		message: "Triage policy revision conflict",
		data: z
			.object({
				expectedRevision: z.number().int(),
				currentRevision: z.number().int().nullable(),
			})
			.optional(),
	},
} as const;

export const agentTurnTriageContract = oc
	.route({ tags: ["agent-turn-triage"], prefix: "/agent-turn-triage" })
	.errors(baseErrors)
	.router({
		triage: oc
			.route({
				method: "POST",
				path: "/triage",
				summary: "Triage an agent turn for urgency",
				description:
					"Scores the agent's message against the organization's triage questions and answers `now` when any probability reaches its threshold. Stores nothing. Model failure or timeout returns `status: \"unavailable\"` with urgency `later`.",
			})
			.input(TriageAgentTurnInputSchema)
			.output(TriageResultSchema),

		labelReply: oc
			.route({
				method: "POST",
				path: "/label-reply",
				summary: "Classify an operator's reply to an agent turn",
				description:
					'Classifies the reply into one fixed reply class using the agent turn as context. Stores nothing. Model failure or timeout returns `status: "unavailable"`.',
			})
			.input(LabelAgentReplyInputSchema)
			.output(LabelAgentReplyResultSchema),

		getPolicy: oc
			.route({
				method: "GET",
				path: "/policy",
				summary: "Get the caller's agent-turn triage policy",
				description:
					'Returns the stored policy for the credential-resolved organization, or the versioned defaults with `source: "default"` and `revision: 0` when none is stored.',
			})
			.input(z.object({}))
			.output(AgentTurnTriagePolicyStateSchema),

		updatePolicy: oc
			.route({
				method: "PUT",
				path: "/policy",
				summary: "Replace the caller's agent-turn triage policy",
				description:
					"Replaces the complete policy using the previously read `revision`. A lost compare-and-swap returns CONFLICT and writes nothing. The server assigns the next policy version.",
			})
			.errors(policyConflictErrors)
			.input(UpdateAgentTurnTriagePolicyInputSchema)
			.output(AgentTurnTriagePolicyStateSchema),

		requestReplyDraft: oc
			.route({
				method: "POST",
				path: "/reply-drafts/request",
				summary: "Ask the drafting tedi to draft a reply to a quiet question",
				description:
					"Only the question's target user may ask. The question must be open, a `tedix.decision-capture.v1` question triaged `later` with no urgent labels, and the caller's policy must enable drafting with an active tedi. Starts one drafting turn per question; a repeat request is a no-op while that turn is in flight (2 minutes) or once a draft exists, and otherwise starts a new attempt, at most 3 in all (then `attempts_exhausted`). Never answers the question. Otherwise returns `status: \"ineligible\"` with a reason.",
			})
			.input(RequestAgentReplyDraftInputSchema)
			.output(RequestAgentReplyDraftResultSchema),

		proposeReplyDraft: oc
			.route({
				method: "POST",
				path: "/reply-drafts",
				summary: "Store a drafted reply proposal for a quiet question",
				description:
					"Callable only by the drafting tedi named in the question target's policy. Rechecks eligibility (open, non-urgent decision-capture question) and appends an immutable draft. Returns its `delivery`: `auto` only when the policy's autoSend is enabled, `reversible` is true, and the question's agent session has fewer than autoSend.maxConsecutive auto-sent replies since the user last replied there, and an independent Clef review of the agent message and draft passes every deliveryGate check (a model failure fails closed); otherwise `review` (the user accepts, edits, or replaces it). This call itself sends nothing.",
			})
			.input(ProposeAgentReplyDraftInputSchema)
			.output(ProposeAgentReplyDraftResultSchema),

		getReplyDraftAcceptance: oc
			.route({
				method: "GET",
				path: "/reply-drafts/acceptance",
				summary: "Measure the caller's reply-draft acceptance per turn type",
				description:
					"Counts drafts proposed for the caller's questions and how the caller answered (accepted, edited, replaced, from response metadata `draftId`/`draftOutcome`), with eligibility against the policy thresholds, plus auto-send counts (autoSent, autoFollowedUp, overridden, overrideRate). Measurement only.",
			})
			.input(GetAgentReplyDraftAcceptanceInputSchema)
			.output(GetAgentReplyDraftAcceptanceResultSchema),

		getSessionLessons: oc
			.route({
				method: "POST",
				path: "/session-lessons",
				summary: "Get approved team lessons for a local agent session",
				description:
					"Returns the credential-resolved organization's active lessons (facts under `learning-feed:` topic keys, confirmed by a person or learned automatically from enough decisions: org-wide lessons plus the calling user's own personal lessons; probation, pending, archived and superseded facts never appear) whose `metadata.learningFeed.scope` repo and harness match the session (`general` matches any), most relevant first, trimmed to `budgetBytes`. Read-only.",
			})
			.input(GetAgentSessionLessonsInputSchema)
			.output(GetAgentSessionLessonsResultSchema),

		mineSessionLessons: oc
			.route({
				method: "POST",
				path: "/session-lessons/mine",
				summary: "Learn lessons from recent decisions now",
				description:
					"Runs the learning-feed miner for the credential-resolved organization immediately instead of waiting for nightly reflection: recent decision-capture answers become active lessons (personal to the deciding user, or in the owning tedi's memory when one clearly owns the subject), newer decisions supersede earlier learned lessons, and learned lessons without a supporting decision for 90 days are archived. Bounded per run and idempotent: a repeat run with no new decisions writes nothing. Returns the run counts.",
			})
			.input(MineAgentSessionLessonsInputSchema)
			.output(MineAgentSessionLessonsResultSchema),
	});

export type AgentTurnTriageContract = typeof agentTurnTriageContract;
