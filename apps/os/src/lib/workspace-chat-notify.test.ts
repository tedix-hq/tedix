import { describe, expect, it } from "vite-plus/test";
import { mentionedPeople } from "./workspace-chat-notify";

const people: Array<[string, string]> = [
	["ada", "Ada Lovelace"],
	["adam", "Adam Smith"],
	["li", "Li"],
	["x", "X"],
	["dot", "J. R. (Bob) Dobbs"],
];

describe("mentionedPeople", () => {
	it("finds people named with an @ by full or first name, whatever the case", () => {
		expect(mentionedPeople("thanks @ada, and @Adam Smith too", people)).toEqual(
			["ada", "adam"],
		);
		expect(mentionedPeople("@LI can you check?", people)).toEqual(["li"]);
	});
	it("does not match part of a longer name, a one-letter name or text without @", () => {
		expect(mentionedPeople("@adam only", people)).toEqual(["adam"]);
		expect(mentionedPeople("ask Ada about @x and @lisa", people)).toEqual([]);
		expect(mentionedPeople("no mention of Ada here", people)).toEqual([]);
	});
	it("treats punctuation in a name as text and returns at most ten people", () => {
		expect(mentionedPeople("@J. R. (Bob) Dobbs hi", people)).toEqual(["dot"]);
		const crowd = Array.from(
			{ length: 15 },
			(_, index) => [`id-${index}`, "Sam"] as [string, string],
		);
		expect(mentionedPeople("@sam", crowd)).toHaveLength(10);
	});
});
