import { describe, expect, it } from "vite-plus/test";
import { isTruncatedCodeModeResult } from "./bounded-result";
import {
	shapeModelResult,
	stringifyModelResult,
} from "./register-codemode-tools";

// messages_read for a judge session: the prompt alone is ~10k tokens.
const transcript = {
	session_key: "workflow:reddit-judge:run-1",
	messages: [
		{ role: "user", content: "x".repeat(40_000) },
		{ role: "assistant", content: '{"cards":[{"url":"https://example.com"}]}' },
	],
};

describe("code tool result budget", () => {
	it("clips an oversized result for a model-facing caller", () => {
		expect(
			isTruncatedCodeModeResult(shapeModelResult(transcript, undefined)),
		).toBe(true);
	});

	it("returns the full result to a skill workflow caller", () => {
		expect(shapeModelResult(transcript, null)).toBe(transcript);
		const text = stringifyModelResult({ result: transcript }, null);
		expect(JSON.parse(text).result.messages[1].role).toBe("assistant");
	});
});
