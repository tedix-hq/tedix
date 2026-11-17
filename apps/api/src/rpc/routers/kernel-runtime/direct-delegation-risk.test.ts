import { describe, expect, it } from "vite-plus/test";
import { decideAutonomousAction } from "@tedix/api-contract/utils/approval-policy";
import { directDelegationRisk } from "./direct-delegation-risk";

const policy = { version: 1, maxRisk: "medium" } as const;
const allowed = (content: string, workId?: string, workRisk?: string | null) =>
	decideAutonomousAction({
		policy,
		risk: directDelegationRisk(workId, workRisk),
		content,
		classId: "delegation:embodied",
	}).autoApprove;

describe("direct delegation risk", () => {
	it("rates an unlinked ask as medium and a linked one by its Work", () => {
		expect(directDelegationRisk(undefined, undefined)).toBe("medium");
		expect(directDelegationRisk("work", "low")).toBe("low");
		expect(directDelegationRisk("work", "high")).toBe("high");
		expect(directDelegationRisk("work", null)).toBe("unknown");
		expect(directDelegationRisk("work", undefined)).toBe("unknown");
	});

	it("lets an ordinary read-only ask run under standing consent", () => {
		expect(
			allowed(
				"Read-only check: open workspace/priorities.tsv and tell me its first line.",
			),
		).toBe(true);
	});

	it("keeps human-reserved actions behind the approval card", () => {
		for (const text of [
			"Email the customer the invoice",
			"Delete the old records",
			"Publish the blog post",
			"Pay the supplier invoice",
		])
			expect(allowed(text)).toBe(false);
	});

	it("follows linked Work risk and keeps unrated Work gated", () => {
		expect(allowed("Research the paper", "work", "medium")).toBe(true);
		expect(allowed("Research the paper", "work", "high")).toBe(false);
		expect(allowed("Research the paper", "work", null)).toBe(false);
	});

	it("honours classes the organization always asks for", () => {
		expect(
			decideAutonomousAction({
				policy: { ...policy, askForClasses: ["delegation:embodied"] },
				risk: directDelegationRisk(undefined, undefined),
				content: "Research the paper",
				classId: "delegation:embodied",
			}).autoApprove,
		).toBe(false);
	});
});
