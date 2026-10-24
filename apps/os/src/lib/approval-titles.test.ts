import { describe, expect, it } from "vite-plus/test";
import {
	appLabel,
	plainApprovalTitle,
	plainToolTitle,
} from "./approval-titles";

describe("plainApprovalTitle", () => {
	it.each([
		[
			"example-unified:tedi_146194__run_skill_workflow",
			{ args: { skillSlug: "weekly-sales-report" } },
			"Run skill: Weekly sales report in Example",
		],
		[
			"example-unified:tedi_146194__run_skill_workflow",
			null,
			"Run a skill in Example",
		],
		[
			"Approve Kernel write: google_gmail.create_draft on google-gmail-tedix",
			null,
			"Create draft in Google Gmail",
		],
		["Run work.create_work_items", { appSlug: "tedix" }, "Create work items"],
		["Run projects.create_factory…", null, "Create factory"],
		["repo_commit", { appSlug: "repo" }, "Repo commit"],
		["", { toolName: "connections.update_role" }, "Update role"],
	])("formats %s", (title, payload, expected) => {
		expect(plainApprovalTitle(title, payload)).toBe(expected);
	});

	it("keeps titles that already read as sentences", () => {
		for (const title of [
			"Create work items — title: Prepare the October report",
			"Commit 2 file(s) to example/repo@main (base main)",
			"Draft the Example GmbH invoice.",
		])
			expect(plainApprovalTitle(title, { toolName: "x.y" })).toBe(title);
	});
});

describe("plainToolTitle", () => {
	it("splits camelCase and drops namespaces", () => {
		expect(plainToolTitle("crm.createContactNote")).toBe("Create contact note");
	});
});

describe("appLabel", () => {
	it("names apps without routing suffixes", () => {
		expect(appLabel("google-drive-tedix")).toBe("Google Drive");
		expect(appLabel("tedix-unified")).toBe("Tedix");
		expect(appLabel(null)).toBeNull();
	});
});
