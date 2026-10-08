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
import type { WorkInteractionReplyDraft } from "@tedix/db/schema/work-factory";
import {
	AUTO_REPLY_FOLLOW_CLASSES,
	AUTO_REPLY_NEUTRAL_CLASSES,
} from "@tedix/db/queries/work-items/reply-drafts";
import type { ObservedLearningInteractionInput } from "./learning-interaction-recorder";

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
 * The learning event for one committed decision-capture answer, or null when
 * the Interaction is not decision capture or the answer is not a human's.
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
	if (requestMeta.schema !== DECISION_CAPTURE_SCHEMA) return null;
	if (response.responseKind !== "answer" || response.responderType !== "user")
		return null;
	const responseMeta = response.metadata ?? {};
	const draft =
		input.draft && input.draft.id === responseMeta.draftId ? input.draft : null;
	const eventKind = eventKindFor(responseMeta, draft);
	const repo = learningScopeSlug(str(requestMeta.repository, 80));
	const harness = learningScopeSlug(
		str(requestMeta.host, 40) ?? str(responseMeta.host, 40),
	);
	const topic = learningScopeSlug(
		draft?.turnType ?? topTriageLabel(requestMeta),
	);
	const sessionId = str(requestMeta.sessionId, 200);
	return {
		organizationId: input.organizationId,
		clientEventId: `decision-capture:${response.id}`,
		signalClass: "quality",
		eventKind,
		surface: DECISION_CAPTURE_LEARNING_SURFACE,
		tediId: draft?.drafterId ?? null,
		issueKey: `decision:${repo}:${harness}:${topic}`,
		targetType: "work_interaction",
		targetId: request.id,
		...(sessionId ? { threadId: sessionId } : {}),
		occurredAt: response.respondedAt,
		metadata: {
			schema: "tedix.learning-feed.decision.v1",
			scope: { repo, harness, topic },
			branch: str(requestMeta.branch, 200),
			question: {
				subject: request.subject.slice(0, 300),
				tail: request.prompt.slice(-QUESTION_CHARS),
			},
			answer: response.body.slice(0, ANSWER_CHARS),
			answerSource: str(responseMeta.source, 64),
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
