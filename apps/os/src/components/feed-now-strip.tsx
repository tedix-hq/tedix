import { useQuery } from "@tanstack/react-query";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { workAgentSessionsQueryOptions } from "@/lib/os-query-options";
import { feedNow } from "@/lib/feed-now";
import { absoluteTime, relativeTime } from "@/lib/time";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { OS_COPY } from "@/shared/os-copy";

export function FeedNowStrip({
	items,
	projectIds,
	now,
	timezone,
	pending,
	failed,
}: {
	items: readonly ActivityFeedItem[];
	projectIds: readonly string[];
	now: Date;
	timezone?: string;
	pending: boolean;
	failed: boolean;
}) {
	const sessions = useQuery(workAgentSessionsQueryOptions());
	const summary = feedNow(items, now, timezone);
	const names = [
		...new Set(
			(sessions.data?.sessions ?? [])
				.filter(
					(row) =>
						row.effectiveState === "working" &&
						row.projectId &&
						projectIds.includes(row.projectId),
				)
				.map((row) => row.label),
		),
	];
	const copy = OS_COPY.workHome;
	return (
		<aside
			aria-label={copy.now}
			className="grid min-w-0 gap-2 break-words rounded-lg border border-kumo-line bg-kumo-elevated p-3 type-tedix-label"
		>
			<Text>
				{pending
					? OS_COPY.feed.loading
					: failed
						? OS_COPY.feed.partial
						: copy.needsToday(summary.needsToday)}
			</Text>
			<Text tone="secondary">
				{sessions.isError
					? copy.activityUnavailable
					: sessions.isPending
						? OS_COPY.feed.loading
						: names.length
							? copy.working(
									names.slice(0, 3).join(", ") +
										(names.length > 3 ? ` +${names.length - 3}` : ""),
								)
							: copy.noSessions}
			</Text>
			{summary.next ? (
				<Link
					href={summary.next.source}
					title={absoluteTime(summary.next.dueAt!)}
				>
					{copy.nextDeadline}: {relativeTime(summary.next.dueAt!)}
				</Link>
			) : (
				<Text tone="secondary">{copy.noDeadline}</Text>
			)}
		</aside>
	);
}
