import { useQuery } from "@tanstack/react-query";
import type { MetricTile as MetricTileData } from "@tedix/api-contract/schemas/metric-tile";
import { osQuery } from "@/lib/os-query-options";
import { attentionMetrics } from "@/lib/deck-attention";
import { MetricGrid } from "@/components/kumo/metric-grid";
import { MetricTile } from "@/components/metric-tile";
import { Text } from "@/components/kumo/text";
import { formatCount } from "@/lib/format";
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
	return { state: "empty", label, emptyReason };
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function DeckAttentionMetrics() {
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
			<MetricGrid columns={3}>
				{tiles.map((tile) => (
					<MetricTile key={tile.label} tile={tile} />
				))}
			</MetricGrid>
		</section>
	);
}
