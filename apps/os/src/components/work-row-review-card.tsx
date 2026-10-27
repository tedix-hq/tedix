import { useState } from "react";
import type { RowReviewSpec } from "@tedix/api-contract/schemas/os-row-review";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { Link } from "@/components/kumo/link";
import {
	WorkDecisionCard,
	type DecisionCardAction,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { osApi } from "@/lib/api";
import { decisionText } from "@/shared/os-copy";

type RowAnswer = { verdict: "confirmed" | "corrected"; correction: string };

export function WorkRowReviewCard({
	requestId,
	requestVersion,
	spec,
	title,
	askedBy,
	disabled,
	onNext,
	onPrevious,
}: {
	requestId: string;
	requestVersion: number;
	spec: RowReviewSpec;
	title: string;
	askedBy: string;
	disabled?: boolean;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const [answers, setAnswers] = useState<Record<number, RowAnswer>>({});
	const complete = spec.rows.every((row) => {
		const answer = answers[row.row];
		return (
			answer &&
			(answer.verdict === "confirmed" || answer.correction.trim().length > 0)
		);
	});
	const set = (row: number, answer: RowAnswer | null) =>
		setAnswers((current) => {
			const next = { ...current };
			if (answer) next[row] = answer;
			else delete next[row];
			return next;
		});
	const confirmAll = () =>
		setAnswers(
			Object.fromEntries(
				spec.rows.map((row) => [
					row.row,
					{ verdict: "confirmed", correction: "" },
				]),
			),
		);
	const actions: DecisionCardAction[] = [
		{
			id: "save",
			label: complete
				? decisionText(`Save ${spec.rows.length} answers`)
				: decisionText("Answer every row"),
			intent: "approve",
			disabled: !complete,
		},
	];
	const decide = async (feedback: DecisionCardFeedback) => {
		if (feedback.action === "save")
			return osApi.attention.decideDeckCard({
				decision: {
					kind: "row_review",
					requestId,
					expectedRequestVersion: requestVersion,
					verdicts: spec.rows.map((row) => {
						const answer = answers[row.row]!;
						return answer.verdict === "corrected"
							? {
									row: row.row,
									verdict: "corrected" as const,
									correction: answer.correction.trim(),
								}
							: { row: row.row, verdict: "confirmed" as const };
					}),
				},
			});
		return osApi.workInteractions.respond({
			requestId,
			expectedRequestVersion: requestVersion,
			responseKind: "answer",
			body: feedback.body,
			resolvesRequest: true,
			metadata: { cardAction: feedback.action, source: "os-decision-card" },
		});
	};
	return (
		<WorkDecisionCard
			kind="decision"
			title={title}
			askedBy={askedBy}
			content={
				<div className="grid gap-3">
					<Text tone="secondary">
						{decisionText(
							`Confirm each proposed row, or correct the ones that are wrong. The answers write back to "${spec.sheet.title}".`,
						)}
					</Text>
					{spec.rows.map((row, index) => {
						const answer = answers[row.row];
						const corrected = answer?.verdict === "corrected";
						return (
							<div
								key={row.row}
								className="grid gap-2 rounded-lg border border-kumo-line p-3"
								data-row-review-row={row.row}
							>
								<Text>
									<strong>
										{index + 1}. {row.label}
									</strong>
								</Text>
								<Text tone="secondary">{row.proposal}</Text>
								<div className="flex items-center gap-2">
									<Button
										variant={
											answer?.verdict === "confirmed" ? "default" : "outline"
										}
										size="sm"
										onClick={() =>
											set(
												row.row,
												answer?.verdict === "confirmed"
													? null
													: { verdict: "confirmed", correction: "" },
											)
										}
									>
										{decisionText("Confirm")}
									</Button>
									<Button
										variant={corrected ? "default" : "outline"}
										size="sm"
										onClick={() =>
											set(
												row.row,
												corrected
													? null
													: { verdict: "corrected", correction: "" },
											)
										}
									>
										{decisionText("Correct")}
									</Button>
								</div>
								{corrected && (
									<Input
										value={answer.correction}
										placeholder={decisionText("Type the correction")}
										onChange={(event) =>
											set(row.row, {
												verdict: "corrected",
												correction: event.target.value,
											})
										}
									/>
								)}
							</div>
						);
					})}
					<div className="flex items-center gap-3">
						<Button variant="ghost" size="sm" onClick={confirmAll}>
							{decisionText("Confirm all")}
						</Button>
						<Link href={`/outputs/${spec.sheet.outputId}`}>
							{decisionText("Open the sheet")}
						</Link>
					</div>
				</div>
			}
			actions={actions}
			allowEdits={false}
			disabled={disabled}
			onDecision={decide}
			onNext={onNext}
			onPrevious={onPrevious}
		/>
	);
}
