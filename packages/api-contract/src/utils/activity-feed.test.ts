import { expect, it } from "vite-plus/test";
import {
	DEFAULT_FEED_COPY,
	feedHeadlineIssues,
	plainFeedText,
} from "./activity-feed";

// Texts Activity showed in production before 2026-10-27.
it.each([
	[
		"partial_result Delegated tedi returned a partial result (reported_partial; The tedi reported a partial result).",
		"Delegated tedi returned a partial result.",
	],
	[
		"partial_result Delegated tedi reported Outcome: needs_follow_up.",
		"Delegated tedi reported needs follow-up.",
	],
	["Failed: partial_result", ""],
	[
		"Copy skill 4f1c2a90-3b7d-4e21-9a55-0c8e7d6b1f42 (Reddit Operator) into the workspace",
		"Copy skill Reddit Operator into the workspace",
	],
	[
		"Update skill 7d2e9b14-6a03-4c8f-b1d2-5e9f0a3c8b67 with the new schedule",
		"Update skill with the new schedule",
	],
	["Run the certification for draft", "Run the certification for draft"],
])("plainFeedText(%j)", (raw, plain) => {
	expect(plainFeedText(raw)).toBe(plain);
	expect(feedHeadlineIssues(plainFeedText(raw))).toEqual([]);
});

it("the copy self-check rejects snake_case codes and ids in a headline", () => {
	expect(
		feedHeadlineIssues("partial_result Delegated tedi returned a result."),
	).toEqual(["technical_text"]);
	expect(
		feedHeadlineIssues(
			"Copy skill 4f1c2a90-3b7d-4e21-9a55-0c8e7d6b1f42 into the workspace.",
		),
	).toEqual(["raw_identifier"]);
	expect(
		feedHeadlineIssues(
			"Cedar finished part of “Run the certification for draft” and needs you to check the rest.",
		),
	).toEqual([]);
});

it("names codes in Spanish when given the Spanish catalog", () => {
	expect(
		plainFeedText("El tedi informó Outcome: needs_follow_up.", {
			...DEFAULT_FEED_COPY,
			codes: { needs_follow_up: "necesita seguimiento" },
		}),
	).toBe("El tedi informó necesita seguimiento.");
});
