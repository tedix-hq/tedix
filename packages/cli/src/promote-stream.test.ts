import { describe, expect, test } from "bun:test";
import { PromoteRegion, stableBlockPrefixLength } from "./promote-stream";

/** A region whose commits are recorded verbatim, in order. */
function makeRegion(resizeDebounceMs?: number) {
	const committed: string[] = [];
	const region = new PromoteRegion({
		commit: (line) => committed.push(line),
		render: (text, width) => [`[${width}]`, ...text.split("\n")],
		...(resizeDebounceMs !== undefined ? { resizeDebounceMs } : {}),
	});
	return { committed, region };
}

describe("stableBlockPrefixLength", () => {
	test("only complete blocks are stable", () => {
		expect(stableBlockPrefixLength("one paragraph still growing")).toBe(0);
		const text = "first block\n\nsecond block";
		expect(text.slice(0, stableBlockPrefixLength(text))).toBe(
			"first block\n\n",
		);
	});

	test("a blank line inside an unclosed fence is not a boundary", () => {
		const open = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;";
		expect(open.slice(0, stableBlockPrefixLength(open))).toBe("intro\n\n");
		const closed = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\ntail";
		expect(closed.slice(0, stableBlockPrefixLength(closed))).toBe(
			"intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
		);
	});
});

describe("PromoteRegion promotion", () => {
	test("a stable block commits once and is never rewritten", () => {
		const { committed, region } = makeRegion();
		expect(region.update("Hello wor", 80, 0)).toBe("Hello wor");
		expect(committed).toEqual([]);

		expect(region.update("Hello world\n\nSecond", 80, 0)).toBe("Second");
		const afterFirstBlock = [...committed];
		expect(afterFirstBlock).toEqual(["", "[80]", "Hello world", ""]);

		// The tail keeps growing. The committed block must not be re-emitted, and
		// nothing already committed may change.
		region.update("Hello world\n\nSecond para", 80, 0);
		region.update("Hello world\n\nSecond para is longer", 80, 0);
		expect(committed).toEqual(afterFirstBlock);
		expect(region.tail()).toBe("Second para is longer");
		expect(region.committedText()).toBe("Hello world\n\n");
	});

	test("every committed line is emitted exactly once across a whole stream", () => {
		const { committed, region } = makeRegion();
		const full = "alpha\n\nbeta\n\ngamma\n\ndelta";
		for (let cut = 1; cut <= full.length; cut++) {
			region.update(full.slice(0, cut), 80, 0);
		}
		region.settle(full, 80, 0);
		const bodies = committed.filter((line) =>
			/^(alpha|beta|gamma|delta)$/.test(line),
		);
		expect(bodies).toEqual(["alpha", "beta", "gamma", "delta"]);
	});

	test("settle commits the remaining tail and reports the scrollback prefix", () => {
		const { committed, region } = makeRegion();
		region.update("Hello world\n\nSecond para", 80, 0);
		const prefix = region.settle("Hello world\n\nSecond para", 80, 0);
		expect(prefix).toBe("Hello world\n\nSecond para");
		expect(committed).toEqual([
			"",
			"[80]",
			"Hello world",
			"",
			"[80]",
			"Second para",
			"",
		]);
		// The canonical answer minus the reported prefix is empty: nothing is left
		// for the summary to print on top of what the user already read.
		expect("Hello world\n\nSecond para".slice(prefix.length)).toBe("");
	});

	test("settle commits the canonical remainder, not just the streamed tail", () => {
		const { committed, region } = makeRegion();
		region.update("Hello world\n\nSecond", 80, 0);
		const prefix = region.settle(
			"Hello world\n\nSecond para, completed",
			80,
			0,
		);
		expect(prefix).toBe("Hello world\n\nSecond para, completed");
		expect(committed).toContain("Second para, completed");
		expect(committed.filter((line) => line === "Hello world")).toHaveLength(1);
	});

	test("a canonical answer that contradicts scrollback reprints in full", () => {
		const { region } = makeRegion();
		region.update("Hello world\n\nSecond", 80, 0);
		expect(region.settle("A completely different answer", 80, 0)).toBe("");
	});

	test("settle promotes nothing when the run never streamed", () => {
		const { committed, region } = makeRegion();
		expect(region.settle("the whole answer", 80, 0)).toBe("");
		expect(committed).toEqual([]);
	});

	test("a re-driven generation re-anchors on the common prefix", () => {
		const { committed, region } = makeRegion();
		region.update("shared start\n\nfirst take\n\n", 80, 0);
		expect(committed).toContain("shared start");
		// A higher stream attempt replaces the text; the committed block stays.
		region.update("shared start\n\nsecond take\n\nmore", 80, 0);
		expect(committed.filter((line) => line === "shared start")).toHaveLength(1);
		expect(committed).toContain("second take");
	});
});

describe("PromoteRegion resize", () => {
	test("the first observed width is adopted at once, so the first block never commits at 80", () => {
		const { committed, region } = makeRegion(250);
		region.update("a\n\n", 40, 0);
		expect(region.width).toBe(40);
		expect(committed).toContain("[40]");
		expect(committed).not.toContain("[80]");
	});

	test("a first width wider than 80 is adopted at once too", () => {
		const { region } = makeRegion(250);
		region.noteWidth(132, 0);
		expect(region.width).toBe(132);
		// A later change still waits for the debounce window.
		region.noteWidth(60, 10);
		expect(region.width).toBe(132);
		region.noteWidth(60, 300);
		expect(region.width).toBe(60);
	});

	test("a new width is adopted only after it holds for the debounce window", () => {
		const { committed, region } = makeRegion(250);
		region.update("a\n\n", 80, 0);
		expect(region.width).toBe(80);

		// A width seen once is pending, not adopted.
		region.update("a\n\nb\n\n", 40, 0);
		expect(region.width).toBe(80);
		// Still inside the window.
		region.update("a\n\nb\n\nc\n\n", 40, 100);
		expect(region.width).toBe(80);
		// A flicker back to another width restarts the window.
		region.update("a\n\nb\n\nc\n\nd\n\n", 60, 200);
		expect(region.width).toBe(80);
		// 40 held for the full window: adopted.
		region.update("a\n\nb\n\nc\n\nd\n\ne\n\n", 40, 400);
		region.update("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\n", 40, 700);
		expect(region.width).toBe(40);
		// Committed rows keep the width they were committed at — nothing replays.
		expect(committed.filter((line) => line === "[80]").length).toBeGreaterThan(
			0,
		);
		expect(committed).toContain("[40]");
	});
});
