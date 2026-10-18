import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import {
	scoreLearning,
	type LearningCandidate,
} from "@tedix/api-contract/utils/decision-learning";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import type { DecisionCardFeedback } from "@/components/work-decision-card";
import diff from "fast-diff";

export function decisionEnvelope(
	metadata: Record<string, unknown> | null | undefined,
) {
	const parsed = DecisionEnvelopeSchema.safeParse(metadata?.decisionDeck);
	return parsed.success ? parsed.data : null;
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

export function rankDecision<
	T extends {
		id: string;
		kind: string;
		project: string;
		urgency: string;
		decision: ReturnType<typeof decisionEnvelope>;
	},
>(
	row: T,
	model: DecisionLearningModel | undefined,
	now: Date,
	context: Partial<LearningCandidate> = {},
) {
	return model
		? scoreLearning(
				{
					id: row.id,
					classId: row.decision?.classId ?? row.kind,
					projectId: row.project,
					urgency: row.urgency === "now" ? 1 : 0,
					protected: row.decision ? true : row.kind === "approval",
					lessons: row.decision?.lessons.map((l) => ({
						...l,
						classId: row.decision!.classId,
					})),
					...context,
				},
				model,
				now,
			)
		: { score: 0, factors: [], lessonIds: [] };
}

/** An elapsed request deadline needs revalidation before it competes with fresh decisions. */
export function compareDecisionFreshness(
	a: { dueAt?: string | null; requestedAt?: string; score?: number },
	b: { dueAt?: string | null; requestedAt?: string; score?: number },
	now: Date,
) {
	const due = (value?: string | null) =>
		value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
	const aDue = due(a.dueAt);
	const bDue = due(b.dueAt);
	const stale = Number(aDue < now.getTime()) - Number(bDue < now.getTime());
	return (
		stale ||
		(b.score ?? 0) - (a.score ?? 0) ||
		(aDue !== bDue ? aDue - bDue : 0) ||
		(Date.parse(b.requestedAt ?? "") || 0) -
			(Date.parse(a.requestedAt ?? "") || 0)
	);
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

/** Coordination due dates schedule a follow-up; question deadlines do not delay review. */
export function decisionIsDue(
	request: { kind: string; dueAt?: string | null },
	now: Date,
) {
	return (
		request.kind !== "coordination" ||
		!request.dueAt ||
		Date.parse(request.dueAt) <= now.getTime()
	);
}
