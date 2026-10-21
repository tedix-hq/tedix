import type { DeckAskKind } from "@tedix/api-contract/schemas/attention";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteDate, absoluteTime } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";

function deadlineText(deadline: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(deadline)
		? absoluteDate(deadline)
		: absoluteTime(deadline);
}

/** What the current card asks of the person, its deadline, and the stale-draft group. */
export function DeckAskStrip({
	card,
	staleDrafts,
	showingStale,
	onShowStale,
}: {
	card?: {
		askKind: DeckAskKind;
		deadline: string | null;
		overdue: boolean;
		handled?: boolean;
		expired?: boolean;
		draftedNotSent: boolean;
	};
	staleDrafts: number;
	showingStale: boolean;
	onShowStale: () => void;
}) {
	useOsFormattingPreferences();
	const copy = OS_COPY.decisionDeck;
	return (
		<div className="fd-deck-ask" data-deck-ask={card?.askKind}>
			{card && (
				<div className="fd-deck-ask-tags">
					<Badge variant="secondary" className="py-0">
						{copy.kinds[card.askKind]}
					</Badge>
					{card.overdue && (
						<Badge variant="error" className="py-0">
							{copy.ask.overdue}
						</Badge>
					)}
					{card.handled && (
						<Badge variant="secondary" className="py-0">
							{copy.ask.handled}
						</Badge>
					)}
					{card.expired && (
						<Badge variant="secondary" className="py-0">
							{copy.ask.expired}
						</Badge>
					)}
					{card.draftedNotSent && (
						<Badge variant="warning" className="py-0">
							{copy.ask.draftedNotSent}
						</Badge>
					)}
					{card.deadline && (
						<Text
							role="label"
							tone={card.overdue ? "error" : "secondary"}
							className="tabular-nums"
						>
							{copy.ask.due(deadlineText(card.deadline))}
						</Text>
					)}
				</div>
			)}
			{staleDrafts > 0 && (
				<Button
					variant="ghost"
					size="xs"
					aria-pressed={showingStale}
					onClick={onShowStale}
				>
					{showingStale ? copy.ask.showAll : copy.ask.staleDrafts(staleDrafts)}
				</Button>
			)}
		</div>
	);
}
