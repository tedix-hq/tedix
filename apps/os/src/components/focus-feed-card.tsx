import { useContext, useEffect, useId, useRef, useState } from "react";
import {
	ChatText,
	CheckCircle,
	CircleHalf,
	Info,
	ListPlus,
	StopCircle,
	XCircle,
} from "@phosphor-icons/react";
import { decisionCardFallbackTitle } from "@tedix/api-contract/utils/decision-card-copy";
import { feedDisplayCard } from "@tedix/api-contract/utils/attention-app-view";
import { FocusRowActions, type FocusRowAction } from "./focus-row-actions";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { FocusItem } from "@tedix/api-contract/utils/focus-feed";
import {
	DecisionContextSection,
	DecisionRailContext,
} from "./decision-context-rail";
import { FeedOutcomePreview } from "./feed-outcome-preview";
import { InternalDecisionUndo } from "./internal-decision-undo";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "./work-actor-avatar";
import { useQuery } from "@tanstack/react-query";
import { workItemDetailQueryOptions } from "@/lib/os-query-options";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetDescription,
} from "./kumo/sheet";
import { useMediaQuery } from "@/lib/use-media-query";
import { WorkItemCommentComposer } from "./work-item-comment-composer";
import { resolveWorkContributor, workActorReference } from "@/lib/work-actor";
import { WorkSourceProvenance } from "./work-source-provenance";
import { Badge } from "./kumo/badge";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { Textarea } from "./kumo/textarea";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import {
	activityHeadline,
	activityStatus,
	type ActivityStatusTone,
} from "@/lib/feed-timeline";
import { OS_COPY } from "@/shared/os-copy";

const STATUS_CHIP = {
	success: { variant: "success", Icon: CheckCircle },
	warning: { variant: "warning", Icon: CircleHalf },
	neutral: { variant: "secondary", Icon: StopCircle },
	error: { variant: "error", Icon: XCircle },
} as const;

function ActivityStatusBadge({
	tone,
	label,
}: {
	tone: ActivityStatusTone;
	label: string;
}) {
	const { variant, Icon } = STATUS_CHIP[tone];
	return (
		<Badge variant={variant} className="gap-1">
			<Icon aria-hidden className="size-3" weight="bold" />
			{label}
		</Badge>
	);
}

const RECEIPT_NOTES = [
	OS_COPY.feed.workExplanation,
	OS_COPY.feed.resultExplanation,
	OS_COPY.feed.correctionExplanation,
];

function PostDiscussion({
	itemId,
	headline,
	open,
	onOpenChange,
	trigger,
}: {
	itemId: string;
	headline: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: HTMLButtonElement;
}) {
	const mobile = useMediaQuery("(max-width: 639px)");
	const list = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const [start, setStart] = useState<number | null>(null);
	const detail = useQuery({
		...workItemDetailQueryOptions(itemId),
		enabled: open,
		refetchInterval: open ? 30_000 : false,
	});
	const directory = useContext(WorkActorDirectoryContext);
	const replies = detail.data?.comments ?? [];
	useEffect(() => {
		if (!open || !detail.data || !list.current) return;
		if (start === null) setStart(Math.max(0, replies.length - 5));
		if (followLatest.current)
			list.current.scrollTop = list.current.scrollHeight;
	}, [open, detail.data, replies.length, start]);
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				keepMounted
				side={mobile ? "bottom" : "right"}
				size="md"
				finalFocus={() => trigger}
				className={
					mobile
						? "h-[min(82dvh,var(--viewport-tedix-height))] overflow-hidden rounded-t-2xl"
						: "overflow-hidden"
				}
			>
				<header className="shrink-0 border-b border-kumo-line px-4 py-4 pe-16">
					<SheetTitle>Comments</SheetTitle>
					<SheetDescription className="mt-1 line-clamp-2">
						<Link href={`/work/items/${itemId}`}>{headline}</Link>
					</SheetDescription>
				</header>
				<div
					ref={list}
					onScroll={({ currentTarget: el }) => {
						followLatest.current =
							el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
					}}
					className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4"
					aria-label="Work discussion"
					role="region"
				>
					{start !== null && start > 0 && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setStart(Math.max(0, (start ?? 0) - 10))}
						>
							Earlier comments
						</Button>
					)}
					{detail.isSuccess && replies.length === 0 && (
						<Text tone="secondary">No comments yet.</Text>
					)}
					{detail.isPending && <Text>Loading comments…</Text>}
					{detail.isError && (
						<Text>
							Could not load comments.{" "}
							<Link href={`/work/items/${itemId}`}>Open task</Link>
						</Text>
					)}
					{replies
						.slice(start ?? Math.max(0, replies.length - 5))
						.map((reply) => {
							const actor = workActorReference(
								reply.authorType,
								reply.authorId,
								reply.metadata,
							);
							const author = resolveWorkContributor(
								actor,
								reply.authorType === "user" ? "Team member" : "Agent",
								directory,
							);
							return (
								<div key={reply.id} className="flex items-start gap-2">
									<WorkActorAvatar actor={actor} name={author.label} />
									<div className="min-w-0">
										<div className="flex flex-wrap items-baseline gap-x-2">
											<Text weight="semibold">{author.label}</Text>
											<time
												dateTime={reply.createdAt}
												title={absoluteTime(reply.createdAt)}
												className="text-xs text-kumo-subtle"
											>
												{relativeTime(reply.createdAt)}
											</time>
										</div>
										<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
											{reply.body}
										</p>
									</div>
								</div>
							);
						})}
				</div>
				<footer className="shrink-0 border-t border-kumo-line p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
					<WorkItemCommentComposer itemId={itemId} compact />
				</footer>
			</SheetContent>
		</Sheet>
	);
}

export function FeedCard({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
	onOpenDiscussion,
	rowActions = [],
}: {
	item: FocusItem;
	actor: string;
	project?: string;
	busy: boolean;
	onOpenDiscussion?: () => void;
	rowActions?: FocusRowAction[];
	onReact: (
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore" | "ask",
		text?: string,
	) => Promise<boolean>;
	onWork: (item: ActivityFeedItem) => Promise<void>;
}) {
	useOsFormattingPreferences();
	const disclosureId = useId();
	const receiptId = `${disclosureId}-receipt`;
	const commentId = `${disclosureId}-note`;
	const article = useRef<HTMLElement>(null);
	const commentTrigger = useRef<HTMLButtonElement>(null);
	const [receipt, setReceipt] = useState(false);
	const [discussionTrigger, setDiscussionTrigger] =
		useState<HTMLButtonElement | null>(null);
	const [discussion, setDiscussion] = useState(false);
	const [comment, setComment] = useState(false);
	const [text, setText] = useState("");
	const [correctionSaved, setCorrectionSaved] = useState(false);
	const closeComment = () => {
		setComment(false);
		const trigger = commentTrigger.current;
		trigger?.focus();
		// A viewport change can hide the desktop trigger while a note is open.
		if (document.activeElement !== trigger)
			article.current
				?.querySelector<HTMLButtonElement>('[aria-label="More actions"]')
				?.focus();
	};
	const rail = useContext(DecisionRailContext);
	const section = `feed-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const directory = useContext(WorkActorDirectoryContext);
	const identity =
		item.actorIdentity ??
		(item.tediId ? { type: "tedi", id: item.tediId } : undefined);
	const resolved = resolveWorkContributor(identity, actor, directory);
	const source = {
		channel: "Work activity",
		capturedAt: item.at,
		evidenceUrl: item.source,
	};
	// A pending choice is a pointer to its Decisions card; the card owns the story.
	const deckCard = ["decision", "approval"].includes(item.kind)
		? item.id.replace(/^decision:/, "")
		: undefined;
	const decisionHref = deckCard
		? `/work?view=deck#card=${encodeURIComponent(deckCard)}`
		: item.source;
	const story = item.needsAction
		? {
				headline:
					item.presentation?.title ??
					decisionCardFallbackTitle(item.sentence, 160),
				detail: "",
			}
		: activityHeadline(item, RECEIPT_NOTES);
	const status = activityStatus(item);
	const options = feedDisplayCard(item).options;
	const quote =
		!!story.detail &&
		(item.kind === "correction" ||
			item.kind === "signal" ||
			identity?.type === "user");
	const more = (
		<Button
			variant="ghost"
			size="sm"
			className="ft-more"
			aria-expanded={receipt}
			aria-controls={receiptId}
			onClick={() => {
				setReceipt((v) => !v);
				if (!receipt) void onReact(item, "why");
			}}
		>
			{receipt ? OS_COPY.feed.timeline.less : OS_COPY.feed.timeline.more}
		</Button>
	);
	return (
		<article
			ref={article}
			aria-label={item.sentence}
			className="fd-story min-w-0"
		>
			<WorkActorAvatar
				actor={identity}
				name={actor}
				className="ft-avatar"
				detail={`${actor}${project ? ` · ${project}` : ""}`}
			/>
			<div className="fd-story-body grid">
				<div className="ft-byline flex-wrap">
					<Text as="span" className="min-w-0 break-words">
						{resolved.label}
					</Text>
					{project && (
						<Text as="span" tone="secondary">
							·{" "}
							{item.projectId ? (
								<Link
									href={`/work/projects/${item.projectId}`}
									variant="record"
								>
									{project}
								</Link>
							) : (
								project
							)}
						</Text>
					)}
					<time dateTime={item.at} title={absoluteTime(item.at)}>
						· {relativeTime(item.at)}
					</time>
				</div>
				<Link
					href={item.needsAction ? decisionHref : item.source}
					variant="record"
					className="ft-post-link"
					aria-label={
						item.needsAction
							? undefined
							: `Open ${item.attachment?.title ?? item.sentence}`
					}
				>
					<span className="ft-sentence">{story.headline}</span>
				</Link>
				{item.presentation?.version === 2 && item.presentation.story && (
					<div className="grid gap-1">
						<Text>{item.presentation.story}</Text>
						{item.presentation.whyMe && (
							<Text>
								<strong>Why you:</strong> {item.presentation.whyMe}
							</Text>
						)}
						<Text>
							<strong>Recommended:</strong> {item.presentation.recommendation}
						</Text>
					</div>
				)}
				{options.length > 0 && (
					<ul aria-label="Options" className="grid gap-1">
						{options.map((option) => (
							<li key={option.id}>
								<strong>
									{option.label}
									{option.recommended && " · Recommended"}
								</strong>
								: {option.consequence}
							</li>
						))}
					</ul>
				)}

				<div className="ft-detail-row">
					{item.needsAction && (
						<Link href={decisionHref} variant="plain" className="ft-chip-link">
							<Badge variant="warning">
								{OS_COPY.feed.timeline.status.needsYou}
							</Badge>
						</Link>
					)}
					{status && <ActivityStatusBadge {...status} />}
					{story.detail && (
						<p
							className={quote ? "ft-detail ft-quote" : "ft-detail"}
							title={story.detail}
						>
							{story.detail}
						</p>
					)}
					{!item.needsAction && more}
				</div>
				{!item.needsAction &&
					(item.attachment || (item.workItemId && item.kind === "result")) && (
						<div className="ft-preview">
							<FeedOutcomePreview item={item} compact />
						</div>
					)}
				{/* Work done on someone's behalf names them up front; other sources sit behind More. */}
				{identity?.contributor && (
					<WorkSourceProvenance actor={identity} name={actor} source={source} />
				)}
				{item.autonomyFeedback && (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || correctionSaved}
						onClick={async () => {
							if (await onReact(item, "ask")) setCorrectionSaved(true);
						}}
					>
						{correctionSaved
							? "I'll ask next time"
							: "This should have asked me"}
					</Button>
				)}
				{item.internalDecisionUndo && (
					<InternalDecisionUndo
						key={`${item.internalDecisionUndo.requestId}:${item.internalDecisionUndo.expectedRevision}`}
						target={item.internalDecisionUndo}
						disabled={busy}
					/>
				)}
				<div className="ft-post-actions flex flex-wrap items-center gap-2">
					{item.workItemId && (
						<Button
							size="sm"
							variant="ghost"
							aria-expanded={discussion}
							aria-haspopup="dialog"
							onClick={(event) => {
								setDiscussionTrigger(event.currentTarget);
								onOpenDiscussion?.();
								setDiscussion(true);
							}}
						>
							<ChatText size={16} aria-hidden />
							Comments
						</Button>
					)}
					<FocusRowActions
						actions={[
							// The first two row reactions stay one click away beside Comment.
							...rowActions.slice(0, 2),
							{
								label: "Private note",
								Icon: ChatText,
								expanded: comment,
								controls: commentId,
								onClick: (trigger) => {
									commentTrigger.current = trigger;
									if (comment) closeComment();
									else setComment(true);
								},
							},
							...rowActions.slice(2),
							{
								label: "Why this update",
								Icon: Info,
								onClick: () => rail?.openSection(section),
							},
							...(item.projectId
								? [
										{
											label: "Turn into Work",
											Icon: ListPlus,
											disabled: busy,
											onClick: () => void onWork(item),
										},
									]
								: []),
						]}
					/>
				</div>
				{discussionTrigger && item.workItemId && (
					<PostDiscussion
						key={item.workItemId}
						itemId={item.workItemId}
						headline={story.headline}
						open={discussion}
						onOpenChange={setDiscussion}
						trigger={discussionTrigger}
					/>
				)}
				<div
					id={receiptId}
					role="region"
					aria-label="Receipt"
					hidden={!receipt}
				>
					{receipt && (
						<div className="focus-receipt">
							<WorkSourceProvenance
								actor={identity}
								name={actor}
								source={source}
								details
							/>
							{!item.attachment && <FeedOutcomePreview item={item} />}
							<Text tone="secondary" className="whitespace-pre-line">
								{item.explanation}
							</Text>
							<Link variant="record" href={item.source}>
								Open receipt
							</Link>
						</div>
					)}
				</div>
				{rail?.activeSection === section && (
					<DecisionContextSection sectionId={section} title="Why this update">
						<WorkSourceProvenance
							actor={identity}
							name={actor}
							source={source}
							details
						/>
						<Text>{item.explanation}</Text>
						{item.because && <Text>{item.because}</Text>}
						<Text tone="secondary">
							Ranked using urgency, importance, value, continuity, freshness and
							the time it takes to read.
						</Text>
					</DecisionContextSection>
				)}
				<div id={commentId} role="region" aria-label="Note" hidden={!comment}>
					{comment && (
						<div className="grid gap-2">
							<Textarea
								aria-label="Your correction"
								value={text}
								onChange={(e) => setText(e.target.value)}
								maxLength={4000}
							/>
							<Button
								disabled={busy || !text.trim()}
								onClick={() =>
									void onReact(item, "comment", text.trim()).then((ok) => {
										if (ok) {
											setText("");
											closeComment();
										}
									})
								}
							>
								Save note
							</Button>
							<Button variant="ghost" onClick={closeComment}>
								Close note
							</Button>
						</div>
					)}
				</div>
			</div>
		</article>
	);
}
