import { expect, it } from "vite-plus/test";
import {
	cardRevisionDiff,
	cardRevisionHunks,
	keepOriginalHunks,
} from "./card-revision-diff";

it("preserves both drafts and shows whole changed words", () => {
	const before = "Please send a detailed overview tomorrow.";
	const after = "Please send a short overview next week.";
	const changes = cardRevisionDiff(before, after);
	expect(
		changes
			.filter(([kind]) => kind <= 0)
			.map(([, text]) => text)
			.join(""),
	).toBe(before);
	expect(
		changes
			.filter(([kind]) => kind >= 0)
			.map(([, text]) => text)
			.join(""),
	).toBe(after);
	expect(
		changes.some(([kind, text]) => kind < 0 && text.includes("detailed")),
	).toBe(true);
	expect(
		changes.some(([kind, text]) => kind > 0 && text.includes("short")),
	).toBe(true);
});

it("keeps selected changes without losing unrelated edits or whitespace", () => {
	const before = "Hello Morgan,\n\nA detailed overview.\n\nBest regards, Robin";
	const after = "Hi Morgan,\n\nA short overview.\n\nThanks, Robin";
	const hunks = cardRevisionHunks(before, after);
	const changed = hunks.filter((hunk) => !hunk.unchanged);
	expect(keepOriginalHunks(hunks, [])).toBe(after);
	expect(
		keepOriginalHunks(
			hunks,
			changed.map((hunk) => hunk.index),
		),
	).toBe(before);
	expect(keepOriginalHunks(hunks, [changed[0]!.index])).toBe(
		"Hello Morgan,\n\nA short overview.\n\nThanks, Robin",
	);
});
it("supports insertion-only, deletion-only and identical bodies", () => {
	expect(keepOriginalHunks(cardRevisionHunks("", "hello"), [0])).toBe("");
	expect(keepOriginalHunks(cardRevisionHunks("hello", ""), [0])).toBe("hello");
	expect(keepOriginalHunks(cardRevisionHunks("same", "same"), [])).toBe("same");
});
