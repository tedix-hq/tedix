import { describe, expect, it } from "vite-plus/test";
import {
	InlineThinkingSplitter,
	opensThinkingImplicitly,
	splitInlineThinking,
} from "./inline-thinking";

function run(chunks: string[], implicitOpen = false) {
	const splitter = new InlineThinkingSplitter(implicitOpen);
	const pieces = [
		...chunks.flatMap((c) => splitter.push(c)),
		...splitter.end(),
	];
	const join = (type: string) =>
		pieces
			.filter((p) => p.type === type)
			.map((p) => p.value)
			.join("");
	return { text: join("text"), reasoning: join("reasoning") };
}

describe("inline thinking", () => {
	it("keeps the reply after an implicit-open </think>, split across chunks", () => {
		expect(
			run(
				[
					"The system says propose_tool_write. ",
					"Do not mention internal routing.</thi",
					"nk>",
					"\n\nI inspected the app.",
				],
				true,
			),
		).toEqual({
			text: "I inspected the app.",
			reasoning:
				"The system says propose_tool_write. Do not mention internal routing.",
		});
	});

	it("replays implicit content as text when no </think> arrives", () => {
		// The hidden provisional copy keeps the stream alive; the reply is whole.
		expect(run(["Plain ", "answer."], true)).toEqual({
			text: "Plain answer.",
			reasoning: "Plain answer.",
		});
		expect(splitInlineThinking("Plain answer.", true)).toEqual({
			text: "Plain answer.",
			reasoning: "",
		});
	});

	it("separates an explicit <think> block for any model", () => {
		expect(run(["<thi", "nk>plan</think>Answer"])).toEqual({
			text: "Answer",
			reasoning: "plan",
		});
	});

	it("streams ordinary text untouched without the implicit flag", () => {
		expect(run(["Hello", " </think> stays text"])).toEqual({
			text: "Hello </think> stays text",
			reasoning: "",
		});
	});

	it("treats content as text once the provider sends reasoning separately", () => {
		const splitter = new InlineThinkingSplitter(true);
		expect(splitter.push("Hi")).toEqual([{ type: "reasoning", value: "Hi" }]);
		expect(splitter.providerReasoning()).toEqual([
			{ type: "text", value: "Hi" },
		]);
		expect(splitter.push(" there")).toEqual([
			{ type: "text", value: " there" },
		]);
	});

	it("splits complete content and recognises Kimi as implicit", () => {
		expect(splitInlineThinking("why</think>Done", true)).toEqual({
			text: "Done",
			reasoning: "why",
		});
		expect(opensThinkingImplicitly("@cf/moonshotai/kimi-k2.7-code")).toBe(true);
		expect(opensThinkingImplicitly("@cf/openai/gpt-oss-120b")).toBe(false);
	});
});
