import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { OS_COPY } from "@/shared/os-copy";
import {
	WorkReadNotice,
	useWorkReadFailure,
} from "@/components/work-read-region";
import { workRefreshOptions } from "@/lib/work-refresh";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import {
	WorkDecisionCard,
	type DecisionCardAction,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	reviewedOutbound,
	type OutboundRecord,
	OutboundActionSchema,
} from "@tedix/api-contract/schemas/outbound";
import { osApi } from "@/lib/api";
import {
	osQuery,
	tediRosterQueryOptions,
	workAttentionQueryOptions,
} from "@/lib/os-query-options";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { errorMessage } from "@/lib/orpc-error";

type OutboundCardNavigation = {
	autoFocus?: boolean;
	onNext?: () => void;
	onPrevious?: () => void;
};

export function OutboundCard({
	workItemId,
	preview,
	presentation,
	...navigation
}: {
	workItemId: string;
	preview?: OutboundRecord;
	presentation?: DecisionCardPresentation;
} & OutboundCardNavigation) {
	const query = useQuery({
		...osQuery.workInteractions.outbound.get.queryOptions({
			input: { workItemId },
		}),
		placeholderData: preview?.workItemId === workItemId ? preview : undefined,
		...workRefreshOptions,
	});
	const record =
		query.data ?? (preview?.workItemId === workItemId ? preview : undefined);
	const failed = query.isError || query.failureCount > 0;
	const inRegion = useWorkReadFailure(
		failed
			? {
					error: query.error ?? query.failureReason,
					retrying: query.isFetching,
					retry: query.refetch,
				}
			: undefined,
	);
	const notice = !inRegion && (
		<WorkReadNotice
			failed={failed}
			partial={Boolean(record)}
			retry={query.refetch}
			retrying={query.isFetching}
			errors={[query.error ?? query.failureReason]}
		/>
	);
	if (!record)
		return failed ? notice : <Text role="body">Loading outbound draft…</Text>;
	return (
		<>
			{notice}
			<OutboundReviewCard
				key={`${record.workItemId}:${record.version}`}
				record={record}
				presentation={presentation}
				{...navigation}
			/>
		</>
	);
}

export function OutboundReviewCard({
	record,
	presentation,
	...navigation
}: {
	record: OutboundRecord;
	presentation?: DecisionCardPresentation;
} & OutboundCardNavigation) {
	const client = useQueryClient();
	const shownAt = useRef(Date.now());
	const state = record.outbound;
	const outcome = useQuery({
		...osQuery.workInteractions.outbound.checkOutcome.queryOptions({
			input: { workItemId: record.workItemId },
		}),
		enabled: state.status === "sent" && !!state.connectionInstanceId,
		staleTime: 60000,
	});
	const roster = useQuery(tediRosterQueryOptions(100));
	const reviewer = roster.data?.data.find(
		(tedi) => tedi.id === state.reviewerTediId,
	);
	const reviewerName =
		reviewer?.displayName || reviewer?.name || "Your reviewer tedi";
	const [recipient, setRecipient] = useState(state.draft.recipient);
	const [subject, setSubject] = useState(state.draft.subject);
	const [account, setAccount] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const connections = useQuery({
		...osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} }),
		enabled: state.draft.channel === "email",
	});
	const ready = reviewedOutbound(state);
	const open = ["reviewing", "waiting_on_you", "feedback"].includes(
		state.status,
	);
	const accounts = connections.data ?? [];
	const actions: DecisionCardAction[] = open
		? [
				...(state.draft.channel === "email"
					? [
							{
								id: "approve_send",
								label: "Send",
								intent: "approve" as const,
								disabled: !ready,
								confirm: `Send this email to ${state.draft.recipient} using your Gmail connection?`,
								confirmDisabled: !account,
								confirmContent: (
									<div className="grid gap-3">
										<Select value={account} onValueChange={setAccount}>
											<SelectTrigger aria-label="Your Gmail account">
												<SelectValue placeholder="Choose your Gmail account">
													{
														accounts.find(
															(connection) => connection.id === account,
														)?.label
													}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												{accounts.map((connection) => (
													<SelectItem key={connection.id} value={connection.id}>
														{connection.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										{connections.isError ? (
											<p role="alert">
												Your Gmail connections could not be loaded.
											</p>
										) : !accounts.length ? (
											<p>
												Connect Gmail and grant compose consent to send here.
											</p>
										) : null}
										<Link href="/account/connections">
											Manage Gmail connection and compose consent
										</Link>
									</div>
								),
							},
						]
					: []),
				{
					id: "approve_manual",
					label: "Approve, I'll send",
					intent: state.draft.channel !== "email" ? "approve" : undefined,
					disabled: !ready,
				},
				{ id: "reject", label: "No / Not needed", intent: "reject" },
			]
		: [];
	const decide = async (feedback: DecisionCardFeedback) => {
		const action = OutboundActionSchema.parse(feedback.action);
		const result = await osApi.workInteractions.outbound.act({
			workItemId: record.workItemId,
			expectedVersion: record.version,
			action,
			elapsedMs: Math.min(86400000, Math.max(0, Date.now() - shownAt.current)),
			...(action === "edit"
				? {
						draft: {
							...state.draft,
							body: feedback.body,
							recipient: recipient.trim(),
							subject: subject.trim(),
						},
					}
				: {}),
			...([feedback.reason, feedback.feedback].some(Boolean)
				? {
						feedback: [feedback.reason, feedback.feedback]
							.filter(Boolean)
							.join("\n"),
					}
				: {}),
			...(action === "approve_send" && account
				? { connectionInstanceId: account }
				: {}),
		});
		await Promise.all([
			client.invalidateQueries({
				queryKey: osQuery.workInteractions.key({ type: "query" }),
			}),
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
			client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
			client.invalidateQueries(workAttentionQueryOptions()),
		]);
		if (result.outbound.status === "send_unknown")
			throw new Error(
				"Delivery is unconfirmed. Sending is locked while Gmail is reconciled.",
			);
		return result;
	};
	return (
		<div className="grid gap-3">
			<WorkDecisionCard
				kind="outbound"
				revisionTarget={
					record.requestVersion
						? { requestId: state.interactionId, version: record.requestVersion }
						: undefined
				}
				title={presentation?.title ?? (state.draft.subject || record.title)}
				askedBy={reviewerName}
				at={state.review?.reviewedAt}
				body={state.draft.body}
				content={
					<div className="grid gap-3">
						<p className="text-kumo-subtle">
							{state.draft.channel} · To {state.draft.recipient}
						</p>
						<ChatMarkdown content={state.draft.body} preserveLineBreaks />
						{presentation && (
							<p className="fd-recommendation">{presentation.recommendation}</p>
						)}
						{ready ? (
							<p className="text-kumo-subtle">Ready for your review</p>
						) : open ? (
							<p className="text-kumo-subtle">
								Your reviewer is checking this revision before approval.
							</p>
						) : null}
						{state.status === "approved_manual" ? (
							<p>Approved for you to send. Delivery is unconfirmed.</p>
						) : state.status === "sent" ? (
							<p>
								{outcome.data?.status === "replied"
									? OS_COPY.learning.replied
									: "Sent through your Gmail account."}
							</p>
						) : state.status === "send_unknown" ||
						  state.status === "sending" ? (
							<p>
								Delivery needs reconciliation in Gmail. Sending is locked to
								prevent a duplicate.
							</p>
						) : null}
					</div>
				}
				why={
					<div className="grid gap-3">
						{presentation && (
							<ChatMarkdown content={state.draft.body} preserveLineBreaks />
						)}
						<p>Reasoning and sources</p>
						<ChatMarkdown content={state.draft.reasoning} />
						{state.review ? (
							<>
								<ChatMarkdown content={state.review.notes} />
								<p>Voice: {state.review.voice}</p>
								<p>Grounding: {state.review.grounding}</p>
								<p>Risks: {state.review.risks}</p>
							</>
						) : null}
						{state.draft.sources.map((source, index) => (
							<p key={`${source.uri}:${index}`}>
								{source.fact} · {source.uri}
							</p>
						))}
						{state.draft.risks.map((risk) => (
							<p key={risk}>{risk}</p>
						))}
						{state.providerReceipt ? (
							<p>Delivery receipt: {state.providerReceipt}</p>
						) : null}
						<Link href={`/work/items/${record.workItemId}`}>View Work</Link>
					</div>
				}
				actions={actions}
				disabled={!open}
				onDecision={decide}
				{...navigation}
				feedbackAction={{ id: "feedback", label: "Send feedback" }}
				editAction={{
					id: "edit",
					label: "Save for review",
					disabled: !recipient.trim(),
				}}
				hasEdits={
					recipient !== state.draft.recipient || subject !== state.draft.subject
				}
				editContent={
					<>
						<Input
							aria-label="Recipient"
							value={recipient}
							onChange={(event) => setRecipient(event.target.value)}
						/>
						<Input
							aria-label="Subject"
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
						/>
						<p className="text-kumo-subtle">
							Save changes for a fresh review, then Send or approve.
						</p>
					</>
				}
			/>
			<div className="flex flex-wrap items-center gap-3">
				{state.draft.providerDraftUrl ? (
					<Link
						href={state.draft.providerDraftUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open {state.draft.channel === "email" ? "Gmail draft" : "draft"}
					</Link>
				) : null}
				<Button
					variant="ghost"
					onClick={async () => {
						await navigator.clipboard.writeText(state.draft.body);
						setCopied(true);
					}}
				>
					{copied ? "Copied" : "Copy text"}
				</Button>
			</div>
			{state.draft.providerDraftUrl && state.draftRevision > 1 ? (
				<Text as="p" role="body" tone="secondary">
					The source draft opens the original wording. Copy the current reviewed
					text and check the recipient and subject before sending there.
				</Text>
			) : null}
		</div>
	);
}

export function OutboundStyleProfile() {
	const client = useQueryClient();
	const query = useQuery(
		osQuery.workInteractions.outbound.profile.queryOptions({ input: {} }),
	);
	const accounts = useQuery(
		osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} }),
	);
	const [account, setAccount] = useState<string | null>(null);
	const learn = useMutation({
		mutationFn: (connectionInstanceId: string) =>
			osApi.workInteractions.outbound.importSentStyle({ connectionInstanceId }),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workInteractions.outbound.key({ type: "query" }),
			}),
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle>{OS_COPY.outboundProfile.title}</CardTitle>
				<CardDescription>{OS_COPY.outboundProfile.description}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3">
				{query.isError ? (
					<Text role="body">{errorMessage(query.error)}</Text>
				) : query.isPending ? (
					<Text role="body">{OS_COPY.outboundProfile.loading}</Text>
				) : (
					<>
						{query.data?.decisionCount ? (
							<Text role="body">
								{OS_COPY.outboundProfile.decisions(query.data.decisionCount)}
							</Text>
						) : null}
						{query.data?.preferences.map((sentence) => (
							<Text key={sentence} role="body">
								{sentence}
							</Text>
						))}
						{query.data?.approvals.length ? (
							query.data.approvals.map((approval, index) => (
								<Collapsible key={approval.id}>
									<CollapsibleDefaultTrigger className="group/disclosure">
										{query.data.lessons[index]}
									</CollapsibleDefaultTrigger>
									<CollapsibleDefaultContent keepMounted>
										<Text as="p" role="body">
											{approval.after}
										</Text>
										{approval.before !== approval.after ? (
											<Text as="p" role="body" tone="secondary">
												Before: {approval.before}
											</Text>
										) : null}
									</CollapsibleDefaultContent>
								</Collapsible>
							))
						) : !query.data?.decisionCount ? (
							<Text role="body">{OS_COPY.outboundProfile.empty}</Text>
						) : null}
					</>
				)}
				<Text role="body" tone="secondary">
					{OS_COPY.outboundProfile.examples(query.data?.sentExamples ?? 0)}
				</Text>
				{query.data?.sentStyleHints.map((hint) => (
					<Text key={hint} role="body" tone="secondary">
						{hint}
					</Text>
				))}
				<Select value={account} onValueChange={setAccount}>
					<SelectTrigger aria-label="Gmail account for style examples">
						<SelectValue placeholder="Choose your Gmail account">
							{
								accounts.data?.find((connection) => connection.id === account)
									?.label
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{accounts.data?.map((connection) => (
							<SelectItem key={connection.id} value={connection.id}>
								{connection.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					disabled={!account || learn.isPending}
					onClick={() => learn.mutate(account!)}
				>
					{learn.isPending
						? OS_COPY.outboundProfile.learning
						: OS_COPY.outboundProfile.learn}
				</Button>
				{learn.isError ? (
					<Text role="body">{errorMessage(learn.error)}</Text>
				) : null}
				<Link href="/account/connections">
					{OS_COPY.outboundProfile.connections}
				</Link>
			</CardContent>
		</Card>
	);
}
