import { describe, expect, it } from "vite-plus/test";
import { evaluateCall } from "./compliance";

describe("evaluateCall", () => {
	it("allows a read with no gate facts", () => {
		expect(
			evaluateCall({ riskTier: "read", approval: "not_required" }),
		).toMatchObject({
			verdict: "allow",
			riskTier: "read",
			blastRadius: "unclassified",
		});
	});
	it("denies in gateway order: scope before rate before policy", () => {
		expect(
			evaluateCall({
				scopeDenied: true,
				rate: { limited: true },
				approval: "denied",
			}).gate,
		).toBe("tool_scope");
		expect(
			evaluateCall({
				rate: { limited: true },
				disposition: "deny",
				approval: "denied",
			}),
		).toMatchObject({ gate: "risk_rate_limit", reason: "tool_rate_limited" });
		expect(
			evaluateCall({ disposition: "deny", approval: "granted" }),
		).toMatchObject({
			verdict: "deny",
			reason: "policy_denied",
		});
	});
	it("holds a destructive call without a receipt and allows one with it", () => {
		expect(
			evaluateCall({ destructive: true, approval: "pending" }),
		).toMatchObject({
			verdict: "needs_approval",
			approvalRoute: "human",
		});
		expect(
			evaluateCall({ destructive: true, approval: "granted" }).verdict,
		).toBe("allow");
		expect(
			evaluateCall({ disposition: "ask", approval: "not_required" }),
		).toMatchObject({
			verdict: "needs_approval",
			reason: "policy_ask",
		});
	});
	it("carries the tier budget", () => {
		expect(
			evaluateCall({ riskTier: "high_impact_write", approval: "not_required" })
				.budget,
		).toEqual({
			limit: 5,
			windowSeconds: 60,
		});
	});
});
