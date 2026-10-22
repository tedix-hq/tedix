import { getRouteApi, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { MemoryHealth } from "@tedix/api-contract/schemas/memory-graph";
import { MemoryBrowser } from "./memory-browser";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { MetricGrid } from "@/components/kumo/metric-grid";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import type { TextTone } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { MetricTile } from "@/components/metric-tile";
import {
	formatCount,
	formatRatioPercent,
	useOsFormattingPreferences,
} from "@/lib/format";
import { getOsSurface } from "@/lib/os-navigation";
import { memoryHealthQueryOptions } from "@/lib/os-query-options";

type MemoryVital = {
	id: string;
	label: string;
	value: string;
	href?: string;
	tone?: TextTone;
};

export function MemoryVitals({ health }: { health: MemoryHealth }) {
	useOsFormattingPreferences();
	const vitals: MemoryVital[] = [
		{
			id: "active-facts",
			label: "Active facts",
			value: formatCount(health.activeFacts),
		},
		{
			id: "edges",
			label: "Connections",
			value: formatCount(health.totalEdges),
		},
		{ id: "domains", label: "Topics", value: formatCount(health.totalDomains) },
		{
			id: "avg-confidence",
			label: "Average confidence",
			value: formatRatioPercent(health.avgConfidence),
		},
		{
			id: "open-gaps",
			label: "Unanswered questions",
			value: formatCount(health.totalGaps),
			href: "/brain?tab=gaps",
		},
		{
			id: "stale-facts",
			label: "Needs review",
			value: formatCount(health.staleFacts),
			href: "/brain?tab=stale",
			tone: health.staleFacts > 0 ? "warning" : "strong",
		},
		{
			id: "contradictions",
			label: "Conflicts",
			value: formatCount(health.contradictions),
			href: "/brain?tab=contradictions",
			tone: health.contradictions > 0 ? "error" : "strong",
		},
		{
			id: "curiosity",
			label: "Questions to explore",
			value: `${formatCount(health.curiosityQueue.queued)} queued · ${formatCount(health.curiosityQueue.exploring)} exploring`,
			href: "/brain?tab=curiosity",
		},
	];
	return (
		<MetricGrid aria-label="Memory overview" columns={4}>
			{vitals.map((vital) => (
				<MetricTile
					key={vital.id}
					data-vital={vital.id}
					tile={{
						state: "measured",
						window: "now",
						source: "memory health",
						label: vital.label,
						value: vital.value,
						href: vital.href,
					}}
					valueTone={vital.tone}
				/>
			))}
		</MetricGrid>
	);
}

const brainRoute = getRouteApi("/_session/_tenant/brain");

export function BrainPage() {
	const surface = getOsSurface("brain");
	const routeSearch = brainRoute.useSearch();
	const hash = useLocation({ select: (location) => location.hash });
	const search = hash.startsWith("lesson-")
		? { ...routeSearch, tab: "rules" as const, detail: hash.slice(7) }
		: routeSearch;
	const navigate = brainRoute.useNavigate();
	const health = useQuery({ ...memoryHealthQueryOptions(), staleTime: 60_000 });
	return (
		<Page width="full">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
			</PageHeader>
			{health.isPending && (
				<div role="status" aria-label="Loading memory overview">
					<ListSkeleton rows={1} rowClassName="h-48" />
				</div>
			)}
			{health.isError && (
				<Alert variant="destructive">
					<AlertTitle>Memory health is unavailable</AlertTitle>
					<AlertDescription>
						{health.error.message}
						<Button variant="outline" onClick={() => void health.refetch()}>
							Try again
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{health.data && <MemoryVitals health={health.data} />}
			<MemoryBrowser
				search={search}
				onSearch={(patch) =>
					void navigate({
						search: { ...search, ...patch },
						hash: "",
						replace: patch.tab === undefined,
						resetScroll: false,
					})
				}
			/>
		</Page>
	);
}
