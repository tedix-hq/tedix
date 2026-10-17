import { useRef } from "react";
import type { DecisionEnvelope } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { Text } from "@/components/kumo/text";

export function DecisionEnvelopeCard({
	decision,
	askedBy,
	disabled,
	defaultLowStakesToDelegate = true,
	onDecision,
	onNext,
	onPrevious,
}: {
	decision: DecisionEnvelope;
	askedBy: string;
	disabled?: boolean;
	defaultLowStakesToDelegate?: boolean;
	onDecision: (
		feedback: DecisionCardFeedback,
		choice: string,
		elapsedMs: number,
	) => Promise<unknown>;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const shownAt = useRef(performance.now());
	const preferDelegation =
		defaultLowStakesToDelegate &&
		decision.reversibility === "two_way" &&
		decision.protectedEffects.length === 0 &&
		decision.kind !== "approval" &&
		decision.kind !== "outbound" &&
		decision.options.some((option) => option.intent === "delegate");
	return (
		<WorkDecisionCard
			autoFocus
			kind={decision.kind}
			title={decision.proposal}
			askedBy={askedBy}
			body={decision.recommendation}
			disabled={disabled}
			content={
				<div className="grid min-w-0 gap-3 break-words">
					<Text>
						<strong>Recommended:</strong> {decision.recommendation}
					</Text>
					<Text>
						<strong>Why now:</strong> {decision.whyNow}
					</Text>
					<Text>
						<strong>{decision.reversibility.replaceAll("_", " ")} door</strong>{" "}
						· {decision.blastRadius}
					</Text>
					<Text>
						Confidence:{" "}
						{decision.confidence === null
							? "not assessed"
							: `${Math.round(decision.confidence * 100)}%`}{" "}
						· Waiting: {decision.costOfWaiting}
					</Text>
				</div>
			}
			why={
				<div className="grid min-w-0 gap-3 break-words">
					<Text>{decision.reasoning}</Text>
					{decision.lessons.length ? (
						decision.lessons.map((lesson) => (
							<Text key={lesson.id}>
								{lesson.text}{" "}
								<span className="text-kumo-subtle">({lesson.id})</span>
							</Text>
						))
					) : (
						<Text>No cited lessons yet.</Text>
					)}
				</div>
			}
			actions={decision.options.map((option) => ({
				id: option.id,
				label: option.label,
				intent:
					option.intent === "reject"
						? "reject"
						: (
									preferDelegation
										? option.intent === "delegate"
										: option.intent === "approve"
							  )
							? "approve"
							: undefined,
				description: `${option.consequence} Cost: ${option.cost}`,
				...(option.intent === "approve" &&
				(decision.reversibility !== "two_way" ||
					decision.protectedEffects.length > 0)
					? {
							confirm: `${option.consequence} ${decision.blastRadius}. This saves your decision; execution still follows the originating Work's permissions.`,
						}
					: {}),
			}))}
			editAction={
				decision.kind === "question"
					? undefined
					: { id: "change", label: "Save changes" }
			}
			onDecision={(feedback) =>
				onDecision(
					feedback,
					feedback.action === "change"
						? "change"
						: decision.options.find((option) => option.id === feedback.action)!
								.intent,
					performance.now() - shownAt.current,
				)
			}
			onNext={onNext}
			onPrevious={onPrevious}
		/>
	);
}
