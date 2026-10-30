import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { useCallback, useEffect, useState } from "react";
import type { OsReviewFeedback } from "@tedix/api-contract/contracts/os-shares";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

type Round = { id: string; title: string; createdAt: string };

const DECISION_LABEL: Record<OsReviewFeedback["decision"], string> = {
	ready: "Ready",
	edit: "Edit",
	skip: "Skip",
	needs_checking: "Needs checking",
};

/**
 * Answers people gave on this link's review rounds. Renders nothing until a
 * round exists, so an owner who never sent one sees no empty state.
 */
export function ReviewFeedbackSummary({ shareId }: { shareId: string }) {
	useOsFormattingPreferences();
	const [titles, setTitles] = useState<Record<string, string>>({});
	const [rows, setRows] = useState<OsReviewFeedback[] | null>(null);
	const [rounds, setRounds] = useState<Round[]>([]);
	const [roundId, setRoundId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const load = useCallback(
		async (batchId?: string) => {
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
			} catch {
				// No round on this link yet, or no access to its answers.
				setRows(null);
			} finally {
				setBusy(false);
			}
		},
		[shareId],
	);
	useEffect(() => {
		void load();
	}, [load]);
	if (rows === null) return null;
	return (
		<div className="grid gap-2" data-review-feedback>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium text-sm">Answers so far</span>
				{rounds.length > 1 && (
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
										{index === 0 ? "Latest" : relativeTime(round.createdAt)}
									</span>
								),
							}))}
						/>
					</fieldset>
				)}
			</div>
			{rows.length === 0 ? (
				<p role="status" className="m-0 text-kumo-subtle text-xs">
					No answers yet.
				</p>
			) : (
				rows.map((row) => (
					<Collapsible
						key={`${row.cardId}:${row.reviewerId}`}
						className="text-sm"
					>
						<CollapsibleDefaultTrigger>
							{titles[row.cardId]} · {DECISION_LABEL[row.decision]} ·{" "}
							{absoluteTime(row.updatedAt)}
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent keepMounted>
							<p className="whitespace-pre-wrap">{row.reason}</p>
							<p className="whitespace-pre-wrap">{row.editedReply}</p>
							<small className="text-kumo-subtle">
								Reviewer ID: {row.reviewerId}
							</small>
						</CollapsibleDefaultContent>
					</Collapsible>
				))
			)}
		</div>
	);
}
