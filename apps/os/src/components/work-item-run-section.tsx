import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Textarea } from "@/components/kumo/textarea";
import {
	useWorkItemRun,
	type WorkRunAttempt,
	WorkRunEntryRow,
	workRunEntries,
	workRunStatus,
	WorkRunStopConfirm,
} from "@/components/work-item-run";
import { useOsFormattingPreferences } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";

/** How close to the end of the list still counts as reading the newest step. */
const FOLLOW_NEWEST_WITHIN_PX = 24;

/**
 * The newest run of a task: what the agent did, oldest first, with the
 * follow-ups people sent. While the run is in progress it also takes a
 * follow-up and a request to stop.
 */
export function WorkItemRunView({
	run,
	attempt,
	names,
	viewerId,
	ownMessageIds,
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
	/** The signed-in person; their own messages read as "You". */
	viewerId?: string;
	/** Messages sent from this page; "You" before the profile has loaded. */
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
	const { steps, messages } = run;
	const entries = useMemo(
		() => workRunEntries({ steps, messages }),
		[steps, messages],
	);
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
						<WorkRunEntryRow
							key={entry.key}
							at={entry.at}
							step={"step" in entry ? entry.step : undefined}
							message={"message" in entry ? entry.message : undefined}
							live={run.live}
							ownMessageIds={ownMessageIds}
							names={names}
							viewerId={viewerId}
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
					<WorkRunStopConfirm
						open={confirmStop}
						onOpenChange={setConfirmStop}
						onStop={onStop}
						stopping={stopping}
						stopError={stopError}
					/>
				</form>
			) : null}
		</PageSection>
	);
}

/**
 * The Run section of the task page. It appears once the newest Attempt has
 * reported a step or is in progress.
 */
export function WorkItemRunSection({
	itemId,
	names,
}: {
	itemId: string;
	names?: ReadonlyMap<string, string>;
}) {
	const { run, attempt, viewerId, ownMessageIds, send, stop } =
		useWorkItemRun(itemId);
	if (!run || (!run.live && run.steps.length === 0)) return null;
	return (
		<WorkItemRunView
			run={run}
			attempt={attempt}
			names={names}
			viewerId={viewerId}
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
