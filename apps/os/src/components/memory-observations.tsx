import { MemoryConsolidationSchema } from "@tedix/api-contract/schemas/memory-observations";
import type { Fact } from "@tedix/api-contract/schemas/memory-graph";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
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
		<article className="space-y-2 border-b border-kumo-line pb-4">
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
			<Text className="whitespace-pre-wrap wrap-anywhere">{fact.content}</Text>
			<Collapsible>
				<CollapsibleDefaultTrigger>
					Sources and refresh trace
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					<div className="grid gap-2 py-2 wrap-anywhere">
						<Text>
							First seen:{" "}
							{meta.firstSeen ? absoluteTime(meta.firstSeen) : "Unknown"}. Last
							seen: {meta.lastSeen ? absoluteTime(meta.lastSeen) : "Unknown"}.
						</Text>
						{meta.evidence.sources.map((source) => (
							<blockquote
								key={source.id}
								className="m-0 border-l border-kumo-line pl-4"
							>
								<Text>{source.quote}</Text>
								<code className="break-all">{source.id}</code>
							</blockquote>
						))}
						<Text>
							Refreshed {absoluteTime(meta.refresh.at)}:{" "}
							{meta.refresh.reason.replaceAll("_", " ")}
						</Text>
						{meta.refresh.previousText && (
							<Text>Previous text: {meta.refresh.previousText}</Text>
						)}
						{meta.refresh.sourceFactIds.length > 0 && (
							<Text className="wrap-anywhere">
								Changed sources: {meta.refresh.sourceFactIds.join(", ")}
							</Text>
						)}
						{meta.refresh.removedSourceFactIds.length > 0 && (
							<Text className="wrap-anywhere">
								Removed sources: {meta.refresh.removedSourceFactIds.join(", ")}
							</Text>
						)}
						{meta.previousVersionId && (
							<Text className="wrap-anywhere">
								Previous version: {meta.previousVersionId}
							</Text>
						)}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</article>
	);
}
