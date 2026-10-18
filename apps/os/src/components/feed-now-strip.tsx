import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { feedNow } from "@/lib/feed-now";
import { absoluteTime, relativeTime } from "@/lib/time";
import { Link } from "@/components/kumo/link";
import { OS_COPY } from "@/shared/os-copy";

export function FeedNowStrip({
	items,
	now,
	timezone,
}: {
	items: readonly ActivityFeedItem[];
	now: Date;
	timezone?: string;
}) {
	const next = feedNow(items, now, timezone).next;
	return next ? (
		<Link href={next.source} title={absoluteTime(next.dueAt!)}>
			{OS_COPY.workHome.nextDeadline}: {relativeTime(next.dueAt!)}
		</Link>
	) : null;
}
