import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	GetAgentSessionLessonsInputSchema,
	GetAgentSessionLessonsResultSchema,
	GetLessonEffectivenessInputSchema,
	GetLessonEffectivenessResultSchema,
	ListAgentLessonsInputSchema,
	ListAgentLessonsResultSchema,
	MineAgentSessionLessonsInputSchema,
	MineAgentSessionLessonsResultSchema,
} from "../schemas/agent-session-lessons";
import {
	ImportAgentSessionDecisionsInputSchema,
	ImportAgentSessionDecisionsResultSchema,
} from "../schemas/agent-session-decisions";
import {
	AgentTurnTriagePolicyStateSchema,
	GetAgentReplyDraftAcceptanceInputSchema,
	GetAgentReplyDraftAcceptanceResultSchema,
	GetAgentReplyDraftLeaderboardInputSchema,
	GetAgentReplyDraftLeaderboardResultSchema,
	GetDecisionCaptureHealthInputSchema,
	GetDecisionCaptureHealthResultSchema,
	LabelAgentReplyInputSchema,
	LabelAgentReplyResultSchema,
	ProposeAgentReplyDraftInputSchema,
	ProposeAgentReplyDraftResultSchema,
	RequestAgentReplyDraftInputSchema,
	RequestAgentReplyDraftResultSchema,
	RetriageAgentTurnQuestionsInputSchema,
	RetriageAgentTurnQuestionsResultSchema,
	TriageAgentTurnInputSchema,
	TriageResultSchema,
	UpdateAgentTurnTriagePolicyInputSchema,
} from "../schemas/agent-turn-triage";

/**
 * Urgency triage of agent turns (MCP: `triage_agent_turn`,
 * `label_agent_reply`, `get_agent_turn_triage_policy`,
 * `update_agent_turn_triage_policy`) and tedi-drafted replies to quiet
 * decision-capture questions (MCP: `request_agent_reply_draft`,
 * `propose_agent_reply_draft`, `get_agent_reply_draft_acceptance`), the
 * re-judging of the caller's open questions as updates or real asks
 * (MCP: `retriage_agent_turn_questions`), and the
 * approved team lessons a local agent session receives
 * (MCP: `get_agent_session_lessons`, learned on demand by
 * `mine_agent_session_lessons`, measured by `get_lesson_effectiveness`), and the historic import of the caller's
 * own past local session decisions (MCP: `import_agent_session_decisions`).
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

		retriageQuestions: oc
			.route({
				method: "POST",
				path: "/questions/retriage",
				summary: "Re-triage the caller's open agent-turn questions",
				description:
					"For the caller's own open decision-capture questions (newest first, up to `limit`): asks Clef whether each turn asks the caller for a decision, fact, approval or action only they can give, and writes a one-line `need` for those that do. With `apply`, stores the verdict as `metadata.attention` and expires the updates (turns that ask nothing); it never answers or cancels a question. A question the model cannot judge is left unchanged.",
			})
			.input(RetriageAgentTurnQuestionsInputSchema)
			.output(RetriageAgentTurnQuestionsResultSchema),

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

		getReplyDraftLeaderboard: oc
			.route({
				method: "GET",
				path: "/reply-drafts/leaderboard",
				summary: "Rank the tedis that draft the caller's replies",
				description:
					"Per drafting tedi, for the caller's questions since `since` and since `todaySince`: drafts written, auto-sent, replies that stood (auto not overridden, or accepted as written), corrected (edited, replaced or overridden) and mean reply time, ranked by replies that stood. Same outcome rules as get_agent_reply_draft_acceptance. Measurement only.",
			})
			.input(GetAgentReplyDraftLeaderboardInputSchema)
			.output(GetAgentReplyDraftLeaderboardResultSchema),

		getCaptureHealth: oc
			.route({
				method: "GET",
				path: "/capture-health",
				summary: "Count what decision capture recorded for the caller",
				description:
					"Since `since`: decision-capture questions from the caller's agent turns, tedi reply drafts on them, and lesson deliveries to the caller's agent sessions. Zero turns on a working day usually means capture is broken on the caller's machine. Measurement only.",
			})
			.input(GetDecisionCaptureHealthInputSchema)
			.output(GetDecisionCaptureHealthResultSchema),

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

		listLessons: oc
			.route({
				method: "GET",
				path: "/session-lessons/notebook",
				summary: "List the lessons the caller's sessions receive, newest first",
				description:
					"The same approved lessons `get_agent_session_lessons` delivers (org-wide plus the caller's own personal ones), unfiltered by session and newest first, each with when it was written and the decisions it was learned from (count, newest reply time, and whether they were the caller's). Read-only; records nothing.",
			})
			.input(ListAgentLessonsInputSchema)
			.output(ListAgentLessonsResultSchema),

		getLessonEffectiveness: oc
			.route({
				method: "POST",
				path: "/session-lessons/effectiveness",
				summary:
					"Measure whether delivered lessons reduce repeated corrections",
				description:
					"For the caller's own sessions (and org-wide ones) over recent weeks: sessions that received learned lessons vs the stable 10% holdout that did not, and the user corrections that followed (decision-capture answers classed correction, challenge, frustration, simplify, verify or plain-english, or an edited or replaced draft), overall, per week and per learned lesson (corrections matched to the lesson's subject). A lesson with at least 20 delivered and 4 holdout sessions gets a verdict: `helps` when its delivered rate is lower, else `no_better`. Read-only.",
			})
			.input(GetLessonEffectivenessInputSchema)
			.output(GetLessonEffectivenessResultSchema),

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

		importSessionDecisions: oc
			.route({
				method: "POST",
				path: "/session-decisions/import",
				summary: "Import the caller's past local agent-session decisions",
				description:
					"Records up to 25 locally extracted, redacted (agent message tail, user reply) pairs from the caller's own past Claude Code or Codex sessions as personal-scope learning events (surface `agent_session_import`) for the learning-feed miner (nightly, or now with `mine_agent_session_lessons`). Requires a person's identity. Idempotent by (harness, sessionId, turnId): a re-run reports duplicates and writes nothing new.",
			})
			.input(ImportAgentSessionDecisionsInputSchema)
			.output(ImportAgentSessionDecisionsResultSchema),
	});

export type AgentTurnTriageContract = typeof agentTurnTriageContract;
