import { Badge } from "@/components/kumo/badge";
import { Text } from "@/components/kumo/text";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { relativeTime, shortDeadline } from "@/lib/time";
import type { projectDecisionDeck } from "./decision-deck-projection";

type WaitingRow = ReturnType<typeof projectDecisionDeck>["rows"][number];

/**
 * The Deck's read-only overview: every card still waiting on the person, one
 * row each — Deck decisions, approvals and open factory cards from every card
 * sheet. Opening a row shows that card in the decide view; listing them here
 * records no verdict, skip or learning event.
 */
export function DeckWaitingList({
	rows,
	onOpen,
	projectLabel,
	now,
}: {
	rows: readonly WaitingRow[];
	onOpen: (cardId: string) => void;
	projectLabel: (id: string) => string | undefined;
	now: Date;
}) {
	if (rows.length === 0) return <Text>{OS_COPY.feed.nothingWaiting}</Text>;
	return (
		<ul
			className="grid gap-2"
			aria-label={decisionText("Everything waiting")}
			data-deck-waiting
		>
			{rows.map((row) => {
				// An unresolved project shows nothing rather than its raw id.
				const project =
					row.project === "Unfiled" ? null : projectLabel(row.project);
				return (
					<li key={row.id}>
						<button
							type="button"
							onClick={() => onOpen(row.id)}
							className="flex w-full min-w-0 flex-col gap-1 rounded-2xl border border-kumo-line bg-kumo-elevated p-4 text-left transition-colors hover:bg-kumo-tint"
						>
							<span className="flex min-w-0 items-baseline justify-between gap-2">
								<Text
									as="span"
									role="caption"
									tone="secondary"
									className="truncate"
								>
									{[
										row.sourceLabel,
										project,
										"objective" in row && row.objective
											? `Serves ${row.objective.title}`
											: null,
									]
										.filter(Boolean)
										.join(" · ")}
								</Text>
								{row.requestedAt && (
									<Text
										as="span"
										role="caption"
										tone="secondary"
										className="shrink-0"
									>
										{relativeTime(row.requestedAt, now)}
									</Text>
								)}
							</span>
							<Text as="span" className="min-w-0 break-words">
								{row.label}
							</Text>
							{(row.costOfWaiting || row.deadline) && (
								<span className="flex min-w-0 flex-wrap items-center gap-2">
									{row.overdue && (
										<Badge variant="warning">{decisionText("Overdue")}</Badge>
									)}
									{row.expired && (
										<Badge variant="secondary">{decisionText("Expired")}</Badge>
									)}
									<Text as="span" role="caption" tone="secondary">
										{row.costOfWaiting
											? `${OS_COPY.feed.waiting}: ${row.costOfWaiting}`
											: `${decisionText("Due")} ${shortDeadline(row.deadline!, now)}`}
									</Text>
								</span>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}
