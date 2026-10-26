import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { WorkActorAvatar } from "./work-actor-avatar";
import { Button } from "./kumo/button";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useOsFormattingPreferences } from "@/lib/format";
import { OS_COPY } from "@/shared/os-copy";

/** Repeated events by one actor read as one row; the list opens on request. */
export function ActivityGroupRow({
	id,
	items,
	actor,
	open,
	onToggle,
}: {
	id: string;
	items: ActivityFeedItem[];
	actor: string;
	open: boolean;
	onToggle: () => void;
}) {
	useOsFormattingPreferences();
	const latest = items[0]!;
	const identity =
		latest.actorIdentity ??
		(latest.tediId ? { type: "tedi", id: latest.tediId } : undefined);
	return (
		<div
			role="listitem"
			tabIndex={-1}
			data-focus-row={id}
			className="focus-row ft-group"
		>
			<article
				aria-label={OS_COPY.feed.timeline.groupLabel(items.length, actor)}
				className="fd-story min-w-0"
			>
				<WorkActorAvatar actor={identity} name={actor} className="ft-avatar" />
				<div className="fd-story-body grid">
					<span className="ft-sentence">
						{OS_COPY.feed.timeline.groupSummary(actor, items.length)}
					</span>
					<div className="ft-byline">
						<span className="ft-group-latest">{latest.sentence}</span>
						<time dateTime={latest.at} title={absoluteTime(latest.at)}>
							· {relativeTime(latest.at)}
						</time>
						<Button
							variant="ghost"
							size="sm"
							className="ft-more"
							aria-expanded={open}
							onClick={onToggle}
						>
							{open
								? OS_COPY.feed.showLess
								: OS_COPY.feed.timeline.showAll(items.length)}
						</Button>
					</div>
				</div>
			</article>
		</div>
	);
}
