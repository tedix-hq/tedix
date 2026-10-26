import { useRef } from "react";
import { renderCardDateText } from "@tedix/api-contract/utils/decision-card-copy";
import type { CardRevisionTarget } from "@/components/card-revision-panel";
import { DecisionProposalBody } from "@/components/decision-proposal-body";
import type { DecisionEnvelope } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { Text } from "@/components/kumo/text";
import { FeedDeckDisclosure } from "@/components/feed-deck-primitives";
import { OS_COPY, decisionText } from "@/shared/os-copy";

export function DecisionEnvelopeCard({
	decision,
	askedBy,
	revisionTarget,
	disabled,
	defaultLowStakesToDelegate = true,
	onDecision,
	onNext,
	onPrevious,
}: {
	decision: DecisionEnvelope;
	askedBy: string;
	revisionTarget?: CardRevisionTarget;
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
			revisionTarget={revisionTarget}
			body={decision.preview?.body ?? decision.recommendation}
			disabled={disabled}
			allowEdits={!decision.options.some((option) => option.effect)}
			content={
				<div className="grid min-w-0 gap-3 break-words">
					{decision.preview && (
						<DecisionProposalBody
							body={decision.preview.body}
							inline={decision.kind === "outbound"}
						/>
					)}
					{!decision.preview && (
						<Text className="fd-card-summary">
							{renderCardDateText(decision.whyNow)}
						</Text>
					)}
					<Text className="fd-recommendation">
						{renderCardDateText(decision.recommendation)}
					</Text>
					{decision.blastRadius && (
						<Text className="fd-stakes">
							If wrong: {renderCardDateText(decision.blastRadius)}
						</Text>
					)}
					<FeedDeckDisclosure title={OS_COPY.feed.details}>
						<Text>
							<strong>{decisionText("Why now:")}</strong>{" "}
							{renderCardDateText(decision.whyNow)}
						</Text>
						<Text>
							<strong>
								{decisionText(
									decision.reversibility === "two_way"
										? "Easy to undo"
										: decision.reversibility === "one_way"
											? "Hard to undo"
											: "Reversibility unknown",
								)}
							</strong>{" "}
							· {renderCardDateText(decision.blastRadius)}
						</Text>
						<Text>
							{decision.confidence !== null &&
								`${decisionText("Confidence:")} ${Math.round(decision.confidence * 100)}% · `}
							{decisionText("Waiting:")}{" "}
							{renderCardDateText(decision.costOfWaiting)}
						</Text>
					</FeedDeckDisclosure>
					{decision.expiresAt && (
						<Text>
							{OS_COPY.decisionDeck.expires(
								Math.ceil(
									(Date.parse(decision.expiresAt) - Date.now()) / 60_000,
								),
							)}
						</Text>
					)}
					{decision.nobodyOn && <Text>{OS_COPY.decisionDeck.nobodyOn}</Text>}
				</div>
			}
			why={
				<div className="grid min-w-0 gap-3 break-words">
					<Text>{decision.reasoning}</Text>
					{decision.lessons.length ? (
						decision.lessons.map((lesson) => (
							<Text key={lesson.id}>{lesson.text} </Text>
						))
					) : (
						<Text>{decisionText("No cited lessons yet.")}</Text>
					)}
				</div>
			}
			actions={decision.options.map((option) => ({
				id: option.id,
				label: option.label,
				intent: option.intent,
				primary: preferDelegation
					? option.intent === "delegate"
					: option.intent === "approve",
				description: `${option.consequence} ${decisionText("Cost:")} ${option.cost}`,
				...(option.intent === "approve" &&
				(decision.reversibility !== "two_way" ||
					decision.protectedEffects.length > 0)
					? {
							confirm: [
								option.consequence,
								renderCardDateText(decision.blastRadius),
								"This saves your decision; execution still follows the originating Work's permissions.",
							]
								.map((part) => part.trim().replace(/([^.!?])$/, "$1."))
								.filter(Boolean)
								.join(" "),
						}
					: {}),
			}))}
			editAction={
				decision.kind === "question" ||
				decision.options.some((option) => option.effect)
					? undefined
					: { id: "change", label: decisionText("Save changes") }
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
