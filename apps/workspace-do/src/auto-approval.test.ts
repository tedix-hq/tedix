import { describe, expect, test } from "bun:test";
import {
	autoApprovalKindFor,
	readAutoApprovalRules,
	writeAutoApprovalRule,
} from "./auto-approval";

function memory() {
	const map = new Map<string, unknown>();
	return {
		get: <T>(key: string) => map.get(key) as T | undefined,
		put: (key: string, value: unknown) => void map.set(key, value),
	};
}

describe("always approve rules", () => {
	test("file writes in the workspace can be covered", () => {
		for (const [binding, method] of [
			["outputs", "create"],
			["outputs", "revise"],
			["documents", "replace"],
			["documents", "edit"],
			["sheets", "edit"],
			["presentations", "replace"],
		])
			expect(autoApprovalKindFor(binding!, method!, [{}])).toBe("files");
	});

	test("Work, app drafts, unknown methods, destructive calls and removals never are", () => {
		expect(autoApprovalKindFor("work", "create", [{}])).toBeNull();
		expect(autoApprovalKindFor("apps", "editFile", [{}])).toBeNull();
		expect(autoApprovalKindFor("outputs", "delete", [{}])).toBeNull();
		expect(autoApprovalKindFor("outputs", "share", [{}])).toBeNull();
		expect(
			autoApprovalKindFor("outputs", "revise", [{}], { destructive: true }),
		).toBeNull();
		expect(
			autoApprovalKindFor("documents", "edit", [
				{
					ops: [
						{ op: "insert", index: 0 },
						{ op: "delete", index: 2 },
					],
				},
			]),
		).toBeNull();
		expect(
			autoApprovalKindFor("presentations", "edit", [
				{ ops: [{ op: "delete", index: 0 }] },
			]),
		).toBeNull();
	});

	test("rules are stored per kind and can be turned off", () => {
		const store = memory();
		expect(readAutoApprovalRules(store)).toEqual([]);
		writeAutoApprovalRule(store, {
			kind: "files",
			enabled: true,
			by: "u1",
			at: "2026-11-18T10:00:00.000Z",
		});
		expect(readAutoApprovalRules(store)).toEqual([
			{
				kind: "files",
				label: "creating and editing docs, sheets and slides in this workspace",
				enabledBy: "u1",
				enabledAt: "2026-11-18T10:00:00.000Z",
			},
		]);
		writeAutoApprovalRule(store, {
			kind: "files",
			enabled: false,
			by: "u1",
			at: "2026-11-18T10:05:00.000Z",
		});
		expect(readAutoApprovalRules(store)).toEqual([]);
	});
});
