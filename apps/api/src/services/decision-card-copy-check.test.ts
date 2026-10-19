import { expect, it } from "vite-plus/test";
import { checkDecisionCardCopy } from "@tedix/api-contract/utils/decision-card-copy";

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
