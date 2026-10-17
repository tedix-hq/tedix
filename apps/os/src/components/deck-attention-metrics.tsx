import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { attentionMetrics } from "@/lib/deck-attention";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Text } from "@/components/kumo/text";
import { OS_COPY } from "@/shared/os-copy";

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
	const percent = (value: number | null) =>
		value === null ? "—" : `${Math.round(value * 100)}%`;
	return (
		<section aria-label={copy.title} className="grid gap-3">
			<Text weight="semibold">{copy.title}</Text>
			<Text tone="secondary">{copy.loaded}</Text>
			<MetricGrid columns={5}>
				<MetricItem
					label={copy.time}
					value={
						metrics.averageMs === null
							? "—"
							: `${Math.round(metrics.averageMs / 1000)}s`
					}
				/>
				<MetricItem
					label={copy.delegation}
					value={percent(metrics.delegationRate)}
				/>
				<MetricItem label={copy.cards} value={metrics.cardsToday} />
				<MetricItem label={copy.visits} value={metrics.returnVisitsToday} />
				<MetricItem
					label={copy.corrections}
					value={percent(metrics.correctionRate)}
				/>
			</MetricGrid>
		</section>
	);
}
