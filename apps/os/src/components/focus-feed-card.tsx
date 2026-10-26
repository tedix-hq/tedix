import { useContext, useId, useRef, useState } from "react";
import { ChatText, Info, ListPlus } from "@phosphor-icons/react";
import { decisionCardFallbackTitle } from "@tedix/api-contract/utils/decision-card-copy";
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
import { resolveWorkContributor } from "@/lib/work-actor";
import { WorkSourceProvenance } from "./work-source-provenance";
import { Badge } from "./kumo/badge";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { Textarea } from "./kumo/textarea";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { activityHeadline, activityStatus } from "@/lib/feed-timeline";
import { OS_COPY } from "@/shared/os-copy";

const RECEIPT_NOTES = [
	OS_COPY.feed.workExplanation,
	OS_COPY.feed.resultExplanation,
	OS_COPY.feed.correctionExplanation,
];

export function FeedCard({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
	rowActions = [],
}: {
	item: FocusItem;
	actor: string;
	project?: string;
	busy: boolean;
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
			{receipt ? "Less" : "More"}
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
				<div className="ft-detail-row">
					{item.needsAction && (
						<Link href={decisionHref} variant="plain" className="ft-chip-link">
							<Badge variant="warning">Needs you</Badge>
						</Link>
					)}
					{status && (
						<Badge variant={status.tone === "success" ? "success" : "error"}>
							{status.label}
						</Badge>
					)}
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
				{!item.needsAction && item.attachment && (
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
				<FocusRowActions
					actions={[
						// The first two row reactions stay one click away beside Comment.
						...rowActions.slice(0, 2),
						{
							label: "Comment",
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
