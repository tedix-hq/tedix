import type {
	DeckPriority,
	DeckPriorityBand,
} from "@tedix/api-contract/schemas/deck-priority";
import {
	deckBandCounts,
	deckPriorityDay,
	deckTimeline,
} from "@tedix/api-contract/utils/deck-priority";
import { Button } from "./kumo/button";
import { SegmentedControl } from "./kumo/segmented-control";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "./kumo/popover";

export type DeckBandFilter = DeckPriorityBand | "all";

const BAND_LABELS: Record<DeckPriorityBand, string> = {
	today: "Today",
	week: "This week",
	whenever: "Whenever",
};
const TIMELINE_DAYS = 14;

/**
 * Toolbar priority controls: a 14-day strip of deadlines (overdue on the left) and
 * the three bands with their counts. Choosing a band narrows the Deck.
 */
export function DeckPriorityBands({
	rows,
	band,
	onBandChange,
	onOpen,
	now,
	timeZone,
}: {
	rows: readonly { id: string; label: string; priority: DeckPriority }[];
	band: DeckBandFilter;
	onBandChange: (band: DeckBandFilter) => void;
	onOpen: (cardId: string) => void;
	now: Date;
	timeZone?: string;
}) {
	const counts = deckBandCounts(rows);
	const dots = deckTimeline(rows, now, timeZone, TIMELINE_DAYS);
	// Overdue takes the first slot; days 0–13 follow.
	const slot = (day: number) =>
		`${(((day < 0 ? 0 : day + 1) + 0.5) / (TIMELINE_DAYS + 1)) * 100}%`;
	const stacked = new Map<number, number>();
	return (
		<PopoverRoot>
			<PopoverTrigger
				render={<Button variant="ghost" size="sm" aria-label="Priority" />}
			>
				Priority ·{" "}
				{band === "all"
					? `All ${rows.length}`
					: `${BAND_LABELS[band]} ${counts[band]}`}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-96 p-3">
				<div className="fd-deck-bands" data-deck-bands>
					<div
						className="fd-deck-timeline"
						role="group"
						aria-label="Deadlines in the next 14 days"
						data-deck-timeline
					>
						<span className="fd-deck-timeline-rail" aria-hidden />
						{dots.map((dot) => {
							const level = stacked.get(dot.day) ?? 0;
							stacked.set(dot.day, level + 1);
							if (level > 2) return null;
							const when = dot.overdue
								? `overdue since ${deckPriorityDay(dot.deadline, timeZone)}`
								: `due ${deckPriorityDay(dot.deadline, timeZone)}`;
							return (
								<Button
									key={dot.id}
									variant="ghost"
									size="icon-xs"
									className="fd-deck-timeline-dot"
									data-overdue={dot.overdue}
									style={{
										left: slot(dot.day),
										top: `${0.25 + level * 0.5}rem`,
									}}
									aria-label={`${dot.label}, ${when}`}
									title={`${dot.label} · ${when}`}
									onClick={() => onOpen(dot.id)}
								>
									<span aria-hidden />
								</Button>
							);
						})}
						<span className="fd-deck-timeline-label" data-edge="start">
							{dots.some((dot) => dot.overdue) ? "Overdue" : "Today"}
						</span>
						<span className="fd-deck-timeline-label" data-edge="end">
							{deckPriorityDay(
								new Date(
									now.getTime() + (TIMELINE_DAYS - 1) * 86_400_000,
								).toISOString(),
								timeZone,
							)}
						</span>
					</div>
					<SegmentedControl
						ariaLabel="Priority band"
						compact
						value={band}
						onValueChange={onBandChange}
						options={[
							{ value: "all", label: `All ${rows.length}` },
							...(["today", "week", "whenever"] as const).map((value) => ({
								value,
								label: `${BAND_LABELS[value]} ${counts[value]}`,
							})),
						]}
					/>
				</div>
			</PopoverContent>
		</PopoverRoot>
	);
}
