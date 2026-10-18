import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { OS_COPY } from "@/shared/os-copy";

/** Pending choices belong in the Deck. The timeline only tells what happened. */
export function timelineItems<T extends ActivityFeedItem>(
	items: readonly T[],
): T[] {
	return items
		.filter((item) => item.kind !== "decision" && item.kind !== "approval")
		.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

export function feedStoryActor(
	item: ActivityFeedItem,
	project: string | undefined,
	tedis: Record<string, string>,
) {
	if (item.tediId && tedis[item.tediId]) return tedis[item.tediId]!;
	const name = item.actor.replace(/\s+(?:code\s+)?session$/i, "").trim();
	if (/^(?:codex|claude|coding|agent|external_agent)$/i.test(name)) {
		return OS_COPY.feed.forProject(
			/claude/i.test(name) ? "Claude" : "Codex",
			project ?? "Tedix",
		);
	}
	return name || "Tedix";
}
