import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import {
	ArrowSquareOut,
	CaretDown,
	CheckCircle,
	TreeStructure,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
	HomeChildRunEvidence,
	HomeRun,
	HomeRunTrace,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { compactPreview, RunStatusChip } from "@/components/chat-cards";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { HomeRunIdentity } from "@/components/home-run-identity";
import {
	Collection,
	Page,
	PageBack,
	PageHeader,
	PageHeading,
	PageMeta,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import {
	homeChildRunEvidenceQueryOptions,
	homeRunQueryOptions,
	homeRunTraceQueryOptions,
	osQuery,
} from "@/lib/os-query-options";
import { absoluteTime, formatDurationMs } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { ArtifactReleaseReview } from "@/components/artifact-release-review";
import { useTediNames } from "@/lib/use-tedi-names";
import { asRecord } from "@tedix/api-contract/utils/is-record";

function safeText(value: unknown): string | null {
	return typeof value === "string" && value.trim()
		? sanitizeUntrustedText(value.trim())
		: null;
}

function statusVariant(status: string) {
	if (["completed", "healthy", "verified", "passed"].includes(status))
		return "success" as const;
	if (["failed", "unhealthy", "rejected"].includes(status))
		return "error" as const;
	if (["running", "queued", "streaming"].includes(status))
		return "info" as const;
	if (
		["partial", "degraded", "requires_approval", "unverified"].includes(status)
	)
		return "warning" as const;
	return "secondary" as const;
}

export function executionTitle(branchId?: string): string {
	return branchId ? "Delegated execution" : "Home execution";
}

function EvidenceRow({
	title,
	detail,
	children,
}: {
	title: string;
	detail?: string | null;
	children?: React.ReactNode;
}) {
	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			<CheckCircle className="mt-0.5 shrink-0 text-kumo-success" size={17} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text as="strong" role="body" weight="medium" className="break-words">
					{title}
				</Text>
				{detail ? (
					<Text as="span" role="label" tone="secondary" className="break-words">
						{detail}
					</Text>
				) : null}
				{children}
			</span>
		</li>
	);
}

function DelegationEvidence({ evidence }: { evidence: HomeChildRunEvidence }) {
	useOsFormattingPreferences();
	const toolEvents = evidence.events.filter((event) =>
		event.kind.startsWith("tool."),
	);
	return (
		<>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Delegated result</SectionTitle>
						<SectionDescription>
							The child runtime's canonical result and control state.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{evidence.preview ? (
					<Text role="body" className="whitespace-pre-wrap">
						{sanitizeUntrustedText(evidence.preview)}
					</Text>
				) : (
					<Text role="body" tone="secondary">
						No result preview was recorded.
					</Text>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Tool activity</SectionTitle>
						<SectionDescription>
							Durable child-runtime tool events, in recorded order.
						</SectionDescription>
					</SectionHeading>
					<Badge variant="secondary">{toolEvents.length}</Badge>
				</SectionHeader>
				{toolEvents.length ? (
					<Collection aria-label="Delegated tool events">
						{toolEvents.map((event) => {
							const payload = asRecord(event.payload);
							const name = safeText(payload?.name) ?? "Tool action";
							const detail = compactPreview(
								payload?.error ?? payload?.result ?? payload?.args,
							);
							return (
								<EvidenceRow
									key={event.id}
									title={`${name} · ${sentenceCase(event.kind.replace("tool.", ""))}`}
									detail={detail ?? absoluteTime(event.createdAt)}
								/>
							);
						})}
					</Collection>
				) : (
					<Text role="body" tone="secondary">
						No tool events were recorded.
					</Text>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Artifacts</SectionTitle>
						<SectionDescription>
							Artifacts attributed to this delegated run.
						</SectionDescription>
					</SectionHeading>
					<Badge variant="secondary">{evidence.artifacts.length}</Badge>
				</SectionHeader>
				{evidence.artifacts.length ? (
					<Collection aria-label="Delegated artifacts">
						{evidence.artifacts.map((artifact) => (
							<EvidenceRow
								key={artifact.id}
								title={sanitizeUntrustedText(artifact.name)}
								detail={[artifact.kind, artifact.mimeType, artifact.uri]
									.filter(Boolean)
									.join(" · ")}
							>
								{artifact.accessClassification === "runtime_private" ? (
									<ArtifactReleaseReview
										tediId={evidence.delegatedTediId}
										artifactId={artifact.id}
									/>
								) : null}
							</EvidenceRow>
						))}
					</Collection>
				) : (
					<Text role="body" tone="secondary">
						No durable artifacts were recorded.
					</Text>
				)}
			</PageSection>
		</>
	);
}

export function HomeExecutionDetailView({
	run,
	trace,
	branchId,
	evidence,
	evidenceError,
	tediNames = {},
	embedded = false,
	events,
	eventsError,
}: {
	run: HomeRun;
	trace: HomeRunTrace;
	branchId?: string;
	evidence?: HomeChildRunEvidence;
	evidenceError?: unknown;
	tediNames?: Record<string, string>;
	embedded?: boolean;
	events?: RuntimeStreamEvent[];
	eventsError?: unknown;
}) {
	useOsFormattingPreferences();
	const selectedBranch = branchId
		? trace.branches.find((branch) => branch.childRunId === branchId)
		: undefined;
	const metadata = asRecord(run.metadata);
	const route = asRecord(metadata?.kernelRoute);
	const delegation = asRecord(metadata?.homeDelegation);
	const workOrder = asRecord(delegation?.workOrder);
	const proof = asRecord(metadata?.delegationProof);
	const selectedTedi = selectedBranch
		? (tediNames[selectedBranch.delegatedTediId] ?? "Digital worker")
		: null;

	const toolNames = [
		...new Set(
			(events ?? [])
				.filter((event) => event.kind.startsWith("tool."))
				.flatMap((event) => {
					const payload = asRecord(event.payload);
					const name = safeText(payload?.name) ?? safeText(payload?.toolName);
					return name ? [name] : [];
				}),
		),
	];
	const workers = [
		...new Set(
			trace.branches.map(
				(branch) => tediNames[branch.delegatedTediId] ?? "Digital worker",
			),
		),
	];
	if (!workers.length && run.delegatedTediId)
		workers.push(tediNames[run.delegatedTediId] ?? "Digital worker");

	return (
		<Page width="lg" className={embedded ? "flex-none gap-6 pt-0" : undefined}>
			{!embedded ? (
				<>
					<PageBack
						render={
							<Link to="/chat" search={{ conversation: run.conversationId }} />
						}
					>
						Conversation
					</PageBack>
					<PageHeader>
						<PageHeading>
							<PageTitle>
								{selectedTedi
									? `Delegation to ${selectedTedi}`
									: executionTitle(branchId)}
							</PageTitle>
							<PageMeta className="gap-x-5">
								<li>
									<RunStatusChip status={run.status} />
								</li>
								<li>
									Started{" "}
									<strong>
										{run.startedAt
											? absoluteTime(run.startedAt)
											: "not recorded"}
									</strong>
								</li>
								{run.completedAt ? (
									<li>
										Finished <strong>{absoluteTime(run.completedAt)}</strong>
									</li>
								) : null}
								{run.usage?.costUsd != null ? (
									<li>
										Kernel cost <strong>${run.usage.costUsd.toFixed(4)}</strong>
									</li>
								) : null}
							</PageMeta>
						</PageHeading>
					</PageHeader>
				</>
			) : null}
			<PageSection aria-label="Response summary">
				<Text role="body" className="[overflow-wrap:anywhere]">
					{safeText(workOrder?.objective) ??
						safeText(route?.rationale) ??
						`This response ${run.status === "running" ? "is in progress" : run.status === "queued" ? "is waiting to start" : sentenceCase(run.status).toLowerCase()}.`}
				</Text>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 type-tedix-body [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere]">
					<dt className="text-kumo-subtle">Tedi</dt>
					<dd>{workers.join(", ") || "Home"}</dd>
					<dt className="text-kumo-subtle">Tools</dt>
					<dd className="break-words">
						{toolNames.join(", ") ||
							(trace.branches.some((branch) => branch.toolEventIds.length)
								? "See delegated tool activity below"
								: events
									? "None in recorded events"
									: "Not available yet")}
					</dd>
					<dt className="text-kumo-subtle">Time</dt>
					<dd>
						{trace.latency.parentElapsedMs != null
							? formatDurationMs(trace.latency.parentElapsedMs)
							: "Not recorded"}
					</dd>
					<dt className="text-kumo-subtle">Cost</dt>
					<dd>
						{run.usage?.costUsd != null
							? `$${run.usage.costUsd.toFixed(4)} (Home only)`
							: "Not recorded"}
					</dd>
				</dl>
			</PageSection>
			<Collapsible defaultOpen={Boolean(branchId)}>
				<CollapsibleTrigger className="group/disclosure">
					<CaretDown
						size={14}
						aria-hidden
						className="transition-transform group-data-[panel-open]/disclosure:rotate-180"
					/>
					Execution and trace
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-6 pt-3">
					{branchId && !selectedBranch ? (
						<Alert variant="warning">
							<AlertTitle>Delegation not found</AlertTitle>
							<AlertDescription>
								This child run is not part of the addressed Home execution.
							</AlertDescription>
						</Alert>
					) : null}

					<PageSection>
						<SectionHeader>
							<SectionHeading>
								<SectionTitle>Execution</SectionTitle>
								<SectionDescription>
									Kernel routing, authority, and durable outcome.
								</SectionDescription>
							</SectionHeading>
							<Badge variant={statusVariant(trace.health.status)}>
								{sentenceCase(trace.health.status)} trace
							</Badge>
						</SectionHeader>
						<Collection aria-label="Execution summary">
							<EvidenceRow title="Home run" detail={run.id} />
							{route ? (
								<EvidenceRow
									title={`Route: ${sentenceCase(safeText(route.routeKind) ?? "unknown")}`}
									detail={safeText(route.rationale)}
								/>
							) : null}
							{workOrder ? (
								<EvidenceRow
									title={
										safeText(workOrder.objective) ?? "Delegated work order"
									}
									detail={safeText(workOrder.outputContract)}
								/>
							) : null}
							{safeText(metadata?.workItemId) ? (
								<EvidenceRow
									title="Work item"
									detail={safeText(metadata?.workItemId)}
								/>
							) : null}
							<EvidenceRow
								title={trace.complete ? "Trace complete" : "Trace has gaps"}
								detail={
									trace.gaps.length
										? trace.gaps.map(sanitizeUntrustedText).join(" · ")
										: `${trace.parentEventIds.length} parent events · ${trace.branches.length} delegated branch${trace.branches.length === 1 ? "" : "es"}`
								}
							/>
							{trace.latency.parentElapsedMs != null ? (
								<EvidenceRow
									title="Elapsed time"
									detail={formatDurationMs(trace.latency.parentElapsedMs)}
								/>
							) : null}
							{proof && safeText(proof.verdict) ? (
								<EvidenceRow
									title={`Evidence: ${sentenceCase(safeText(proof.verdict)!)}`}
									detail={safeText(proof.note)}
								/>
							) : null}
						</Collection>
					</PageSection>

					{trace.branches.length ? (
						<PageSection>
							<SectionHeader>
								<SectionHeading>
									<SectionTitle>Delegations</SectionTitle>
									<SectionDescription>
										Select a branch to inspect its tool and artifact evidence.
									</SectionDescription>
								</SectionHeading>
							</SectionHeader>
							<Collection aria-label="Delegated branches">
								{trace.branches.map((branch) => (
									<li
										key={branch.childRunId}
										className="flex min-w-0 items-center gap-3 px-3 py-2"
									>
										<TreeStructure size={18} className="shrink-0" />
										<span className="flex min-w-0 flex-1 flex-col">
											<Text as="strong" weight="medium">
												{tediNames[branch.delegatedTediId] ?? "Digital worker"}
											</Text>
											<Text as="span" role="label" tone="secondary">
												{branch.eventIds.length} events ·{" "}
												{branch.artifactIds.length} artifacts
												{branch.workItemId
													? ` · work item ${branch.workItemId}`
													: ""}
											</Text>
										</span>
										<Badge variant={statusVariant(branch.status)}>
											{sentenceCase(branch.status)}
										</Badge>
										<Link
											to="/chat"
											search={{
												conversation: run.conversationId,
												details: run.id,
												branch: branch.childRunId,
											}}
											resetScroll={false}
											className="inline-flex items-center gap-1 text-kumo-link text-sm"
										>
											Inspect <ArrowSquareOut size={14} />
										</Link>
									</li>
								))}
							</Collection>
						</PageSection>
					) : null}

					{selectedBranch && evidence ? (
						<DelegationEvidence evidence={evidence} />
					) : null}
					{selectedBranch && evidenceError ? (
						<DetailUnavailable
							resource="Delegation evidence"
							error={evidenceError}
						/>
					) : null}
					{selectedBranch && !evidence && !evidenceError ? (
						<div
							className="grid gap-2"
							aria-label="Loading delegation evidence"
						>
							<Skeleton className="h-20" />
							<Skeleton className="h-32" />
						</div>
					) : null}
				</CollapsibleContent>
			</Collapsible>
			<Collapsible>
				<CollapsibleTrigger className="group/disclosure">
					<CaretDown
						size={14}
						aria-hidden
						className="transition-transform group-data-[panel-open]/disclosure:rotate-180"
					/>
					Events
					{events
						? ` (${events.length}${events.length === 100 ? "+" : ""})`
						: ""}
				</CollapsibleTrigger>
				<CollapsibleContent>
					{eventsError ? (
						<DetailUnavailable
							resource="Execution events"
							error={eventsError}
						/>
					) : !events ? (
						<Skeleton className="h-20" />
					) : null}
					{events?.length === 100 ? (
						<Text role="label" tone="secondary">
							Showing the first 100 recorded events.
						</Text>
					) : null}
					<Collection aria-label="Execution events">
						{(events ?? []).map((event) => (
							<EvidenceRow
								key={event.id}
								title={sentenceCase(event.kind.replaceAll(".", " "))}
								detail={absoluteTime(event.createdAt)}
							/>
						))}
					</Collection>
				</CollapsibleContent>
			</Collapsible>
		</Page>
	);
}

export function HomeExecutionDetailPage({
	runId,
	branchId,
	embedded = false,
}: {
	runId: string;
	branchId?: string;
	embedded?: boolean;
}) {
	const runQuery = useQuery({
		...homeRunQueryOptions(runId),
		refetchInterval: (query) =>
			query.state.data?.run.status &&
			["queued", "running"].includes(query.state.data.run.status)
				? 5_000
				: false,
	});
	const traceQuery = useQuery({
		...homeRunTraceQueryOptions(runId),
		refetchInterval:
			runQuery.data?.run.status &&
			["queued", "running"].includes(runQuery.data.run.status)
				? 5_000
				: false,
	});
	const eventsQuery = useQuery(
		osQuery.kernelRuntime.readRunEvents.queryOptions({
			input: { runId, limit: 100 },
		}),
	);
	const names = useTediNames();
	const branch = branchId
		? traceQuery.data?.trace.branches.find(
				(candidate) => candidate.childRunId === branchId,
			)
		: undefined;
	const evidenceQuery = useQuery({
		...homeChildRunEvidenceQueryOptions(
			branch?.delegatedTediId ?? "",
			branch?.childRunId ?? "",
		),
		enabled: Boolean(branch),
	});

	const identity = embedded ? null : <HomeRunIdentity runId={runId} />;
	if (runQuery.isError || traceQuery.isError) {
		return (
			<Page width="lg">
				{identity}
				{runQuery.isError ? (
					<div className="grid gap-2">
						<DetailUnavailable
							resource="Home execution"
							error={runQuery.error}
						/>
						<Button
							variant="outline"
							disabled={runQuery.isFetching}
							onClick={() => void runQuery.refetch()}
						>
							Retry Home execution
						</Button>
					</div>
				) : null}
				{traceQuery.isError ? (
					<div className="grid gap-2">
						<DetailUnavailable
							resource="Execution trace"
							error={traceQuery.error}
						/>
						<Button
							variant="outline"
							disabled={traceQuery.isFetching}
							onClick={() => void traceQuery.refetch()}
						>
							Retry execution trace
						</Button>
					</div>
				) : null}
			</Page>
		);
	}
	if (runQuery.isPending || traceQuery.isPending) {
		return (
			<Page width="lg">
				{identity}
				<div className="grid gap-2" aria-label="Loading Home execution">
					<Skeleton className="h-24" />
					<Skeleton className="h-32" />
					<Skeleton className="h-32" />
				</div>
			</Page>
		);
	}
	if (!runQuery.data || !traceQuery.data) return null;

	return (
		<HomeExecutionDetailView
			run={runQuery.data.run}
			trace={traceQuery.data.trace}
			branchId={branchId}
			evidence={evidenceQuery.data?.evidence}
			evidenceError={evidenceQuery.error}
			tediNames={names}
			embedded={embedded}
			events={eventsQuery.data?.events}
			eventsError={eventsQuery.error}
		/>
	);
}
