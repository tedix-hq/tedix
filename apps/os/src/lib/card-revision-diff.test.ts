import { expect, it } from "vite-plus/test";
import { cardRevisionDiff } from "./card-revision-diff";

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
