import { useContext, useState } from "react";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { FocusItem } from "@/lib/focus-feed";
import {
	DecisionContextSection,
	DecisionRailContext,
} from "./decision-context-rail";
import { FeedOutcomePreview } from "./feed-outcome-preview";
import { WorkActorAvatar } from "./work-actor-avatar";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { Textarea } from "./kumo/textarea";
import { absoluteTime, relativeTime } from "@/lib/time";

export function FeedCard({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
}: {
	item: FocusItem;
	actor: string;
	project?: string;
	busy: boolean;
	onReact: (
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore",
		text?: string,
	) => Promise<boolean>;
	onWork: (item: ActivityFeedItem) => Promise<void>;
}) {
	const [receipt, setReceipt] = useState(false);
	const [comment, setComment] = useState(false);
	const [text, setText] = useState("");
	const rail = useContext(DecisionRailContext);
	const section = `feed-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	return (
		<article aria-label={item.sentence} className="fd-story min-w-0">
			<WorkActorAvatar
				actor={
					item.actorIdentity ??
					(item.tediId ? { type: "tedi", id: item.tediId } : undefined)
				}
				name={actor}
				className="ft-avatar"
				detail={`${actor}${project ? ` · ${project}` : ""}`}
			/>
			<div className="fd-story-body grid gap-3">
				<div className="ft-byline">
					<Text weight="semibold">{project ?? actor}</Text>
					<time dateTime={item.at} title={absoluteTime(item.at)}>
						· {relativeTime(item.at)}
					</time>
				</div>
				<Link
					href={item.source}
					className="ft-post-link"
					aria-label={`Open ${item.attachment?.title ?? item.sentence}`}
				>
					<Text className="ft-sentence">{item.sentence}</Text>
				</Link>
				<div className="focus-receipt-actions">
					<Button
						size="sm"
						variant="ghost"
						aria-label="Receipt"
						aria-expanded={receipt}
						onClick={() => {
							setReceipt((v) => !v);
							if (!receipt) void onReact(item, "why");
						}}
					>
						Receipt
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-label="Comment"
						aria-expanded={comment}
						onClick={() => setComment((v) => !v)}
					>
						Note
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-label="Why this update"
						onClick={() => rail?.openSection(section)}
					>
						Why this
					</Button>
					{item.projectId && (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							aria-label="Turn into Work"
							onClick={() => void onWork(item)}
						>
							Make a task
						</Button>
					)}
				</div>
				{receipt && (
					<div className="focus-receipt">
						<FeedOutcomePreview item={item} />
						<Text tone="secondary">{item.explanation}</Text>
						<Link href={item.source}>Open receipt</Link>
					</div>
				)}
				{rail?.activeSection === section && (
					<DecisionContextSection sectionId={section} title="Why this update">
						<Text>{item.explanation}</Text>
						<Text tone="secondary">
							Ranked using urgency, importance, value, continuity, freshness and
							the time it takes to read.
						</Text>
					</DecisionContextSection>
				)}
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
										setComment(false);
									}
								})
							}
						>
							Save note
						</Button>
					</div>
				)}
			</div>
		</article>
	);
}
