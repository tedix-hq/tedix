import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { WorkActorAvatar } from "./work-actor-avatar";
import { Badge } from "./kumo/badge";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useOsFormattingPreferences } from "@/lib/format";
import type { StalledCause } from "@/lib/feed-timeline";
import { OS_COPY } from "@/shared/os-copy";

/**
 * One cause of stalled work: what stalled, why, how often, and where to act.
 * The records behind it open on request.
 */
export function StalledCauseRow({
	group,
	actor,
	project,
	open,
	onToggle,
}: {
	group: StalledCause<ActivityFeedItem>;
	actor: string;
	project?: string;
	open: boolean;
	onToggle: () => void;
}) {
	useOsFormattingPreferences();
	const copy = OS_COPY.feed.timeline;
	const latest = group.items[0]!;
	const cause = copy.stalledCauses[group.cause];
	const identity =
		latest.actorIdentity ??
		(latest.tediId ? { type: "tedi", id: latest.tediId } : undefined);
	const why = [
		cause.why,
		group.report ? copy.stalledLastReport(group.report) : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div
			role="listitem"
			tabIndex={-1}
			data-focus-row={group.key}
			className="focus-row ft-stalled"
		>
			<article
				aria-label={copy.stalledRow(group.target, cause.label, group.times)}
				className="fd-story min-w-0"
			>
				<WorkActorAvatar actor={identity} name={actor} className="ft-avatar" />
				<div className="fd-story-body grid">
					{/* First link in the row, so the "o" shortcut opens what stalled. */}
					<Link href={latest.source} variant="record" className="ft-post-link">
						<span className="ft-sentence">{group.target}</span>
					</Link>
					<div className="ft-byline flex-wrap">
						<Text as="span" className="min-w-0 break-words">
							{actor}
						</Text>
						{project && (
							<Text as="span" tone="secondary">
								·{" "}
								{latest.projectId ? (
									<Link
										href={`/work/projects/${latest.projectId}`}
										variant="record"
									>
										{project}
									</Link>
								) : (
									project
								)}
							</Text>
						)}
						<time dateTime={latest.at} title={absoluteTime(latest.at)}>
							· {relativeTime(latest.at)}
						</time>
					</div>
					<div className="ft-stalled-why">
						<Badge variant={group.cause === "failed" ? "error" : "warning"}>
							{cause.label}
							{group.times > 1 && ` · ${copy.stalledTimes(group.times)}`}
						</Badge>
						{why && <p>{why}</p>}
					</div>
					<div className="ft-stalled-actions">
						<Link
							href={latest.source}
							aria-label={`${
								latest.workItemId
									? copy.stalledOpenWork
									: copy.stalledOpenSource
							}: ${group.target}`}
						>
							{latest.workItemId
								? copy.stalledOpenWork
								: copy.stalledOpenSource}
						</Link>
						<Button
							variant="ghost"
							size="sm"
							className="ft-more"
							aria-expanded={open}
							onClick={onToggle}
						>
							{open ? copy.stalledHide : copy.stalledShow(group.items.length)}
						</Button>
					</div>
				</div>
			</article>
		</div>
	);
}
