import { CaretRight, Check, Robot, Warning } from "@phosphor-icons/react";
import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import {
	useWorkItemRun,
	type WorkRunAttempt,
	WorkRunEntryRow,
	workRunEntries,
	workRunOpenQuestion,
	WorkRunQuestion,
	workRunStatus,
	WorkRunStopConfirm,
} from "@/components/work-item-run";
import type { AgentRunRef } from "@/lib/agent-run-result";
import { useOsFormattingPreferences } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { OS_COPY } from "@/shared/os-copy";

/** Steps shown before "Show all": the newest ones. */
const COMPACT_STEPS = 8;

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
 * it, where it stands and its newest steps. The person steers the run by
 * writing to the tedi, so there is no follow-up box here; stopping is direct,
 * and so is answering a question the agent is waiting on.
 */
export function AgentRunCardView({
	agentRun,
	run,
	failed = false,
	attempt,
	viewerId,
	ownMessageIds,
	onAnswer,
	answering = false,
	onStop,
	stopping = false,
	stopError,
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
	/** Sends the person's answer to a question the run is waiting on. */
	onAnswer?: (answer: string) => Promise<unknown>;
	answering?: boolean;
	onStop?: () => Promise<unknown>;
	stopping?: boolean;
	stopError?: unknown;
	LinkComponent?: ComponentType<AgentRunTaskLinkProps>;
}) {
	useOsFormattingPreferences();
	const [showAll, setShowAll] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);
	const live = run?.live ?? false;
	const now = useNow(live);
	const steps = run?.steps;
	const messages = run?.messages;
	const entries = useMemo(
		() => workRunEntries({ steps: steps ?? [], messages: messages ?? [] }),
		[steps, messages],
	);
	const executor = executorLabel(agentRun.executor);
	const waiting = Boolean(run && !run.live && run.steps.length === 0);
	const status = failed
		? "The run could not be loaded. Open the task to see it."
		: !run
			? "Loading the run…"
			: waiting && !attempt
				? "Waiting for an agent to pick it up"
				: workRunStatus(run, attempt, undefined, new Date(now));
	const stopRequested = Boolean(
		messages?.some((message) => message.kind === "stop"),
	);
	const hidden = showAll ? 0 : Math.max(0, entries.length - COMPACT_STEPS);
	const visible = hidden ? entries.slice(hidden) : entries;
	const title = agentRun.title || "Agent run";
	const outcome = attempt?.outcome;
	const question = workRunOpenQuestion(run);

	return (
		<li
			data-slot="agent-run-card"
			data-run-live={live}
			className="flex w-full min-w-0 justify-start"
		>
			<section
				aria-label={`Agent run: ${title}`}
				className="flex min-w-0 max-w-[860px] flex-1 flex-col gap-2 rounded-xl border border-kumo-hairline bg-kumo-base px-3.5 py-3"
			>
				<div className="flex min-w-0 items-start gap-2">
					<span
						aria-hidden="true"
						className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle"
					>
						{live ? (
							<Loader aria-label="Run in progress" size={15} />
						) : failed || outcome === "failed" ? (
							<Warning size={15} className="text-kumo-warning" />
						) : outcome === "succeeded" ? (
							<Check size={15} className="text-kumo-success" />
						) : (
							<Robot size={15} />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<Text
							as="strong"
							weight="medium"
							className="block [overflow-wrap:anywhere]"
						>
							{title}
						</Text>
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="block [overflow-wrap:anywhere]"
						>
							{executor ? (
								<span data-slot="agent-run-executor">{executor} · </span>
							) : null}
							<span role="status" data-slot="agent-run-status">
								{status}
							</span>
						</Text>
					</div>
				</div>
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
				{question ? (
					<WorkRunQuestion
						question={question}
						onAnswer={onAnswer}
						sending={answering}
						answerBox
					/>
				) : null}
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<LinkComponent
						to="/work/items/$workItemId"
						params={{ workItemId: agentRun.workItemId }}
						className="inline-flex min-h-8 items-center gap-0.5 rounded-md text-kumo-link text-sm no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus coarse:min-h-11 max-sm:min-h-11"
					>
						Open task
						<CaretRight size={11} aria-hidden />
					</LinkComponent>
					{live && !question ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="ml-auto"
							disabled={stopRequested}
							onClick={() => setConfirmStop(true)}
						>
							{stopRequested ? "Stop requested" : "Stop run"}
						</Button>
					) : null}
				</div>
				<WorkRunStopConfirm
					open={confirmStop}
					onOpenChange={setConfirmStop}
					onStop={onStop}
					stopping={stopping}
					stopError={stopError}
				/>
			</section>
		</li>
	);
}

/** The run card with its own data: reads the run and keeps it current. */
export function AgentRunCard({ agentRun }: { agentRun: AgentRunRef }) {
	const { run, failed, attempt, viewerId, ownMessageIds, send, stop } =
		useWorkItemRun(agentRun.workItemId, true);
	return (
		<AgentRunCardView
			agentRun={agentRun}
			run={run}
			failed={failed}
			attempt={attempt}
			viewerId={viewerId}
			ownMessageIds={ownMessageIds}
			onAnswer={(answer) =>
				send.mutateAsync({
					body: answer,
					attemptId: run?.attemptId ?? undefined,
				})
			}
			answering={send.isPending}
			onStop={() => stop.mutateAsync()}
			stopping={stop.isPending}
			stopError={stop.error}
		/>
	);
}
