import { describe, expect, it } from "vite-plus/test";
import { isContextOverflowError } from "./context-overflow";

describe("isContextOverflowError", () => {
	// One case per provider wording Tedix actually sees. These are the strings
	// that decide whether a recoverable prompt-size miss is refolded and retried
	// or reported to the operator as "model unavailable", so they are pinned
	// individually rather than as one regex assertion.
	it.each([
		["anthropic", "prompt is too long: 215000 tokens > 200000 maximum"],
		["openai", "This model's maximum context length is 128000 tokens"],
		["openai code", "context_length_exceeded"],
		["azure", "Please reduce the length of the messages."],
		["google", "The input token count exceeds the maximum number of tokens"],
		["workers ai", "input is too long for this context window"],
	])("classifies the %s wording as overflow", (_provider, message) => {
		expect(isContextOverflowError(new Error(message))).toBe(true);
	});

	it("does not classify unrelated provider failures as overflow", () => {
		for (const message of [
			"429 Too Many Requests",
			"rate limit exceeded",
			"Network connection lost.",
			"AiError 8001: invalid request",
			"insufficient inference capacity",
		]) {
			expect(isContextOverflowError(new Error(message))).toBe(false);
		}
	});

	it("reads a bare string and a structured error body", () => {
		expect(isContextOverflowError("maximum context length reached")).toBe(true);
		expect(
			isContextOverflowError({ error: { message: "prompt is too long" } }),
		).toBe(true);
	});

	it("is fail-safe on values it cannot read", () => {
		// A value that cannot be stringified must not be treated as overflow: a
		// false positive burns the single retry on a turn that would have run.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(isContextOverflowError(circular)).toBe(false);
		expect(isContextOverflowError(undefined)).toBe(false);
		expect(isContextOverflowError(null)).toBe(false);
	});
});
