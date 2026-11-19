import type {
	ListWorkAttemptStepsResult,
	WorkAttemptMessage,
	WorkAttemptStep,
	WorkAttemptStepKind,
} from "@tedix/api-contract/schemas/work-attempt-steps";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kumo/button";
import { Label } from "@/components/kumo/label";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osLocale, osTimeZone, useOsFormattingPreferences } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import {
	osQuery,
	workItemAttemptsQueryOptions,
	workItemRunStepsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

const RUN_REFRESH_MS = 3_000;
/** How close to the end of the list still counts as reading the newest step. */
const FOLLOW_NEWEST_WITHIN_PX = 24;

const STEP_LABEL: Record<WorkAttemptStepKind, string> = {
	started: "Started",
	message: "Message",
	command: "Command",
	tool: "Tool",
	file_change: "File change",
	error: "Error",
	follow_up: "Follow-up",
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

type RunEntry =
	| { key: string; at: number; step: WorkAttemptStep }
	| { key: string; at: number; message: WorkAttemptMessage };

/**
 * Steps and sent messages in the order they happened. The runner also records
 * a received follow-up as a step; that step is left out when the message that
 * caused it is already listed, so one follow-up reads as one line.
 */
export function workRunEntries(
	run: Pick<ListWorkAttemptStepsResult, "steps" | "messages">,
): RunEntry[] {
	const followUps = run.messages
		.filter((message) => message.kind === "follow_up")
		.map((message) => message.body.trim());
	const entries: RunEntry[] = [];
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
): string {
	if (ownMessageIds.has(message.id)) return "You";
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
	if (attempt?.outcome && attempt.outcome !== "expired")
		return `Finished${when}: ${attempt.outcome}`;
	if (run.steps.at(-1)?.kind === "finished") return `Finished${when}`;
	const lastUpdate = attempt?.heartbeatAt ?? last;
	return `Stopped reporting${lastUpdate ? `, last update ${relativeTime(lastUpdate, now)}` : ""}`;
}

function RunEntryRow({
	entry,
	live,
	ownMessageIds,
	names,
}: {
	entry: RunEntry;
	live: boolean;
	ownMessageIds: ReadonlySet<string>;
	names?: ReadonlyMap<string, string>;
}) {
	const time = (
		<Text as="span" role="label" tone="mono-secondary" className="pt-0.5">
			<time
				dateTime={new Date(entry.at).toISOString()}
				title={absoluteTime(new Date(entry.at).toISOString())}
			>
				{clockTime(entry.at)}
			</time>
		</Text>
	);
	if ("step" in entry) {
		const { step } = entry;
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
	const { message } = entry;
	const sender = senderLabel(message, ownMessageIds, names);
	const waiting =
		message.kind === "follow_up" && message.appliedAt === null
			? live
				? "Waiting for the current step to finish"
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
}

/**
 * The newest run of a task: what the agent did, oldest first, with the
 * follow-ups people sent. While the run is in progress it also takes a
 * follow-up and a request to stop.
 */
export function WorkItemRunView({
	run,
	attempt,
	names,
	ownMessageIds = new Set(),
	onSend,
	sending = false,
	sendError,
	onStop,
	stopping = false,
	stopError,
}: {
	run: ListWorkAttemptStepsResult;
	attempt?: WorkRunAttempt;
	/** `type:id` to display name. */
	names?: ReadonlyMap<string, string>;
	/** Messages this reader sent from this page; they read as "You". */
	ownMessageIds?: ReadonlySet<string>;
	/** Resolves once the follow-up is stored; the draft is cleared then. */
	onSend?: (body: string) => Promise<unknown>;
	sending?: boolean;
	sendError?: unknown;
	onStop?: () => Promise<unknown>;
	stopping?: boolean;
	stopError?: unknown;
}) {
	useOsFormattingPreferences();
	const [draft, setDraft] = useState("");
	const [confirmStop, setConfirmStop] = useState(false);
	const list = useRef<HTMLUListElement>(null);
	const followNewest = useRef(true);
	const entries = workRunEntries(run);
	const stopRequested = run.messages.some((message) => message.kind === "stop");
	const fieldId = `work-run-follow-up-${run.attemptId ?? "none"}`;

	useLayoutEffect(() => {
		const element = list.current;
		if (element && followNewest.current)
			element.scrollTop = element.scrollHeight;
	}, [entries.length]);

	return (
		<PageSection aria-label="Run" data-run-live={run.live}>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Run</SectionTitle>
					<SectionDescription role="status">
						{workRunStatus(run, attempt, names)}
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{entries.length ? (
				<Collection
					ref={list}
					aria-label="Run steps"
					tabIndex={0}
					// A block list: grid rows would shrink to fit the height limit.
					className="block max-h-96 overflow-y-auto [&>li]:px-4 [&>li]:py-3"
					onScroll={(event) => {
						const element = event.currentTarget;
						followNewest.current =
							element.scrollHeight - element.scrollTop - element.clientHeight <
							FOLLOW_NEWEST_WITHIN_PX;
					}}
				>
					{entries.map((entry) => (
						<RunEntryRow
							key={entry.key}
							entry={entry}
							live={run.live}
							ownMessageIds={ownMessageIds}
							names={names}
						/>
					))}
				</Collection>
			) : (
				<p className="m-0 border-kumo-hairline border-t py-3 text-kumo-subtle type-tedix-body">
					The agent has not reported a step yet.
				</p>
			)}
			{run.live ? (
				<form
					className="grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const body = draft.trim();
						if (!body || sending || !onSend) return;
						void onSend(body).then(
							() => setDraft(""),
							() => {},
						);
					}}
				>
					<Label htmlFor={fieldId}>Send a follow-up</Label>
					<Textarea
						id={fieldId}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						maxLength={4000}
						disabled={sending}
						placeholder="The agent reads it when its current step ends"
					/>
					{sendError ? (
						<p role="alert" className="m-0">
							{errorMessage(sendError, "The follow-up could not be sent.")}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button type="submit" disabled={!draft.trim() || sending}>
							{sending ? "Sending…" : "Send"}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={stopRequested}
							onClick={() => setConfirmStop(true)}
						>
							{stopRequested ? "Stop requested" : "Stop run"}
						</Button>
					</div>
					<ConfirmDialog
						open={confirmStop}
						onOpenChange={setConfirmStop}
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
								() => setConfirmStop(false),
								() => {},
							);
						}}
					/>
				</form>
			) : null}
		</PageSection>
	);
}

/**
 * The Run section of the task page. It appears once the newest Attempt has
 * reported a step or is in progress, refreshes every few seconds while the
 * run is in progress, and reads once more when the run ends.
 */
export function WorkItemRunSection({
	itemId,
	names,
}: {
	itemId: string;
	names?: ReadonlyMap<string, string>;
}) {
	const client = useQueryClient();
	const options = workItemRunStepsQueryOptions(itemId);
	const run = useQuery({
		...options,
		refetchInterval: (query) =>
			query.state.data?.live ? RUN_REFRESH_MS : false,
	});
	const attempts = useQuery(workItemAttemptsQueryOptions(itemId));
	const [ownMessageIds, setOwnMessageIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const refreshRun = () =>
		client.invalidateQueries({ queryKey: options.queryKey });
	const send = useMutation({
		mutationFn: (body: string) =>
			osApi.workItems.sendAttemptMessage({ id: itemId, body }),
		onSuccess: (message) => {
			setOwnMessageIds((ids) => new Set(ids).add(message.id));
			return refreshRun();
		},
		// A refusal because the run just ended should also end the composer.
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

	if (!run.data || (!run.data.live && run.data.steps.length === 0)) return null;
	const newest = attempts.data?.data;
	return (
		<WorkItemRunView
			run={run.data}
			attempt={
				newest?.find((attempt) => attempt.id === run.data.attemptId) ??
				(run.data.attemptId ? undefined : newest?.[0])
			}
			names={names}
			ownMessageIds={ownMessageIds}
			onSend={(body) => send.mutateAsync(body)}
			sending={send.isPending}
			sendError={send.error}
			onStop={() => stop.mutateAsync()}
			stopping={stop.isPending}
			stopError={stop.error}
		/>
	);
}
