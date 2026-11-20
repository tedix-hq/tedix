import { describe, expect, it } from "vite-plus/test";
import { tediApprovalHref } from "./workspace-chat-tedi-approval-card";

describe("tediApprovalHref", () => {
	it("links only to a web or in-app address, otherwise to the approvals list", () => {
		expect(tediApprovalHref("https://os.example.test/work/approvals/1")).toBe(
			"https://os.example.test/work/approvals/1",
		);
		expect(tediApprovalHref("/work/approvals/1")).toBe("/work/approvals/1");
		expect(tediApprovalHref("javascript:alert(1)")).toBe("/work/approvals");
		expect(tediApprovalHref("//evil.example")).toBe("/work/approvals");
		expect(tediApprovalHref(null)).toBe("/work/approvals");
	});
});
