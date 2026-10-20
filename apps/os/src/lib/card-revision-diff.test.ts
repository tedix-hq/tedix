import { expect, it } from "vite-plus/test";
import {
	cardRevisionDiff,
	cardRevisionHunks,
	keepOriginalHunks,
	proposalRevisionHunks,
	keepOriginalProposalHunks,
	proposalRevisionBody,
} from "./card-revision-diff";
import type { WorkProposal } from "@tedix/api-contract/schemas/work-interactions";

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

it("keeps plan wording by Work identity while preserving revised execution and other edits", () => {
	const before: WorkProposal = {
		key: "fictional-plan",
		item: { title: "Prepare the report", sourceIntentId: "report" },
		children: [
			{
				title: "Review the report",
				description: "Check the sources.",
				sourceIntentId: "review",
			},
			{ title: "Archive it", sourceIntentId: "archive" },
		],
	};
	const after: WorkProposal = {
		...before,
		item: {
			...before.item,
			title: "Draft the report",
			description: "A new description.",
		},
		children: [
			{ title: "New task", sourceIntentId: "new" },
			{
				title: "Read it",
				description: "Check every source.",
				sourceIntentId: "review",
			},
		],
		start: {
			kind: "delegate",
			brief: "Prepare a draft for human review.",
			tedi: "report-writer",
		},
	};
	const hunks = proposalRevisionHunks(before, after);
	const chosen = hunks
		.filter(
			(hunk) =>
				(hunk.sourceIntentId === "report" && hunk.field === "description") ||
				(hunk.sourceIntentId === "review" && hunk.field === "title"),
		)
		.map((hunk) => hunk.index);
	const kept = keepOriginalProposalHunks(before, after, chosen);
	expect(kept.item).toEqual({
		title: "Draft the report",
		sourceIntentId: "report",
	});
	expect(kept.children).toEqual([
		after.children[0],
		{ ...after.children[1], title: "Review the report" },
	]);
	expect(kept.start).toEqual(after.start);
	expect(kept.key).toBe(after.key);
	expect(after.item.description).toBe("A new description.");
	expect(proposalRevisionBody(kept)).toContain(
		"Review the report\nCheck every source.",
	);
	expect(
		hunks
			.filter((hunk) => hunk.sourceIntentId === "new")
			.every((hunk) => !hunk.canKeep),
	).toBe(true);
});

it("does not match ambiguous plan identities or resurrect removed Work", () => {
	const item = { title: "Original", sourceIntentId: "duplicate" };
	const before: WorkProposal = { key: "plan", item, children: [item] };
	const after: WorkProposal = {
		key: "plan",
		item: { ...item, title: "Revised" },
		children: [],
	};
	expect(
		proposalRevisionHunks(before, after).every((hunk) => !hunk.canKeep),
	).toBe(true);
	expect(keepOriginalProposalHunks(before, after, [0, 1])).toEqual(after);
});
