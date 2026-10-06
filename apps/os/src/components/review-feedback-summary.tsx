import { useState } from "react";
import type { OsReviewFeedback } from "@tedix/api-contract/contracts/os-shares";
import { Button } from "@/components/kumo/button";
export function ReviewFeedbackSummary({ shareId }: { shareId: string }) {
	const [titles, setTitles] = useState<Record<string, string>>({});
	const [rows, setRows] = useState<OsReviewFeedback[] | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	async function load() {
		setBusy(true);
		try {
			const { osApi } = await import("@/lib/api");
			const result = await osApi.osShares.reviews.listFeedback({ shareId });
			setRows(result.feedback);
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
