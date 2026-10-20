import { cardIsDue } from "@/lib/card-schedule";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { currentDeckCuration } from "@tedix/api-contract/utils/deck-curator";
import type { DecisionCardFeedback } from "@/components/work-decision-card";
import diff from "fast-diff";

export function decisionEnvelope(
	metadata: Record<string, unknown> | null | undefined,
) {
	const parsed = DecisionEnvelopeSchema.safeParse(metadata?.decisionDeck);
	const curation = currentDeckCuration(metadata);
	const previewBody = curation ? curation.draftBody : metadata?.cardContent;
	return parsed.success
		? {
				...parsed.data,
				...(typeof previewBody === "string"
					? { preview: { ...parsed.data.preview, body: previewBody } }
					: {}),
			}
		: null;
}

export interface DecisionLearningReceipt {
	id: string;
	requestId?: string;
	classId: string;
	choice: string;
	signal: string;
	at: string;
	feedback?: string;
	elapsedMs?: number;
}

/** A bounded history is evidence for a counter, never authority to execute. */
export function classReadiness(
	receipts: readonly DecisionLearningReceipt[],
	classId: string,
	threshold: number,
) {
	const history = [
		...new Map(
			receipts
				.filter((row) => row.classId === classId)
				.map((row) => [row.id, row]),
		).values(),
	].sort((a, b) => b.at.localeCompare(a.at));
	const seen = new Set<string>();
	let unchanged = 0;
	for (const row of history) {
		if (row.choice === "later") continue;
		if (row.signal !== "approve-as-is" || row.choice !== "approve") break;
		const key = row.requestId ?? row.id;
		if (seen.has(key)) continue;
		seen.add(key);
		unchanged++;
	}
	return {
		unchanged,
		ready: unchanged >= threshold,
		delegated: history.filter((row) => row.choice === "delegate").length,
		total: history.length,
	};
}

export function decisionFeedbackMetadata(
	feedback: DecisionCardFeedback,
	classId: string,
	choice: string,
	elapsedMs: number,
) {
	return {
		source: "os-decision-card",
		decisionClass: classId,
		cardAction: feedback.action,
		decisionChoice: choice,
		feedbackSignal:
			choice === "delegate" || choice === "later" ? "answer" : feedback.signal,
		elapsedMs: Math.max(0, Math.round(elapsedMs)),
		...(feedback.reason ? { feedbackReason: feedback.reason } : {}),
		...(feedback.feedback ? { feedbackText: feedback.feedback } : {}),
		...(feedback.originalBody
			? {
					originalBody: feedback.originalBody,
					editedBody: feedback.body,
					editRatio: Math.min(
						1,
						diff(feedback.originalBody, feedback.body).reduce(
							(total, [operation, text]) =>
								total + (operation === 0 ? 0 : text.length),
							0,
						) / Math.max(feedback.originalBody.length, feedback.body.length, 1),
					),
				}
			: {}),
	};
}

/** An absent holder field on an older server is unknown, not an idle outcome. */
export function workIsUnowned(
	work:
		| { accountableOwnerId: string | null; activeAttempt?: unknown }
		| null
		| undefined,
) {
	return work?.activeAttempt === null && work.accountableOwnerId === null;
}

/** Correlate feedback with the durable effect, never a later client telemetry event. */
export function decisionLearningKey(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return;
	if (
		"learningClientEventId" in result &&
		typeof result.learningClientEventId === "string"
	)
		return result.learningClientEventId;
	if (
		"response" in result &&
		result.response &&
		typeof result.response === "object" &&
		"id" in result.response &&
		typeof result.response.id === "string"
	)
		return `decision-capture:${result.response.id}`;
}

/** Scheduled cards enter the decision queue on the viewer's calendar date. */
export function decisionIsDue(
	request: {
		kind: string;
		dueAt?: string | null;
		metadata?: Record<string, unknown> | null;
	},
	now: Date,
	timeZone?: string,
) {
	if (request.metadata?.source === "deadline-decisions") {
		const { dueAt: _deadline, ...scheduled } = request;
		return cardIsDue(scheduled, now, timeZone);
	}
	return cardIsDue(request, now, timeZone);
}

export function decisionDeadlinePassed(
	request: { kind: string; dueAt?: string | null },
	now: Date,
) {
	return (
		request.kind !== "coordination" &&
		!!request.dueAt &&
		Date.parse(request.dueAt) < now.getTime()
	);
}
