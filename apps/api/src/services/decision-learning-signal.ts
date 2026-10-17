/**
 * Decision-capture → learning ledger.
 *
 * A decision-capture Interaction (`metadata.schema` = tedix.decision-capture.v1)
 * is an agent turn waiting on its user; the answer is the user's decision, and
 * when a tedi drafted a reply the answer also judges that draft. Once the
 * answer has committed, this records one `learning_interaction_events` row so
 * the reflection miner (`learning-feed-miner.ts`) can turn repeated decisions
 * and corrections into review-pending memory.
 *
 * Signal strength, strongest first:
 *   - draft replaced / edited in Tedix OS, or an auto-sent draft the user
 *     redirected in chat → `manually_replaced` / `edited` (draft vs final kept)
 *   - draft accepted as-is, or an auto-sent draft the user followed → `accepted`
 *   - no draft → `answered` (a plain decision)
 *
 * Scope is the answering user's personal scope (server-derived identity).
 * Recording is fail-soft: the answer already committed.
 */

import type { LearningInteractionKind } from "@tedix/api-contract/schemas/learning-feedback";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import type { WorkInteractionReplyDraft } from "@tedix/db/schema/work-factory";
import {
	AUTO_REPLY_FOLLOW_CLASSES,
	AUTO_REPLY_NEUTRAL_CLASSES,
} from "@tedix/db/queries/work-items/reply-drafts";
import type { ObservedLearningInteractionInput } from "./learning-interaction-recorder";
import { decisionEditContext } from "./decision-edit-context";

export const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
/** `learning_interaction_events.surface` of a decision-capture answer. */
export const DECISION_CAPTURE_LEARNING_SURFACE = "decision_capture";

const QUESTION_CHARS = 600;
const ANSWER_CHARS = 1000;
const DRAFT_CHARS = 1000;

type JsonRecord = Record<string, unknown>;

export interface DecisionCaptureRequestView {
	id: string;
	subject: string;
	prompt: string;
	workItemId: string | null;
	projectId: string | null;
	metadata: JsonRecord | null;
}

export interface DecisionCaptureResponseView {
	id: string;
	responseKind: string;
	body: string;
	responderType: string;
	respondedAt: string;
	metadata: JsonRecord | null;
}

function str(value: unknown, max = 200): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

/** Lowercase slug safe for a topic key segment. */
export function learningScopeSlug(value: string | null | undefined): string {
	const slug = (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "general";
}

/** Highest-scoring triage label, when the turn was triaged. */
function topTriageLabel(metadata: JsonRecord): string | null {
	const triage = metadata.triage;
	if (!triage || typeof triage !== "object") return null;
	const labels = (triage as JsonRecord).labels;
	if (!labels || typeof labels !== "object") return null;
	let best: [string, number] | null = null;
	for (const [label, score] of Object.entries(labels as JsonRecord)) {
		if (typeof score !== "number" || !Number.isFinite(score)) continue;
		if (!best || score > best[1]) best = [label, score];
	}
	return best?.[0] ?? null;
}

function eventKindFor(
	responseMeta: JsonRecord,
	draft: WorkInteractionReplyDraft | null,
): LearningInteractionKind {
	if (!draft) return "answered";
	switch (responseMeta.draftOutcome) {
		case "accepted":
			return "accepted";
		case "edited":
			return "edited";
		case "replaced":
			return "manually_replaced";
		case "auto-sent": {
			const replyClass = str(responseMeta.replyClass, 64);
			// A question about the auto-sent draft judges nothing.
			if (
				replyClass &&
				(AUTO_REPLY_NEUTRAL_CLASSES as readonly string[]).includes(replyClass)
			)
				return "answered";
			return replyClass &&
				(AUTO_REPLY_FOLLOW_CLASSES as readonly string[]).includes(replyClass)
				? "accepted"
				: "manually_replaced";
		}
		default:
			return "answered";
	}
}

/**
 * The learning event for a committed capture answer or decision-card response.
 * Agent responses never become human preference signals.
 * `draft` must be the draft the response cites (same id), else null.
 */
export function decisionCaptureLearningSignal(input: {
	organizationId: string;
	request: DecisionCaptureRequestView;
	response: DecisionCaptureResponseView;
	draft: WorkInteractionReplyDraft | null;
}): ObservedLearningInteractionInput | null {
	const { request, response } = input;
	const requestMeta = request.metadata ?? {};
	const responseMeta = response.metadata ?? {};
	const decision = DecisionEnvelopeSchema.safeParse(requestMeta.decisionDeck);
	const cardFeedback = responseMeta.source === "os-decision-card";
	if (requestMeta.schema !== DECISION_CAPTURE_SCHEMA && !cardFeedback)
		return null;
	if (response.responderType !== "user") return null;
	if (!cardFeedback && response.responseKind !== "answer") return null;
	const draft =
		input.draft && input.draft.id === responseMeta.draftId ? input.draft : null;
	const eventKind: LearningInteractionKind = cardFeedback
		? responseMeta.feedbackSignal === "approve-as-is"
			? "accepted"
			: responseMeta.feedbackSignal === "edited"
				? "edited"
				: responseMeta.feedbackSignal === "rejected" ||
					  responseMeta.feedbackSignal === "reason"
					? "rejected"
					: "answered"
		: eventKindFor(responseMeta, draft);
	const repo = learningScopeSlug(str(requestMeta.repository, 80));
	const harness = learningScopeSlug(
		str(requestMeta.host, 40) ?? str(responseMeta.host, 40),
	);
	const topic = learningScopeSlug(
		(decision.success
			? decision.data.classId
			: str(responseMeta.decisionClass, 100)) ??
			draft?.turnType ??
			topTriageLabel(requestMeta),
	);
	const sessionId = str(requestMeta.sessionId, 200);
	return {
		organizationId: input.organizationId,
		clientEventId: `decision-capture:${response.id}`,
		signalClass: "quality",
		eventKind,
		surface: DECISION_CAPTURE_LEARNING_SURFACE,
		tediId: draft?.drafterId ?? str(requestMeta.proposerTediId, 200) ?? null,
		issueKey: `decision:${repo}:${harness}:${topic}`,
		targetType: "work_interaction",
		targetId: request.id,
		...(sessionId ? { threadId: sessionId } : {}),
		occurredAt: response.respondedAt,
		metadata: {
			schema: "tedix.learning-feed.decision.v1",
			scope: { repo, harness, topic },
			...(decision.success
				? {
						decisionContext: {
							kind: decision.data.kind,
							proposal: decision.data.proposal,
							workItemId: request.workItemId,
							projectId: request.projectId,
							reversibility: decision.data.reversibility,
							protectedEffects: decision.data.protectedEffects,
							confidence: decision.data.confidence,
							whyNow: decision.data.whyNow,
							costOfWaiting: decision.data.costOfWaiting,
							recommendation: decision.data.recommendation,
						},
						decisionEffect: responseMeta.decisionEffect ?? null,
					}
				: {}),
			decisionClass: decision.success
				? decision.data.classId
				: str(responseMeta.decisionClass, 100),
			channel: str(requestMeta.channel, 100),
			personId: str(requestMeta.personId, 200),
			entityId: str(requestMeta.entityId, 200),
			source: str(requestMeta.source, 200) ?? "decision_capture",
			decisionChoice: str(responseMeta.decisionChoice, 40),
			urgency:
				str((requestMeta.triage as JsonRecord | undefined)?.urgency, 40) ??
				str(responseMeta.urgency, 40),
			...(["edited", "manually_replaced"].includes(eventKind)
				? {
						editContext: decisionEditContext(
							typeof responseMeta.originalBody === "string"
								? responseMeta.originalBody
								: (draft?.body ?? ""),
							typeof responseMeta.editedBody === "string"
								? responseMeta.editedBody
								: response.body,
						),
					}
				: {}),
			originalLength:
				typeof responseMeta.originalBody === "string"
					? responseMeta.originalBody.length
					: (draft?.body.length ?? null),
			editedLength:
				typeof responseMeta.editedBody === "string"
					? responseMeta.editedBody.length
					: response.body.length,
			elapsedMs:
				typeof responseMeta.elapsedMs === "number" &&
				Number.isFinite(responseMeta.elapsedMs)
					? Math.max(0, responseMeta.elapsedMs)
					: null,
			branch: str(requestMeta.branch, 200),
			question: {
				subject: request.subject.slice(0, 300),
				tail: request.prompt.slice(-QUESTION_CHARS),
			},
			answer: response.body.slice(0, ANSWER_CHARS),
			answerSource: str(responseMeta.source, 64),
			cardAction: str(responseMeta.cardAction, 100),
			feedbackSignal: str(responseMeta.feedbackSignal, 40),
			feedbackReason: str(responseMeta.feedbackReason, 100),
			feedbackText: str(responseMeta.feedbackText, ANSWER_CHARS),
			originalBody:
				str(responseMeta.originalBody, DRAFT_CHARS) ??
				(draft ? draft.body.slice(0, DRAFT_CHARS) : null),
			editedBody:
				str(responseMeta.editedBody, DRAFT_CHARS) ??
				(["edited", "manually_replaced"].includes(eventKind)
					? response.body.slice(0, DRAFT_CHARS)
					: null),
			editRatio:
				typeof responseMeta.editRatio === "number" &&
				Number.isFinite(responseMeta.editRatio)
					? Math.max(0, Math.min(1, responseMeta.editRatio))
					: null,
			replyClass: str(responseMeta.replyClass, 64),
			draft: draft
				? {
						id: draft.id,
						outcome: str(responseMeta.draftOutcome, 32),
						delivery: draft.delivery,
						body: draft.body.slice(0, DRAFT_CHARS),
						editRatio:
							typeof responseMeta.editRatio === "number"
								? responseMeta.editRatio
								: null,
					}
				: null,
			workItemId: request.workItemId,
			projectId: request.projectId,
		},
	};
}
