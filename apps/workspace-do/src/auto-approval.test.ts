import { describe, expect, test } from "bun:test";
import { fileWriteAppliesAtOnce } from "./auto-approval";

describe("file writes that apply at once", () => {
	test("creating and editing a doc, sheet or deck", () => {
		for (const [binding, method] of [
			["outputs", "create"],
			["outputs", "revise"],
			["documents", "replace"],
			["documents", "edit"],
			["sheets", "edit"],
			["presentations", "replace"],
		])
			expect(fileWriteAppliesAtOnce(binding!, method!, [{}])).toBe(true);
	});

	test("Work, apps, unknown methods, destructive calls and removals wait", () => {
		expect(fileWriteAppliesAtOnce("work", "create", [{}])).toBe(false);
		expect(fileWriteAppliesAtOnce("apps", "editFile", [{}])).toBe(false);
		expect(fileWriteAppliesAtOnce("apps", "create", [{}])).toBe(false);
		expect(fileWriteAppliesAtOnce("outputs", "delete", [{}])).toBe(false);
		expect(fileWriteAppliesAtOnce("outputs", "share", [{}])).toBe(false);
		expect(
			fileWriteAppliesAtOnce("outputs", "revise", [{}], { destructive: true }),
		).toBe(false);
		expect(
			fileWriteAppliesAtOnce("documents", "edit", [
				{
					ops: [
						{ op: "insert", index: 0 },
						{ op: "delete", index: 2 },
					],
				},
			]),
		).toBe(false);
		expect(
			fileWriteAppliesAtOnce("presentations", "edit", [
				{ ops: [{ op: "delete", index: 0 }] },
			]),
		).toBe(false);
	});
});
