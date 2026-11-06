import { describe, expect, it } from "vite-plus/test";
import { delegationResolutionAction } from "./delegation-resolution-claim";

const claimedAt = "2026-11-05T21:49:47.443Z";
const claimed = (recovery?: unknown) => ({
	homeDelegationResolutionClaim: {
		phase: "resolving",
		claimId: "claim-1",
		claimedAt,
		approvalEventId: "event-1",
		approvalResolvedAt: claimedAt,
	},
	...(recovery === undefined
		? {}
		: { homeDelegationResolutionRecovery: recovery }),
});
const at = (offsetMs: number) => Date.parse(claimedAt) + offsetMs;

describe("delegationResolutionAction", () => {
	it("allows both decisions when no resolver holds the run", () => {
		expect(delegationResolutionAction({}, at(0))).toEqual({ kind: "decide" });
		expect(
			delegationResolutionAction(
				{ homeDelegationResolutionClaim: { phase: "admission_failed" } },
				at(0),
			),
		).toEqual({ kind: "decide" });
	});
	it("shows a fresh claim as being recorded until it goes stale", () => {
		expect(delegationResolutionAction(claimed(), at(60_000))).toEqual({
			kind: "recording",
			staleAt: "2026-11-05T21:54:47.443Z",
		});
	});
	it("asks to check again for a stale claim without the server's receipt check", () => {
		expect(delegationResolutionAction(claimed(), at(10 * 60_000)).kind).toBe(
			"recording",
		);
	});
	it("offers the decision the server accepts for a stale claim", () => {
		expect(
			delegationResolutionAction(
				claimed({ recordedDecision: null }),
				at(10 * 60_000),
			),
		).toEqual({ kind: "decide" });
		expect(
			delegationResolutionAction(
				claimed({ recordedDecision: "approve" }),
				at(10 * 60_000),
			),
		).toEqual({ kind: "finish", decision: "approve" });
	});
});
