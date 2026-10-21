import { MemoryBrowser } from "./memory-browser";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { memoryText, workflowRunLinkId } from "@/lib/memory-browser";
import { BookOpen, Brain, CaretRight } from "@phosphor-icons/react";
import type { RationaleOutcomeStatus } from "@tedix/api-contract/constants/enums";
import type {
	KnowledgeEntry,
	KnowledgeEntryType,
} from "@tedix/api-contract/schemas/cognitive";
import type { MemoryHealth } from "@tedix/api-contract/schemas/memory-graph";
import type { MetricTileMeasured } from "@tedix/api-contract/schemas/metric-tile";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { useQuery } from "@tanstack/react-query";
import { getOsSurface } from "@/lib/os-navigation";
import type { ComponentType } from "react";
import { type CardRunLinkProps, compactPreview } from "@/components/chat-cards";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { MetricGrid } from "@/components/kumo/metric-grid";
import { MetricTile } from "@/components/metric-tile";
import { Text, type TextTone } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	useOsFormattingPreferences,
	formatCount,
	humanize,
	sentenceCase,
} from "@/lib/format";
import { memoryHealthQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const OUTCOME_TABS = [
	{ id: "all", label: "All", status: undefined },
	{ id: "pending", label: "Pending", status: "pending" },
	{ id: "success", label: "Success", status: "success" },
	{ id: "failure", label: "Failure", status: "failure" },
] as const satisfies readonly {
	id: string;
	label: string;
	status: RationaleOutcomeStatus | undefined;
}[];

export type OutcomeTabId = (typeof OUTCOME_TABS)[number]["id"];

/**
 * Outcome-status chip variants. `unverified` is a success CLAIM that carried
 * no span-checkable proof — a governance smell, so it warns instead of
 * celebrating; `partial` warns for the same honesty reason.
 */
export const OUTCOME_BADGE_VARIANTS: Record<
	RationaleOutcomeStatus,
	BadgeVariant
> = {
	pending: "info",
	success: "success",
	failure: "error",
	partial: "warning",
	unverified: "warning",
};

/** 0.724 → "72%" — the one confidence dialect for Brain rows and vitals. */
export function confidencePercent(confidence: number): string {
	return `${Math.round(confidence * 100)}%`;
}

/** Rationale/knowledge body previews are clamped to this many characters. */
export const BRAIN_PREVIEW_LENGTH = 200;

export function runtimeReferenceLabel(runId: string): string {
	const compoundId = runId.match(/:mcp:([^:]+)/i)?.[1] ?? runId;
	return `Runtime ${compoundId.length > 8 ? `${compoundId.slice(0, 8)}…` : compoundId}`;
}

export type MemoryVitalTone = "default" | "warn" | "danger";

export type MemoryVital = {
	id: string;
	tile: MetricTileMeasured;
	tone: MemoryVitalTone;
};

/**
 * Projects `memoryGraph.health` (pure aggregate counts — the honest brain
 * vitals) into labeled stats. Hygiene counters only escalate their tone when
 * they are actually non-zero. Every tile carries its provenance — a live
 * aggregate read, so the window is "now" and the source is the health read.
 */
export function memoryVitals(health: MemoryHealth): MemoryVital[] {
	const provenance = {
		state: "measured" as const,
		window: "now",
		source: "memory graph health",
	};
	return [
		{
			id: "active-facts",
			tile: {
				...provenance,
				label: "Active facts",
				value: formatCount(health.activeFacts),
			},
			tone: "default",
		},
		{
			id: "edges",
			tile: {
				...provenance,
				label: "Edges",
				value: formatCount(health.totalEdges),
			},
			tone: "default",
		},
		{
			id: "domains",
			tile: {
				...provenance,
				label: "Domains",
				value: formatCount(health.totalDomains),
			},
			tone: "default",
		},
		{
			id: "avg-confidence",
			tile: {
				...provenance,
				label: "Avg confidence",
				value: confidencePercent(health.avgConfidence),
			},
			tone: "default",
		},
		{
			id: "open-gaps",
			tile: {
				...provenance,
				label: "Open gaps",
				value: formatCount(health.totalGaps),
			},
			tone: "default",
		},
		{
			id: "stale-facts",
			tile: {
				...provenance,
				label: "Stale facts",
				value: formatCount(health.staleFacts),
			},
			tone: health.staleFacts > 0 ? "warn" : "default",
		},
		{
			id: "contradictions",
			tile: {
				...provenance,
				label: "Contradictions",
				value: formatCount(health.contradictions),
			},
			tone: health.contradictions > 0 ? "danger" : "default",
		},
		{
			id: "curiosity",
			tile: {
				...provenance,
				label: "Curiosity queue",
				value: `${formatCount(health.curiosityQueue.queued)} queued · ${formatCount(
					health.curiosityQueue.exploring,
				)} exploring`,
			},
			tone: "default",
		},
	];
}

/** Knowledge entry-type chips stay muted; only anti-patterns warn. */
export const ENTRY_TYPE_VARIANTS: Record<KnowledgeEntryType, BadgeVariant> = {
	insight: "info",
	pattern: "secondary",
	anti_pattern: "warning",
	convention: "secondary",
	opinion: "outline",
	decision: "secondary",
};

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function OutcomeChip({ status }: { status: RationaleOutcomeStatus }) {
	return (
		<Badge variant={OUTCOME_BADGE_VARIANTS[status]} data-status={status}>
			{sentenceCase(status)}
		</Badge>
	);
}

const VITAL_TEXT_TONE: Record<MemoryVitalTone, TextTone> = {
	default: "strong",
	warn: "warning",
	danger: "error",
};

/** Memory vitals — labeled aggregate counts, no graph explorer. */
export function MemoryVitals({ health }: { health: MemoryHealth }) {
	useOsFormattingPreferences();
	return (
		<MetricGrid
			aria-label="Memory vitals"
			columns={4}
			className="grid-cols-4 lg:grid-cols-8"
		>
			{memoryVitals(health).map((vital) => (
				<MetricTile
					key={vital.id}
					tile={{
						...vital.tile,
						href:
							vital.id === "stale-facts"
								? "/brain?tab=stale"
								: vital.id === "open-gaps"
									? "/brain?tab=gaps"
									: vital.id === "contradictions" || vital.id === "curiosity"
										? `/brain?tab=${vital.id}`
										: undefined,
					}}
					data-vital={vital.id}
					data-tone={vital.tone}
					className="!px-2 !py-3"
					valueTone={VITAL_TEXT_TONE[vital.tone]}
				/>
			))}
		</MetricGrid>
	);
}

export function RationaleRow({
	record,
	tediNames = {},
	LinkComponent = OsRouterLink,
}: {
	record: RationaleRecord;
	tediNames?: Record<string, string>;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	useOsFormattingPreferences();
	const rationalePreview = compactPreview(
		record.rationale,
		BRAIN_PREVIEW_LENGTH,
	);
	const outcomePreview =
		record.outcomeStatus === "pending"
			? null
			: compactPreview(record.outcome, BRAIN_PREVIEW_LENGTH);
	const workflowRunId = workflowRunLinkId(record.runId);
	const content = (
		<>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex flex-wrap items-center gap-1.5">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="strong"
						className="min-w-0 truncate"
					>
						{record.action}
					</Text>
					<OutcomeChip status={record.outcomeStatus} />
					<Text as="span" role="label" tone="secondary">
						{humanize(record.category)} · {confidencePercent(record.confidence)}{" "}
						confident
					</Text>
				</span>
				{rationalePreview ? (
					<Text
						as="span"
						role="label"
						tone="secondary"
						data-preview="rationale"
						className="line-clamp-2 break-words sm:line-clamp-1"
					>
						{rationalePreview}
					</Text>
				) : null}
				{outcomePreview ? (
					<Text
						as="span"
						role="label"
						data-preview="outcome"
						className="line-clamp-2 break-words sm:line-clamp-1"
					>
						→ {outcomePreview}
					</Text>
				) : null}
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="flex flex-wrap items-center gap-1.5"
				>
					<span>
						{tediNames[record.tediId] ?? "a tedi"} · decided{" "}
						<time
							dateTime={record.createdAt}
							title={absoluteTime(record.createdAt)}
						>
							{relativeTime(record.createdAt)}
						</time>
					</span>
					{workflowRunId ? (
						<span className="inline-flex items-center gap-0.5 font-medium text-kumo-default">
							Run details
							<CaretRight size={11} aria-hidden />
						</span>
					) : record.runId ? (
						<Text
							as="span"
							role="caption"
							tone="mono-secondary"
							data-slot="runtime-reference"
							title={record.runId}
						>
							{runtimeReferenceLabel(record.runId)}
						</Text>
					) : null}
				</Text>
			</span>
		</>
	);
	const rowClassName = "flex min-h-16 min-w-0 items-start gap-3 px-3 py-2.5";
	return (
		<li data-slot="brain-decision-row" className="min-w-0">
			{workflowRunId ? (
				<Link
					variant="collection"
					render={
						<LinkComponent
							to="/work/runs/$runId"
							params={{ runId: workflowRunId }}
						/>
					}
					title={`Open run ${workflowRunId}`}
					aria-label={`Open run details for ${record.action}`}
					className={`${rowClassName} w-full gap-3!`}
				>
					{content}
				</Link>
			) : (
				<span className={rowClassName}>{content}</span>
			)}
		</li>
	);
}

export function RationaleEmpty({ filtered }: { filtered: boolean }) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Brain size={20} />
				</EmptyMedia>
				<EmptyTitle>
					{filtered ? "No decisions match this filter" : "No decisions yet"}
				</EmptyTitle>
				<EmptyDescription>
					Rationale records are the tedi decision journal — every entry is
					span-checkable against a run, work item, or tool call. They appear
					here as tedis decide and act.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function KnowledgeRow({
	entry,
	tediNames = {},
}: {
	entry: KnowledgeEntry;
	tediNames?: Record<string, string>;
}) {
	useOsFormattingPreferences();
	const text = memoryText(entry.title, entry.content);
	const contentPreview = text.title
		? compactPreview(entry.content, BRAIN_PREVIEW_LENGTH)
		: null;
	const updated = entry.updatedAt ?? entry.createdAt ?? null;
	const scope = entry.tediId
		? (tediNames[entry.tediId] ?? "a tedi")
		: "org-wide";
	return (
		<li className="flex min-h-16 min-w-0 items-start gap-3 px-3 py-2.5">
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex flex-wrap items-center gap-1.5">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="strong"
						className="min-w-0 truncate"
					>
						{text.line}
					</Text>
					<Badge
						variant={ENTRY_TYPE_VARIANTS[entry.entryType]}
						data-entry-type={entry.entryType}
					>
						{sentenceCase(entry.entryType)}
					</Badge>
					<Text as="span" role="label" tone="secondary">
						{scope} · {confidencePercent(entry.confidence)} confident
						{entry.sourceCount > 0
							? ` · ${formatCount(entry.sourceCount)} source ${
									entry.sourceCount === 1 ? "fact" : "facts"
								}`
							: ""}
						{entry.revision > 1 ? ` · rev ${entry.revision}` : ""}
					</Text>
				</span>
				{contentPreview ? (
					<Text as="span" role="label" tone="secondary">
						{contentPreview}
					</Text>
				) : null}
				{updated ? (
					<Text as="span" role="label" tone="secondary">
						updated{" "}
						<time dateTime={updated} title={absoluteTime(updated)}>
							{relativeTime(updated)}
						</time>
					</Text>
				) : null}
			</span>
		</li>
	);
}

export function KnowledgeEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<BookOpen size={20} />
				</EmptyMedia>
				<EmptyTitle>No knowledge entries yet</EmptyTitle>
				<EmptyDescription>
					Knowledge entries are consolidated insights, patterns, and conventions
					distilled from facts. Tedis record them as they learn.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
			{health.isPending && <ListSkeleton rows={1} rowClassName="h-24" />}
			{health.isError && (
				<Alert variant="destructive">
					<AlertTitle>Memory health is unavailable</AlertTitle>
					<AlertDescription>{health.error.message}</AlertDescription>
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
