import { describe, expect, it, vi } from "vite-plus/test";
import {
	distillPrompt,
	modelLessonDistiller,
	parseDistilledRules,
} from "./lesson-distiller";

const input = {
	content:
		'Lessons from user decisions in acme (codex, correction):\n- Decided: "they are called tedis, not agents" (agent asked: "Shall the agents run?").',
	scope: { repo: "acme", harness: "codex", topic: "correction" },
};

describe("parseDistilledRules", () => {
	it("keeps at most three bullet rules", () => {
		expect(
			parseDistilledRules(
				"Here are the rules:\n- Call them tedis, not agents.\n* Answer in short plain English.\n- Commit to main.\n- Fourth rule is dropped.",
			),
		).toEqual([
			"Call them tedis, not agents.",
			"Answer in short plain English.",
			"Commit to main.",
		]);
	});

	it("reads NONE as nothing lasting and junk as a failure", () => {
		expect(parseDistilledRules("NONE")).toEqual([]);
		expect(parseDistilledRules("none.")).toEqual([]);
		expect(parseDistilledRules("I cannot help with that")).toBeNull();
		expect(parseDistilledRules("")).toBeNull();
	});
});

describe("modelLessonDistiller", () => {
	it("asks the model with the quoted lesson and parses its rules", async () => {
		const run = vi.fn(async () => ({
			response: "- Call them tedis, not agents.",
		}));
		const rules = await modelLessonDistiller({ AI: { run } } as never)(input);
		expect(rules).toEqual(["Call them tedis, not agents."]);
		const prompt = (run.mock.calls[0] as unknown[])[1] as {
			messages: Array<{ content: string }>;
		};
		expect(prompt.messages[0]!.content).toBe(distillPrompt(input));
		expect(prompt.messages[0]!.content).toContain("they are called tedis");
	});

	it("fails soft", async () => {
		const run = vi.fn(async () => {
			throw new Error("model down");
		});
		expect(
			await modelLessonDistiller({ AI: { run } } as never)(input),
		).toBeNull();
	});
});
