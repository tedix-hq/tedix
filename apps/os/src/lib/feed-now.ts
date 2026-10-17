import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";

export function feedNow(
	items: readonly ActivityFeedItem[],
	now: Date,
	timezone?: string,
) {
	const unique = [...new Map(items.map((item) => [item.id, item])).values()];
	const calendar = new Intl.DateTimeFormat("en", {
		dateStyle: "short",
		timeZone: timezone,
	});
	const today = calendar.format(now);
	const pending = unique.filter((item) => item.needsAction && !item.done);
	return {
		needsToday: pending.filter(
			(item) =>
				!item.dueAt ||
				Date.parse(item.dueAt) <= now.getTime() ||
				calendar.format(new Date(item.dueAt)) === today,
		).length,
		next:
			unique
				.filter(
					(item) =>
						!item.done && item.dueAt && Number.isFinite(Date.parse(item.dueAt)),
				)
				.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0] ?? null,
	};
}
