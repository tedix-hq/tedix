import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	Progress,
	ProgressIndicator,
	ProgressTrack,
} from "@/components/kumo/progress";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";

export function DeckProgress({
	total,
	completed,
	position,
	filtered,
	saving,
	leading,
	counting = false,
}: {
	total: number;
	completed: number;
	position: number;
	filtered: boolean;
	saving: boolean;
	/** The card's state and date, on the counter line so the meta is one line. */
	leading?: ReactNode;
	/** Some sources are still loading, so the total is not known yet. */
	counting?: boolean;
}) {
	const label = counting
		? "Counting cards…"
		: `${position} of ${total}${filtered ? " · filtered" : ""}`;
	const [announcement, setAnnouncement] = useState("");
	useEffect(() => {
		// Search updates the display immediately, but speaks only after typing pauses.
		if (counting) return;
		const timer = setTimeout(
			() =>
				setAnnouncement(
					completed === total
						? saving
							? "Saving your last decisions."
							: `All ${total} done${filtered ? " in this filter" : ""} — nice.`
						: label,
				),
			600,
		);
		return () => clearTimeout(timer);
	}, [label, completed, total, saving, filtered, counting]);
	return (
		<div className="fd-card-progress grid gap-1" data-deck-progress>
			<div className="fd-deck-meta flex min-w-0 items-center justify-between gap-2">
				{leading ?? <span />}
				<Text
					role="label"
					tone="secondary"
					className="shrink-0 px-2 text-right tabular-nums"
				>
					{label}
				</Text>
			</div>
			<Progress
				value={counting ? 0 : completed}
				max={counting ? 1 : total}
				aria-label="Decision progress"
				aria-busy={counting || undefined}
				aria-valuetext={
					counting
						? label
						: `${completed} of ${total} reviewed${filtered ? " · filtered" : ""}`
				}
			>
				<ProgressTrack className="h-px">
					<ProgressIndicator />
				</ProgressTrack>
			</Progress>
			<span
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{announcement}
			</span>
		</div>
	);
}

export function DeckCompletion({
	total,
	filtered,
	saving,
	onClearFilters,
}: {
	total: number;
	filtered: boolean;
	saving: boolean;
	onClearFilters: () => void;
}) {
	return (
		<section className="fd-closure">
			<Text as="h2" className="fd-closure-title">
				{saving
					? "Saving your last decisions…"
					: `All ${total} done${filtered ? " in this filter" : ""} — nice.`}
			</Text>
			<Text tone="secondary">
				{filtered
					? "Clear your filters to see what else is waiting."
					: "Nothing else waiting in Decisions."}
			</Text>
			{filtered && (
				<Button variant="outline" onClick={onClearFilters}>
					Clear filters
				</Button>
			)}
			<Link href="/work?view=feed" variant="plain">
				Back to Activity
			</Link>
		</section>
	);
}

export function DeckCardSkeleton() {
	return (
		<Skeleton
			className="h-60 w-full shrink-0"
			role="status"
			aria-label="Loading decision"
		/>
	);
}
