import {
	ArrowCounterClockwise,
	Brain,
	Check,
	Package,
	Prohibit,
	Scroll,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type {
	SkillWorkflowArtifactSummary,
	SkillWorkflowStep,
} from "@tedix/api-contract/contracts/cognitive";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { RunStatusChip } from "@/components/activity-runs";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Empty, EmptyMedia } from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Collection,
	Page,
	PageActions,
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
	findSkillDefinitionHealth,
	partitionEventGates,
	RunEventGateRow,
	RunReconciliationPanel,
	RunToolCallRow,
} from "@/components/run-trace";
import { CostChip } from "@/components/cost-chip";
import { useRunWebMcpTools } from "@/components/run-webmcp-tools";
import { cn } from "@/lib/utils";
import { osApi } from "@/lib/api";
import { callCostRunReading, queryReading } from "@/lib/cost-reading";
import { formatCount } from "@/lib/format";
import {
	RUN_RATIONALE_LIMIT,
	WORKFLOW_DEFINITIONS_LIMIT,
	osQueryKeys,
	runArtifactsQueryOptions,
	tediCallCostsQueryOptions,
	tediRationaleQueryOptions,
	workflowDefinitionHealthQueryOptions,
	workflowRetryCandidatesQueryOptions,
	workflowRunInspectQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, formatDurationMs } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The call-cost window this surface groups by run. Part of the request, and
 * therefore part of the generated key — it stays a literal so the read and the
 * post-action invalidation address the same cache entry. */
const RUN_COST_PERIOD = "30d";

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * An approval id lives in the waiting wait_for_event step's durable evidence
 * when the workflow author recorded one. This is best-effort extraction — the
 * operator can always paste the id from the run evidence instead.
 */
export function extractApprovalId(step: SkillWorkflowStep): string | null {
	const data = step.data;
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	const direct = record.approvalId;
	if (typeof direct === "string" && direct.length > 0) return direct;
	return null;
}

export function extractWaitEventType(step: SkillWorkflowStep): string | null {
	const data = step.data;
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	return typeof record.eventType === "string" && record.eventType.length > 0
		? record.eventType
		: null;
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function RunStepRow({ step }: { step: SkillWorkflowStep }) {
	const detail: string[] = [step.kind.replace(/_/g, " ")];
	if (step.kind === "tool_call" && step.namespace && step.method) {
		detail.push(`${step.namespace}.${step.method}`);
	}
	if (step.attempt != null && step.attempt > 1) {
		detail.push(`attempt ${step.attempt}`);
	}
	const duration = formatDurationMs(step.durationMs);
	if (duration) detail.push(duration);
	detail.push(step.status ?? step.outcome);
	return (
		<li className="flex min-w-0 items-center gap-3 px-3 py-2">
			<span
				data-outcome={step.outcome}
				aria-hidden
				className={cn(
					"size-2 shrink-0 rounded-full bg-kumo-interact",
					step.outcome === "success" && "bg-kumo-success",
					step.outcome === "failure" && "bg-kumo-danger",
				)}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{step.name}
				</Text>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunArtifactRow({
	artifact,
}: {
	artifact: SkillWorkflowArtifactSummary;
}) {
	const detail = [
		artifact.mimeType,
		formatBytes(artifact.sizeBytes),
		artifact.outcome,
		artifact.storage === "r2" ? "stored in R2" : "inline",
	];
	if (artifact.sha256) detail.push(`sha256 ${artifact.sha256.slice(0, 12)}…`);
	return (
		<li className="flex min-w-0 items-center gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<Package size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{artifact.path}
				</Text>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunRationaleRow({ record }: { record: RationaleRecord }) {
	const detail = [
		record.category,
		`confidence ${Math.round(record.confidence * 100)}%`,
		record.outcomeStatus,
	];
	if (record.workItemId) detail.push(`work item ${record.workItemId}`);
	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<Brain size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{record.action}
				</Text>
				<Text as="span" role="label">
					{record.rationale}
				</Text>
				<Text as="span" role="label" tone="secondary">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunRationaleEmpty({
	runId,
	workItemId,
}: {
	runId: string;
	workItemId: string | null;
}) {
	return (
		<Empty
			appearance="quiet"
			icon={
				<EmptyMedia variant="icon">
					<Scroll size={18} />
				</EmptyMedia>
			}
			title="No rationale records reference this run"
			description={`Rationale is linked from the run record: decisions carry a runId execution link, and none of this tedi's recent records point at run ${runId}${workItemId ? ` (work item ${workItemId})` : ""}.`}
		/>
	);
}

/**
 * Dense operational evidence reads as one collection, not a stack of cards.
 * The shared Kumo Collection owns the single boundary and semantic hairlines;
 * evidence rows provide content and interaction without standalone chrome.
 */
export function RunEvidenceList({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return <Collection aria-label={label}>{children}</Collection>;
}

export function RunDetailSectionHeader({
	title,
	description,
	count,
}: {
	title: string;
	description: string;
	count?: number;
}) {
	return (
		<SectionHeader>
			<SectionHeading>
				<span className="flex flex-wrap items-center gap-2">
					<SectionTitle>{title}</SectionTitle>
					{count !== undefined ? (
						<Badge variant="secondary">{count}</Badge>
					) : null}
				</span>
				<SectionDescription>{description}</SectionDescription>
			</SectionHeading>
		</SectionHeader>
	);
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

export function RunDetailPage() {
	const { runId } = useParams({
		from: "/_session/_tenant/work/runs/$runId",
	});
	const queryClient = useQueryClient();

	// Read-only WebMCP scope bound to this run: an in-page browser agent can
	// explain what this run did through the same canonical reads this page uses.
	useRunWebMcpTools(runId);

	const inspect = useQuery({
		...workflowRunInspectQueryOptions(runId),
		refetchInterval: (query) => {
			const status = query.state.data?.run.status;
			return status && ["queued", "running", "paused"].includes(status)
				? 5_000
				: false;
		},
	});
	const run = inspect.data?.run;
	const priorRunStatus = useRef<string | null>(null);
	const tediId = run?.tediId;

	const artifacts = useQuery(runArtifactsQueryOptions(runId));

	// The contract has no runId filter on rationale reads: records carry the
	// execution link, so list the tedi's recent records and match client-side.
	// The generated key therefore encodes tedi + page size and NOT this run —
	// two runs of one tedi correctly share the entry, and the client-side
	// filter below still narrows to this run.
	const rationale = useQuery({
		...tediRationaleQueryOptions(tediId ?? "", RUN_RATIONALE_LIMIT),
		enabled: Boolean(tediId),
	});

	// Per-run USD comes from tedi_call_costs rows (row.runId); there is no
	// runId input filter, so fetch by tedi + period and group client-side.
	const costs = useQuery({
		...tediCallCostsQueryOptions(tediId ?? "", RUN_COST_PERIOD),
		enabled: Boolean(tediId),
	});

	// Retry eligibility must come from the engine-verified candidate inbox,
	// never inferred from history; restartId is epoch-bound.
	const retryCandidates = useQuery({
		...workflowRetryCandidatesQueryOptions(),
		enabled: run?.status === "failed",
	});
	const retryCandidate = retryCandidates.data?.candidates.find(
		(candidate) => candidate.runId === runId,
	);

	// Reconciliation evidence for the definition this run executes: drift
	// against the current revision and whether the execution surface is even
	// reachable. Skills and Triggers issue the identical request through the
	// same factory, so the generated key makes all three one fetch — and keeps
	// Triggers' post-run-now invalidation reaching this chip.
	const definitionHealth = useQuery({
		...workflowDefinitionHealthQueryOptions(WORKFLOW_DEFINITIONS_LIMIT),
		staleTime: 60_000,
	});

	// Every read this surface refreshes after an operator action is its own
	// generated cache entry, so each one is named explicitly. A single
	// hand-written `["os-run", runId]` prefix used to stand here and had
	// already stopped reaching `inspect` once that read moved to a generated
	// key — the status and step list kept rendering the pre-action snapshot.
	const invalidateRun = () => {
		void queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
		void queryClient.invalidateQueries({
			queryKey: workflowRunInspectQueryOptions(runId).queryKey,
		});
		void queryClient.invalidateQueries({
			queryKey: runArtifactsQueryOptions(runId).queryKey,
		});
		if (tediId) {
			void queryClient.invalidateQueries({
				queryKey: tediRationaleQueryOptions(tediId, RUN_RATIONALE_LIMIT)
					.queryKey,
			});
			void queryClient.invalidateQueries({
				queryKey: tediCallCostsQueryOptions(tediId, RUN_COST_PERIOD).queryKey,
			});
		}
		void queryClient.invalidateQueries({
			queryKey: workflowRetryCandidatesQueryOptions().queryKey,
		});
		void queryClient.invalidateQueries({
			queryKey: workflowDefinitionHealthQueryOptions(WORKFLOW_DEFINITIONS_LIMIT)
				.queryKey,
		});
	};
	useEffect(() => {
		const status = run?.status ?? null;
		const previous = priorRunStatus.current;
		priorRunStatus.current = status;
		if (
			previous &&
			["queued", "running", "paused"].includes(previous) &&
			status &&
			!["queued", "running", "paused"].includes(status)
		) {
			invalidateRun();
		}
	}, [run?.status]);

	const cancelRun = useMutation({
		mutationFn: () =>
			osApi.skills.runWorkflowCancel({
				runId,
				confirmDestructive: true,
				reason: "Canceled by the operator from the Tedix OS run detail surface",
			}),
		onSettled: invalidateRun,
	});
	const retryRun = useMutation({
		mutationFn: (restartId: string) =>
			osApi.skills.restartWorkflow({
				runId,
				restartId,
				confirmDestructive: true,
				reason: "Operator retry from the Tedix OS run detail surface",
			}),
		onSettled: invalidateRun,
	});
	const approveRun = useMutation({
		mutationFn: (approvalId: string) =>
			osApi.skills.approveWorkflow({
				runId,
				approvalId,
				confirmDestructive: true,
				reason: "Approved by the operator from the Tedix OS run detail surface",
			}),
		onSettled: invalidateRun,
	});
	const rejectRun = useMutation({
		mutationFn: (approvalId: string) =>
			osApi.skills.rejectWorkflow({
				runId,
				approvalId,
				confirmDestructive: true,
				reason: "Rejected by the operator from the Tedix OS run detail surface",
			}),
		onSettled: invalidateRun,
	});
	const sendEvent = useMutation({
		mutationFn: (input: { type: string; payload: Record<string, unknown> }) =>
			osApi.skills.runWorkflowSendEvent({
				runId,
				type: input.type,
				payload: input.payload,
				confirmDestructive: true,
				reason: "Operator response from the Tedix OS run detail surface",
			}),
		onSettled: invalidateRun,
	});

	const eventGates = partitionEventGates(inspect.data?.steps ?? []);
	const waitingGates = eventGates.waiting;
	const [approvalIdInput, setApprovalIdInput] = useState<string | null>(null);
	const [eventTypeInput, setEventTypeInput] = useState<string | null>(null);
	const [eventPayloadInput, setEventPayloadInput] = useState("{}");
	const [eventPayloadError, setEventPayloadError] = useState<string | null>(
		null,
	);
	const approvalId =
		approvalIdInput ??
		(waitingGates[0] ? extractApprovalId(waitingGates[0]) : null) ??
		"";
	const eventType =
		eventTypeInput ??
		(waitingGates[0] ? extractWaitEventType(waitingGates[0]) : null) ??
		"";

	const runRationale = (rationale.data?.data ?? []).filter(
		(record) => record.runId === runId,
	);
	const runCostRows = (costs.data?.costs ?? []).filter(
		(row) => row.runId === runId,
	);
	// The SAME classifier the run chip on the list uses. Summing every row here
	// — quarantined ones included — into a bare `$` figure made this page and the
	// chip that links to it disagree: the chip excluded held-out rows and said
	// "quarantined", while this page priced them and printed a total.
	// `no_attribution_path`, matching the runs list: no cost row ever carries a
	// `skill_runs.id`, so an empty filter here is a missing join rather than a
	// ledger consulted and found empty.
	const runCostReading =
		queryReading(costs) ??
		callCostRunReading(runCostRows, { emptyReason: "no_attribution_path" });
	const runTokens = runCostRows.reduce(
		(total, row) => total + row.totalTokens,
		0,
	);

	const cancelable =
		run != null && ["queued", "running", "paused"].includes(run.status);
	const mutationError = [
		cancelRun,
		retryRun,
		approveRun,
		rejectRun,
		sendEvent,
	].find((mutation) => mutation.isError)?.error;

	return (
		<Page width="lg">
			<PageBack render={<Link to="/" />}>Activity</PageBack>

			{inspect.isPending && (
				<div className="grid gap-2" aria-hidden>
					<Skeleton className="h-24" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
				</div>
			)}
			{/* The not-found verdict for this route lives here, not in a loader:
			    only a settled NOT_FOUND says the run is gone. */}
			{inspect.isError && (
				<DetailUnavailable resource="Run" error={inspect.error} />
			)}

			{inspect.data && run && (
				<>
					<PageHeader>
						<PageHeading>
							<PageTitle>
								{inspect.data.revision.skillSlug ?? run.skillId}
							</PageTitle>
							<PageMeta className="gap-x-5">
								<li>
									<RunStatusChip status={run.status} />
								</li>
								<li>
									Actor <strong>{run.createdBy ?? "unattributed"}</strong> ·
									tedi <strong>{run.tediId}</strong>
								</li>
								{run.startedAt && (
									<li>
										Started{" "}
										<strong>
											<time dateTime={run.startedAt}>
												{absoluteTime(run.startedAt)}
											</time>
										</strong>
									</li>
								)}
								{run.completedAt && (
									<li>
										Finished{" "}
										<strong>
											<time dateTime={run.completedAt}>
												{absoluteTime(run.completedAt)}
											</time>
										</strong>
									</li>
								)}
								{run.workItemId && (
									<li>
										Work item <strong>{run.workItemId}</strong>
									</li>
								)}
							</PageMeta>
						</PageHeading>
						<PageActions>
							{run.status === "failed" && (
								<AlertDialog>
									<AlertDialogTrigger
										render={
											<Button
												variant="outline"
												icon={<ArrowCounterClockwise size={15} />}
												disabled={!retryCandidate || retryRun.isPending}
												title={
													retryCandidate
														? "Retry in a new execution epoch"
														: "No engine-verified retry candidate"
												}
											/>
										}
									>
										Retry
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												Retry this failed run?
											</AlertDialogTitle>
											<AlertDialogDescription>
												This uses the engine-verified retry token and starts a
												new execution epoch. It does not generically restart an
												arbitrary run.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Keep failed</AlertDialogCancel>
											<AlertDialogAction
												onClick={() =>
													retryCandidate &&
													retryRun.mutate(retryCandidate.restartId)
												}
											>
												Retry run
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
							{cancelable && (
								<AlertDialog>
									<AlertDialogTrigger
										render={
											<Button
												variant="destructive"
												icon={<Prohibit size={15} />}
												disabled={cancelRun.isPending}
											/>
										}
									>
										Cancel
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Cancel this run?</AlertDialogTitle>
											<AlertDialogDescription>
												The durable workflow will be asked to stop. Its final
												terminal status may take a moment to arrive.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Keep running</AlertDialogCancel>
											<AlertDialogAction
												variant="destructive"
												onClick={() => cancelRun.mutate()}
											>
												Cancel run
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
						</PageActions>
					</PageHeader>

					{mutationError != null && (
						<p className="text-kumo-danger text-sm" role="alert">
							{(mutationError as Error).message}
						</p>
					)}

					{run.error && (
						<Alert variant="destructive">
							<AlertTitle>Run error</AlertTitle>
							<AlertDescription>{run.error}</AlertDescription>
						</Alert>
					)}

					{waitingGates.length > 0 && (
						<Card size="sm">
							<CardHeader>
								<CardTitle>
									Waiting on{" "}
									{extractWaitEventType(waitingGates[0]!) ?? "an event"} —{" "}
									{waitingGates[0]!.name}
								</CardTitle>
								<CardDescription>
									{approvalId
										? "Approve or reject with the approval id recorded in the gate evidence."
										: "Send the event this non-approval gate is waiting for. The payload must be a JSON object."}
								</CardDescription>
							</CardHeader>
							<CardContent>
								{approvalId ? (
									<div className="flex flex-wrap items-center gap-2">
										<Input
											aria-label="Approval id"
											placeholder="approval id"
											className="max-w-64"
											value={approvalId}
											onChange={(event) =>
												setApprovalIdInput(event.target.value)
											}
										/>
										<Button
											size="sm"
											icon={<Check size={15} />}
											disabled={approvalId.length === 0 || approveRun.isPending}
											onClick={() => approveRun.mutate(approvalId)}
										>
											Approve
										</Button>
										<Button
											size="sm"
											variant="destructive"
											icon={<X size={15} />}
											disabled={approvalId.length === 0 || rejectRun.isPending}
											onClick={() => rejectRun.mutate(approvalId)}
										>
											Reject
										</Button>
									</div>
								) : (
									<div className="grid max-w-xl gap-2">
										<Input
											aria-label="Event type"
											placeholder="event type"
											value={eventType}
											onChange={(event) =>
												setEventTypeInput(event.target.value)
											}
										/>
										<Input
											aria-label="Event payload"
											placeholder="{}"
											value={eventPayloadInput}
											onChange={(event) => {
												setEventPayloadInput(event.target.value);
												setEventPayloadError(null);
											}}
										/>
										{eventPayloadError ? (
											<p className="m-0 text-kumo-danger text-xs" role="alert">
												{eventPayloadError}
											</p>
										) : null}
										<AlertDialog>
											<AlertDialogTrigger
												render={
													<Button
														size="sm"
														className="w-fit"
														disabled={
															eventType.length === 0 || sendEvent.isPending
														}
													/>
												}
											>
												Review event
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														Send this workflow event?
													</AlertDialogTitle>
													<AlertDialogDescription>
														The event is non-idempotent. Confirm type{" "}
														<strong>{eventType}</strong> with payload{" "}
														<code>{eventPayloadInput}</code>.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>Go back</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => {
															try {
																const parsed: unknown =
																	JSON.parse(eventPayloadInput);
																if (
																	!parsed ||
																	typeof parsed !== "object" ||
																	Array.isArray(parsed)
																)
																	throw new Error(
																		"Event payload must be a JSON object.",
																	);
																setEventPayloadError(null);
																sendEvent.mutate({
																	type: eventType,
																	payload: parsed as Record<string, unknown>,
																});
															} catch (error) {
																setEventPayloadError(
																	error instanceof Error
																		? error.message
																		: "Invalid event payload.",
																);
															}
														}}
													>
														Send event
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									</div>
								)}
							</CardContent>
						</Card>
					)}

					{inspect.data.warnings.length > 0 && (
						<Alert variant="warning">
							<AlertTitle>Run warnings</AlertTitle>
							<AlertDescription>
								<ul className="m-0 list-disc pl-4">
									{inspect.data.warnings.map((warning) => (
										<li key={warning}>{warning}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					)}

					<PageSection>
						<RunDetailSectionHeader
							title="Cloudflare execution"
							description="Engine binding, reconciliation, definition drift, and engine evidence."
						/>
						<RunReconciliationPanel
							run={run}
							definitionHealth={
								definitionHealth.data
									? findSkillDefinitionHealth(
											definitionHealth.data.health,
											run.skillId,
										)
									: undefined
							}
							definitionEvidenceTruncated={
								definitionHealth.data?.truncated ?? false
							}
						/>
						{definitionHealth.isError && (
							<p className="text-kumo-subtle text-xs" role="alert">
								Workflow definition health is unavailable, so no drift or
								execution-surface evidence is shown:{" "}
								{(definitionHealth.error as Error).message}
							</p>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Steps"
							description="Step receipts in execution order."
							count={inspect.data.steps.length}
						/>
						{inspect.data.steps.length === 0 ? (
							<Text role="body" tone="secondary">
								No durable step evidence was recorded for this run yet.
							</Text>
						) : (
							<RunEvidenceList label="Steps">
								{inspect.data.steps.map((step) => (
									<RunStepRow
										key={`${step.path}:${step.executionEpoch}:${step.count}`}
										step={step}
									/>
								))}
							</RunEvidenceList>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Tool calls"
							description="Governed MCP invocations and their provider receipts."
							count={inspect.data.toolCalls.length}
						/>
						{inspect.data.toolCalls.length === 0 ? (
							<Text role="body" tone="secondary">
								This run made no governed MCP tool calls.
							</Text>
						) : (
							<RunEvidenceList label="Governed tool calls">
								{inspect.data.toolCalls.map((call) => (
									<RunToolCallRow
										key={`${call.path}:${call.executionEpoch}:${call.count}`}
										call={call}
									/>
								))}
							</RunEvidenceList>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Event gates"
							description="Suspension points and durable external-event evidence."
							count={eventGates.waiting.length + eventGates.resolved.length}
						/>
						{eventGates.waiting.length + eventGates.resolved.length === 0 ? (
							<Text role="body" tone="secondary">
								This run never suspended on a waitForEvent gate.
							</Text>
						) : (
							<RunEvidenceList label="Event gates">
								{[...eventGates.waiting, ...eventGates.resolved].map((step) => (
									<RunEventGateRow
										key={`${step.path}:${step.executionEpoch}:${step.count}`}
										step={step}
									/>
								))}
							</RunEvidenceList>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Artifacts"
							description="Persisted output and integrity evidence produced by the run."
							count={artifacts.data?.artifacts.length}
						/>
						{artifacts.isPending && (
							<Text role="body" tone="secondary">
								Loading artifacts…
							</Text>
						)}
						{artifacts.isError && (
							<p className="text-kumo-danger text-sm" role="alert">
								{(artifacts.error as Error).message}
							</p>
						)}
						{artifacts.data && artifacts.data.artifacts.length === 0 && (
							<Text role="body" tone="secondary">
								This run produced no evidence artifacts.
							</Text>
						)}
						{artifacts.data && artifacts.data.artifacts.length > 0 && (
							<RunEvidenceList label="Run artifacts">
								{artifacts.data.artifacts.map((artifact) => (
									<RunArtifactRow
										key={`${artifact.path}:${artifact.attempt}`}
										artifact={artifact}
									/>
								))}
							</RunEvidenceList>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Rationale"
							description="Decision records explicitly linked to this execution."
							count={runRationale.length}
						/>
						{rationale.isPending && (
							<Text role="body" tone="secondary">
								Loading rationale…
							</Text>
						)}
						{rationale.isError && (
							<p className="text-kumo-danger text-sm" role="alert">
								{(rationale.error as Error).message}
							</p>
						)}
						{rationale.data && runRationale.length > 0 && (
							<RunEvidenceList label="Run rationale">
								{runRationale.map((record) => (
									<RunRationaleRow key={record.id} record={record} />
								))}
							</RunEvidenceList>
						)}
						{rationale.data && runRationale.length === 0 && (
							<RunRationaleEmpty
								runId={runId}
								workItemId={run.workItemId ?? null}
							/>
						)}
					</PageSection>

					<PageSection>
						<RunDetailSectionHeader
							title="Costs"
							description="Recorded execution totals and attributable ledger evidence."
						/>
						{run.costSummary == null && runCostRows.length === 0 ? (
							<Text role="body" tone="secondary">
								No cost evidence was recorded for this run.
							</Text>
						) : (
							<MetricGrid
								aria-label="Run cost summary"
								appearance="bounded"
								columns={6}
							>
								{run.costSummary && (
									<>
										<MetricItem label="Steps" value={run.costSummary.steps} />
										<MetricItem
											label="Tool calls"
											value={run.costSummary.toolCalls}
										/>
										<MetricItem
											label="Retries"
											value={run.costSummary.retries}
										/>
										{formatDurationMs(run.costSummary.wallMs) && (
											<MetricItem
												label="Wall time"
												value={formatDurationMs(run.costSummary.wallMs)}
											/>
										)}
									</>
								)}
								{runCostRows.length > 0 && (
									<>
										<MetricItem
											label="Cost"
											value={
												<CostChip
													reading={runCostReading}
													subject="Ledger cost attributed to this run"
												/>
											}
										/>
										<MetricItem label="Tokens" value={formatCount(runTokens)} />
									</>
								)}
							</MetricGrid>
						)}
					</PageSection>
				</>
			)}
		</Page>
	);
}
