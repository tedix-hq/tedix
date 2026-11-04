import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import {
	CaretRight,
	CheckCircle,
	Clock,
	TreeStructure,
	Warning,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type {
	HomeChildRunEvidence,
	HomeRun,
	HomeRunTrace,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { compactPreview, RunStatusChip } from "@/components/chat-cards";
import { ChatMarkdown } from "@/components/chat-markdown";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { CodeBlock } from "@/components/kumo/code";
import { Loader } from "@/components/kumo/loader";
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
import {
	delegatedResult,
	elapsedSince,
	isActiveRunStatus,
	traceSummary,
} from "@/lib/execution-detail-copy";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import {
	homeChildRunEvidenceQueryOptions,
	homeRunQueryOptions,
	homeRunTraceQueryOptions,
	osQuery,
} from "@/lib/os-query-options";
import {
	absoluteTime,
	formatDurationBetween,
	formatDurationMs,
} from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { ArtifactReleaseReview } from "@/components/artifact-release-review";
import { useTediNames } from "@/lib/use-tedi-names";
import { useNow } from "@/lib/use-now";
import { delegationLiveState, shortAge } from "@/lib/delegation-activity";
import { formatSettledEurMicros } from "@/lib/billing-price";
import {
	Progress,
	ProgressIndicator,
	ProgressTrack,
} from "@/components/kumo/progress";
import { asRecord } from "@tedix/api-contract/utils/is-record";

const DIGITAL_WORKER = "Digital worker";

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

function runTime(run: HomeRun, trace: HomeRunTrace, now: number): string {
	if (isActiveRunStatus(run.status)) {
		const elapsed = elapsedSince(run.startedAt ?? run.createdAt, now);
		return elapsed == null
			? "Running"
			: `Running for ${formatDurationMs(Math.floor(elapsed / 1_000) * 1_000)}`;
	}
	return (
		formatDurationMs(trace.latency.parentElapsedMs) ??
		formatDurationBetween(run.startedAt ?? run.createdAt, run.completedAt) ??
		"Not recorded"
	);
}

const ROW_ICONS = {
	complete: (
		<CheckCircle className="mt-0.5 shrink-0 text-kumo-success" size={17} />
	),
	pending: <Clock className="mt-0.5 shrink-0 text-kumo-subtle" size={17} />,
	warning: <Warning className="mt-0.5 shrink-0 text-kumo-warning" size={17} />,
} as const;

function EvidenceRow({
	title,
	detail,
	tone = "complete",
	children,
}: {
	title: string;
	detail?: string | null;
	tone?: keyof typeof ROW_ICONS;
	children?: React.ReactNode;
}) {
	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			{ROW_ICONS[tone]}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text
					as="strong"
					role="body"
					weight="medium"
					className="[overflow-wrap:anywhere]"
				>
					{title}
				</Text>
				{detail ? (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="[overflow-wrap:anywhere]"
					>
						{detail}
					</Text>
				) : null}
				{children}
			</span>
		</li>
	);
}

/** A long identifier: truncated to the row, copyable in full. */
function CopyableId({ value }: { value: string }) {
	return (
		<ClipboardText
			size="sm"
			text={value}
			textToCopy={value}
			className="mt-1 max-w-full"
		/>
	);
}

function Disclosure({
	label,
	defaultOpen,
	children,
}: {
	label: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Collapsible defaultOpen={defaultOpen}>
			<CollapsibleDefaultTrigger className="group/disclosure">
				{label}
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent className="min-w-0 pt-3">
				{children}
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}

export function DelegatedResultView({
	evidence,
	tediName,
}: {
	evidence: Pick<HomeChildRunEvidence, "status" | "preview">;
	tediName: string;
}) {
	const result = delegatedResult(evidence.status, evidence.preview, tediName);
	if (result.kind === "working")
		return (
			<Text
				as="p"
				role="body"
				tone="secondary"
				className="flex items-center gap-2"
			>
				<Loader size={14} aria-hidden />
				{result.message}
			</Text>
		);
	if (result.kind === "empty")
		return (
			<Text role="body" tone="secondary">
				{result.message}
			</Text>
		);
	if (result.kind === "text") return <ChatMarkdown content={result.markdown} />;
	return (
		<div className="grid min-w-0 gap-3">
			<Text role="body" tone="secondary">
				{result.message}
				{result.truncatedChars != null
					? ` Only the first part of its ${result.truncatedChars.toLocaleString()} characters was kept.`
					: ""}
			</Text>
			<Disclosure label="Show raw">
				<CodeBlock
					lang="json"
					showCopyButton
					code={sanitizeUntrustedText(result.raw)}
					className="max-h-96 min-w-0 max-w-full overflow-auto [&_code]:!whitespace-pre-wrap [&_pre]:!whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
				/>
			</Disclosure>
		</div>
	);
}

function DelegationEvidence({
	run,
	now,
	evidence,
	tediName,
}: {
	run: HomeRun;
	now: number;
	evidence: HomeChildRunEvidence;
	tediName: string;
}) {
	useOsFormattingPreferences();
	// The read returns newest first; people read activity oldest first.
	const events = [...evidence.events].sort(
		(a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
	);
	const toolEvents = events.filter((event) => event.kind.startsWith("tool."));
	const live = delegationLiveState({
		run,
		events,
		latestEventAt: evidence.latestEventAt,
		now,
	});
	const active = isActiveRunStatus(run.status);
	return (
		<>
			{active ? (
				<PageSection aria-label={`${tediName}'s progress`}>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Progress</SectionTitle>
							<SectionDescription>
								What {tediName} is doing right now.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					<div className="grid min-w-0 gap-2" data-slot="delegation-progress">
						<Text role="body" className="[overflow-wrap:anywhere]">
							{live.currentStep ?? "Starting…"}
						</Text>
						{live.progress ? (
							<Progress
								value={live.progress.percent}
								aria-label={`${live.progress.current} of ${live.progress.total}`}
							>
								<ProgressTrack className="h-1">
									<ProgressIndicator />
								</ProgressTrack>
							</Progress>
						) : null}
						<Text
							role="label"
							tone={live.phase === "stalled" ? "warning" : "secondary"}
							className="tabular-nums"
						>
							{[
								live.progress
									? `${live.progress.current} of ${live.progress.total}`
									: null,
								live.elapsedMs != null
									? `running ${formatDurationMs(Math.floor(live.elapsedMs / 1_000) * 1_000)}`
									: null,
								live.idleMs != null
									? live.phase === "stalled"
										? `no activity for ${shortAge(live.idleMs)}, it may be stuck`
										: `last activity ${shortAge(live.idleMs)} ago`
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					</div>
				</PageSection>
			) : null}

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>{tediName}'s answer</SectionTitle>
						<SectionDescription>
							What {tediName} sent back to Home.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<DelegatedResultView evidence={evidence} tediName={tediName} />
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Tool activity</SectionTitle>
						<SectionDescription>
							Tools {tediName} used, in order.
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
						No tools used yet.
					</Text>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>{tediName}'s events</SectionTitle>
						<SectionDescription>
							Everything {tediName} recorded, oldest first.
						</SectionDescription>
					</SectionHeading>
					<Badge variant="secondary">{events.length}</Badge>
				</SectionHeader>
				{events.length ? (
					<Collection aria-label="Delegated events">
						{events.map((event) => (
							<EvidenceRow
								key={event.id}
								title={sentenceCase(event.kind.replaceAll(".", " "))}
								detail={absoluteTime(event.createdAt)}
								tone={event.kind.endsWith(".failed") ? "warning" : "complete"}
							/>
						))}
					</Collection>
				) : (
					<Text role="body" tone="secondary">
						Nothing recorded yet.
					</Text>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Artifacts</SectionTitle>
						<SectionDescription>
							Files and outputs {tediName} saved.
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
						No artifacts saved.
					</Text>
				)}
			</PageSection>
		</>
	);
}

/**
 * A running delegation can be missing from the trace until its first durable
 * event lands; the run row itself still names the branch, so the drawer can
 * show its live activity instead of "not found".
 */
function runBranch(
	run: HomeRun,
	branchId: string,
): { childRunId: string; delegatedTediId: string } | undefined {
	return run.childRunId === branchId && run.delegatedTediId
		? { childRunId: branchId, delegatedTediId: run.delegatedTediId }
		: undefined;
}

export function HomeExecutionDetailView({
	run,
	trace,
	branchId,
	onSelectBranch,
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
	/** Select a delegation in place; without it, rows link to the chat URL. */
	onSelectBranch?: (childRunId: string) => void;
	evidence?: HomeChildRunEvidence;
	evidenceError?: unknown;
	tediNames?: Record<string, string>;
	embedded?: boolean;
	events?: RuntimeStreamEvent[];
	eventsError?: unknown;
}) {
	useOsFormattingPreferences();
	const now = useNow(isActiveRunStatus(run.status));
	const selectedBranch = branchId
		? (trace.branches.find((branch) => branch.childRunId === branchId) ??
			runBranch(run, branchId))
		: undefined;
	const metadata = asRecord(run.metadata);
	const route = asRecord(metadata?.kernelRoute);
	const delegation = asRecord(metadata?.homeDelegation);
	const workOrder = asRecord(delegation?.workOrder);
	const proof = asRecord(metadata?.delegationProof);
	const nameOfTedi = (tediId: string) => tediNames[tediId] ?? DIGITAL_WORKER;
	const nameOfBranch = (childRunId: string) => {
		const branch = trace.branches.find(
			(candidate) => candidate.childRunId === childRunId,
		);
		return branch ? nameOfTedi(branch.delegatedTediId) : "The delegated tedi";
	};
	const selectedTedi = selectedBranch
		? nameOfTedi(selectedBranch.delegatedTediId)
		: null;
	const summary = traceSummary(trace, run.status, nameOfBranch);
	const workItemId = safeText(metadata?.workItemId);

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
	const personalReads = [
		...new Set(
			(events ?? []).flatMap((event) => {
				const read = asRecord(asRecord(event.payload)?.personalAccountRead);
				const notice = safeText(read?.notice);
				return event.kind === "context.injected" && notice ? [notice] : [];
			}),
		),
	];
	const workers = [
		...new Set(
			trace.branches.map((branch) => nameOfTedi(branch.delegatedTediId)),
		),
	];
	if (!workers.length && run.delegatedTediId)
		workers.push(nameOfTedi(run.delegatedTediId));

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
								{run.settledCharge ? (
									<li>
										Delegated run cost{" "}
										<strong>
											{formatSettledEurMicros(run.settledCharge.chargedMicros)}
										</strong>
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
			{personalReads.length ? (
				<PageSection aria-label="Personal accounts used">
					{personalReads.map((notice) => (
						<Text key={notice} role="body">
							{notice}
						</Text>
					))}
				</PageSection>
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
					<dd>
						{toolNames.join(", ") ||
							(trace.branches.some((branch) => branch.toolEventIds.length)
								? "See the delegation's tool activity"
								: events
									? "None used"
									: "Not available yet")}
					</dd>
					<dt className="text-kumo-subtle">Time</dt>
					<dd>{runTime(run, trace, now)}</dd>
					<dt className="text-kumo-subtle">Cost</dt>
					<dd>
						{run.settledCharge
							? `${formatSettledEurMicros(run.settledCharge.chargedMicros)} settled for the delegated run`
							: run.usage?.costUsd != null
								? `$${run.usage.costUsd.toFixed(4)} (Home only)`
								: isActiveRunStatus(run.status)
									? "Counted when it finishes"
									: "Not recorded"}
					</dd>
				</dl>
			</PageSection>
			<Disclosure label="How it ran" defaultOpen={Boolean(branchId)}>
				<div className="space-y-6">
					{branchId && !selectedBranch ? (
						<Alert variant="warning">
							<AlertTitle>Delegation not found</AlertTitle>
							<AlertDescription>
								This delegation is not part of this response.
							</AlertDescription>
						</Alert>
					) : null}

					<PageSection>
						<SectionHeader>
							<SectionHeading>
								<SectionTitle>Execution</SectionTitle>
								<SectionDescription>
									How Home handled this request.
								</SectionDescription>
							</SectionHeading>
						</SectionHeader>
						<Collection aria-label="Execution summary">
							<EvidenceRow title="Home run">
								<CopyableId value={run.id} />
							</EvidenceRow>
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
							{workItemId ? (
								<EvidenceRow title="Work item">
									<CopyableId value={workItemId} />
								</EvidenceRow>
							) : null}
							<EvidenceRow title={summary.title} tone={summary.tone}>
								{summary.notes.length ? (
									<ul className="grid gap-0.5">
										{summary.notes.map((note) => (
											<Text
												key={note}
												as="li"
												role="label"
												tone="secondary"
												className="[overflow-wrap:anywhere]"
											>
												{note}
											</Text>
										))}
									</ul>
								) : null}
							</EvidenceRow>
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
										Select one to see its answer, tools, and artifacts.
									</SectionDescription>
								</SectionHeading>
							</SectionHeader>
							<Collection aria-label="Delegated branches">
								{trace.branches.map((branch) => {
									const selected = branch.childRunId === branchId;
									const label = selected ? "Showing" : "Show details";
									return (
										<li
											key={branch.childRunId}
											className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
										>
											<TreeStructure size={18} className="shrink-0" />
											<span className="flex min-w-0 flex-1 basis-40 flex-col">
												<Text as="strong" weight="medium">
													{nameOfTedi(branch.delegatedTediId)}
												</Text>
												<Text as="span" role="label" tone="secondary">
													{branch.eventIds.length} step
													{branch.eventIds.length === 1 ? "" : "s"} ·{" "}
													{branch.artifactIds.length} artifact
													{branch.artifactIds.length === 1 ? "" : "s"}
												</Text>
											</span>
											<Badge variant={statusVariant(branch.status)}>
												{sentenceCase(branch.status)}
											</Badge>
											{branch.workItemId ? (
												<Link
													to="/work/items/$workItemId"
													params={{ workItemId: branch.workItemId }}
													className="text-kumo-link text-sm"
												>
													Work item
												</Link>
											) : null}
											{onSelectBranch ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													aria-pressed={selected}
													disabled={selected}
													onClick={() => onSelectBranch(branch.childRunId)}
												>
													{label}
												</Button>
											) : (
												<Link
													to="/work/executions/$runId"
													params={{ runId: run.id }}
													search={{ branch: branch.childRunId }}
													aria-current={selected ? "true" : undefined}
													className="inline-flex items-center gap-1 text-kumo-link text-sm"
												>
													{label} <CaretRight size={12} aria-hidden />
												</Link>
											)}
										</li>
									);
								})}
							</Collection>
						</PageSection>
					) : null}

					{selectedBranch && evidence ? (
						<DelegationEvidence
							run={run}
							now={now}
							evidence={evidence}
							tediName={selectedTedi ?? DIGITAL_WORKER}
						/>
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
				</div>
			</Disclosure>
			<Disclosure
				label={`Events${events ? ` (${events.length}${events.length === 100 ? "+" : ""})` : ""}`}
			>
				{eventsError ? (
					<DetailUnavailable resource="Execution events" error={eventsError} />
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
			</Disclosure>
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
	// Branch ids are not always URL-safe UUIDs, so selection lives here; the URL
	// only seeds it.
	const [selectedBranchId, setSelectedBranchId] = useState(branchId);
	useEffect(() => setSelectedBranchId(branchId), [branchId, runId]);
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
	const eventsQuery = useQuery({
		...osQuery.kernelRuntime.readRunEvents.queryOptions({
			input: { runId, limit: 100 },
		}),
		refetchInterval:
			runQuery.data?.run.status &&
			["queued", "running"].includes(runQuery.data.run.status)
				? 5_000
				: false,
	});
	const names = useTediNames();
	// A run that delegated opens on its delegation: that is where the work is.
	const shownBranchId =
		selectedBranchId ?? runQuery.data?.run.childRunId ?? undefined;
	const branch = shownBranchId
		? (traceQuery.data?.trace.branches.find(
				(candidate) => candidate.childRunId === shownBranchId,
			) ??
			(runQuery.data ? runBranch(runQuery.data.run, shownBranchId) : undefined))
		: undefined;
	const evidenceQuery = useQuery({
		...homeChildRunEvidenceQueryOptions(
			branch?.delegatedTediId ?? "",
			branch?.childRunId ?? "",
		),
		enabled: Boolean(branch),
		refetchInterval: (query) =>
			query.state.data?.evidence &&
			isActiveRunStatus(query.state.data.evidence.status)
				? 5_000
				: false,
	});

	const identity = embedded ? null : <HomeRunIdentity runId={runId} />;
	if (runQuery.isError || traceQuery.isError) {
		return (
			<Page width="lg">
				{identity}
				{runQuery.data ? (
					<PageSection aria-label="Saved execution">
						<Text as="h2" weight="medium">
							{executionTitle(branchId)}
						</Text>
						<RunStatusChip status={runQuery.data.run.status} />
						<ChatMarkdown
							content={
								safeText(
									asRecord(runQuery.data.run.metadata)?.childRunPreview,
								) ??
								runQuery.data.run.progress?.detail ??
								"The saved run is available. Its execution trace could not be loaded."
							}
						/>
						<Link
							to="/chat"
							search={{ conversation: runQuery.data.run.conversationId }}
						>
							Back to conversation
						</Link>
					</PageSection>
				) : null}
				{runQuery.isError ? (
					<div className="grid gap-2">
						<DetailUnavailable
							resource="Home execution"
							error={runQuery.error}
							onRetry={() => runQuery.refetch()}
							retrying={runQuery.isFetching}
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
							onRetry={() => traceQuery.refetch()}
							retrying={traceQuery.isFetching}
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
			branchId={shownBranchId}
			onSelectBranch={setSelectedBranchId}
			evidence={evidenceQuery.data?.evidence}
			evidenceError={evidenceQuery.error}
			tediNames={names}
			embedded={embedded}
			events={eventsQuery.data?.events}
			eventsError={eventsQuery.error}
		/>
	);
}
