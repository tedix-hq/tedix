import { expect, it } from "vite-plus/test";
import {
	checkDecisionCardCopy,
	recommendationIssues,
} from "@tedix/api-contract/utils/decision-card-copy";

const copy = {
	title: "Save a task to follow up with Jules?",
	context: "You met at a workshop yesterday.",
	body: "Adds a reminder; sends no message.",
	recommendation: "Recommend yes while the conversation is fresh.",
	actionLabels: { approve: "Save task", reject: "Skip task" },
};
it("allows a concrete, short face without removing the difference between saving and sending", () => {
	expect(checkDecisionCardCopy(copy)).toEqual([]);
});
it("counts context, stakes and outcome buttons in the word budget", () => {
	expect(
		checkDecisionCardCopy({
			...copy,
			stakes: Array(40).fill("people").join(" "),
		}),
	).toContain("face_word_limit");
});
it.each([
	"Workers fetch",
	"markdown",
	"API key",
	"governance",
	"MCP",
	"credential",
])("rejects %s on any part of the face", (term) => {
	expect(
		checkDecisionCardCopy({ ...copy, context: `The ${term} needs attention.` }),
	).toContain("banned_words");
});
it("keeps raw identifiers out of context and button labels", () => {
	expect(
		checkDecisionCardCopy({
			...copy,
			actionLabels: { approve: "Use org_fictional" },
		}),
	).toContain("raw_identifier");
});

it.each([
	"human_mcp_grant_invalid",
	"tests_write.GenerateMagicLinkForTestUser",
	"ECONNRESET",
	"/Users/fictional/project",
])("keeps machine names and raw errors in Details: %s", (term) => {
	expect(checkDecisionCardCopy({ ...copy, context: term })).toContain(
		"technical_text",
	);
});

it.each([
	"Recommend yes while the conversation is fresh.",
	"Yes — no price named, nothing sent until you say so.",
	"No, the draft names a price the owner has not approved.",
	"Record it — the prep deadline is proposed, not an external commitment.",
	"Keep it here — the project brief covers profile display.",
	"Don't send yet; the supplier has not confirmed stock.",
	"Save task now while the meeting is fresh.",
])("accepts a recommendation that names an action and a reason: %s", (text) => {
	expect(recommendationIssues({ ...copy, recommendation: text })).toEqual([]);
});

it.each([
	"The prep deadline is proposed, not an external commitment.",
	"Your rule is plain language; the current text uses two banned terms.",
	"No supplied project fits this request.",
	"It replaces three monthly tools.",
])("rejects a recommendation that only states a fact: %s", (text) => {
	expect(recommendationIssues({ ...copy, recommendation: text })).toEqual([
		"recommendation_action",
	]);
});

it("needs a reason after the action", () => {
	expect(recommendationIssues({ ...copy, recommendation: "Yes." })).toEqual([
		"recommendation_reason",
	]);
	expect(
		recommendationIssues({ ...copy, recommendation: "Approve it now." }),
	).toEqual(["recommendation_reason"]);
});

it("leaves recommendations in other reader languages to the writer", () => {
	const fact = { ...copy, recommendation: "La fecha es solo una propuesta." };
	expect(recommendationIssues(fact, "es-MX")).toEqual([]);
	expect(recommendationIssues(fact, "en-GB")).toEqual([
		"recommendation_action",
	]);
});
