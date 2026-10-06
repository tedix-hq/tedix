import { describe, expect, it } from "vite-plus/test";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import {
	type DiffLine,
	buildUnifiedDiff,
	collapseDiff,
} from "@/lib/diff/diff-model";

/** Compact rendering of one hunk, in the shape a unified diff prints. */
function render(lines: readonly DiffLine[]): string[] {
	return lines.map((line) => {
		const marker =
			line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
		return `${marker}${line.text}`;
	});
}

function allLines(model: ReturnType<typeof buildUnifiedDiff>): DiffLine[] {
	return model.hunks.flatMap((hunk) => hunk.lines);
}

describe("buildUnifiedDiff", () => {
	it("reports an unchanged document with no hunks", () => {
		const model = buildUnifiedDiff("a\nb", "a\nb");
		expect(model.status).toBe("unchanged");
		expect(model.hunks).toEqual([]);
		expect(model.additions).toBe(0);
		expect(model.deletions).toBe(0);
	});

	it("renders a replacement as the removed line above the added line", () => {
		const model = buildUnifiedDiff("one\ntwo\nthree", "one\nTWO\nthree");
		expect(model.status).toBe("modified");
		expect(model.additions).toBe(1);
		expect(model.deletions).toBe(1);
		expect(render(allLines(model))).toEqual([" one", "-two", "+TWO", " three"]);
	});

	it("numbers both sides so a reviewer can locate the change", () => {
		const model = buildUnifiedDiff("a\nb\nc", "a\nx\ny\nc");
		expect(
			allLines(model).map((line) => [
				line.kind,
				line.originalLine,
				line.modifiedLine,
			]),
		).toEqual([
			["context", 1, 1],
			["removed", 2, null],
			["added", null, 2],
			["added", null, 3],
			["context", 3, 4],
		]);
	});

	it("highlights only the changed words on a replaced line", () => {
		const model = buildUnifiedDiff(
			'  "title": "old name",',
			'  "title": "new name",',
		);
		const [removed, added] = allLines(model);
		expect(removed?.slices).toEqual([{ startCol: 13, endCol: 16 }]);
		expect(added?.slices).toEqual([{ startCol: 13, endCol: 16 }]);
	});

	it("does not inline-highlight two unrelated lines", () => {
		// Sharing a few incidental letters must not make these a replacement.
		const model = buildUnifiedDiff(
			"the quick brown fox",
			"synchronize budget policy",
		);
		for (const line of allLines(model)) expect(line.slices).toEqual([]);
	});

	it("keeps two changes separated by one unchanged line in one hunk", () => {
		const model = buildUnifiedDiff("a\nkeep\nb", "x\nkeep\ny");
		expect(model.hunks).toHaveLength(1);
		expect(render(allLines(model))).toEqual(["-a", "+x", " keep", "-b", "+y"]);
	});

	it("splits distant changes into separate hunks and drops the middle", () => {
		const original = Array.from({ length: 40 }, (_, i) => `line ${i}`);
		const modified = [...original];
		modified[1] = "changed head";
		modified[38] = "changed tail";
		const model = buildUnifiedDiff(original.join("\n"), modified.join("\n"));
		expect(model.hunks).toHaveLength(2);
		expect(model.hunks[0]?.lines.some((l) => l.text === "changed head")).toBe(
			true,
		);
		expect(model.hunks[1]?.lines.some((l) => l.text === "changed tail")).toBe(
			true,
		);
		// The 30-odd untouched lines between them are never rendered.
		expect(allLines(model).length).toBeLessThan(20);
	});

	it("classifies a document created from nothing as added", () => {
		expect(buildUnifiedDiff("", "a\nb").status).toBe("added");
	});

	it("classifies a document emptied out as deleted", () => {
		expect(buildUnifiedDiff("a\nb", "").status).toBe("deleted");
	});

	it("falls back to an approximate diff instead of running away", () => {
		const original = Array.from({ length: 400 }, (_, i) => `a${i}`).join("\n");
		const modified = Array.from({ length: 400 }, (_, i) => `b${i}`).join("\n");
		const model = buildUnifiedDiff(original, modified);
		expect(model.approximate).toBe(true);
		expect(model.additions).toBe(400);
		expect(model.deletions).toBe(400);
	});

	it("skips the inline pass on a pathologically long line", () => {
		const long = "x".repeat(2_000);
		const model = buildUnifiedDiff(`${long}a`, `${long}b`);
		for (const line of allLines(model)) expect(line.slices).toEqual([]);
	});
});

describe("collapseDiff", () => {
	it("shows everything when the diff fits", () => {
		const model = buildUnifiedDiff("a", "b");
		expect(collapseDiff(model, 100)).toEqual({
			hunks: model.hunks,
			hiddenLines: 0,
		});
	});

	it("caps the rendered rows and reports how many are withheld", () => {
		const original = Array.from({ length: 60 }, (_, i) => `a${i}`).join("\n");
		const modified = Array.from({ length: 60 }, (_, i) => `b${i}`).join("\n");
		const model = buildUnifiedDiff(original, modified);
		const collapsed = collapseDiff(model, 10);
		expect(
			collapsed.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
		).toBe(10);
		expect(collapsed.hiddenLines).toBe(110);
	});
});

describe("canonicalJsonText", () => {
	it("sorts object keys so a key reordering is not a change", () => {
		const a = canonicalJsonText({ b: 1, a: { d: 2, c: 3 } });
		const b = canonicalJsonText({ a: { c: 3, d: 2 }, b: 1 });
		expect(a).toBe(b);
		expect(buildUnifiedDiff(a, b).status).toBe("unchanged");
	});

	it("keeps array order, which is semantic", () => {
		expect(canonicalJsonText([2, 1])).not.toBe(canonicalJsonText([1, 2]));
	});

	it("renders an absent document as empty text", () => {
		expect(canonicalJsonText(undefined)).toBe("");
	});
});
