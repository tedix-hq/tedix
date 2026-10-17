import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	reviewedOutbound,
	type OutboundRecord,
	type OutboundDraft,
} from "@tedix/api-contract/schemas/outbound";
import { osApi } from "@/lib/api";
import {
	osQuery,
	osQueryKeys,
	tediRosterQueryOptions,
	workAttentionQueryOptions,
} from "@/lib/os-query-options";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Textarea } from "@/components/kumo/textarea";
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
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
	PageDescription,
} from "@/components/kumo/page";
import { errorMessage } from "@/lib/orpc-error";

export function OutboundCard({ workItemId }: { workItemId: string }) {
	const query = useQuery(
		osQuery.workInteractions.outbound.get.queryOptions({
			input: { workItemId },
		}),
	);
	if (query.isError)
		return <Text role="body">{errorMessage(query.error)}</Text>;
	if (!query.data) return <Text role="body">Loading outbound draft…</Text>;
	return (
		<OutboundReviewCard
			key={`${query.data.workItemId}:${query.data.version}`}
			record={query.data}
		/>
	);
}

export function OutboundReviewCard({ record }: { record: OutboundRecord }) {
	const client = useQueryClient();
	const state = record.outbound;
	const roster = useQuery(tediRosterQueryOptions(100));
	const reviewer = roster.data?.data.find(
		(tedi) => tedi.id === state.reviewerTediId,
	);
	const reviewerName =
		reviewer?.displayName || reviewer?.name || "Reviewer tedi";
	const [editing, setEditing] = useState(false);
	const [givingFeedback, setGivingFeedback] = useState(false);
	const [body, setBody] = useState(state.draft.body);
	const [recipient, setRecipient] = useState(state.draft.recipient);
	const [subject, setSubject] = useState(state.draft.subject);
	const [feedback, setFeedback] = useState("");
	const [account, setAccount] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const connections = useQuery(
		osQuery.workInteractions.outbound.accounts.queryOptions({ input: {} }),
	);
	const accounts = connections.data ?? [];
	const act = useMutation({
		mutationFn: (value: {
			action:
				| "approve_manual"
				| "approve_send"
				| "edit"
				| "feedback"
				| "reject";
			draft?: OutboundDraft;
			body?: string;
			feedback?: string;
			connectionInstanceId?: string;
		}) =>
			osApi.workInteractions.outbound.act({
				workItemId: record.workItemId,
				expectedVersion: record.version,
				...value,
			}),
		onSettled: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workInteractions() }),
				client.invalidateQueries({ queryKey: osQuery.workItems.key() }),
				client.invalidateQueries({
					queryKey: workAttentionQueryOptions().queryKey,
				}),
			]);
		},
	});
	const ready = reviewedOutbound(state);
	const open = ["reviewing", "waiting_on_you", "feedback"].includes(
		state.status,
	);
	const review = state.review;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					<Badge variant="info">Outbound</Badge>
					{state.draft.subject || record.title}
				</CardTitle>
				<CardDescription>
					{state.draft.channel} · To {state.draft.recipient} ·{" "}
					{state.status.replaceAll("_", " ")}
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-5">
				{editing ? (
					<div className="grid gap-3">
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
						<Textarea
							aria-label="Edit outbound draft"
							rows={14}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					</div>
				) : (
					<ChatMarkdown content={state.draft.body} preserveLineBreaks />
				)}
				{review ? (
					<section className="grid gap-2" aria-label="Reviewer notes">
						<Text as="p" role="label">
							{reviewerName}: {review.verdict.replaceAll("_", " ")}
						</Text>
						<ChatMarkdown content={review.notes} />
						<Text as="p" role="body" tone="secondary">
							Voice: {review.voice}
						</Text>
						<Text as="p" role="body" tone="secondary">
							Grounding: {review.grounding}
						</Text>
						<Text as="p" role="body" tone="secondary">
							Risks: {review.risks}
						</Text>
					</section>
				) : (
					<Text as="p" role="body" tone="secondary">
						Your reviewer tedi is checking voice, sources and commitments.
						Approval becomes available after this revision is marked ready.
					</Text>
				)}
				<details>
					<summary>Reasoning and sources</summary>
					<div className="grid gap-3 py-3">
						<ChatMarkdown content={state.draft.reasoning} />
						{state.draft.sources.map((source, index) => (
							<div key={`${source.uri}:${index}`}>
								<Text as="p" role="body">
									{source.fact}
								</Text>
								<Text as="p" role="label" tone="secondary">
									{source.uri}
								</Text>
							</div>
						))}
						{state.draft.risks.map((risk) => (
							<Text as="p" role="body" key={risk}>
								{risk}
							</Text>
						))}
						<Text as="p" role="label" tone="secondary">
							Author: {state.author.type} ·{" "}
							{state.author.sessionId ?? state.author.id}. Reviewer:{" "}
							{state.reviewerTediId}. Draft revision {state.draftRevision}.
						</Text>
					</div>
				</details>
				{givingFeedback ? (
					<Textarea
						aria-label="Feedback for reviewer"
						rows={3}
						value={feedback}
						onChange={(event) => setFeedback(event.target.value)}
						placeholder="What should change?"
					/>
				) : null}
				{open && state.draft.channel === "email" ? (
					<div className="grid gap-2">
						<Select value={account} onValueChange={setAccount}>
							<SelectTrigger aria-label="Your Gmail account">
								<SelectValue placeholder="Choose your Gmail account" />
							</SelectTrigger>
							<SelectContent>
								{accounts.map((connection) => (
									<SelectItem key={connection.id} value={connection.id}>
										{connection.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Link href="/account/connections">
							Manage Gmail connection and compose consent
						</Link>
					</div>
				) : null}
				{act.isError ? (
					<Text as="p" role="body">
						{errorMessage(act.error)}
					</Text>
				) : null}
				{open ? (
					<div className="flex flex-wrap gap-2">
						{editing ? (
							<>
								<Button
									disabled={
										act.isPending ||
										!body.trim() ||
										!recipient.trim() ||
										(body === state.draft.body &&
											recipient === state.draft.recipient &&
											subject === state.draft.subject)
									}
									onClick={() =>
										act.mutate({
											action: "edit",
											draft: { ...state.draft, body, recipient, subject },
										})
									}
								>
									Save for review
								</Button>
								<Button variant="ghost" onClick={() => setEditing(false)}>
									Cancel edit
								</Button>
							</>
						) : (
							<>
								{state.draft.channel === "email" ? (
									<Button
										disabled={act.isPending || !ready || !account}
										onClick={() =>
											act.mutate({
												action: "approve_send",
												connectionInstanceId: account!,
											})
										}
									>
										Approve &amp; send
									</Button>
								) : null}
								<Button
									variant="outline"
									disabled={act.isPending || !ready}
									onClick={() => act.mutate({ action: "approve_manual" })}
								>
									Approve (I'll send)
								</Button>
								<Button
									variant="outline"
									disabled={act.isPending}
									onClick={() => setEditing(true)}
								>
									Edit
								</Button>
							</>
						)}
						{givingFeedback ? (
							<Button
								disabled={act.isPending || !feedback.trim()}
								onClick={() => act.mutate({ action: "feedback", feedback })}
							>
								Send feedback
							</Button>
						) : (
							<Button
								variant="ghost"
								disabled={act.isPending}
								onClick={() => setGivingFeedback(true)}
							>
								Feedback
							</Button>
						)}
						<Button
							variant="ghost"
							disabled={act.isPending}
							onClick={() =>
								act.mutate({
									action: "reject",
									feedback: feedback.trim() || undefined,
								})
							}
						>
							Reject
						</Button>
					</div>
				) : null}
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
					<Link href={`/work/items/${record.workItemId}`}>View Work</Link>
				</div>
				{state.status === "approved_manual" ? (
					<Text as="p" role="body">
						Approved for you to send. Approval is saved as positive feedback;
						delivery is still unconfirmed.
					</Text>
				) : state.status === "sent" ? (
					<Text as="p" role="body">
						Sent through your Gmail account. Receipt: {state.providerReceipt}
					</Text>
				) : state.status === "send_unknown" || state.status === "sending" ? (
					<Text as="p" role="body">
						Delivery needs reconciliation in Gmail. Sending is locked to prevent
						a duplicate.
					</Text>
				) : (
					<Text as="p" role="label" tone="secondary">
						Your approval is positive feedback. Edits and feedback teach your
						style and the reviewer. Nothing is sent until you click Approve
						&amp; send.
					</Text>
				)}
			</CardContent>
		</Card>
	);
}

export function OutboundPage() {
	const query = useQuery(
		osQuery.workInteractions.outbound.list.queryOptions({
			input: { limit: 50 },
		}),
	);
	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>Outbound</PageTitle>
					<PageDescription>
						Drafts, reviews and human decisions, kept with their originating
						Work.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<Link href="/account/profile">
				Your style profile and last 10 approvals
			</Link>
			{query.isError ? (
				<Text role="body">{errorMessage(query.error)}</Text>
			) : query.data?.length === 0 ? (
				<Text role="body">No outbound drafts yet.</Text>
			) : (
				query.data?.map((record) => (
					<OutboundReviewCard
						key={`${record.workItemId}:${record.version}`}
						record={record}
					/>
				))
			)}
		</Page>
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
			client.invalidateQueries({ queryKey: osQueryKeys.workInteractions() }),
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle>What we learned from your last 10 approvals</CardTitle>
				<CardDescription>
					Your own choices are the style examples used by your reviewer.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3">
				{query.isError ? (
					<Text role="body">{errorMessage(query.error)}</Text>
				) : query.data?.approvals.length ? (
					query.data.approvals.map((approval, index) => (
						<details key={approval.id}>
							<summary>{query.data.lessons[index]}</summary>
							<Text as="p" role="body">
								{approval.after}
							</Text>
							{approval.before !== approval.after ? (
								<Text as="p" role="body" tone="secondary">
									Before: {approval.before}
								</Text>
							) : null}
						</details>
					))
				) : (
					<Text role="body">
						No approvals yet. Your first approval or edit starts your profile.
					</Text>
				)}
				<Text role="body" tone="secondary">
					{query.data?.sentExamples ?? 0} sent-mail examples. You can import the
					plain text of your last 10 sent emails to teach your voice.
				</Text>
				{query.data?.sentStyleHints.map((hint) => (
					<Text key={hint} role="body" tone="secondary">
						{hint}
					</Text>
				))}
				<Select value={account} onValueChange={setAccount}>
					<SelectTrigger aria-label="Gmail account for style examples">
						<SelectValue placeholder="Choose your Gmail account" />
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
					Learn from my last 10 sent emails
				</Button>
				{learn.isError ? (
					<Text role="body">{errorMessage(learn.error)}</Text>
				) : null}
				<Link href="/account/connections">
					Manage read consent in Connections
				</Link>
			</CardContent>
		</Card>
	);
}
