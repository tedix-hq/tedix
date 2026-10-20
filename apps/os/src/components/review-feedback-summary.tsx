import { useState } from "react";
import type { OsReviewFeedback } from "@tedix/api-contract/contracts/os-shares";
import { Button } from "@/components/kumo/button";
import { SegmentedControl } from "@/components/kumo/segmented-control";
type Round = { id: string; title: string; createdAt: string };
export function ReviewFeedbackSummary({ shareId }: { shareId: string }) {
	const [titles, setTitles] = useState<Record<string, string>>({});
	const [rows, setRows] = useState<OsReviewFeedback[] | null>(null);
	const [rounds, setRounds] = useState<Round[]>([]);
	const [roundId, setRoundId] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	async function load(batchId?: string) {
		setBusy(true);
		try {
			const { osApi } = await import("@/lib/api");
			const result = await osApi.osShares.reviews.listFeedback({
				shareId,
				...(batchId ? { batchId } : {}),
			});
			setRows(result.feedback);
			setRounds(result.rounds);
			setRoundId(result.batch.id);
			setTitles(
				Object.fromEntries(
					result.batch.cards.map((card) => [card.id, card.title]),
				),
			);
			setMessage(result.feedback.length ? "" : "No feedback yet.");
		} catch {
			setMessage(
				"No review batch is available, or you do not have access to its feedback.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="w-full">
			<Button
				variant="ghost"
				size="sm"
				disabled={busy}
				onClick={() => void load()}
			>
				{busy ? "Loading…" : "View saved feedback"}
			</Button>
			{rounds.length > 1 && (
				<div
					className="flex flex-wrap items-center gap-1 text-xs text-kumo-subtle"
					aria-label="Review rounds"
				>
					Rounds:
					<fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
						<SegmentedControl
							ariaLabel="Review rounds"
							compact
							value={roundId ?? ""}
							onValueChange={(id) => {
								if (!busy) void load(id);
							}}
							options={rounds.map((round, index) => ({
								value: round.id,
								label: (
									<span title={round.title}>
										{index === 0
											? "Current"
											: new Date(round.createdAt).toLocaleDateString()}
									</span>
								),
							}))}
						/>
					</fieldset>
				</div>
			)}
			<p role="status" className="text-xs text-kumo-subtle">
				{message}
			</p>
			{rows?.map((row) => (
				<details key={`${row.cardId}:${row.reviewerId}`} className="text-sm">
					<summary>
						{titles[row.cardId]} · {row.decision.replaceAll("_", " ")} ·{" "}
						{new Date(row.updatedAt).toLocaleString()}
					</summary>
					<p className="whitespace-pre-wrap">{row.reason}</p>
					<p className="whitespace-pre-wrap">{row.editedReply}</p>
					<details>
						<summary>Technical details</summary>
						<small>Reviewer: {row.reviewerId}</small>
					</details>
				</details>
			))}
		</div>
	);
}
