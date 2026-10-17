import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";

export function feedNow(items: readonly ActivityFeedItem[], now: Date) {
	const unique = [...new Map(items.map((item) => [item.id, item])).values()];
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);
	const pending = unique.filter((item) => item.needsAction && !item.done);
	return {
		needsToday: pending.filter(
			(item) => !item.dueAt || Date.parse(item.dueAt) <= end.getTime(),
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
