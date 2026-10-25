import { describe, expect, it } from "vite-plus/test";
import { approvalDecision } from "./approval-decision";
describe("approval decision catalog", () => {
	it("does not invent effects for unknown runtime actions", () => {
		const result = approvalDecision({
			actionType: "fictional_action",
			review: { intent: "unknown" },
		});
		expect(result.recommendation).toBe("rejected");
		expect(result.reason).toContain("no verified description");
	});
	it("recommends approving a low-risk Home write and reviewing anything riskier", () => {
		const write = (riskTier?: string) =>
			approvalDecision({
				actionType: "home_request",
				review: { intent: "home_write" },
				riskTier,
			});
		expect(write("low")).toMatchObject({
			recommendation: "approved",
			reason: expect.stringContaining("Low-risk"),
		});
		for (const risk of ["medium", "high", undefined])
			expect(write(risk).recommendation).toBe("rejected");
	});
	it("keeps sign-in and consent with the person", () => {
		expect(
			approvalDecision({
				actionType: "browser.live_view_takeover",
				review: { intent: "browser_takeover" },
			}),
		).toMatchObject({
			recommendation: "rejected",
			reason: expect.stringContaining("your presence"),
		});
	});
});
