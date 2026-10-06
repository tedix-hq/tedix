import { describe, expect, test } from "bun:test";
import { parseQuestionPrompt } from "./question-prompt";

describe("parseQuestionPrompt", () => {
	test("extracts numbered and bulleted choices", () => {
		expect(
			parseQuestionPrompt(
				"Which workspace?\n1. Tedix\n2) Globex\n- Ask me later",
			),
		).toEqual({
			prompt: "Which workspace?",
			options: [
				{ label: "Tedix", value: "Tedix" },
				{
					label: "Globex",
					value: "Globex",
				},
				{ label: "Ask me later", value: "Ask me later" },
			],
		});
	});

	test("keeps prose questions as free text", () => {
		expect(parseQuestionPrompt("What outcome matters most?")).toEqual({
			prompt: "What outcome matters most?",
			options: [],
		});
	});
});
