import { useQuery } from "@tanstack/react-query";
import type { MetricTile as MetricTileData } from "@tedix/api-contract/schemas/metric-tile";
import { osQuery } from "@/lib/os-query-options";
import { attentionMetrics } from "@/lib/deck-attention";
import { MetricGrid } from "@/components/kumo/metric-grid";
import { MetricTile } from "@/components/metric-tile";
import { Text } from "@/components/kumo/text";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import { OS_COPY } from "@/shared/os-copy";

const DECK_EVENTS = "deck events";

function measured(
	label: string,
	value: string,
	window: string,
): MetricTileData {
	return { state: "measured", label, value, window, source: DECK_EVENTS };
}

function empty(label: string, emptyReason: string): MetricTileData {
	return { state: "empty", label, emptyReason, setupHref: "/work?view=deck" };
}

/** Plain-English name for a decision class id such as "reddit_reply". */
function cardClassLabel(classId: string): string {
	const known = OS_COPY.decisionDeck.cardKinds[classId];
	if (known) return known;
	const words = classId.replace(/[-_:.]+/g, " ").trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : classId;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function DeckAttentionMetrics() {
	useOsFormattingPreferences();
	const query = useQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
	);
	const copy = OS_COPY.decisionDeck.metrics;
	if (query.isError) return <Text>{copy.unavailable}</Text>;
	if (!query.data) return null;
	const metrics = attentionMetrics(query.data.events);
	const rate = (
		label: string,
		value: number | null,
		window: string,
		reason: string,
	): MetricTileData =>
		value === null
			? empty(label, reason)
			: measured(label, percent(value), window);
	const decisionsWindow = `latest ${formatCount(metrics.decisionCount)} decisions`;
	const actionsWindow = `latest ${formatCount(metrics.actionCount)} deck actions`;
	const tiles: MetricTileData[] = [
		metrics.medianMs === null
			? empty("Median decision time", "No timed decisions recorded yet")
			: measured(
					"Median decision time",
					`${Math.round(metrics.medianMs / 1000)}s`,
					`latest ${formatCount(metrics.measuredDecisions)} timed decisions`,
				),
		rate(
			copy.delegation,
			metrics.delegationRate,
			decisionsWindow,
			"No recorded decisions yet",
		),
		measured(copy.cards, formatCount(metrics.cardsToday), "today"),
		rate(
			"Decided without details",
			metrics.withoutDetailsRate,
			`latest ${formatCount(metrics.observedDecisionCount)} observed decisions`,
			"No decisions with detail tracking recorded yet",
		),
		measured("Later", formatCount(metrics.laterCount), actionsWindow),
		measured("Not this", formatCount(metrics.notThisCount), actionsWindow),
		measured(
			"Asked for changes",
			formatCount(metrics.changeRequestCount),
			actionsWindow,
		),
		measured(copy.visits, formatCount(metrics.returnVisitsToday), "today"),
		rate(
			copy.corrections,
			metrics.correctionRate,
			decisionsWindow,
			"No recorded decisions yet",
		),
	];
	return (
		<section aria-label={copy.title} className="grid gap-3">
			<Text weight="semibold">{copy.title}</Text>
			<Text tone="secondary">{copy.loaded}</Text>
			{/* The grid sits in a narrow side panel at every viewport width, so it
			    keeps the phone's two columns instead of widening to three. */}
			<MetricGrid
				className="sm:grid-cols-2 sm:[&>[data-slot=metric-item]:last-child]:col-span-2"
				columns={3}
			>
				{tiles.map((tile) => (
					<MetricTile key={tile.label} tile={tile} />
				))}
			</MetricGrid>
			{metrics.withoutDetailsByClass.length > 0 && (
				<section aria-label={copy.byClassTitle} className="grid gap-1">
					<Text weight="semibold">{copy.byClassTitle}</Text>
					<ul className="grid gap-1" data-without-details-by-class>
						{metrics.withoutDetailsByClass.map((row) => {
							const share = row.withoutDetails / row.decisions;
							return (
								<li key={row.classId} className="flex justify-between gap-3">
									<Text as="span" truncate>
										{cardClassLabel(row.classId)}
									</Text>
									<Text as="span" tone={share < 0.8 ? "warning" : "secondary"}>
										{copy.byClassValue(
											percent(share),
											formatCount(row.decisions),
										)}
									</Text>
								</li>
							);
						})}
					</ul>
					<Text tone="secondary">{copy.byClassHint}</Text>
				</section>
			)}
		</section>
	);
}
