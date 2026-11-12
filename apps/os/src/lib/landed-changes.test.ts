import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	createLandedChanges,
	landedDelay,
	LANDED_UNDO_MS,
	savedByAgent,
	watchForInput,
} from "./landed-changes";

type Doc = Extract<OsOutputContent, { kind: "document" }>;
const doc = (...texts: string[]): Doc => ({
	kind: "document",
	blocks: [],
	richText: {
		type: "doc",
		content: texts.map((text) => ({
			type: "paragraph",
			content: [{ type: "text", text }],
		})),
	},
});
const texts = (content: Doc | undefined) =>
	content?.richText!.content.map((node) => node.content![0]!.text);

describe("changes someone else made to an open file", () => {
	it("takes an agent's change set back out and keeps what the person edited since", () => {
		const landed = createLandedChanges<Doc>();
		expect(landed.undoable).toBe(false);
		landed.add(doc("one", "two", "three"), doc("one", "TWO", "three"), true);
		expect(landed.undoable).toBe(true);
		// The person has since changed another paragraph.
		expect(texts(landed.undo(doc("one", "TWO", "three, mine")))).toEqual([
			"one",
			"two",
			"three, mine",
		]);
		expect(landed.undoable).toBe(false);
		expect(landed.undo(doc("one"))).toBeUndefined();
	});

	it("keeps the person's later words where they edited what the agent changed", () => {
		const landed = createLandedChanges<Doc>();
		landed.add(doc("The plan is fine"), doc("The plan is great"), true);
		expect(texts(landed.undo(doc("The plan is superb")))).toEqual([
			"The plan is superb",
		]);
	});

	it("undoes saves that follow each other closely as one change set", () => {
		let now = 1_000;
		const landed = createLandedChanges<Doc>({}, () => now);
		landed.add(doc("a", "b"), doc("A", "b"), true);
		now += 2_000;
		landed.add(doc("A", "b"), doc("A", "B"), true);
		expect(texts(landed.undo(doc("A", "B")))).toEqual(["a", "b"]);
		// A later change set stands alone.
		landed.add(doc("a", "b"), doc("A", "b"), true);
		now += 9_000;
		landed.add(doc("A", "b"), doc("A", "B"), true);
		expect(texts(landed.undo(doc("A", "B")))).toEqual(["A", "b"]);
	});

	it("offers undo for agents only, and only for a while", () => {
		let now = 0;
		const landed = createLandedChanges<Doc>({}, () => now);
		landed.add(doc("a"), doc("b"), false);
		expect(landed.undoable).toBe(false);
		landed.add(doc("b"), doc("c"), true);
		expect(landed.undoable).toBe(true);
		now += LANDED_UNDO_MS;
		expect(landed.undoable).toBe(false);
		landed.add(doc("c"), doc("d"), true);
		landed.clear();
		expect(landed.undoable).toBe(false);
	});

	it("tells agents from people", () => {
		for (const kind of ["tedi", "external_agent", "service"])
			expect(savedByAgent({ createdByKind: kind })).toBe(true);
		expect(savedByAgent({ createdByKind: "user" })).toBe(false);
		expect(savedByAgent({ revision: 3 })).toBe(false);
		expect(savedByAgent(null)).toBe(false);
	});

	it("lights changes one after another within a second and a half", () => {
		expect([0, 1, 2].map((index) => landedDelay(index, 3))).toEqual([
			0, 140, 280,
		]);
		expect(landedDelay(39, 40)).toBeLessThanOrEqual(1_600);
	});

	it("counts someone as watching once they stop typing, clicking and scrolling", () => {
		let now = 10_000;
		const target = new EventTarget() as unknown as Window;
		const input = watchForInput(target, () => now);
		expect(input.watching).toBe(true);
		target.dispatchEvent(new Event("keydown"));
		expect(input.watching).toBe(false);
		now += 3_000;
		expect(input.watching).toBe(true);
		target.dispatchEvent(new Event("wheel"));
		expect(input.watching).toBe(false);
		input.stop();
		now += 3_000;
		target.dispatchEvent(new Event("pointerdown"));
		expect(input.watching).toBe(true);
	});
});
