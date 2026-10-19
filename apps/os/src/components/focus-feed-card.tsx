import { useContext, useState } from "react";
import { ChatText, Info, ListPlus, Receipt } from "@phosphor-icons/react";
import { FocusRowActions, type FocusRowAction } from "./focus-row-actions";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { FocusItem } from "@tedix/api-contract/utils/focus-feed";
import {
	DecisionContextSection,
	DecisionRailContext,
} from "./decision-context-rail";
import { FeedOutcomePreview } from "./feed-outcome-preview";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "./work-actor-avatar";
import { resolveWorkContributor } from "@/lib/work-actor";
import { WorkSourceProvenance } from "./work-source-provenance";
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
	const [receipt, setReceipt] = useState(false);
	const [comment, setComment] = useState(false);
	const [text, setText] = useState("");
	const [correctionSaved, setCorrectionSaved] = useState(false);
	const rail = useContext(DecisionRailContext);
	const section = `feed-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const directory = useContext(WorkActorDirectoryContext);
	const identity =
		item.actorIdentity ??
		(item.tediId ? { type: "tedi", id: item.tediId } : undefined);
	const resolved = resolveWorkContributor(identity, actor, directory);
	const source = {
		channel: "Work feed",
		capturedAt: item.at,
		evidenceUrl: item.source,
	};
	return (
		<article aria-label={item.sentence} className="fd-story min-w-0">
			<WorkActorAvatar
				actor={identity}
				name={actor}
				className="ft-avatar"
				detail={`${actor}${project ? ` · ${project}` : ""}`}
			/>
			<div className="fd-story-body grid gap-3">
				<div className="ft-byline flex-wrap">
					<Text as="span" weight="semibold" className="min-w-0 break-words">
						{resolved.label}
					</Text>
					{project && (
						<Text as="span" tone="secondary">
							· {project}
						</Text>
					)}
					<time dateTime={item.at} title={absoluteTime(item.at)}>
						· {relativeTime(item.at)}
					</time>
				</div>
				<Link
					href={item.source}
					variant="record"
					className="ft-post-link"
					aria-label={`Open ${item.attachment?.title ?? item.sentence}`}
				>
					<Text className="ft-sentence font-medium">{item.sentence}</Text>
				</Link>
				{(identity?.type === "external_agent" || identity?.contributor) && (
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
				<FocusRowActions
					actions={[
						{
							label: "Receipt",
							Icon: Receipt,
							expanded: receipt,
							onClick: () => {
								setReceipt((v) => !v);
								if (!receipt) void onReact(item, "why");
							},
						},
						{
							label: "Comment",
							Icon: ChatText,
							expanded: comment,
							onClick: () => setComment((v) => !v),
						},
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
						...rowActions,
					]}
				/>
				{receipt && (
					<div className="focus-receipt">
						<WorkSourceProvenance
							actor={identity}
							name={actor}
							source={source}
							details
						/>
						<FeedOutcomePreview item={item} />
						<Text tone="secondary">{item.explanation}</Text>
						<Link variant="record" href={item.source}>
							Open receipt
						</Link>
					</div>
				)}
				{rail?.activeSection === section && (
					<DecisionContextSection sectionId={section} title="Why this update">
						<WorkSourceProvenance
							actor={identity}
							name={actor}
							source={source}
							details
						/>
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
