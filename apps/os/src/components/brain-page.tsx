import { BookOpen, Brain, CaretRight } from "@phosphor-icons/react";
import type { RationaleOutcomeStatus } from "@tedix/api-contract/constants/enums";
import type {
	KnowledgeEntry,
	KnowledgeEntryType,
} from "@tedix/api-contract/schemas/cognitive";
import type { MemoryHealth } from "@tedix/api-contract/schemas/memory-graph";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { useQuery } from "@tanstack/react-query";
import { getOsSurface } from "@/lib/os-navigation";
import { useState } from "react";
import type { ComponentType } from "react";
import { type CardRunLinkProps, compactPreview } from "@/components/chat-cards";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { KumoTabs } from "@/components/kumo/tabs";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Text, type TextTone } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatCount, humanize, sentenceCase } from "@/lib/format";
import {
	knowledgeListQueryOptions,
	memoryHealthQueryOptions,
	rationaleListQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";

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

// The Run detail route reads `skill_runs`, whose production creation path uses
// `crypto.randomUUID()`. Rationale `runId` is intentionally broader and also
// carries Agent/Home compound runtime references. Sending those identifiers to
// the workflow-only route produces a false "Run not found" destination.
const WORKFLOW_RUN_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workflowRunLinkId(runId: string | null): string | null {
	return runId && WORKFLOW_RUN_ID_PATTERN.test(runId) ? runId : null;
}

export function runtimeReferenceLabel(runId: string): string {
	const compoundId = runId.match(/:mcp:([^:]+)/i)?.[1] ?? runId;
	return `Runtime ${compoundId.length > 8 ? `${compoundId.slice(0, 8)}…` : compoundId}`;
}

export type MemoryVitalTone = "default" | "warn" | "danger";

export type MemoryVital = {
	id: string;
	label: string;
	value: string;
	tone: MemoryVitalTone;
};

/**
 * Projects `memoryGraph.health` (pure aggregate counts — the honest brain
 * vitals) into labeled stats. Hygiene counters only escalate their tone when
 * they are actually non-zero.
 */
export function memoryVitals(health: MemoryHealth): MemoryVital[] {
	return [
		{
			id: "active-facts",
			label: "Active facts",
			value: formatCount(health.activeFacts),
			tone: "default",
		},
		{
			id: "edges",
			label: "Edges",
			value: formatCount(health.totalEdges),
			tone: "default",
		},
		{
			id: "domains",
			label: "Domains",
			value: formatCount(health.totalDomains),
			tone: "default",
		},
		{
			id: "avg-confidence",
			label: "Avg confidence",
			value: confidencePercent(health.avgConfidence),
			tone: "default",
		},
		{
			id: "open-gaps",
			label: "Open gaps",
			value: formatCount(health.totalGaps),
			tone: "default",
		},
		{
			id: "stale-facts",
			label: "Stale facts",
			value: formatCount(health.staleFacts),
			tone: health.staleFacts > 0 ? "warn" : "default",
		},
		{
			id: "contradictions",
			label: "Contradictions",
			value: formatCount(health.contradictions),
			tone: health.contradictions > 0 ? "danger" : "default",
		},
		{
			id: "curiosity",
			label: "Curiosity queue",
			value: `${formatCount(health.curiosityQueue.queued)} queued · ${formatCount(
				health.curiosityQueue.exploring,
			)} exploring`,
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
	return (
		<MetricGrid aria-label="Memory vitals" columns={4}>
			{memoryVitals(health).map((vital) => (
				<MetricItem
					key={vital.id}
					data-vital={vital.id}
					data-tone={vital.tone}
					label={vital.label}
					value={vital.value}
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
				<LinkComponent
					to="/work/runs/$runId"
					params={{ runId: workflowRunId }}
					title={`Open run ${workflowRunId}`}
					aria-label={`Open run details for ${record.action}`}
					className={`${rowClassName} no-underline transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus`}
				>
					{content}
				</LinkComponent>
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
	const contentPreview = compactPreview(entry.content, BRAIN_PREVIEW_LENGTH);
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
						{entry.title}
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

const RATIONALE_LIMIT = 20;
/** `knowledge.list` has no schema max — ALWAYS pass an explicit small limit. */
const KNOWLEDGE_LIMIT = 20;

export function BrainPage() {
	const surface = getOsSurface("brain");
	const [tab, setTab] = useState<OutcomeTabId>("all");
	const activeTab = OUTCOME_TABS.find((t) => t.id === tab) ?? OUTCOME_TABS[0];

	// Bounded reads only, per the ADR: health aggregates + recent rationale +
	// consolidated knowledge. No graph explorer, no vector search per request.
	const health = useQuery({
		...memoryHealthQueryOptions(),
		staleTime: 60_000,
	});

	const rationale = useQuery(
		rationaleListQueryOptions(
			activeTab.status
				? { outcomeStatus: activeTab.status, limit: RATIONALE_LIMIT }
				: { limit: RATIONALE_LIMIT },
		),
	);

	const knowledge = useQuery({
		...knowledgeListQueryOptions(KNOWLEDGE_LIMIT),
		staleTime: 60_000,
	});

	const tediNames = useTediNames();

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
			</PageHeader>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Memory vitals</SectionTitle>
						<SectionDescription>
							Graph health, confidence, contradictions, and open learning gaps.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{health.isPending && <ListSkeleton rows={1} rowClassName="h-24" />}
				{health.isError && (
					<Alert variant="destructive">
						<AlertTitle>Memory health is unavailable</AlertTitle>
						<AlertDescription>
							{(health.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{health.data && (
					<>
						<MemoryVitals health={health.data} />
						{health.data.totalFacts === 0 && (
							<Text role="body" tone="secondary" className="m-0">
								No memories recorded yet — facts accumulate as tedis observe,
								learn, and consolidate.
							</Text>
						)}
					</>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Recent decisions</SectionTitle>
						<SectionDescription>
							Latest rationale, outcomes, confidence, and run evidence.
						</SectionDescription>
					</SectionHeading>
					<div className="flex max-w-full flex-wrap items-center gap-2">
						{rationale.data ? (
							<Badge variant="outline">{rationale.data.pagination.total}</Badge>
						) : null}
						<KumoTabs
							value={tab}
							onValueChange={(value) => setTab(value as OutcomeTabId)}
							className="shrink-0"
							aria-label="Decision outcome"
							size="sm"
							tabs={OUTCOME_TABS.map(({ id, label }) => ({ value: id, label }))}
						/>
					</div>
				</SectionHeader>
				{rationale.isPending && <ListSkeleton />}
				{rationale.isError && (
					<Alert variant="destructive">
						<AlertTitle>Decisions are unavailable</AlertTitle>
						<AlertDescription>
							{(rationale.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{rationale.data && rationale.data.data.length === 0 && (
					<RationaleEmpty filtered={activeTab.status !== undefined} />
				)}
				{rationale.data && rationale.data.data.length > 0 && (
					<>
						<Collection>
							{rationale.data.data.map((record) => (
								<RationaleRow
									key={record.id}
									record={record}
									tediNames={tediNames}
								/>
							))}
						</Collection>
						{rationale.data.pagination.hasMore && (
							<Text role="label" tone="secondary" className="m-0">
								Showing the latest {formatCount(rationale.data.data.length)} of{" "}
								{formatCount(rationale.data.pagination.total)} decisions. Narrow
								the outcome filter to see more.
							</Text>
						)}
					</>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Knowledge</SectionTitle>
						<SectionDescription>
							Consolidated patterns, conventions, insights, and source depth.
						</SectionDescription>
					</SectionHeading>
					{knowledge.data ? (
						<Badge variant="outline">{knowledge.data.entries.length}</Badge>
					) : null}
				</SectionHeader>
				{knowledge.isPending && <ListSkeleton rows={2} />}
				{knowledge.isError && (
					<Alert variant="destructive">
						<AlertTitle>Knowledge is unavailable</AlertTitle>
						<AlertDescription>
							{(knowledge.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{knowledge.data && knowledge.data.entries.length === 0 && (
					<KnowledgeEmpty />
				)}
				{knowledge.data && knowledge.data.entries.length > 0 && (
					<>
						<Collection>
							{knowledge.data.entries.map((entry) => (
								<KnowledgeRow
									key={entry.id}
									entry={entry}
									tediNames={tediNames}
								/>
							))}
						</Collection>
						{knowledge.data.entries.length >= KNOWLEDGE_LIMIT && (
							<Text role="label" tone="secondary" className="m-0">
								Showing the latest {KNOWLEDGE_LIMIT} knowledge entries — the
								read is bounded by design.
							</Text>
						)}
					</>
				)}
			</PageSection>
		</Page>
	);
}
