import {
	ArrowSquareOut,
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
import { sentenceCase } from "@/lib/format";
import {
	homeChildRunEvidenceQueryOptions,
	homeRunQueryOptions,
	homeRunTraceQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, formatDurationMs } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { ArtifactReleaseReview } from "@/components/artifact-release-review";
import { useTediNames } from "@/lib/use-tedi-names";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

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
							const payload = record(event.payload);
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
}: {
	run: HomeRun;
	trace: HomeRunTrace;
	branchId?: string;
	evidence?: HomeChildRunEvidence;
	evidenceError?: unknown;
	tediNames?: Record<string, string>;
}) {
	const selectedBranch = branchId
		? trace.branches.find((branch) => branch.childRunId === branchId)
		: undefined;
	const metadata = record(run.metadata);
	const route = record(metadata?.kernelRoute);
	const delegation = record(metadata?.homeDelegation);
	const workOrder = record(delegation?.workOrder);
	const proof = record(metadata?.delegationProof);
	const selectedTedi = selectedBranch
		? (tediNames[selectedBranch.delegatedTediId] ?? "Digital worker")
		: null;

	return (
		<Page width="lg">
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
								{run.startedAt ? absoluteTime(run.startedAt) : "not recorded"}
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
							title={safeText(workOrder.objective) ?? "Delegated work order"}
							detail={safeText(workOrder.outputContract)}
						/>
					) : null}
					{safeText(metadata?.workItemId) ? (
						<EvidenceRow
							title="Governed Work Item"
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
									to="/work/executions/$runId"
									params={{ runId: run.id }}
									search={{ branch: branch.childRunId }}
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
				<div className="grid gap-2" aria-label="Loading delegation evidence">
					<Skeleton className="h-20" />
					<Skeleton className="h-32" />
				</div>
			) : null}
		</Page>
	);
}

export function HomeExecutionDetailPage({
	runId,
	branchId,
}: {
	runId: string;
	branchId?: string;
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

	if (runQuery.isPending || traceQuery.isPending) {
		return (
			<Page width="lg">
				<div className="grid gap-2" aria-label="Loading Home execution">
					<Skeleton className="h-24" />
					<Skeleton className="h-32" />
					<Skeleton className="h-32" />
				</div>
			</Page>
		);
	}
	if (runQuery.isError) {
		return (
			<Page width="lg">
				<DetailUnavailable resource="Home execution" error={runQuery.error} />
			</Page>
		);
	}
	if (traceQuery.isError) {
		return (
			<Page width="lg">
				<DetailUnavailable
					resource="Execution trace"
					error={traceQuery.error}
				/>
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
		/>
	);
}
