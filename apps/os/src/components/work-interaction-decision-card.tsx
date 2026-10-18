import { decisionEnvelope } from "@/lib/decision-deck";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { useRef } from "react";
import { OutboundCard } from "@/components/outbound-card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as z from "zod";
import { DecisionProposalBody } from "@/components/decision-proposal-body";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	WorkDecisionCard,
	type DecisionCardAction,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import {
	draftAnswerMetadata,
	latestDraftOf,
} from "@/components/work-interaction-draft";
import { osApi } from "@/lib/api";
import {
	osQuery,
	osQueryKeys,
	workAttentionQueryOptions,
	workFleetQueryOptions,
	workSchedulerQueryOptions,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	decisionCaptureSummary,
	interactionSubject,
} from "@/lib/work-interaction-display";

const laneHandoffSchema = z.object({
	nextClick: z.string().optional(),
	summary: z.string().optional(),
});
const offeredChoices = z.object({
	laneHandoff: laneHandoffSchema.optional().catch(undefined),
	followThrough: z
		.object({ laneHandoff: laneHandoffSchema.optional() })
		.optional()
		.catch(undefined),
	suggestedAnswers: z
		.array(z.string().trim().min(1).max(300))
		.max(8)
		.optional()
		.catch(undefined),
	decisionCard: z
		.object({
			kind: z.literal("decision"),
			options: z
				.array(
					z.object({
						id: z.string().min(1).max(100),
						label: z.string().min(1).max(300),
						body: z.string().max(4000).optional(),
					}),
				)
				.min(2)
				.max(4),
		})
		.optional()
		.catch(undefined),
	externalAction: z
		.object({
			label: z.string().min(1).max(120),
			url: z.url().refine((value) => {
				const url = new URL(value);
				return url.protocol === "https:" && !url.username && !url.password;
			}),
		})
		.optional()
		.catch(undefined),
});

export function WorkInteractionDecisionCard({
	requestId,
	askedBy,
	drafterName,
	deliveryText,
	autoFocus,
	onNext,
	onPrevious,
}: {
	requestId: string;
	askedBy?: string;
	drafterName?: string;
	deliveryText?: string;
	autoFocus?: boolean;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const client = useQueryClient();
	const shown = useRef({ requestId, at: Date.now() });
	if (shown.current.requestId !== requestId)
		shown.current = { requestId, at: Date.now() };
	const query = useQuery(workInteractionDetailQueryOptions(requestId));
	const refresh = () =>
		Promise.all([
			client.invalidateQueries({
				queryKey: osQuery.workInteractions.key({ type: "query" }),
			}),
			client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
			client.invalidateQueries({
				queryKey: workSchedulerQueryOptions().queryKey,
			}),
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
			client.invalidateQueries({ queryKey: workFleetQueryOptions().queryKey }),
			client.invalidateQueries(workAttentionQueryOptions()),
			client.invalidateQueries({
				queryKey: osQueryKeys.agentSessionRequests(),
			}),
		]);
	const respond = useMutation({
		mutationFn: async (feedback: DecisionCardFeedback) => {
			if (!query.data) throw new Error("Request is not loaded");
			const { request } = query.data;
			const proposal = request.kind === "handoff";
			const deferred = proposal && feedback.action === "not-now";
			const draft = latestDraftOf(query.data);
			const offered = offeredChoices.parse(request.metadata ?? {});
			const lane =
				request.kind === "question" &&
				Boolean(offered.laneHandoff ?? offered.followThrough?.laneHandoff);
			const option = offered.decisionCard?.options.find(
				(choice) => choice.id === feedback.action,
			);
			const body = lane
				? feedback.action === "done"
					? "Done."
					: "Snoozed for one day."
				: proposal
					? feedback.action === "start"
						? "Yes, start."
						: deferred
							? "Not now."
							: "Never suggest this again."
					: (option?.body ?? option?.label ?? feedback.body);
			const result = await osApi.workInteractions.respond({
				requestId,
				expectedRequestVersion: request.version,
				responseKind: proposal
					? feedback.action === "start"
						? "handoff_accepted"
						: "handoff_declined"
					: request.kind === "input"
						? "input_provided"
						: request.kind === "coordination"
							? "coordination_update"
							: "answer",
				body,
				resolvesRequest: !deferred && !(lane && feedback.action === "snooze"),
				metadata: {
					elapsedMs: Date.now() - shown.current.at,
					cardAction: feedback.action,
					decisionClass:
						decisionEnvelope(request.metadata)?.classId ??
						(typeof request.metadata?.decisionClass === "string"
							? request.metadata.decisionClass
							: request.kind),
					decisionChoice:
						deferred || feedback.action === "snooze"
							? "later"
							: feedback.signal === "rejected"
								? "reject"
								: feedback.signal === "edited"
									? "change"
									: "approve",
					...(feedback.signal === "edited" ? { editedBody: body } : {}),
					...(lane ? { laneAction: feedback.action } : {}),
					feedbackSignal: draft
						? body === draft.body
							? "approve-as-is"
							: "edited"
						: feedback.signal,
					...(feedback.reason ? { feedbackReason: feedback.reason } : {}),
					...(feedback.feedback ? { feedbackText: feedback.feedback } : {}),
					...(feedback.originalBody
						? { originalBody: feedback.originalBody }
						: {}),
					...(draft ? draftAnswerMetadata(draft, body) : {}),
					source: "os-decision-card",
				},
			});
			await refresh();
			return result;
		},
	});
	const cancel = useMutation({
		mutationFn: async () => {
			if (!query.data) throw new Error("Request is not loaded");
			await osApi.workInteractions.cancel({
				requestId,
				expectedRequestVersion: query.data.request.version,
			});
			await refresh();
		},
	});
	if (query.isPending)
		return (
			<Skeleton
				className="h-60 w-full"
				aria-label={decisionText("Loading request")}
			/>
		);
	if (!query.data || query.isError)
		return (
			<p role="alert">
				This request could not be loaded.{" "}
				<Button variant="outline" onClick={() => void query.refetch()}>
					{decisionText("Try again")}
				</Button>
			</p>
		);
	const { request, effectiveState, canRespond, canCancel, responses } =
		query.data;
	if (request.metadata?.schema === "tedix.outbound.v1" && request.workItemId)
		return (
			<OutboundCard
				workItemId={request.workItemId}
				autoFocus={autoFocus}
				onNext={onNext}
				onPrevious={onPrevious}
			/>
		);
	const choices = offeredChoices.parse(request.metadata ?? {});
	const capture = decisionCaptureSummary(request.metadata);
	const source =
		(capture?.source?.includes("Codex")
			? "Codex"
			: capture?.source?.includes("Claude Code")
				? "Claude Code"
				: undefined) ??
		(typeof request.metadata?.originChatId === "string" &&
		request.metadata?.agentHarness === "codex"
			? "Codex"
			: undefined) ??
		(typeof request.metadata?.originChatTitle === "string"
			? request.metadata.originChatTitle
			: (askedBy ??
				(request.creatorType === "tedi" ? "Your tedi" : "Your agent")));
	const draft = latestDraftOf(query.data);
	const proposal = request.kind === "handoff";
	const lane =
		request.kind === "question" &&
		Boolean(choices.laneHandoff ?? choices.followThrough?.laneHandoff);
	const pastDeadline =
		effectiveState === "open" &&
		!!request.dueAt &&
		Date.parse(request.dueAt) < Date.now();
	const active =
		!pastDeadline &&
		canRespond &&
		(effectiveState === "open" ||
			(request.kind === "question" && effectiveState === "resolved"));
	const actions: DecisionCardAction[] = lane
		? [
				{ id: "done", label: decisionText("Done"), intent: "approve" },
				{ id: "snooze", label: decisionText("Snooze 1 day"), intent: "reject" },
			]
		: proposal
			? [
					{ id: "start", label: decisionText("Yes, start"), intent: "approve" },
					{ id: "not-now", label: decisionText("Not now"), intent: "reject" },
					{ id: "never", label: decisionText("Never"), intent: "reject" },
				]
			: choices.decisionCard
				? choices.decisionCard.options.map((option) => ({
						id: option.id,
						label: option.label,
						description: option.body,
					}))
				: [
						{
							id: "answer",
							label:
								draft?.delivery === "auto"
									? decisionText("Override")
									: decisionText("Answer"),
							intent: "approve",
						},
					];
	return (
		<div className="grid min-w-0 gap-3">
			{deliveryText ? <p className="text-kumo-subtle">{deliveryText}</p> : null}
			<WorkDecisionCard
				autoFocus={autoFocus}
				key={`${request.id}:${effectiveState}`}
				kind={
					proposal
						? "proposal"
						: choices.decisionCard || lane
							? "decision"
							: "question"
				}
				title={interactionSubject(request)}
				askedBy={source}
				at={request.requestedAt}
				content={
					<div className="grid gap-3">
						{effectiveState !== "open" ? (
							<p>
								{effectiveState === "resolved" && !choices.externalAction
									? "Answer saved"
									: "Request closed"}
							</p>
						) : null}
						{capture?.attention === "fyi" ? (
							<p>{decisionText("Update: nothing needed from you")}</p>
						) : capture?.urgency === "now" ? (
							<p className="text-kumo-danger">{capture.reasons.join(" · ")}</p>
						) : capture?.urgency === "later" ? (
							<p className="text-kumo-subtle">{decisionText("Can wait")}</p>
						) : null}
						{pastDeadline && (
							<p role="status">{OS_COPY.decisionDeck.revalidate}</p>
						)}
						<DecisionProposalBody key={request.id} body={request.prompt} />
						{draft ? (
							<div className="grid gap-1 rounded-lg border border-kumo-line p-3">
								<p className="text-kumo-subtle">
									{draft.delivery === "auto"
										? "Sent automatically by"
										: "Recommended answer from"}{" "}
									{drafterName ?? "your tedi"}
								</p>
								<p className="whitespace-pre-wrap">{draft.body}</p>
							</div>
						) : null}
					</div>
				}
				why={
					<div className="grid gap-3">
						{draft?.rationale ? <p>{draft.rationale}</p> : null}
						<p>
							{capture?.need ??
								"Your answer goes back to the agent that asked and is saved with this task."}
						</p>
						{request.metadata?.host === "codex" ||
						request.metadata?.agentHarness === "codex" ? (
							<p>
								{decisionText(
									"Codex receives your answer with its next prompt.",
								)}
							</p>
						) : null}
						<Link href={`/work/interactions/${request.id}`}>
							{decisionText("Open request history")}
						</Link>

						{canCancel && effectiveState === "open" ? (
							<Button
								className="w-fit"
								variant="ghost"
								disabled={cancel.isPending}
								onClick={() => cancel.mutate()}
							>
								{decisionText("Cancel request")}
							</Button>
						) : null}
						{cancel.error ? <p role="alert">{cancel.error.message}</p> : null}
						{responses.data.map((response) => (
							<p key={response.id} className="whitespace-pre-wrap">
								{response.body}
							</p>
						))}
					</div>
				}
				actions={choices.externalAction || !active ? [] : actions}
				suggestedAnswers={choices.suggestedAnswers}
				initialAnswer={draft && draft.delivery !== "auto" ? draft.body : ""}
				disabled={!active || Boolean(choices.externalAction)}
				pending={respond.isPending}
				onDecision={(feedback) => respond.mutateAsync(feedback)}
				onNext={onNext}
				onPrevious={onPrevious}
			/>
			{choices.externalAction && active ? (
				<Button
					className="w-fit"
					render={
						<a
							href={choices.externalAction.url}
							target="_blank"
							rel="noopener noreferrer"
						/>
					}
				>
					{choices.externalAction.label}
				</Button>
			) : null}
			{respond.error ? <p role="alert">{respond.error.message}</p> : null}
		</div>
	);
}
