import assert from "node:assert/strict";
import { submissionAssistantText } from "./facet-submission-result";
import type { SessionMessage } from "agents/sessions";
import type { PiSubmissionInspection } from "./pi-types";
const receipt: PiSubmissionInspection = {
	submissionId: "run",
	status: "completed",
	messageId: "owned",
};
const message: SessionMessage = {
	id: "owned",
	role: "assistant",
	parts: [{ type: "text", text: "exact result" }],
};
assert.equal(submissionAssistantText(receipt, message), "exact result");
assert.equal(
	submissionAssistantText(receipt, {
		...message,
		parts: [
			{ type: "text", text: "I checked the subtitle." },
			{ type: "step-start" },
			{ type: "reasoning", text: "private reasoning" },
			{ type: "text", text: "" },
			{ type: "text", text: "I found the result." },
		],
	}),
	"I checked the subtitle.\n\nI found the result.",
);
assert.equal(
	submissionAssistantText(receipt, {
		...message,
		parts: [
			{ type: "text", text: "First paragraph.\n\n" },
			{ type: "text", text: "\nSecond paragraph." },
		],
	}),
	"First paragraph.\n\n\nSecond paragraph.",
);

assert.throws(
	() => submissionAssistantText(receipt, { ...message, id: "later-turn" }),
	/owned assistant/,
);
assert.throws(
	() => submissionAssistantText(receipt, { ...message, role: "user" }),
	/owned assistant/,
);
assert.throws(() => submissionAssistantText(receipt, null), /owned assistant/);
for (const status of [
	"pending",
	"running",
	"error",
	"aborted",
	"skipped",
] as const)
	assert.throws(
		() => submissionAssistantText({ ...receipt, status }, message),
		new RegExp(status),
	);
assert.throws(() => submissionAssistantText(null, message), /not found/);
console.log("facet-submission-result OK");
