import { useQuery } from "@tanstack/react-query";
import { MemoryConsolidationSchema } from "@tedix/api-contract/schemas/memory-observations";
import type { Fact } from "@tedix/api-contract/schemas/memory-graph";
import { osQuery } from "@/lib/os-query-options";
import { Badge } from "@/components/kumo/badge";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime } from "@/lib/time";

export function ObservationEvidence({ fact }: { fact: Fact }) {
	useOsFormattingPreferences();
	const parsed = MemoryConsolidationSchema.safeParse(
		fact.metadata?.consolidation,
	);
	if (!parsed.success) return null;
	const meta = parsed.data;
	return (
		<article className="space-y-2 border-b py-4">
			<div className="flex flex-wrap items-center gap-2">
				<Badge>
					{meta.kind === "standing_summary"
						? "Standing summary"
						: "Observation"}
				</Badge>
				<Badge>{meta.state}</Badge>
				<Text role="caption">
					Version {meta.revision} · {meta.evidence.supportCount} sources ·{" "}
					{Math.round(fact.confidence * 100)}% confidence
				</Text>
			</div>
			<Text>{fact.content}</Text>
			<details>
				<summary className="cursor-pointer text-sm">
					Sources and refresh trace
				</summary>
				<div className="space-y-2 py-2 text-sm">
					<p>
						First seen:{" "}
						{meta.firstSeen ? absoluteTime(meta.firstSeen) : "Unknown"}. Last
						seen: {meta.lastSeen ? absoluteTime(meta.lastSeen) : "Unknown"}.
					</p>
					{meta.evidence.sources.map((source) => (
						<blockquote key={source.id} className="border-l pl-3">
							<p>{source.quote}</p>
							<code className="break-all">{source.id}</code>
						</blockquote>
					))}
					<p>
						Refreshed {absoluteTime(meta.refresh.at)}:{" "}
						{meta.refresh.reason.replaceAll("_", " ")}
					</p>
					{meta.refresh.previousText && (
						<p>Previous text: {meta.refresh.previousText}</p>
					)}
					{meta.refresh.sourceFactIds.length > 0 && (
						<p className="break-all">
							Changed sources: {meta.refresh.sourceFactIds.join(", ")}
						</p>
					)}
					{meta.refresh.removedSourceFactIds.length > 0 && (
						<p className="break-all">
							Removed sources: {meta.refresh.removedSourceFactIds.join(", ")}
						</p>
					)}
					{meta.previousVersionId && (
						<p className="break-all">
							Previous version: {meta.previousVersionId}
						</p>
					)}
				</div>
			</details>
		</article>
	);
}
export function MemoryObservations() {
	const query = useQuery({
		...osQuery.memoryGraph.listObservations.queryOptions({
			input: { limit: 25 },
		}),
		staleTime: 30_000,
	});
	if (query.isPending) return <ListSkeleton />;
	if (query.isError)
		return <Text tone="secondary">Memory observations are unavailable.</Text>;
	if (!query.data.facts.length)
		return (
			<Text tone="secondary">
				Related memories become observations after reflection. Sources and
				changes appear here.
			</Text>
		);
	return (
		<div>
			{query.data.facts.map((fact) => (
				<ObservationEvidence key={fact.id} fact={fact} />
			))}
		</div>
	);
}
