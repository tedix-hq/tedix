import { CaretRight, Check, Robot, Warning } from "@phosphor-icons/react";
import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { useQuery } from "@tanstack/react-query";
import {
	type ComponentType,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react";
import { Button, buttonVariants } from "@/components/kumo/button";
import { Label } from "@/components/kumo/label";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { ChatCard } from "@/components/workspace-chat-card";
import {
	useWorkItemRun,
	type WorkRunAttempt,
	WorkRunEntryRow,
	workRunEntries,
	workRunStatus,
	WorkRunStopConfirm,
} from "@/components/work-item-run";
import type { AgentRunRef } from "@/lib/agent-run-result";
import { useOsFormattingPreferences } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import { osQuery } from "@/lib/os-query-options";
import { pollingBackoff } from "@/lib/polling-backoff";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { OS_COPY } from "@/shared/os-copy";

/** Steps shown before "Show all": the newest ones. */
const COMPACT_STEPS = 8;
/** A runner usually picks a run up within a minute or two. */
const PICK_UP_MS = 5 * 60_000;
/** A runner reports every two minutes; two missed reports mean it stopped. */
const SILENT_MS = 4 * 60_000;

function forHowLong(ms: number): string {
	const minutes = Math.max(1, Math.floor(ms / 60_000));
	if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
}

/** No runner has taken the run: how long it has waited, once that is long. */
function notPickedUp(requestedAt: string | undefined, now: number): string {
	const waited = requestedAt ? now - Date.parse(requestedAt) : Number.NaN;
	return waited > PICK_UP_MS
		? `No runner has picked this up for ${forHowLong(waited)}`
		: "Waiting for an agent to pick it up";
}

/** A run with no outcome whose runner has not reported for too long. */
function stoppedResponding(
	attempt: WorkRunAttempt | undefined,
	lastStepAt: number | undefined,
	now: number,
): string | null {
	const heard = Math.max(
		Date.parse(attempt?.heartbeatAt ?? attempt?.startedAt ?? "") || 0,
		lastStepAt ?? 0,
	);
	if (!attempt || attempt.outcome || !heard || now - heard <= SILENT_MS)
		return null;
	return `The runner stopped responding ${forHowLong(now - heard)} ago`;
}

export type AgentRunTaskLinkProps = {
	to: "/work/items/$workItemId";
	params: { workItemId: string };
	className?: string;
	children?: ReactNode;
};
const DefaultTaskLink: ComponentType<AgentRunTaskLinkProps> = OsRouterLink;

function executorLabel(executor: string): string | null {
	const labels: Record<string, string> = OS_COPY.feed.actors;
	return Object.hasOwn(labels, executor) ? (labels[executor] ?? null) : null;
}

/**
 * A run a tedi started for an agent, in the chat: what it is for, who runs
 * it, where it stands and its newest steps. Ordinary follow-ups go through
 * the tedi. The person can interrupt, stop or answer directly on the card.
 */
export function AgentRunCardView({
	agentRun,
	run,
	failed = false,
	attempt,
	viewerId,
	ownMessageIds,
	answering = false,
	onInterrupt,
	onStop,
	stopping = false,
	stopError,
	permissionHold,
	children,
	LinkComponent = DefaultTaskLink,
}: {
	agentRun: AgentRunRef;
	/** Missing while the first read is under way. */
	run?: ListWorkAttemptStepsResult;
	/** The run could not be read. */
	failed?: boolean;
	attempt?: WorkRunAttempt;
	viewerId?: string;
	ownMessageIds?: ReadonlySet<string>;
	answering?: boolean;
	onInterrupt?: (input: {
		body: string;
		attemptId: string;
		interrupt: true;
	}) => Promise<unknown>;
	onStop?: () => Promise<unknown>;
	stopping?: boolean;
	stopError?: unknown;
	permissionHold?: string;
	children?: ReactNode;
	LinkComponent?: ComponentType<AgentRunTaskLinkProps>;
}) {
	useOsFormattingPreferences();
	const [showAll, setShowAll] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);
	const [interruptAttemptId, setInterruptAttemptId] = useState<string>();
	const [interruptDraft, setInterruptDraft] = useState("");
	const [interruptError, setInterruptError] = useState<string>();
	const interruptFieldId = useId();
	const live = run?.live ?? false;
	const waiting = Boolean(run && !run.live && run.steps.length === 0);
	// A run nobody picked up is not live, yet its wait keeps growing: check
	// it once a minute so an open tab says so without a reload.
	const now = useNow(live || (waiting && !attempt), live ? 1_000 : 60_000);
	const steps = run?.steps;
	const messages = run?.messages;
	const launch = steps?.findLast((step) => step.kind === "started");
	const entries = useMemo(
		() =>
			workRunEntries({
				steps: steps?.filter((step) => step !== launch) ?? [],
				messages: messages ?? [],
			}),
		[steps, messages, launch],
	);
	const executor = executorLabel(agentRun.executor);
	const status = failed
		? "The run could not be loaded. Open the task to see it."
		: !run
			? "Loading the run…"
			: waiting && !attempt
				? permissionHold
					? "Waiting for your permission. Open the task to review and answer the request."
					: notPickedUp(agentRun.requestedAt, now)
				: (stoppedResponding(attempt, run.steps.at(-1)?.at, now) ??
					workRunStatus(run, attempt, undefined, new Date(now)));
	const stopRequested = Boolean(
		messages?.some((message) => message.kind === "stop"),
	);
	const hidden = showAll ? 0 : Math.max(0, entries.length - COMPACT_STEPS);
	const visible = hidden ? entries.slice(hidden) : entries;
	const title = agentRun.title || "Agent run";
	const outcome = attempt?.outcome;
	const canInterrupt = live && !stopRequested && run?.attemptId;
	const composingInterrupt =
		canInterrupt && canInterrupt === interruptAttemptId;

	return (
		<li
			data-slot="agent-run-card"
			data-run-live={live}
			className="flex w-full min-w-0 justify-start"
		>
			<ChatCard
				aria-label={`Agent run: ${title}`}
				className="max-w-[860px] flex-1"
				icon={
					live ? (
						<Loader aria-label="Run in progress" size={15} />
					) : failed || outcome === "failed" ? (
						<Warning size={15} className="text-kumo-warning" />
					) : outcome === "succeeded" ? (
						<Check size={15} className="text-kumo-success" />
					) : (
						<Robot size={15} />
					)
				}
				title={title}
				meta={
					<>
						{executor ? (
							<span data-slot="agent-run-executor">{executor} · </span>
						) : null}
						<span role="status" data-slot="agent-run-status">
							{status}
						</span>
						{launch ? (
							<span className="block [overflow-wrap:anywhere]">
								{launch.text}
							</span>
						) : null}
					</>
				}
			>
				{children}
				{waiting && !attempt && permissionHold ? (
					<Text as="p" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
						{permissionHold}
					</Text>
				) : null}
				{hidden ? (
					<div>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() => setShowAll(true)}
						>
							Show all {entries.length} steps
						</Button>
					</div>
				) : null}
				{visible.length ? (
					<ul
						aria-label="Run steps"
						tabIndex={showAll ? 0 : undefined}
						// The newest eight always show in full; the whole run scrolls.
						className={cn(
							"m-0 block list-none border-kumo-hairline border-t p-0 pt-2 [&>li+li]:mt-2",
							showAll && "max-h-96 overflow-y-auto",
						)}
					>
						{visible.map((entry) => (
							<WorkRunEntryRow
								key={entry.key}
								at={entry.at}
								step={"step" in entry ? entry.step : undefined}
								message={"message" in entry ? entry.message : undefined}
								live={live}
								ownMessageIds={ownMessageIds}
								viewerId={viewerId}
							/>
						))}
					</ul>
				) : null}
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{/* Link-styled, but a real link: Button would announce it as a
					    button (role="button") although it navigates. */}
					<LinkComponent
						to="/work/items/$workItemId"
						params={{ workItemId: agentRun.workItemId }}
						className={buttonVariants({ variant: "link", size: "sm" })}
					>
						Open task
						<CaretRight size={11} aria-hidden />
					</LinkComponent>
					{canInterrupt && onInterrupt && !composingInterrupt ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-controls={interruptFieldId}
							className="ml-auto"
							onClick={() => {
								setInterruptAttemptId(canInterrupt);
								setInterruptDraft("");
								setInterruptError(undefined);
							}}
						>
							Interrupt
						</Button>
					) : null}
					{live ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className={
								canInterrupt && onInterrupt && !composingInterrupt
									? undefined
									: "ml-auto"
							}
							disabled={stopRequested}
							onClick={() => setConfirmStop(true)}
						>
							{stopRequested ? "Stop requested" : "Stop run"}
						</Button>
					) : null}
				</div>
				{composingInterrupt && onInterrupt ? (
					<form
						className="grid gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const body = interruptDraft.trim();
							if (!body || answering) return;
							setInterruptError(undefined);
							void onInterrupt({
								body,
								attemptId: canInterrupt,
								interrupt: true,
							}).then(
								() => setInterruptAttemptId(undefined),
								(error: unknown) =>
									setInterruptError(
										errorMessage(error, "The interrupt could not be sent."),
									),
							);
						}}
					>
						<Label htmlFor={interruptFieldId}>Send an urgent follow-up</Label>
						<Textarea
							id={interruptFieldId}
							autoFocus
							value={interruptDraft}
							onChange={(event) => setInterruptDraft(event.target.value)}
							maxLength={4000}
							disabled={answering}
						/>
						{interruptError ? (
							<p role="alert" className="m-0">
								{interruptError}
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Button
								type="submit"
								size="sm"
								disabled={!interruptDraft.trim() || answering}
							>
								{answering ? "Sending…" : "Interrupt and send"}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={answering}
								onClick={() => setInterruptAttemptId(undefined)}
							>
								Cancel
							</Button>
						</div>
					</form>
				) : null}
				<WorkRunStopConfirm
					open={confirmStop}
					onOpenChange={setConfirmStop}
					onStop={onStop}
					stopping={stopping}
					stopError={stopError}
				/>
			</ChatCard>
		</li>
	);
}

/** The run card with its own data: reads the run and keeps it current. */
export function AgentRunCard({
	agentRun,
	children,
}: {
	agentRun: AgentRunRef;
	children?: ReactNode;
}) {
	const { run, failed, attempt, viewerId, ownMessageIds, send, stop } =
		useWorkItemRun(agentRun.workItemId, true);
	const waiting = run?.attemptId === null && !attempt;
	const requests = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: { workItemId: agentRun.workItemId, states: ["open"], limit: 50 },
		}),
		enabled: waiting,
		staleTime: 0,
		refetchInterval: (query) =>
			pollingBackoff(
				query,
				waiting && !document.hidden ? 120_000 : false,
				300_000,
				query.state.data?.data,
			),
	});
	const hold = requests.data?.data.find(
		({ request }) => request.metadata?.source === "lane-dispatch-blocker",
	);
	return (
		<AgentRunCardView
			agentRun={agentRun}
			children={children}
			run={run}
			failed={failed}
			attempt={attempt}
			permissionHold={hold?.request.prompt}
			viewerId={viewerId}
			ownMessageIds={ownMessageIds}
			answering={send.isPending}
			onInterrupt={send.mutateAsync}
			onStop={() => stop.mutateAsync()}
			stopping={stop.isPending}
			stopError={stop.error}
		/>
	);
}
