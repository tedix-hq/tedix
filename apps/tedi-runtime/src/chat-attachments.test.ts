import assert from "node:assert/strict";
import {
	sanitizeChatAttachments,
	isVisionCapableChatDeployment,
} from "./chat-attachments";

for (const input of [
	undefined,
	null,
	{},
	[],
	[null, {}, { type: "video", content: "x" }],
]) {
	assert.equal(sanitizeChatAttachments(input), undefined);
}
assert.deepEqual(
	sanitizeChatAttachments([
		{
			type: "audio",
			content: "a",
			fileName: "voice.wav",
			mimeType: "audio/wav",
			extra: true,
		},
		{ type: "image", content: "i", fileName: 12 },
		{ type: "file", content: "f", mimeType: null },
		{ type: "file", content: "" },
	]),
	[
		{
			type: "audio",
			content: "a",
			fileName: "voice.wav",
			mimeType: "audio/wav",
		},
		{ type: "image", content: "i", fileName: "", mimeType: "" },
		{ type: "file", content: "f", fileName: "", mimeType: "" },
	],
);
// The cap applies before validation, so invalid entries still consume slots.
assert.equal(
	sanitizeChatAttachments([
		...Array(8).fill(null),
		{ type: "file", content: "x" },
	]),
	undefined,
);
assert.equal(
	sanitizeChatAttachments(Array(10).fill({ type: "file", content: "x" }))
		?.length,
	8,
);
for (const deployment of [" GPT-6.1-SOL-region ", "gpt-4o-2026", "gpt-5.6"]) {
	assert.equal(isVisionCapableChatDeployment(deployment), true);
}
for (const deployment of [undefined, "", "text-only", "prefix-gpt-4o"]) {
	assert.equal(isVisionCapableChatDeployment(deployment), false);
}
console.log("PASS: chat attachment normalization and vision fallback");
