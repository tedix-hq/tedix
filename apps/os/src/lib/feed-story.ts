import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { OS_COPY } from "@/shared/os-copy";

/** Pending choices belong in the Deck. The timeline only tells what happened. */
export function timelineItems<T extends ActivityFeedItem>(
	items: readonly T[],
): T[] {
	const seen = new Map<string, number>();
	const sentences = new Map<string, number>();
	return items
		.filter((item) => item.kind !== "decision" && item.kind !== "approval")
		.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
		.filter((item) => {
			const outcome =
				item.kind === "result"
					? (item.classId?.split(":").at(-1) ??
						(item.stalled ? "failed" : "finished"))
					: item.classId;
			const key = `${item.workItemId ?? item.source}:${outcome}:${item.kind === "result" ? "" : item.sentence?.toLowerCase().trim()}`;
			const at = Date.parse(item.at);
			const previous = seen.get(key);
			if (previous !== undefined && previous - at < 30 * 60_000) return false;
			const sentence = item.sentence?.toLowerCase().replace(/\s+/g, " ").trim();
			const duplicate = sentence ? sentences.get(sentence) : undefined;
			if (duplicate !== undefined && duplicate - at < 30 * 60_000) return false;
			if (sentence) sentences.set(sentence, at);
			seen.set(key, at);
			return true;
		});
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
