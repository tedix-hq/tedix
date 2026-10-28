import {
	ArrowCounterClockwise,
	Check,
	Prohibit,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { SkillWorkflowStep } from "@tedix/api-contract/contracts/cognitive";
import { useEffect, useRef, useState } from "react";
import { RunStatusChip } from "@/components/activity-runs";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import {
	Page,
	PageActions,
	PageBack,
	PageHeader,
	PageHeading,
	PageMeta,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { partitionEventGates } from "@/components/run-trace";
import {
	RunCostsSection,
	RunErrorAlert,
	RunEvidenceSections,
	RunTechnicalSection,
} from "@/components/run-detail-sections";
import { useRunWebMcpTools } from "@/components/run-webmcp-tools";
import { RunTimeline } from "@/components/run-timeline";
import { readableField } from "@/lib/run-step-content";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences } from "@/lib/format";
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
import { absoluteTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useTediNames } from "@/lib/use-tedi-names";

/** The call-cost window this surface groups by run. Part of the request, and
 * therefore part of the generated key — it stays a literal so the read and the
 * post-action invalidation address the same cache entry. */
const RUN_COST_PERIOD = "30d";

export function extractGateField(
	step: SkillWorkflowStep,
	field: "approvalId" | "eventType",
): string | null {
	const data = step.data;
	if (!data || typeof data !== "object") return null;
	const value = (data as Record<string, unknown>)[field];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function RunDetailPage() {
	useOsFormattingPreferences();
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
	const tediNames = useTediNames();
	const skillLabel = inspect.data?.revision.skillSlug ?? run?.skillId;
	useDocumentTitle(skillLabel ? `${skillLabel} · Run` : "Run");

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
	const connectionGate = waitingGates.find(
		(gate) => gate.connectionRecovery,
	)?.connectionRecovery;
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
			{run ? (
				<PageBack
					render={
						<Link
							to="/skills/$skillId/runs"
							params={{ skillId: run.skillId }}
						/>
					}
				>
					Run history
				</PageBack>
			) : (
				<PageBack render={<Link to="/" />}>Activity</PageBack>
			)}

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
				<DetailUnavailable
					resource="Run"
					error={inspect.error}
					onRetry={() => inspect.refetch()}
					retrying={inspect.isFetching}
				/>
			)}

			{inspect.data && run && (
				<>
					<PageHeader>
						<PageHeading>
							<PageTitle>
								{inspect.data.revision.skillSlug
									? readableField(inspect.data.revision.skillSlug)
									: "Workflow run"}
							</PageTitle>
							<PageMeta className="gap-x-5">
								<li>
									<RunStatusChip status={run.status} />
								</li>
								<li>
									{run.createdBy === "schedule"
										? "Scheduled run"
										: "Started on request"}{" "}
									· <strong>{tediNames[run.tediId] ?? "Assistant"}</strong>
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
												The automation will be asked to stop. Its final terminal
												status may take a moment to arrive.
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
						<Alert variant="destructive">
							<AlertDescription>
								{(mutationError as Error).message}
							</AlertDescription>
						</Alert>
					)}

					{run.error && <RunErrorAlert error={run.error} />}

					{connectionGate && (
						<ConnectionRecoveryNotice
							gate={connectionGate}
							checking={sendEvent.isPending}
							onContinue={() =>
								sendEvent.mutate({
									type: connectionGate.eventType,
									payload: {},
								})
							}
						/>
					)}
					{waitingGates[0] && !connectionGate && (
						<RunWaitingGate
							gate={waitingGates[0]}
							approveRun={approveRun}
							rejectRun={rejectRun}
							sendEvent={sendEvent}
						/>
					)}

					{inspect.data.warnings.length > 0 && (
						<Alert variant="warning">
							<AlertTitle>Run notes</AlertTitle>
							<AlertDescription>
								<Text as="p">
									Some records need attention. Select a step to load its saved
									result, or open the recording details below.
								</Text>
								<Collapsible>
									<CollapsibleTrigger>Recording details</CollapsibleTrigger>
									<CollapsibleContent>
										<ul className="m-0 list-disc pl-4">
											{inspect.data.warnings.map((warning) => (
												<li key={warning}>{warning}</li>
											))}
										</ul>
									</CollapsibleContent>
								</Collapsible>
							</AlertDescription>
						</Alert>
					)}

					<RunTimeline runId={runId} />
					<Collapsible>
						<CollapsibleTrigger>Step list and evidence</CollapsibleTrigger>
						<CollapsibleContent className="grid gap-6">
							<RunEvidenceSections
								inspection={inspect.data}
								artifacts={artifacts}
								rationale={rationale}
							/>
						</CollapsibleContent>
					</Collapsible>
					<RunCostsSection run={run} costs={costs} />
					<RunTechnicalSection run={run} definitionHealth={definitionHealth} />
				</>
			)}
		</Page>
	);
}

export function ConnectionRecoveryNotice({
	gate,
	checking,
	onContinue,
}: {
	gate: NonNullable<SkillWorkflowStep["connectionRecovery"]>;
	checking: boolean;
	onContinue: () => void;
}) {
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Reconnect the selected account</CardTitle>
				<CardDescription>
					This operation has not run. Earlier completed steps are preserved.
					Reconnect the same account, then check it before continuing.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-wrap gap-2">
					<Button
						render={
							<a
								href={
									gate.recovery.scope === "user"
										? "/account/connections"
										: "/admin/connections"
								}
							/>
						}
					>
						Open connections
					</Button>
					<Button disabled={checking} onClick={onContinue}>
						Check connection and continue
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function RunWaitingGate({
	gate,
	approveRun,
	rejectRun,
	sendEvent,
}: {
	gate: SkillWorkflowStep;
	approveRun: { isPending: boolean; mutate: (id: string) => void };
	rejectRun: { isPending: boolean; mutate: (id: string) => void };
	sendEvent: {
		isPending: boolean;
		mutate: (input: { type: string; payload: Record<string, unknown> }) => void;
	};
}) {
	const [approvalIdInput, setApprovalIdInput] = useState<string | null>(null);
	const [eventTypeInput, setEventTypeInput] = useState<string | null>(null);
	const [eventPayloadInput, setEventPayloadInput] = useState("{}");
	const [eventPayloadError, setEventPayloadError] = useState<string | null>(
		null,
	);
	const approvalId =
		approvalIdInput ?? extractGateField(gate, "approvalId") ?? "";
	const eventType = eventTypeInput ?? extractGateField(gate, "eventType") ?? "";

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					Waiting on {extractGateField(gate, "eventType") ?? "an event"} —{" "}
					{gate.name}
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
							onChange={(event) => setApprovalIdInput(event.target.value)}
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
							onChange={(event) => setEventTypeInput(event.target.value)}
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
							<Text
								as="p"
								role="label"
								tone="error"
								aria-live="polite"
								className="m-0"
							>
								{eventPayloadError}
							</Text>
						) : null}
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button
										size="sm"
										className="w-fit"
										disabled={eventType.length === 0 || sendEvent.isPending}
									/>
								}
							>
								Review event
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Send this event to the automation?
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
												const parsed: unknown = JSON.parse(eventPayloadInput);
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
	);
}
