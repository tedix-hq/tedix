import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { attentionMetrics } from "@/lib/deck-attention";
import { Text } from "@/components/kumo/text";

/** The weekly line shares the Results measurements; absent history is never reported as zero. */
export function WeeklyCardContext() {
	const query = useQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
	);
	if (!query.data) return null;
	const metrics = attentionMetrics(
		query.data.events.filter(
			(event) => Date.parse(event.occurredAt) >= Date.now() - 7 * 86400000,
		),
	);
	if (metrics.medianMs === null) return null;
	return (
		<Text tone="secondary">
			This week: median decision time {Math.round(metrics.medianMs / 1000)} s;{" "}
			{metrics.withoutDetailsRate === null
				? "details use not measured yet"
				: `${Math.round(metrics.withoutDetailsRate * 100)}% decided without opening details`}
			. Based on recent recorded choices.
		</Text>
	);
}
