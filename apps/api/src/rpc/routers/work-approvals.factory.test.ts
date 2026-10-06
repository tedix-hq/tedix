import { describe, expect, it } from "vite-plus/test";
import { workApprovalsContractRouter } from "./work-approvals";

describe("Work approvals router", () => {
	it("mounts proposal, decision, actor inbox, and admin audit operations", () => {
		expect(Object.keys(workApprovalsContractRouter)).toEqual([
			"propose",
			"decide",
			"listInbox",
			"listAudit",
		]);
	});
});
