import type {
	ListWorkAttemptStepsResult,
	WorkAttemptMessage,
	WorkAttemptStep,
	WorkAttemptStepKind,
} from "@tedix/api-contract/schemas/work-attempt-steps";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osLocale, osTimeZone } from "@/lib/format";
import {
	osQuery,
	userProfileQueryOptions,
	workItemAttemptsQueryOptions,
	workItemRunStepsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

/**
 * What the task page's Run section and the chat's run card share: how a run
 * is read and refreshed, how one step or message reads, the status line, and
 * the question asked before a run is stopped.
 */

const RUN_REFRESH_MS = 3_000;

const NO_OWN_MESSAGES: ReadonlySet<string> = new Set();

const STEP_LABEL: Record<WorkAttemptStepKind, string> = {
	started: "Started",
	message: "Message",
	command: "Command",
	tool: "Tool",
	file_change: "File change",
	error: "Error",
	follow_up: "Follow-up",
	question: "Question",
	stopped: "Stopped",
	finished: "Finished",
};

/** The fields of the newest Attempt the status line reads. */
export type WorkRunAttempt = {
	id: string;
	executorType: string;
	executorId: string;
	outcome: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	heartbeatAt?: string | null;
};

export type WorkRunEntry =
	| { key: string; at: number; step: WorkAttemptStep }
	| { key: string; at: number; message: WorkAttemptMessage };

/**
 * Steps and sent messages in the order they happened. The runner also records
 * a received follow-up as a step; that step is left out when the message that
 * caused it is already listed, so one follow-up reads as one line.
 */
export function workRunEntries(
	run: Pick<ListWorkAttemptStepsResult, "steps" | "messages">,
): WorkRunEntry[] {
	const followUps = run.messages
		.filter((message) => message.kind === "follow_up")
		.map((message) => message.body.trim());
	const entries: WorkRunEntry[] = [];
	for (const step of run.steps) {
		const text = step.text.trim().replace(/(…|\.\.\.)$/, "");
		if (
			step.kind === "follow_up" &&
			text &&
			followUps.some((body) => body.startsWith(text))
		)
			continue;
		entries.push({ key: `step-${step.seq}`, at: step.at, step });
	}
	for (const message of run.messages) {
		const at = Date.parse(message.createdAt);
		entries.push({
			key: `message-${message.id}`,
			at: Number.isNaN(at) ? 0 : at,
			message,
		});
	}
	// A stable sort keeps steps in seq order when two share a millisecond.
	return entries.sort((a, b) => a.at - b.at);
}

/** The last question stays open until someone answers or stops the run. */
export function workRunOpenQuestion(
	run:
		| Pick<ListWorkAttemptStepsResult, "steps" | "messages" | "questionOpen">
		| undefined,
): WorkAttemptStep | undefined {
	const last = run?.steps.at(-1);
	if (!run || last?.kind !== "question" || run.questionOpen === false) return;
	if (run.questionOpen) return last;
	return run.messages.some(
		(message) =>
			message.kind === "stop" || Date.parse(message.createdAt) >= last.at,
	)
		? undefined
		: last;
}

/**
 * The question a run is waiting on, with the answers the agent offers. With
 * `answerBox` it also takes an answer in the person's own words; the task
 * page uses its follow-up box for that instead.
 */
export function WorkRunQuestion({
	question,
	onAnswer,
	sending = false,
	answerBox = false,
}: {
	question: WorkAttemptStep;
	/** Resolves once the answer is stored. */
	onAnswer?: (answer: string) => Promise<unknown>;
	sending?: boolean;
	answerBox?: boolean;
}) {
	const [draft, setDraft] = useState("");
	const answer = (text: string) => {
		const body = text.trim();
		if (!body || sending || !onAnswer) return;
		void onAnswer(body).then(
			() => setDraft(""),
			() => {},
		);
	};
	return (
		<div
			role="group"
			aria-label="The agent asks"
			data-slot="run-question"
			className="grid min-w-0 gap-2 rounded-lg border border-kumo-hairline px-3 py-2.5"
		>
			<Text as="span" role="label" tone="secondary" weight="medium">
				The agent is waiting for your answer
			</Text>
			<Text className="m-0 whitespace-pre-wrap break-words">
				{question.text}
			</Text>
			{question.choices?.length ? (
				<div className="flex min-w-0 flex-wrap gap-2">
					{question.choices.map((choice) => (
						<Button
							key={choice}
							type="button"
							variant="outline"
							size="sm"
							disabled={sending || !onAnswer}
							onClick={() => answer(choice)}
						>
							{choice}
						</Button>
					))}
				</div>
			) : null}
			{answerBox ? (
				<form
					className="flex min-w-0 flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						answer(draft);
					}}
				>
					<Input
						aria-label="Your answer"
						className="min-w-0 flex-1"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						maxLength={4000}
						disabled={sending}
						placeholder="Answer in your own words"
					/>
					<Button
						type="submit"
						size="sm"
						disabled={!draft.trim() || sending || !onAnswer}
					>
						Answer
					</Button>
				</form>
			) : null}
		</div>
	);
}

function clockTime(at: number): string {
	const timeZone = osTimeZone();
	return new Intl.DateTimeFormat(osLocale(), {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...(timeZone ? { timeZone } : {}),
	}).format(new Date(at));
}

function senderLabel(
	message: WorkAttemptMessage,
	ownMessageIds: ReadonlySet<string>,
	names?: ReadonlyMap<string, string>,
	viewerId?: string,
): string {
	if (
		ownMessageIds.has(message.id) ||
		(message.senderType === "user" && message.senderId === viewerId)
	)
		return "You";
	const known = names?.get(`${message.senderType}:${message.senderId}`);
	if (known) return known;
	if (message.senderType === "user") return "Team member";
	return message.senderType === "tedi" ? "A tedi" : "An agent";
}

export function workRunStatus(
	run: Pick<ListWorkAttemptStepsResult, "live" | "steps">,
	attempt: WorkRunAttempt | undefined,
	names?: ReadonlyMap<string, string>,
	now = new Date(),
): string {
	const iso = (at: number | undefined) =>
		at === undefined ? null : new Date(at).toISOString();
	const first = iso(run.steps[0]?.at);
	const last = iso(run.steps.at(-1)?.at);
	if (run.live) {
		const executor = attempt
			? names?.get(`${attempt.executorType}:${attempt.executorId}`)
			: undefined;
		const started = attempt?.startedAt ?? first;
		return `Running${executor ? ` on ${executor}` : ""}${started ? `, started ${relativeTime(started, now)}` : ""}`;
	}
	const ended = attempt?.finishedAt ?? last;
	const when = ended ? ` ${relativeTime(ended, now)}` : "";
	if (attempt?.outcome === "cancelled") return `Stopped${when}`;
	if (attempt?.outcome === "landed_unverified")
		return `Landed, not verified${when}`;
	if (attempt?.outcome && attempt.outcome !== "expired")
		return `Finished${when}: ${attempt.outcome}`;
	if (run.steps.at(-1)?.kind === "finished") return `Finished${when}`;
	const lastUpdate = attempt?.heartbeatAt ?? last;
	return `Stopped reporting${lastUpdate ? `, last update ${relativeTime(lastUpdate, now)}` : ""}`;
}

/**
 * Memoized on the step or message itself, which a refresh keeps as the same
 * object: a refresh that adds a step leaves the rows above it alone.
 */
export const WorkRunEntryRow = memo(function WorkRunEntryRow({
	at,
	step,
	message,
	live,
	ownMessageIds = NO_OWN_MESSAGES,
	names,
	viewerId,
}: {
	at: number;
	step?: WorkAttemptStep;
	message?: WorkAttemptMessage;
	live: boolean;
	ownMessageIds?: ReadonlySet<string>;
	names?: ReadonlyMap<string, string>;
	viewerId?: string;
}) {
	const time = (
		<Text as="span" role="label" tone="mono-secondary" className="pt-0.5">
			<time
				dateTime={new Date(at).toISOString()}
				title={absoluteTime(new Date(at).toISOString())}
			>
				{clockTime(at)}
			</time>
		</Text>
	);
	if (step) {
		return (
			<li
				className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3"
				data-run-step={step.kind}
			>
				{time}
				<div className="min-w-0">
					<Text
						as="span"
						role="label"
						tone={step.kind === "error" ? "error" : "secondary"}
						weight="medium"
						className="block"
					>
						{STEP_LABEL[step.kind]}
					</Text>
					{step.text ? (
						<Text
							tone={step.kind === "command" ? "mono" : "default"}
							className="m-0 whitespace-pre-wrap break-words"
						>
							{step.text}
						</Text>
					) : null}
				</div>
			</li>
		);
	}
	if (!message) return null;
	const sender = senderLabel(message, ownMessageIds, names, viewerId);
	const waiting =
		message.kind === "follow_up" && message.appliedAt === null
			? live
				? message.interrupt
					? "Stopping the current step to apply this"
					: "Waiting for the current step to finish"
				: "Not applied: the run ended first"
			: null;
	return (
		<li
			className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3"
			data-run-message={message.kind}
		>
			{time}
			<div className="min-w-0">
				{message.kind === "stop" ? (
					<Text className="m-0">Stop requested by {sender}</Text>
				) : (
					<Text className="m-0 whitespace-pre-wrap break-words">
						<Text as="span" weight="medium">
							{sender}:
						</Text>{" "}
						{message.body}
					</Text>
				)}
				{waiting ? (
					<Text as="span" role="label" tone="secondary" className="block">
						{waiting}
					</Text>
				) : null}
			</div>
		</li>
	);
});

/** Asks before a run is stopped; stays open until the request settles. */
export function WorkRunStopConfirm({
	open,
	onOpenChange,
	onStop,
	stopping = false,
	stopError,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onStop?: () => Promise<unknown>;
	stopping?: boolean;
	stopError?: unknown;
}) {
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Stop this run?"
			description="The agent stops working on this task and the run is recorded as cancelled. Work it has already saved stays."
			confirmLabel="Stop run"
			pendingLabel="Stopping…"
			retryLabel="Try again"
			cancelLabel="Keep running"
			destructive
			isPending={stopping}
			error={stopError}
			onConfirm={() => {
				if (!onStop) return;
				void onStop().then(
					() => onOpenChange(false),
					() => {},
				);
			}}
		/>
	);
}

/**
 * The newest run of a task, kept current. While the run is in progress it
 * asks every few seconds for the steps after the last one shown, and it reads
 * once more when the run ends. Also sends a follow-up and a request to stop.
 */
export function useWorkItemRun(itemId: string, waitForStart = false) {
	const client = useQueryClient();
	const options = workItemRunStepsQueryOptions(itemId);
	const run = useQuery({
		...options,
		refetchInterval: (query) =>
			(waitForStart && query.state.data?.attemptId === null) ||
			query.state.data?.live ||
			query.state.data?.questionOpen ||
			query.state.data?.steps.at(-1)?.kind === "question"
				? RUN_REFRESH_MS
				: false,
		// A run goes on while the person looks at another window; the card and
		// the task page must be current when they look back, not a poll later.
		refetchIntervalInBackground: true,
	});
	// Read again while the run is live, so a runner that stops reporting shows.
	const attempts = useQuery({
		...workItemAttemptsQueryOptions(itemId),
		refetchInterval: run.data?.live ? 60_000 : false,
	});
	// Already loaded by the shell; this adds a reader, not a request.
	const viewer = useQuery(userProfileQueryOptions());
	const [ownMessageIds, setOwnMessageIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const refreshRun = () =>
		client.invalidateQueries({ queryKey: options.queryKey });
	const send = useMutation({
		mutationFn: (followUp: {
			body: string;
			interrupt?: boolean;
			attemptId?: string;
		}) =>
			osApi.workItems.sendAttemptMessage({
				id: itemId,
				body: followUp.body,
				...(followUp.attemptId ? { attemptId: followUp.attemptId } : {}),
				...(followUp.interrupt ? { interrupt: true } : {}),
			}),
		onSuccess: (message) => {
			setOwnMessageIds((ids) => new Set(ids).add(message.id));
			return refreshRun();
		},
		// Refresh if another answer won or a newer run took over.
		onError: refreshRun,
	});
	const stop = useMutation({
		mutationFn: () => osApi.workItems.stopAttempt({ id: itemId }),
		onSuccess: (message) => {
			setOwnMessageIds((ids) => new Set(ids).add(message.id));
			return refreshRun();
		},
		onError: refreshRun,
	});

	const live = run.data?.live;
	const wasLive = useRef(false);
	useEffect(() => {
		if (wasLive.current && live === false) {
			// The last steps and the outcome land with the end of the run.
			void client.invalidateQueries({ queryKey: options.queryKey });
			void client.invalidateQueries({
				queryKey: osQuery.workItems.listAttempts.key(),
			});
		}
		if (live !== undefined) wasLive.current = live;
	}, [live, client, options.queryKey]);

	const newest = attempts.data?.data;
	const attempt: WorkRunAttempt | undefined = run.data
		? (newest?.find((row) => row.id === run.data.attemptId) ??
			(run.data.attemptId ? undefined : newest?.[0]))
		: undefined;
	return {
		run: run.data,
		/** The run could not be read at all (no cached steps to show). */
		failed: run.isError && !run.data,
		attempt,
		viewerId: viewer.data?.id,
		ownMessageIds,
		send,
		stop,
	};
}
