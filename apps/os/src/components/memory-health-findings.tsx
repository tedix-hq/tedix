import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "./kumo/collapsible";
import { Info } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type {
	MemoryHealthFinding,
	MemoryHealthFindingSample,
	MemoryHealthFindings,
} from "@tedix/api-contract/schemas/memory-graph";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { OsRouterLink } from "@/components/kumo/link-provider";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	PopoverContent,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatCount } from "@/lib/format";
import { memoryHealthFindingsQueryOptions } from "@/lib/os-query-options";
import { absoluteTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

type FindingContext = Pick<
	MemoryHealthFindings,
	"unusedDays" | "staleDays" | "orphanWindow"
>;

/** "500+" when the server stopped counting at its cap. */
export function findingCount(finding: MemoryHealthFinding): string {
	return `${formatCount(finding.count)}${finding.capped ? "+" : ""}`;
}

/** One plain-English sentence per finding; the number is always in it. */
export function findingHeadline(
	finding: MemoryHealthFinding,
	context: FindingContext,
): string {
	const n = findingCount(finding);
	const one = finding.count === 1 && !finding.capped;
	switch (finding.kind) {
		case "unused":
			return finding.count === 0
				? `Every fact has been used in the last ${context.unusedDays} days`
				: `${n} ${one ? "fact was" : "facts were"} not retrieved in the last ${context.unusedDays} days`;
		case "stale_in_use":
			return finding.count === 0
				? "No fact in use is overdue for a re-check"
				: `${n} ${one ? "fact is" : "facts are"} still being retrieved but not re-checked in ${context.staleDays} days`;
		case "duplicate":
			return finding.count === 0
				? "No topic has more than one current fact"
				: `${n} ${one ? "topic has" : "topics have"} more than one current fact`;
		case "contradiction":
			return finding.count === 0
				? "No two current facts contradict each other"
				: `${n} ${one ? "fact contradicts" : "facts contradict"} another current fact`;
		case "orphan":
			return finding.count === 0
				? `Every one of the ${formatCount(context.orphanWindow)} most recent facts is linked`
				: `${n} of the ${formatCount(context.orphanWindow)} most recently updated facts ${one ? "isn't" : "aren't"} linked to anything`;
	}
}

export const FINDING_ACTIONS: Record<MemoryHealthFinding["kind"], string> = {
	unused: "Archive them, or check why no tedi reaches for them.",
	stale_in_use: "Re-verify these first: tedis are acting on them today.",
	duplicate: "Keep the current one and archive the rest.",
	contradiction: "Decide which side is true and supersede the other.",
	orphan: "Link them to what they explain, or archive them.",
};

/** Names the graph layer for what it is: a projection of D1, never the record. */
export function graphLayerStatus(layer: MemoryHealthFindings["graphLayer"]): {
	label: string;
	detail: string;
	variant: "warning" | "success";
} {
	return layer.configured
		? {
				label: "Connected (projection only)",
				detail:
					"The Neo4j graph is rebuilt from D1 for graph views. D1 stays the record; this page reads D1 only.",
				variant: "success",
			}
		: {
				label: "Paused (projection only)",
				detail:
					"The Neo4j graph layer is paused. Memory itself is unaffected: D1 is the record and every number on this page comes from it.",
				variant: "warning",
			};
}

/** Where a person can review the fact; org-wide facts have no per-tedi page. */
export function reviewTarget(
	sample: Pick<MemoryHealthFindingSample, "tediId">,
): { tediId: string } | null {
	return sample.tediId ? { tediId: sample.tediId } : null;
}

export function provenanceLines(sample: MemoryHealthFindingSample): string[] {
	const lines: string[] = [];
	if (sample.source) lines.push(`Source: ${sample.source}`);
	if (sample.sourceUrl) lines.push(`Link: ${sample.sourceUrl}`);
	if (sample.sourceSessionId)
		lines.push(`Conversation: ${sample.sourceSessionId}`);
	return lines;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The evidence a fact carries, or the plain statement that it has none. */
export function ProvenanceDetails({
	sample,
	showText = true,
}: {
	sample: MemoryHealthFindingSample;
	showText?: boolean;
}) {
	const lines = provenanceLines(sample);
	return (
		<>
			{showText && (
				<Text role="body" tone="strong" className="m-0 break-words">
					{sample.text}
				</Text>
			)}
			{lines.length > 0 ? (
				lines.map((line) => (
					<Text
						key={line}
						role="label"
						tone="secondary"
						className="m-0 break-all"
					>
						{line}
					</Text>
				))
			) : (
				<Text role="label" tone="warning" className="m-0">
					No source was recorded for this fact. Treat it as unverified.
				</Text>
			)}
			<Text role="label" tone="secondary" className="m-0">
				Confidence {Math.round(sample.confidence * 100)}%
				{sample.reviewStatus ? ` · review: ${sample.reviewStatus}` : ""}
			</Text>
			<Text role="label" tone="secondary" className="m-0">
				{sample.createdAt
					? `Recorded ${absoluteTime(sample.createdAt)}`
					: "Record date unknown"}
				{" · "}
				{sample.lastVerifiedAt
					? `last verified ${absoluteTime(sample.lastVerifiedAt)}`
					: "never verified"}
				{" · "}
				{sample.lastAccessedAt
					? `last retrieved ${absoluteTime(sample.lastAccessedAt)}`
					: "never retrieved"}
			</Text>
		</>
	);
}

export function WhyWeBelieveThis({
	sample,
}: {
	sample: MemoryHealthFindingSample;
}) {
	return (
		<PopoverRoot>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						variant="ghost"
						aria-label={`Why do we believe this: ${sample.text}`}
					/>
				}
			>
				<Info size={14} aria-hidden /> Why do we believe this?
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label="Why do we believe this"
				className="w-[min(22rem,calc(100vw-2rem))] gap-2"
			>
				<PopoverTitle>Why do we believe this?</PopoverTitle>
				<ProvenanceDetails sample={sample} />
			</PopoverContent>
		</PopoverRoot>
	);
}

function SampleRow({ sample }: { sample: MemoryHealthFindingSample }) {
	const target = reviewTarget(sample);
	return (
		<li
			data-slot="memory-health-sample"
			className="flex min-w-0 flex-col gap-1 py-2"
		>
			<Text role="body" tone="strong" className="m-0 line-clamp-2 break-words">
				{sample.text}
			</Text>
			<Text role="label" tone="secondary" className="m-0 break-words">
				{sample.detail}
			</Text>
			<span className="flex flex-wrap items-center gap-1">
				<WhyWeBelieveThis sample={sample} />
				{target ? (
					<Link
						render={
							<OsRouterLink
								to="/team/$tediId/memory"
								params={{ tediId: target.tediId }}
							/>
						}
					>
						Review in this tedi&apos;s memory
					</Link>
				) : (
					<Text role="label" tone="secondary" className="m-0">
						Org-wide fact
					</Text>
				)}
			</span>
		</li>
	);
}

function SampleGroup({ samples }: { samples: MemoryHealthFindingSample[] }) {
	if (samples.length === 1) return <SampleRow sample={samples[0]!} />;
	return (
		<li data-slot="memory-health-sample" className="grid min-w-0 gap-1 py-2">
			<Text role="body" tone="strong" className="m-0 break-words">
				{samples[0]!.text}
			</Text>
			<Collapsible>
				<CollapsibleTrigger className="min-h-11">
					{samples.length} sources
				</CollapsibleTrigger>
				<CollapsibleContent keepMounted>
					<ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
						{samples.map((sample) => (
							<li key={sample.factId} className="grid gap-1 py-2">
								<Text
									role="label"
									tone="secondary"
									className="m-0 wrap-anywhere"
								>
									Fact: {sample.factId}
								</Text>
								<Text className="m-0 break-words">{sample.detail}</Text>
								<ProvenanceDetails sample={sample} showText={false} />
								{sample.tediId && (
									<Link
										render={
											<OsRouterLink
												to="/team/$tediId/memory"
												params={{ tediId: sample.tediId }}
											/>
										}
										className="min-h-11"
									>
										Review in this tedi&apos;s memory
									</Link>
								)}
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

export function MemoryHealthFindingItem({
	finding,
	context,
}: {
	finding: MemoryHealthFinding;
	context: FindingContext;
}) {
	const groups = new Map<string, MemoryHealthFindingSample[]>();
	for (const sample of finding.samples) {
		const key = sample.text.trim().replace(/\s+/g, " ");
		const group = groups.get(key);
		if (group) group.push(sample);
		else groups.set(key, [sample]);
	}

	return (
		<li
			data-slot="memory-health-finding"
			data-kind={finding.kind}
			className="flex min-w-0 flex-col gap-1 px-3 py-2.5"
		>
			<span className="flex flex-wrap items-center gap-2">
				<Text
					as="strong"
					role="body"
					weight="medium"
					tone="strong"
					className="min-w-0"
				>
					{findingHeadline(finding, context)}
				</Text>
				<Badge variant={finding.count === 0 ? "success" : "warning"}>
					{finding.count === 0 ? "Clear" : "Review"}
				</Badge>
			</span>
			{finding.count > 0 ? (
				<>
					<Text role="label" tone="secondary" className="m-0">
						{FINDING_ACTIONS[finding.kind]}
						{finding.samples.length < finding.count
							? ` Showing ${finding.samples.length}.`
							: ""}
					</Text>
					<ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
						{[...groups.values()].map((samples) => (
							<SampleGroup
								key={`${finding.kind}:${samples[0]!.factId}`}
								samples={samples}
							/>
						))}
					</ul>
				</>
			) : null}
		</li>
	);
}

export function MemoryHealthFindingsList({
	data,
}: {
	data: MemoryHealthFindings;
}) {
	const layer = graphLayerStatus(data.graphLayer);
	return (
		<>
			<Collection aria-label="Memory health findings">
				{data.findings.map((finding) => (
					<MemoryHealthFindingItem
						key={finding.kind}
						finding={finding}
						context={data}
					/>
				))}
				<li
					data-slot="memory-graph-layer"
					className="flex min-w-0 flex-col gap-1 px-3 py-2.5"
				>
					<span className="flex flex-wrap items-center gap-2">
						<Text as="strong" role="body" weight="medium" tone="strong">
							Graph layer (Neo4j)
						</Text>
						<Badge variant={layer.variant}>{layer.label}</Badge>
					</span>
					<Text role="label" tone="secondary" className="m-0">
						{layer.detail}
					</Text>
				</li>
			</Collection>
			<Text role="label" tone="secondary" className="m-0">
				Counts stop at 500. Checked {absoluteTime(data.checkedAt)} against
				active facts only.
			</Text>
		</>
	);
}

export function MemoryHealthFindingsSection() {
	const findings = useQuery({
		...memoryHealthFindingsQueryOptions(),
		staleTime: 5 * 60_000,
	});
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Memory health</SectionTitle>
					<SectionDescription>
						What to clean up so tedis act on facts that are current, sourced,
						and consistent.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{findings.isPending && <ListSkeleton rows={3} />}
			{findings.isError && (
				<Alert variant="destructive">
					<AlertTitle>Memory health findings are unavailable</AlertTitle>
					<AlertDescription>
						{(findings.error as Error).message}
					</AlertDescription>
				</Alert>
			)}
			{findings.data && <MemoryHealthFindingsList data={findings.data} />}
		</PageSection>
	);
}
