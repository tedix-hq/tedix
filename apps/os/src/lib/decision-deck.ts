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
	let unchanged = 0;
	for (const row of history) {
		if (row.choice === "later") continue;
		if (row.signal !== "approve-as-is" || row.choice !== "approve") break;
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
