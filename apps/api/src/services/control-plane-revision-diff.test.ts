import { describe, expect, it } from "vite-plus/test";
import { diffControlPlaneJson } from "./control-plane-revision-diff";

describe("control-plane revision diff", () => {
	it("returns deterministic path-sorted changes and treats arrays atomically", () => {
		expect(
			diffControlPlaneJson(
				{ z: 1, nested: { keep: true, remove: "old" }, list: [1, 2] },
				{ a: 2, nested: { keep: true, add: "new" }, list: [2, 1] },
			),
		).toEqual([
			{ path: "$.a", kind: "added", after: 2 },
			{ path: "$.list", kind: "changed", before: [1, 2], after: [2, 1] },
			{ path: "$.nested.add", kind: "added", after: "new" },
			{ path: "$.nested.remove", kind: "removed", before: "old" },
			{ path: "$.z", kind: "removed", before: 1 },
		]);
	});
});
