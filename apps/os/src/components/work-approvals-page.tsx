import { ChatCircle, Check, Pulse, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod";
import { ActivityAutoApproval } from "@/components/activity-auto-approval";
import { ActivityHistory } from "@/components/activity-history";
import { MachineApprovalReview } from "@/components/machine-approval-review";
import { ApprovalManifestReview } from "@/components/approval-manifest";
import { ApprovalProvenanceHistory } from "@/components/approval-provenance";
import {
	type ApprovalListItem,
	collapseIdenticalItems,
	useApprovalInbox,
} from "@/components/approval-inbox";
import { BrowserTakeoverLiveView } from "@/components/browser-takeover-live-view";
import { EntityAvatar } from "@/shared/entity-avatar";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { DateTimePicker } from "@/components/kumo/date-picker";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import {
	Page,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { ResponsiveFormSurface } from "@/components/kumo/responsive-form-surface";
import { SelectItem } from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences } from "@/lib/format";
import {
	osQueryKeys,
	workApprovalsQueryOptions,
	workFleetQueryOptions,
	workItemReadinessQueryOptions,
	workSchedulerQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import {
	ApprovalRequestError,
	MutationError,
	PageControls,
	useCursorPaging,
} from "./work-operations-shared";

type ApprovalsTab = "needs-you" | "auto" | "history";

const SOON_MS = 3 * 3_600_000;

const approvalProposalSchema = z.object({
	workItemId: z.string().trim().min(1, "Enter a Work Item id."),
	workItemVersion: z
		.string()
		.regex(/^\d+$/, "Enter a valid Work Item version.")
		.transform(Number)
		.refine((value) => value >= 1, "Version must be at least 1."),
	proposalJson: z.string().refine((value) => {
		try {
			JSON.parse(value);
			return true;
		} catch {
			return false;
		}
	}, "Enter valid proposal JSON."),
	authorityKey: z.string().trim().min(1, "Enter an authority key."),
	approverType: z.enum(["user", "tedi"]),
	approverId: z.string().trim().min(1, "Enter an approver id."),
	requestRationale: z
		.string()
		.trim()
		.min(1, "Explain why authority is needed."),
	expiresAt: z.date().nullable().refine(Boolean, "Choose an expiry."),
});

/** "expires in 20h", or "expired 3h ago" once the window has passed. */
export function expiryLabel(expiresAt: string, now = new Date()): string {
	return Date.parse(expiresAt) <= now.getTime()
		? `expired ${relativeTime(expiresAt, now)}`
		: `expires ${relativeTime(expiresAt, now)}`;
}

export function WorkApprovalsPage() {
	useOsFormattingPreferences();
	const inbox = useApprovalInbox();
	const { workStartPending, count: waiting } = inbox;
	const [tab, setTab] = useState<ApprovalsTab>("needs-you");
	return (
		<Page width="lg">
			<WorkPageHeader
				title="Approvals"
				description="Review requests, manage what can run automatically, and see past decisions."
			/>
			<Tabs
				className="gap-0"
				onValueChange={(value) => setTab(value as ApprovalsTab)}
				value={tab}
			>
				<TabsList aria-label="Approvals" className="-mx-1" variant="line">
					<TabsTrigger className="px-2!" value="needs-you">
						Needs review
						{waiting > 0 ? (
							<Badge className="ml-1.5 tabular-nums" variant="secondary">
								{waiting}
							</Badge>
						) : null}
					</TabsTrigger>
					<TabsTrigger className="px-2!" value="auto">
						Automatic rules
					</TabsTrigger>
					<TabsTrigger className="px-2!" value="history">
						History
					</TabsTrigger>
				</TabsList>
				<TabsContent className="pt-4" value="needs-you">
					<NeedsYou inbox={inbox} workStartPending={workStartPending} />
				</TabsContent>
				<TabsContent className="pt-2" value="auto">
					<Text as="p" className="m-0 pb-1" role="body" tone="secondary">
						Choose what can run without asking each time. Existing permissions
						and safeguards still apply.
					</Text>
					<ActivityAutoApproval canChange={inbox.canDecide} />
				</TabsContent>
				<TabsContent className="pt-2" value="history">
					<ActivityHistory
						canRetry={inbox.canDecide}
						tediNames={inbox.tediNames}
					/>
					<div className="px-4 py-3">
						<ApprovalProvenanceHistory />
					</div>
					<WorkStartHistory />
				</TabsContent>
			</Tabs>
		</Page>
	);
}

type Inbox = ReturnType<typeof useApprovalInbox>;
type WorkStartRow = Awaited<
	ReturnType<typeof osApi.workApprovals.listInbox>
>["data"][number];

function NeedsYou({
	inbox,
	workStartPending,
}: {
	inbox: Inbox;
	workStartPending: readonly WorkStartRow[];
}) {
	const rows = collapseIdenticalItems(inbox.items);
	const recommended = inbox.items.filter(
		(item) => item.recommendation === "approved",
	);
	const [confirmBulk, setConfirmBulk] = useState(false);
	const total = inbox.count;
	// The card leaves the list once decided, so the result is a toast that
	// shows wherever the person has scrolled to.
	async function decide(
		row: readonly ApprovalListItem[],
		choice: "approved" | "rejected",
	) {
		const result = await inbox.decide(row, choice);
		if (!result) {
			toast.error("The decision could not be saved", {
				description: "The request is still waiting. Try again.",
			});
			return;
		}
		if (result.status === "approved") toast.success(result.message);
		else toast.message(result.message);
	}
	return (
		<div className="grid gap-4 pb-24 md:pb-8">
			<ActivityHistory
				attentionOnly
				only="approvals"
				canRetry={inbox.canDecide}
				tediNames={inbox.tediNames}
			/>
			{inbox.error ? (
				<Text as="p" className="m-0" role="body" tone="error">
					The decision could not be saved:{" "}
					{inbox.error instanceof Error ? inbox.error.message : "unknown error"}
					. The request is still waiting.
				</Text>
			) : null}
			{inbox.loading ? (
				<WorkListSkeleton />
			) : inbox.readError ? (
				<WorkReadFailure
					title="Approvals could not be loaded"
					error={inbox.readError}
				/>
			) : total === 0 ? (
				<WorkEmpty
					title="You're all caught up"
					description="When an agent needs your approval, the request will appear here."
				/>
			) : (
				<>
					<div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
						<Text
							as="p"
							className="m-0 tabular-nums"
							role="label"
							tone="secondary"
						>
							{total} waiting · soonest to expire first
						</Text>
						{recommended.length > 1 ? (
							confirmBulk ? (
								<div className="flex flex-wrap items-center gap-2">
									<Button
										disabled={inbox.busy}
										icon={<Check size={14} />}
										onClick={async () => {
											setConfirmBulk(false);
											await decide(recommended, "approved");
										}}
										size="sm"
									>
										Approve these {recommended.length}
									</Button>
									<Button
										onClick={() => setConfirmBulk(false)}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							) : (
								<Button
									disabled={inbox.busy}
									onClick={() => setConfirmBulk(true)}
									size="sm"
									variant="secondary"
								>
									Approve {recommended.length} recommended
								</Button>
							)
						) : null}
					</div>
					{confirmBulk ? (
						<Text as="p" className="m-0" role="label" tone="secondary">
							Recommended for approval. Check each request before approving:{" "}
							{recommended
								.map((item) => sanitizeUntrustedText(item.title))
								.join("; ")}
							.
						</Text>
					) : null}
					{rows.length > 0 ? (
						<ul
							aria-label="Waiting for you"
							className="m-0 grid list-none gap-3 p-0"
						>
							{rows.map((row) => (
								<ApprovalCard
									busy={row.some((item) => inbox.isPending(item.key))}
									key={row[0]!.key}
									onDecide={(choice) => void decide(row, choice)}
									row={row}
								/>
							))}
						</ul>
					) : null}
					{inbox.hidden > 0 ? (
						<Text as="p" className="m-0" role="label" tone="secondary">
							{inbox.hidden} more are waiting. Decide some of these to see them.
						</Text>
					) : null}
					{workStartPending.length > 0 ? (
						<WorkStartCards rows={workStartPending} />
					) : null}
				</>
			)}
			{inbox.expired.length > 0 ? <ExpiredRequests inbox={inbox} /> : null}
		</div>
	);
}

function ApprovalCard({
	row,
	busy,
	onDecide,
}: {
	row: readonly ApprovalListItem[];
	busy: boolean;
	onDecide: (choice: "approved" | "rejected") => void;
}) {
	const item = row[0]!;
	const repeats = row.length;
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [linkedOpen, setLinkedOpen] = useState(false);
	const title = sanitizeUntrustedText(item.title);
	const expiresAt = item.expiresAt;
	const soon =
		expiresAt !== null && Date.parse(expiresAt) - Date.now() < SOON_MS;
	const who = item.tedi ? sanitizeUntrustedText(item.tedi.name) : "an agent";
	return (
		<Surface
			aria-label={title}
			className="grid min-w-0 gap-3 p-4"
			data-approval-card=""
			render={<li />}
		>
			<div className="flex min-w-0 items-start gap-3">
				{item.tedi ? (
					<EntityAvatar
						className="mt-0.5 size-8 shrink-0"
						id={item.tedi.id}
						kind="tedi"
						name={item.tedi.name}
					/>
				) : (
					<span
						aria-hidden
						className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle"
					>
						<Pulse size={16} />
					</span>
				)}
				<div className="grid min-w-0 flex-1 gap-1">
					<Text as="h3" className="m-0 break-words" role="body" tone="strong">
						{title}
					</Text>
					{item.details.length > 0 ? (
						<Text as="p" className="m-0 break-words" role="label">
							{sanitizeUntrustedText(item.details.join(" · "))}
						</Text>
					) : null}
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle type-tedix-label">
						<span className="min-w-0 break-words">
							Asked by {who}
							{item.where ? ` in ${sanitizeUntrustedText(item.where)}` : ""}
						</span>
						{item.requestedAt ? (
							<time
								dateTime={item.requestedAt}
								title={absoluteTime(item.requestedAt)}
							>
								{relativeTime(item.requestedAt)}
							</time>
						) : null}
						{repeats > 1 ? (
							<Badge variant="outline">{repeats} identical</Badge>
						) : null}
						{item.chip.tone === "error" ? (
							<Badge variant="error">{item.chip.label}</Badge>
						) : null}
					</div>
				</div>
				{expiresAt ? (
					<Badge
						className="shrink-0"
						title={`Expires ${absoluteTime(expiresAt)}`}
						variant={soon ? "warning" : "outline"}
					>
						<time dateTime={expiresAt}>{expiryLabel(expiresAt)}</time>
					</Badge>
				) : null}
			</div>
			<MachineApprovalReview
				payload={
					item.raw && typeof item.raw === "object" && !Array.isArray(item.raw)
						? (item.raw as Record<string, unknown>).payload
						: null
				}
			/>
			<Text as="p" className="m-0" role="body">
				<span className="text-kumo-subtle">If you approve: </span>
				{item.ifApproved}
			</Text>
			<Text as="p" className="m-0" role="label" tone="secondary">
				Tedix suggests:{" "}
				<strong className="font-medium text-kumo-default">
					{item.recommendation === "approved" ? "approve" : "reject"}
				</strong>
				. {item.recommendationReason}
			</Text>
			{item.actionType === "browser.live_view_takeover" &&
			item.target.plane === "runtime" ? (
				<BrowserTakeoverLiveView approvalId={item.target.approvalId} />
			) : null}
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Button
					disabled={busy}
					icon={<Check size={14} />}
					loading={busy}
					onClick={() => onDecide("approved")}
				>
					{repeats > 1 ? `Approve all ${repeats}` : "Approve"}
				</Button>
				<Button
					disabled={busy}
					icon={<X size={14} />}
					onClick={() => onDecide("rejected")}
					variant="secondary"
				>
					{repeats > 1 ? `Reject all ${repeats}` : "Reject"}
				</Button>
				{item.conversationId ? (
					<Link
						className="inline-flex min-h-9 items-center gap-1.5 px-2 type-tedix-control"
						href={`/chat?conversation=${encodeURIComponent(item.conversationId)}`}
					>
						<ChatCircle aria-hidden size={14} />
						Ask the tedi
					</Link>
				) : null}
			</div>
			<Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
				<CollapsibleDefaultTrigger className="group/disclosure -mx-2 w-fit px-2 text-kumo-subtle">
					Details
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<dl className="m-0 mt-2 grid gap-2 type-tedix-label">
						{[
							["What it does", item.what],
							["If you reject", item.ifRejected],
							["Why it is waiting", item.technical ?? item.chip.label],
						].map(([label, text]) => (
							<div className="grid gap-0.5" key={label}>
								<dt className="text-kumo-subtle">{label}</dt>
								<dd className="m-0 break-words text-kumo-default">
									{sanitizeUntrustedText(text ?? "")}
								</dd>
							</div>
						))}
					</dl>
					{item.raw ? (
						<CodeBlock
							className="mt-2 max-h-64 overflow-auto"
							code={JSON.stringify(item.raw, null, 2)}
							lang="json"
							showCopyButton
						/>
					) : null}
					{item.target.plane === "runtime" ? (
						<div className="mt-2 grid gap-2">
							{linkedOpen ? (
								<ApprovalManifestReview
									approvalRequestIds={[item.target.approvalId]}
									onClose={() => setLinkedOpen(false)}
								/>
							) : (
								<Button
									className="w-fit"
									onClick={() => setLinkedOpen(true)}
									size="sm"
									variant="ghost"
								>
									Check linked requests
								</Button>
							)}
						</div>
					) : null}
				</CollapsibleDefaultContent>
			</Collapsible>
		</Surface>
	);
}

function ExpiredRequests({ inbox }: { inbox: Inbox }) {
	return (
		<section aria-labelledby="expired-approvals-title" className="grid gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="grid gap-0.5">
					<Text
						as="h2"
						className="m-0"
						id="expired-approvals-title"
						role="label"
						tone="strong"
					>
						Expired · {inbox.expired.length}
					</Text>
					<Text as="p" className="m-0" role="label" tone="secondary">
						No one answered in time, so these did not run.
					</Text>
				</div>
				<Button
					disabled={inbox.clearExpired.isPending}
					onClick={() => inbox.clearExpired.mutate()}
					size="sm"
					variant="secondary"
				>
					Clear expired
				</Button>
			</div>
			<ul className="m-0 grid list-none divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline p-0">
				{inbox.expired.map((item) => (
					<li
						className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
						key={item.key}
					>
						<Text as="span" className="min-w-0 truncate" role="label">
							{sanitizeUntrustedText(item.title)}
						</Text>
						{item.expiresAt ? (
							<Text
								as="span"
								className="shrink-0"
								role="label"
								tone="secondary"
							>
								{expiryLabel(item.expiresAt)}
							</Text>
						) : null}
					</li>
				))}
			</ul>
			<MutationError error={inbox.clearExpired.error} />
		</section>
	);
}

function useWorkStartDecision() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({
			proposalId,
			version,
			decision,
		}: {
			proposalId: string;
			version: number;
			decision: "approved" | "rejected";
			workItemId: string;
		}) =>
			osApi.workApprovals.decide({
				proposalId,
				expectedProposalVersion: version,
				decision,
				rationale:
					decision === "approved"
						? "Approved on the Approvals page."
						: "Rejected on the Approvals page.",
			}),
		onSuccess: async (_value, variables) => {
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workApprovals() }),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(variables.workItemId)
						.queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
}

function WorkStartCards({ rows }: { rows: readonly WorkStartRow[] }) {
	const decide = useWorkStartDecision();
	return (
		<section aria-labelledby="work-start-title" className="grid gap-2">
			<Text
				as="h2"
				className="m-0"
				id="work-start-title"
				role="label"
				tone="strong"
			>
				Work waiting to start
			</Text>
			<ul className="m-0 grid list-none gap-3 p-0">
				{rows.map(({ proposal, workItem }) => (
					<Surface
						className="grid min-w-0 gap-3 p-4"
						data-approval-card=""
						key={proposal.id}
						render={<li />}
					>
						<div className="flex min-w-0 items-start justify-between gap-3">
							<div className="grid min-w-0 gap-1">
								<Text
									as="h3"
									className="m-0 break-words"
									role="body"
									tone="strong"
								>
									Start{" "}
									{workItem ? (
										<Link variant="record" href={`/work/items/${workItem.id}`}>
											{workItem.title}
										</Link>
									) : (
										"a Work item"
									)}
								</Text>
								<Text
									as="p"
									className="m-0 break-words"
									role="label"
									tone="secondary"
								>
									{sanitizeUntrustedText(proposal.requestRationale)}
								</Text>
							</div>
							<Badge
								className="shrink-0"
								title={`Expires ${absoluteTime(proposal.expiresAt)}`}
								variant="outline"
							>
								{expiryLabel(proposal.expiresAt)}
							</Badge>
						</div>
						<Text as="p" className="m-0" role="body">
							<span className="text-kumo-subtle">If you approve: </span>
							the Work item may start with the scope it asked for.
						</Text>
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={decide.isPending}
								icon={<Check size={14} />}
								onClick={() =>
									decide.mutate({
										proposalId: proposal.id,
										version: proposal.version,
										decision: "approved",
										workItemId: proposal.workItemId,
									})
								}
							>
								Approve
							</Button>
							<Button
								disabled={decide.isPending}
								icon={<X size={14} />}
								onClick={() =>
									decide.mutate({
										proposalId: proposal.id,
										version: proposal.version,
										decision: "rejected",
										workItemId: proposal.workItemId,
									})
								}
								variant="secondary"
							>
								Reject
							</Button>
						</div>
						<Collapsible>
							<CollapsibleDefaultTrigger className="-mx-2 w-fit px-2 text-kumo-subtle">
								Details
							</CollapsibleDefaultTrigger>
							<CollapsibleDefaultContent>
								<CodeBlock
									className="mt-2 max-h-64 overflow-auto"
									code={JSON.stringify(
										{
											action: proposal.action,
											authority: proposal.authorityKey,
											proposal: proposal.proposal,
										},
										null,
										2,
									)}
									lang="json"
									showCopyButton
								/>
							</CollapsibleDefaultContent>
						</Collapsible>
					</Surface>
				))}
			</ul>
			{decide.isSuccess ? (
				<div role="status">
					<Text as="p" className="m-0" role="body">
						{decide.variables?.decision === "approved"
							? "Approved. The Work item can start."
							: "Rejected. The Work item stays waiting."}
					</Text>
				</div>
			) : null}
			<MutationError error={decide.error} />
		</section>
	);
}

function WorkStartHistory() {
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const query = useQuery(workApprovalsQueryOptions(paging.cursor));
	const [mobileProposalOpen, setMobileProposalOpen] = useState(false);
	const propose = useMutation({
		mutationFn: (value: z.output<typeof approvalProposalSchema>) =>
			osApi.workApprovals.propose({
				workItemId: value.workItemId,
				workItemVersion: value.workItemVersion,
				proposal: JSON.parse(value.proposalJson) as never,
				authorityKey: value.authorityKey,
				approverType: value.approverType,
				approverId: value.approverId,
				requestRationale: value.requestRationale,
				expiresAt: value.expiresAt?.toISOString() ?? "",
			}),
		onSuccess: async (_result, value) => {
			form.setFieldValue("proposalJson", "{}");
			form.setFieldValue("requestRationale", "");
			paging.reset();
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workApprovals() }),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(value.workItemId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	const form = useZodForm({
		schema: approvalProposalSchema,
		defaultValues: {
			workItemId: "",
			workItemVersion: "1",
			proposalJson: "{}",
			authorityKey: "",
			approverType: "user",
			approverId: "",
			requestRationale: "",
			expiresAt: null,
		},
		validateOn: "submit",
		onSubmit: ({ value }) => propose.mutate(value),
	});
	const rows = (query.data?.data ?? []).filter(
		({ effectiveStatus, canDecide }) =>
			effectiveStatus !== "pending" || !canDecide,
	);
	return (
		<PageSection
			aria-labelledby="work-start-history-title"
			className="pb-24 md:pb-8"
		>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="work-start-history-title">
						Work start approvals
					</SectionTitle>
					<SectionDescription>
						Decisions that let a Work item start, and requests waiting on
						someone else.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{query.isPending ? (
				<WorkListSkeleton />
			) : query.isError ? (
				<WorkReadFailure
					title="Work start approvals unavailable"
					error={query.error}
				/>
			) : rows.length === 0 ? (
				<WorkEmpty
					title="No Work start approvals"
					description="Approvals a Work item needed before it could start appear here."
				/>
			) : (
				<ul className="m-0 grid list-none divide-y divide-kumo-hairline p-0">
					{rows.map(({ proposal, effectiveStatus, workItem }) => (
						<li
							className="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-3"
							key={proposal.id}
						>
							<div className="grid min-w-0 gap-0.5">
								<Text as="span" className="truncate" role="body" tone="strong">
									{workItem ? (
										<Link variant="record" href={`/work/items/${workItem.id}`}>
											{workItem.title}
										</Link>
									) : (
										"Work item"
									)}
								</Text>
								<Text
									as="span"
									className="line-clamp-2"
									role="label"
									tone="secondary"
								>
									{sanitizeUntrustedText(proposal.requestRationale)}
								</Text>
							</div>
							<Badge
								className="w-fit"
								variant={
									effectiveStatus === "approved"
										? "success"
										: effectiveStatus === "rejected"
											? "error"
											: effectiveStatus === "pending"
												? "outline"
												: "warning"
								}
							>
								{effectiveStatus === "pending"
									? "Waiting on someone else"
									: effectiveStatus.charAt(0).toUpperCase() +
										effectiveStatus.slice(1)}
							</Badge>
						</li>
					))}
				</ul>
			)}
			<PageControls
				hasPrevious={paging.hasPrevious}
				hasNext={Boolean(query.data?.hasMore && query.data.nextCursor)}
				onPrevious={paging.reset}
				onBack={paging.previous}
				onNext={() => {
					if (query.data?.nextCursor) paging.next(query.data.nextCursor);
				}}
			/>
			<ResponsiveFormSurface
				collapse="always"
				title="Ask someone to approve a Work item"
				description="Send a new approval request to another person or tedi."
				mobileDescription="Send a new approval request to another person or tedi."
				mobileOpen={mobileProposalOpen}
				onMobileOpenChange={setMobileProposalOpen}
			>
				<form
					className="grid gap-3 md:grid-cols-2"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void form.handleSubmit();
					}}
				>
					{(
						[
							["workItemId", "Work Item id"],
							["workItemVersion", "Work Item version"],
							["authorityKey", "Authority key"],
							["approverId", "Approver id"],
						] as const
					).map(([name, label]) => (
						<FormField key={name} form={form} name={name} label={label}>
							{(field, meta) => <FormInput field={field} {...meta} />}
						</FormField>
					))}
					<FormField form={form} name="approverType" label="Approver type">
						{(field, meta) => (
							<FormSelect field={field} {...meta}>
								<SelectItem value="user">Person</SelectItem>
								<SelectItem value="tedi">Tedi</SelectItem>
							</FormSelect>
						)}
					</FormField>
					<FormField form={form} name="expiresAt" label="Expiry">
						{(field, meta) => (
							<DateTimePicker
								id={meta.id}
								aria-label="Approval expiry"
								aria-describedby={meta.errorId ?? meta.descriptionId}
								aria-invalid={meta.invalid}
								min={new Date()}
								onChange={field.handleChange}
								value={field.state.value}
							/>
						)}
					</FormField>
					<FormField
						form={form}
						name="requestRationale"
						label="Why it is needed"
					>
						{(field, meta) => <FormTextarea field={field} {...meta} />}
					</FormField>
					<FormField form={form} name="proposalJson" label="Proposal JSON">
						{(field, meta) => (
							<FormTextarea
								field={field}
								{...meta}
								className="min-h-32 font-mono"
							/>
						)}
					</FormField>
					<Button
						className="md:col-span-2"
						disabled={propose.isPending}
						type="submit"
					>
						Send request
					</Button>
					<ApprovalRequestError error={propose.error} />
				</form>
			</ResponsiveFormSurface>
		</PageSection>
	);
}
