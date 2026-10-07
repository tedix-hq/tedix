import { describe, expect, it, vi } from "vite-plus/test";
import {
	acceptedRules,
	distillPrompt,
	distillReplies,
	modelLessonDistiller,
	parseCitedRules,
	supportedRules,
} from "./lesson-distiller";

const reply = (text: string, session: string, day: number, kind?: string) => ({
	text,
	session,
	occurredAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`,
	...(kind ? { kind } : {}),
});

const input = {
	content: "Lessons from user decisions in acme (general, general):",
	scope: { repo: "acme", harness: "general", topic: "general" },
	replies: [
		reply("they are called tedis, not agents", "s1", 1, "correction"),
		reply("again: call them tedis please", "s2", 5, "correction"),
		reply("set crossSessionInbound to accept", "s3", 6, "instruction"),
		reply("Without tools, report only the Tedix context received", "s4", 7),
	],
};

describe("distillReplies", () => {
	it("drops meta prompts and lists telling replies newest first", () => {
		expect(distillReplies(input.replies).map((r) => r.session)).toEqual([
			"s3",
			"s2",
			"s1",
		]);
	});
});

describe("parseCitedRules", () => {
	it("reads rules with their cited replies", () => {
		expect(
			parseCitedRules(
				"Rules:\n- Call them tedis, not agents. [2, 3]\n* Set crossSessionInbound to accept [1]",
			),
		).toEqual([
			{ rule: "Call them tedis, not agents.", cites: [2, 3] },
			{ rule: "Set crossSessionInbound to accept", cites: [1] },
		]);
	});

	it("reads NONE as nothing lasting and junk as a failure", () => {
		expect(parseCitedRules("NONE")).toEqual([]);
		expect(parseCitedRules("I cannot help with that")).toBeNull();
	});
});

describe("acceptedRules", () => {
	const replies = distillReplies(input.replies);

	it("keeps a rule two sessions state and drops a one-off instruction", () => {
		expect(
			acceptedRules(
				[
					{ rule: "Call them tedis, not agents.", cites: [2, 3] },
					{ rule: "Set crossSessionInbound to accept.", cites: [1] },
				],
				replies,
			),
		).toEqual(["Call them tedis, not agents."]);
	});

	it("keeps a rule one reply states as standing", () => {
		expect(
			acceptedRules(
				[{ rule: "Never open pull requests.", cites: [1] }],
				[reply("never open pull requests in this repo", "s9", 1)],
			),
		).toEqual(["Never open pull requests."]);
	});

	it("drops money and rules the cited replies do not state", () => {
		expect(
			acceptedRules(
				[
					{ rule: "Pay the €3,000 invoice monthly.", cites: [2, 3] },
					{ rule: "Deploy fixes to production.", cites: [2, 3] },
				],
				replies,
			),
		).toEqual([]);
	});
});

describe("supportedRules", () => {
	it("needs the rule's words in the source text", () => {
		expect(
			supportedRules(
				["Call them tedis, not agents.", "Commit straight to main."],
				"they are called tedis, not agents",
			),
		).toEqual(["Call them tedis, not agents."]);
	});
});

describe("modelLessonDistiller", () => {
	it("numbers the replies, gives no example rule, and filters the answer", async () => {
		const run = vi.fn(async () => ({
			response:
				"- Call them tedis, not agents. [2, 3]\n- Set crossSessionInbound to accept. [1]",
		}));
		const rules = await modelLessonDistiller({ AI: { run } } as never)(input);
		expect(rules).toEqual(["Call them tedis, not agents."]);
		const prompt = (run.mock.calls[0] as unknown[])[1] as {
			messages: Array<{ content: string }>;
		};
		expect(prompt.messages[0]!.content).toBe(distillPrompt(input));
		expect(prompt.messages[0]!.content).toContain(
			"[3] they are called tedis, not agents",
		);
		expect(prompt.messages[0]!.content).not.toContain("report only");
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
