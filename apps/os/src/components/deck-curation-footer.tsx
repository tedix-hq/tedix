import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";
import { Button } from "./kumo/button";
import { Text } from "./kumo/text";

/** "Last cleaned HH:MM", the staleness alarm, week-1 numbers and removable learned rules. */
export function DeckCurationFooter() {
	useOsFormattingPreferences();
	const copy = OS_COPY.decisionDeck.pipeline;
	const client = useQueryClient();
	const status = useQuery({
		...osQuery.attention.getDeckPipelineStatus.queryOptions({ input: {} }),
		refetchInterval: 5 * 60_000,
	});
	const remove = useMutation({
		mutationFn: (ruleId: string) => osApi.attention.removeDeckRule({ ruleId }),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: osQuery.attention.key() }),
	});
	const data = status.data;
	if (!data) return null;
	const metrics = data.metrics;
	const share =
		metrics && metrics.settled > 0
			? `${Math.round((metrics.notUseful / metrics.settled) * 100)}%`
			: null;
	return (
		<footer className="grid gap-2" data-deck-curation>
			<Text role="label" tone="secondary" className="tabular-nums">
				{data.lastCleanedAt
					? copy.lastCleaned(absoluteTime(data.lastCleanedAt))
					: copy.neverCleaned}
				{metrics?.morning && share
					? ` · ${copy.metrics(metrics.morning.liveCards, share)}`
					: ""}
			</Text>
			{data.stale && (
				<div role="alert">
					<Text tone="error">{copy.stale(data.staleAfterHours)}</Text>
				</div>
			)}
			{data.rules.length > 0 && (
				<Collapsible>
					<CollapsibleDefaultTrigger>
						{`${copy.rules} (${data.rules.length})`}
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<ul className="grid gap-1">
							{data.rules.map((rule) => (
								<li key={rule.id} className="flex items-center gap-2">
									<Text>{rule.sentence}</Text>
									<Button
										size="xs"
										variant="ghost"
										disabled={remove.isPending}
										onClick={() => remove.mutate(rule.id)}
									>
										{copy.remove}
									</Button>
								</li>
							))}
						</ul>
					</CollapsibleDefaultContent>
				</Collapsible>
			)}
		</footer>
	);
}
