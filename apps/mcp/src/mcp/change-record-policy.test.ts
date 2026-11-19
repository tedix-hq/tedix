import { describe, expect, it } from "vite-plus/test";
import {
	declaresSkipAppliedChangeRecord,
	needsChangeRecord,
} from "./change-record-policy";

describe("needsChangeRecord", () => {
	it.each([
		["refused read", "denied", "read", false, true],
		["read awaiting approval", "needs_approval", "read", false, true],
		["errored read", "not_applied", "read", false, true],
		["read with unknown outcome", "unknown", "read", false, true],
		["refused liveness report", "denied", "bounded_write", true, true],
		["errored liveness report", "not_applied", "bounded_write", true, true],
		["applied read", "applied", "read", false, false],
		["applied liveness report", "applied", "bounded_write", true, false],
		["applied ordinary bounded write", "applied", "bounded_write", false, true],
		["applied unclassified write", "applied", "unclassified", false, true],
		[
			"unclassified write claiming liveness",
			"applied",
			"unclassified",
			true,
			true,
		],
		[
			"high-impact write claiming liveness",
			"applied",
			"high_impact_write",
			true,
			true,
		],
		[
			"external write claiming liveness",
			"applied",
			"external_side_effect",
			true,
			true,
		],
	] as const)("%s: stored=%s", (_name, outcome, riskTier, skip, stored) => {
		expect(
			needsChangeRecord({
				outcome,
				riskTier,
				skipAppliedChangeRecord: skip,
			}),
		).toBe(stored);
	});
});

describe("declaresSkipAppliedChangeRecord", () => {
	it("reads only a valid policy that declares it", () => {
		expect(
			declaresSkipAppliedChangeRecord({
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					skipAppliedChangeRecord: true,
				},
			}),
		).toBe(true);
		expect(
			declaresSkipAppliedChangeRecord({
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			}),
		).toBe(false);
		expect(
			declaresSkipAppliedChangeRecord({
				"com.tedix/policy": { skipAppliedChangeRecord: "yes" },
			}),
		).toBe(false);
		expect(declaresSkipAppliedChangeRecord(null)).toBe(false);
	});
});
