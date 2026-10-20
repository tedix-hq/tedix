import type { CardRevision } from "../schemas/card-revisions";

/** A full-body unified diff needs no host renderer or diff dependency. */
export function cardVersionsText(
	revisions: CardRevision[],
	pending: boolean,
): string {
	const current = revisions.at(-1);
	if (!current)
		return "No saved versions yet. The original is saved when changes are first requested.";
	const previous = revisions.at(-2);
	const lines = [
		"Card versions",
		...[...revisions]
			.reverse()
			.map(
				(revision) =>
					`v${revision.revision} · ${revision.cause === "initial" ? "Original" : revision.cause === "restore" ? "Restored" : revision.cause === "human_edit" ? "Your edit" : "Agent rewrite"}${revision.summary ? ` — ${revision.summary}` : ""}`,
			),
	];
	if (pending)
		lines.push(
			"Revising… The card remains open. This is not approval or sending.",
		);
	if (current.summary) lines.push(`What changed: ${current.summary}`);
	if (previous && previous.body !== current.body) {
		const before = previous.body.split("\n");
		const after = current.body.split("\n");
		lines.push(
			"",
			"```diff",
			`--- v${previous.revision}`,
			`+++ v${current.revision}`,
			`@@ -1,${before.length} +1,${after.length} @@`,
			...before.map((line) => `-${line}`),
			...after.map((line) => `+${line}`),
			"```",
		);
	} else lines.push("", current.body);
	const unresolved =
		current.anchors
			?.map((anchor, index) => ({
				anchor,
				index,
				resolution: current.anchorsResolved?.find(
					(item) => item.index === index,
				),
			}))
			.filter((item) => item.resolution?.status !== "done") ?? [];
	if (unresolved.length)
		lines.push(
			"",
			"Unresolved comments",
			...unresolved.map(
				({ anchor, index, resolution }) =>
					`${index + 1}. “${anchor.quote}” — ${anchor.chip ?? anchor.note ?? "Review this passage"}${resolution?.note ? ` (${resolution.note})` : ""}`,
			),
		);
	return lines.join("\n");
}
