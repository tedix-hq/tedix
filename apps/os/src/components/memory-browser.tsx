import type { AgentLessonEntry } from "@tedix/api-contract/schemas/agent-session-lessons";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "./kumo/collapsible";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { RunLinkChip, type CardRunLinkProps } from "./chat-cards";
import type { Fact } from "@tedix/api-contract/schemas/memory-graph";
import { MemoryConsolidationSchema } from "@tedix/api-contract/schemas/memory-observations";
import { osQuery } from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import {
	MEMORY_PAGE_SIZE,
	MEMORY_RECENT_LIMIT,
	MEMORY_TABS,
	filterMemoryRows,
	memoryPage,
	memoryText,
	workflowRunLinkId,
	type MemorySearch,
	type MemoryTableRow,
} from "@/lib/memory-browser";
import { Button } from "./kumo/button";
import { Input } from "./kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./kumo/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
} from "./kumo/sheet";
import {
	Table,
	TableHeader,
	TableHead,
	TableBody,
	TableRow,
	TableCell,
} from "./kumo/table";
import { Tabs, TabsList, TabsTrigger } from "./kumo/tabs";
import { Text } from "./kumo/text";
import { LoadError } from "./kumo/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./kumo/empty";
import { ListSkeleton } from "./list-skeleton";
import {
	collapseWhitespace,
	MemoryHealthFindingsSection,
} from "./memory-health-findings";
import { ObservationEvidence } from "./memory-observations";

type Row = MemoryTableRow & { details: ReactNode };

export function MemoryRunEvidence({
	runId,
	LinkComponent,
}: {
	runId: string | null;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	const workflowRunId = workflowRunLinkId(runId);
	if (workflowRunId)
		return (
			<div className="[&_a]:min-h-11">
				<RunLinkChip runId={workflowRunId} LinkComponent={LinkComponent} />
			</div>
		);
	return runId ? <Text className="wrap-anywhere">Run: {runId}</Text> : null;
}

function Choice({
	label,
	value,
	choices,
	onChange,
	disabled = false,
}: {
	label: string;
	value: string;
	choices: { value: string; label: string }[];
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			disabled={disabled}
			value={value}
			onValueChange={(value) => {
				if (value !== null) onChange(value);
			}}
		>
			<SelectTrigger aria-label={label} className="w-full min-w-0">
				<SelectValue>
					{choices.find((choice) => choice.value === value)?.label}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{choices.map((choice) => (
					<SelectItem key={choice.value} value={choice.value}>
						{choice.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function FactDetails({ fact }: { fact: Fact }) {
	useOsFormattingPreferences();
	const consolidated = MemoryConsolidationSchema.safeParse(
		fact.metadata?.consolidation,
	).success;
	return (
		<div className="grid gap-4">
			{consolidated ? (
				<ObservationEvidence fact={fact} />
			) : (
				<Text className="whitespace-pre-wrap wrap-anywhere">
					{fact.content}
				</Text>
			)}
			<Text weight="medium">Evidence and history</Text>
			<Text tone="secondary">
				Created:{" "}
				{fact.createdAt ? absoluteTime(fact.createdAt) : "Not recorded"}
			</Text>
			<Text tone="secondary">
				Last verified:{" "}
				{fact.lastVerifiedAt
					? absoluteTime(fact.lastVerifiedAt)
					: "Not recorded"}
			</Text>
			{fact.metadata && !consolidated && (
				<Collapsible>
					<CollapsibleTrigger>Additional source data</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<pre className="whitespace-pre-wrap wrap-anywhere type-tedix-caption">
							{JSON.stringify(fact.metadata, null, 2)}
						</pre>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

export function MemoryRuleDetails({ lesson }: { lesson: AgentLessonEntry }) {
	return (
		<div className="grid gap-4">
			<Text className="whitespace-pre-wrap wrap-anywhere">{lesson.text}</Text>
			<Collapsible>
				<CollapsibleTrigger className="min-h-11">Evidence</CollapsibleTrigger>
				<CollapsibleContent keepMounted>
					<div className="grid gap-3 pt-2">
						{lesson.evidence?.sources.length ? (
							lesson.evidence.sources.map((source) => (
								<blockquote
									key={`${source.kind}:${source.id}`}
									className="m-0 border-l border-kumo-line pl-4"
								>
									{collapseWhitespace(source.quote) !==
										collapseWhitespace(lesson.text) && (
										<Text className="whitespace-pre-wrap wrap-anywhere">
											{source.quote}
										</Text>
									)}
									<Text
										role="caption"
										tone="secondary"
										className="wrap-anywhere"
									>
										{source.kind}: {source.id}
									</Text>
								</blockquote>
							))
						) : (
							<Text tone="secondary">No source quotes recorded.</Text>
						)}
						<Text tone="secondary">
							{lesson.learnedFrom
								? `${lesson.learnedFrom.replies} decisions cited`
								: "No decision history recorded."}
						</Text>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

export function MemoryBrowser({
	search,
	onSearch,
}: {
	search: MemorySearch;
	onSearch: (patch: Partial<MemorySearch>) => void;
}) {
	useOsFormattingPreferences();
	const factView =
		search.tab === "observations" ||
		search.tab === "stale" ||
		search.tab === "contradictions" ||
		search.tab === "gaps";
	const facts = useQuery({
		...osQuery.memoryGraph.browse.queryOptions({
			input: {
				view: factView
					? (search.tab as "observations" | "stale" | "contradictions" | "gaps")
					: "observations",
				search: search.q || undefined,
				domainId: search.domain || undefined,
				minConfidence:
					search.confidence === "all"
						? undefined
						: Number(search.confidence) / 100,
				orderBy: search.sort,
				limit: MEMORY_PAGE_SIZE,
				offset: search.page * MEMORY_PAGE_SIZE,
			},
		}),
		enabled: factView,
	});
	const rules = useQuery({
		...osQuery.agentTurnTriage.listLessons.queryOptions({
			input: { limit: MEMORY_RECENT_LIMIT },
		}),
		enabled: search.tab === "rules",
	});
	const knowledge = useQuery({
		...osQuery.knowledge.list.queryOptions({
			input: { limit: MEMORY_RECENT_LIMIT },
		}),
		enabled: search.tab === "knowledge",
	});
	const decisions = useQuery({
		...osQuery.rationaleRecords.list.queryOptions({
			input: { limit: MEMORY_RECENT_LIMIT },
		}),
		enabled: search.tab === "decisions",
	});
	const curiosity = useQuery({
		...osQuery.memoryGraph.optimize.backlog.queryOptions({
			input: { type: "curiosity", limit: MEMORY_RECENT_LIMIT },
		}),
		enabled: search.tab === "curiosity",
	});
	const domains = useQuery({
		...osQuery.memoryGraph.listDomains.queryOptions(),
		enabled: factView,
	});
	let rows: Row[] = [];
	if (factView)
		rows = (facts.data?.facts ?? []).map((fact) => ({
			id: fact.id,
			title: fact.summary,
			body: fact.content,
			source: fact.source ?? "Not recorded",
			updated: fact.updatedAt ?? fact.createdAt ?? null,
			confidence: fact.confidence,
			domain: fact.domainId,
			details: <FactDetails fact={fact} />,
		}));
	if (search.tab === "rules")
		rows = (rules.data?.lessons ?? [])
			.filter((lesson) => lesson.fromCallerFeedback)
			.map((lesson) => ({
				id: lesson.id,
				body: lesson.text,
				source: "Your feedback",
				updated: lesson.addedAt,
				confidence: null,
				details: <MemoryRuleDetails lesson={lesson} />,
			}));
	if (search.tab === "knowledge")
		rows = (knowledge.data?.entries ?? []).map((entry) => ({
			id: entry.id,
			title: entry.title,
			body: entry.content,
			source: entry.entryType,
			updated: entry.updatedAt ?? entry.createdAt ?? null,
			confidence: entry.confidence,
			domain: entry.domainId,
			details: (
				<div className="grid gap-4">
					<Text className="whitespace-pre-wrap wrap-anywhere">
						{entry.content}
					</Text>
					<Text weight="medium">Evidence and history</Text>
					<Text>
						{entry.sourceCount} source facts · Revision {entry.revision}
					</Text>
					<Text className="wrap-anywhere">
						{entry.sourceFactIds?.join(", ") ?? "Source fact IDs not recorded."}
					</Text>
					{entry.revisionReasoning && <Text>{entry.revisionReasoning}</Text>}
					{entry.supersedesId && (
						<Text className="wrap-anywhere">
							Previous version: {entry.supersedesId}
						</Text>
					)}
				</div>
			),
		}));
	if (search.tab === "decisions")
		rows = (decisions.data?.data ?? []).map((record) => ({
			id: record.id,
			title: record.action,
			body: record.rationale ?? "",
			source: record.outcomeStatus,
			updated: record.completedAt ?? record.createdAt,
			confidence: record.confidence,
			details: (
				<div className="grid gap-4">
					<Text className="wrap-anywhere">{record.rationale}</Text>
					<Text>Outcome: {record.outcomeStatus}</Text>
					{record.outcome && <Text>{record.outcome}</Text>}
					<Text weight="medium">Evidence</Text>
					<pre className="whitespace-pre-wrap wrap-anywhere type-tedix-caption">
						{JSON.stringify(record.evidence, null, 2)}
					</pre>
					<MemoryRunEvidence runId={record.runId} />
					{record.proofRef && (
						<Text className="wrap-anywhere">Proof: {record.proofRef.ref}</Text>
					)}
				</div>
			),
		}));
	if (search.tab === "curiosity")
		rows = (curiosity.data?.curiosityItems ?? []).map((item) => ({
			id: item.id,
			title: item.topic,
			body: item.reason,
			source: item.status,
			updated: item.updatedAt ?? item.createdAt ?? null,
			confidence: null,
			domain: item.domain,
			details: (
				<div className="grid gap-4">
					<Text>{item.reason}</Text>
					<Text>
						Domain: {item.domain} · Status: {item.status}
					</Text>
					<Text>
						{item.factsLearned} facts learned · {item.gapsFound} gaps found
					</Text>
					<Text>Source: {item.source}</Text>
				</div>
			),
		}));
	const activeQuery = factView
		? facts
		: search.tab === "rules"
			? rules
			: search.tab === "knowledge"
				? knowledge
				: search.tab === "decisions"
					? decisions
					: curiosity;
	const selected = rows.find((row) => row.id === search.detail) ?? null;
	const confidenceAvailable =
		search.tab !== "rules" && search.tab !== "curiosity";
	const filtered = factView
		? rows
		: filterMemoryRows(rows, {
				...search,
				confidence: confidenceAvailable ? search.confidence : "all",
				sort: confidenceAvailable ? search.sort : "updated",
			});
	const sourceLabel =
		search.tab === "decisions"
			? "Outcome"
			: search.tab === "knowledge"
				? "Type"
				: search.tab === "curiosity"
					? "Status"
					: "Source";
	const pageRows = factView ? rows : memoryPage(filtered, search.page);
	const hasNext = factView
		? facts.data?.nextOffset != null
		: (search.page + 1) * MEMORY_PAGE_SIZE < filtered.length;
	const label = MEMORY_TABS.find((tab) => tab.id === search.tab)!.label;
	const change = (patch: Partial<MemorySearch>) =>
		onSearch({ ...patch, page: 0, detail: "" });
	const sources = [...new Set(rows.map((row) => row.source))].sort();
	const hasFilters = Boolean(
		search.q || search.domain || search.source || search.confidence !== "all",
	);
	const description =
		search.tab === "stale"
			? "Not accessed in 60 days. Only memories you can access are listed."
			: search.tab === "contradictions"
				? "Memories with a contradiction link. One memory may have several links."
				: search.tab === "gaps"
					? "Questions with missing evidence. Only memories you can access are listed."
					: factView
						? "Observations and evidence you can access."
						: `Search and sort the latest ${MEMORY_RECENT_LIMIT} records. Open a memory for full text and evidence.`;
	return (
		<section className="grid min-w-0 gap-4" aria-label="Memory browser">
			<Tabs
				value={search.tab}
				onValueChange={(tab) =>
					change({
						tab: tab as MemorySearch["tab"],
						q: "",
						domain: "",
						source: "",
						confidence: "all",
						sort: "updated",
					})
				}
			>
				<TabsList variant="line" aria-label="Memory sections">
					{MEMORY_TABS.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{search.tab === "health" ? (
				<MemoryHealthFindingsSection />
			) : (
				<>
					<div className="grid gap-3">
						<Text as="h2" role="section" className="sr-only">
							{label}
						</Text>
						<Text tone="secondary" className="m-0">
							{description}
						</Text>
						<div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-5">
							<div className="col-span-2">
								<Input
									aria-label={`Search ${label.toLowerCase()}`}
									placeholder="Search memories…"
									value={search.q}
									onChange={(event) => change({ q: event.target.value })}
								/>
							</div>
							{factView ? (
								<Choice
									label="Domain"
									value={search.domain}
									choices={[
										{ value: "", label: "All domains" },
										...(domains.data?.domains ?? []).map((domain) => ({
											value: domain.id,
											label: domain.name,
										})),
									]}
									onChange={(domain) => change({ domain })}
								/>
							) : (
								<Choice
									label={sourceLabel}
									value={search.source}
									choices={[
										{
											value: "",
											label: `All ${sourceLabel === "Status" ? "statuses" : `${sourceLabel.toLowerCase()}s`}`,
										},
										...sources.map((source) => ({
											value: source,
											label: source.replaceAll("_", " "),
										})),
									]}
									onChange={(source) => change({ source })}
								/>
							)}
							<Choice
								label="Confidence"
								disabled={!confidenceAvailable}
								value={confidenceAvailable ? search.confidence : "all"}
								choices={[
									{ value: "all", label: "Any confidence" },
									{ value: "80", label: "80% or higher" },
									{ value: "50", label: "50% or higher" },
								]}
								onChange={(confidence) =>
									change({
										confidence: confidence as MemorySearch["confidence"],
									})
								}
							/>
							<div className="col-span-2 lg:col-span-1">
								<Choice
									label="Sort memories"
									value={confidenceAvailable ? search.sort : "updated"}
									choices={[
										{ value: "updated", label: "Updated: newest" },
										...(confidenceAvailable
											? [{ value: "confidence", label: "Confidence: highest" }]
											: []),
									]}
									onChange={(sort) =>
										change({ sort: sort as MemorySearch["sort"] })
									}
								/>
							</div>
						</div>
						{hasFilters && (
							<div>
								<Button
									variant="ghost"
									onClick={() =>
										change({ q: "", domain: "", source: "", confidence: "all" })
									}
								>
									Clear filters
								</Button>
							</div>
						)}
					</div>
					{activeQuery.isError && (
						<LoadError
							title={`${label} is unavailable`}
							error={activeQuery.error}
							onRetry={() => void activeQuery.refetch()}
							retrying={activeQuery.isFetching}
						/>
					)}
					{activeQuery.isPending ? (
						<ListSkeleton rows={5} />
					) : activeQuery.isError &&
					  activeQuery.data === undefined ? null : pageRows.length === 0 ? (
						<Empty appearance="quiet">
							<EmptyHeader>
								<EmptyTitle>No memories to show</EmptyTitle>
								<EmptyDescription>
									{hasFilters
										? "Try another search or clear the filters."
										: "Memories appear here as your tedis learn."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table className="w-full table-fixed" aria-label={label}>
							<TableHeader>
								<TableRow>
									<TableHead className="w-full sm:w-1/2">Memory</TableHead>
									<TableHead className="hidden sm:table-cell">
										{sourceLabel}
									</TableHead>
									<TableHead className="hidden sm:table-cell">
										Updated
									</TableHead>
									<TableHead className="hidden text-right sm:table-cell">
										Confidence
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pageRows.map((row) => (
									<TableRow key={row.id}>
										<TableCell className="!whitespace-normal">
											<Button
												variant="ghost"
												multiline
												aria-label={`Open details: ${memoryText(row.title, row.body).line}`}
												className="w-full min-w-0 justify-start !p-0 text-left"
												onClick={() => onSearch({ detail: row.id })}
											>
												<span className="min-w-0">
													<span className="my-2 block line-clamp-2 wrap-anywhere">
														{memoryText(row.title, row.body).line}
													</span>
													<span className="block pb-2 wrap-anywhere text-kumo-subtle type-tedix-caption sm:hidden">
														{row.source.replaceAll("_", " ")} ·{" "}
														{row.updated
															? relativeTime(row.updated)
															: "Date unknown"}{" "}
														·{" "}
														{row.confidence === null
															? "Confidence not recorded"
															: `${Math.round(row.confidence * 100)}%`}
													</span>
												</span>
											</Button>
										</TableCell>
										<TableCell className="hidden !whitespace-normal text-kumo-subtle wrap-anywhere sm:table-cell">
											{row.source.replaceAll("_", " ")}
										</TableCell>
										<TableCell className="hidden text-kumo-subtle sm:table-cell">
											{row.updated ? (
												<time
													dateTime={row.updated}
													title={absoluteTime(row.updated)}
												>
													{relativeTime(row.updated)}
												</time>
											) : (
												"—"
											)}
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{row.confidence === null
												? "—"
												: `${Math.round(row.confidence * 100)}%`}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Text role="caption" tone="secondary" aria-live="polite">
							Page {search.page + 1} · {pageRows.length} memories
							{factView ? "" : ` of ${filtered.length} in this recent window`}
						</Text>
						<div className="flex gap-2">
							<Button
								variant="outline"
								disabled={search.page === 0}
								onClick={() => onSearch({ page: search.page - 1, detail: "" })}
							>
								Previous
							</Button>
							<Button
								variant="outline"
								disabled={!hasNext || activeQuery.isFetching}
								onClick={() => onSearch({ page: search.page + 1, detail: "" })}
							>
								Next
							</Button>
						</div>
					</div>
					<Sheet
						open={selected !== null}
						onOpenChange={(open) => {
							if (!open) onSearch({ detail: "" });
						}}
					>
						<SheetContent size="lg">
							<SheetHeader>
								<SheetTitle>Memory details</SheetTitle>
								<SheetDescription className="pr-8 wrap-anywhere">
									{selected
										? (memoryText(selected.title, selected.body).title ??
											"Full text, evidence and history")
										: ""}
								</SheetDescription>
							</SheetHeader>
							<div className="grid gap-4 px-4 pb-6 sm:px-6">
								{selected && (
									<Text tone="secondary" className="wrap-anywhere">
										{selected.source} ·{" "}
										{selected.updated
											? absoluteTime(selected.updated)
											: "Date not recorded"}
										{selected.confidence !== null
											? ` · ${Math.round(selected.confidence * 100)}% confidence`
											: ""}
									</Text>
								)}
								{selected?.details}
							</div>
						</SheetContent>
					</Sheet>
				</>
			)}
		</section>
	);
}
