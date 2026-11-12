/**
 * After a person posts in a workspace chat, ask the server to notify the
 * people it concerns. The server looks the post up itself and decides who is
 * told; this only says who the text mentions.
 */

/** The activity feed trails a post by a moment. */
const FIRST_ATTEMPT_MS = 1_500;
const SECOND_ATTEMPT_MS = 5_000;

/**
 * People named with an @ in the text: "@Ada Lovelace" or "@Ada". `people`
 * maps a person's id to their name. At most ten are returned.
 */
export function mentionedPeople(
	text: string,
	people: Iterable<readonly [id: string, name: string]>,
): string[] {
	const lower = text.toLowerCase();
	if (!lower.includes("@")) return [];
	const found = new Set<string>();
	for (const [id, name] of people) {
		const full = name.trim().toLowerCase();
		const first = full.split(/\s+/)[0] ?? "";
		const named = [full, first].some(
			(candidate) =>
				candidate.length >= 2 &&
				new RegExp(
					`@${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
					"u",
				).test(lower),
		);
		if (named) found.add(id);
		if (found.size >= 10) break;
	}
	return [...found];
}

export function notifyChatPosted(input: {
	workspaceId: string;
	conversationId: string;
	mentionedUserIds: string[];
}): void {
	const attempt = (last: boolean) =>
		void import("./api")
			.then(({ osApi }) => osApi.workspaceUnread.notifyChat(input))
			.then((result) => {
				if (result.status === "pending" && !last)
					setTimeout(() => attempt(true), SECOND_ATTEMPT_MS);
			})
			// Notifying others is best effort; the post itself is already saved.
			.catch(() => undefined);
	setTimeout(() => attempt(false), FIRST_ATTEMPT_MS);
}
