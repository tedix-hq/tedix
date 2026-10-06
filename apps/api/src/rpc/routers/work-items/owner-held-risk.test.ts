import { describe, expect, it } from "vite-plus/test";
import { ownerHeldRiskLevel } from "./policy-helpers";

/**
 * `riskLevel` is the input to `requiredWorkAdmissionAuthorities`, which returns
 * nothing below high/critical. If a scoped harness can set it, it can create,
 * accept and admit its own work without a proposer/disposer pair ever existing
 * — the exact invariant the D1 trigger `'self approval is forbidden'` exists to
 * protect. The gate therefore fails closed on every identity that is not
 * affirmatively a human or an operator-issued key.
 */
describe("ownerHeldRiskLevel", () => {
	it("discards a risk level chosen by an agent principal", () => {
		expect(ownerHeldRiskLevel("tedi", "low")).toBeUndefined();
		expect(ownerHeldRiskLevel("m2m", "low")).toBeUndefined();
		expect(ownerHeldRiskLevel("service-binding", "low")).toBeUndefined();
	});

	it("fails closed on an unproven identity", () => {
		expect(ownerHeldRiskLevel(undefined, "low")).toBeUndefined();
		expect(ownerHeldRiskLevel("", "low")).toBeUndefined();
		expect(ownerHeldRiskLevel("something-new", "critical")).toBeUndefined();
	});

	it("keeps an owner's or operator key's chosen risk level", () => {
		expect(ownerHeldRiskLevel("user", "low")).toBe("low");
		expect(ownerHeldRiskLevel("user", "critical")).toBe("critical");
		expect(ownerHeldRiskLevel("apikey", "low")).toBe("low");
	});

	it("discards an agent's escalation too, not only its de-escalation", () => {
		// The field is owner-held, not merely floor-guarded: an agent must not
		// steer admission in either direction.
		expect(ownerHeldRiskLevel("tedi", "critical")).toBeUndefined();
	});
});
