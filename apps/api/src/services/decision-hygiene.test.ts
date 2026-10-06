import { describe, expect, it } from "vite-plus/test";
import {
	assertSkillPromotionPremortem,
	premortemRequiredForSkillPromotion,
	type SkillPremortemNote,
} from "./decision-hygiene";

const validPremortem: SkillPremortemNote = {
	failureModes: [
		"The workflow silently depends on a tool schema that drifts",
		"Rollback tag is deleted so demotion loses its baseline",
	],
	rollback: "Demote back to proven and restore revision N-1 from history",
};

describe("premortemRequiredForSkillPromotion", () => {
	it("requires a premortem when promoting INTO crystallized (record layer)", () => {
		expect(
			premortemRequiredForSkillPromotion(
				{ paceLayer: "differentiation", lifecycleState: "proven" },
				"crystallized",
			),
		).toBe(true);
	});

	it("requires a premortem when the proposal is already crystallized (default target preserves it)", () => {
		expect(
			premortemRequiredForSkillPromotion(
				{ paceLayer: "record", lifecycleState: "crystallized" },
				undefined,
			),
		).toBe(true);
	});

	it("requires a premortem when mutating stored record-layer content", () => {
		expect(
			premortemRequiredForSkillPromotion(
				{ paceLayer: "record", lifecycleState: "proven" },
				"active",
			),
		).toBe(true);
	});

	it("does not fire for innovation/differentiation promotions", () => {
		expect(
			premortemRequiredForSkillPromotion(
				{ paceLayer: "innovation", lifecycleState: "draft" },
				undefined,
			),
		).toBe(false);
		expect(
			premortemRequiredForSkillPromotion(
				{ paceLayer: "differentiation", lifecycleState: "proven" },
				"proven",
			),
		).toBe(false);
	});
});

describe("assertSkillPromotionPremortem", () => {
	const recordExisting = {
		id: "skill-1",
		paceLayer: "record",
		lifecycleState: "crystallized",
	} as const;
	const draftExisting = {
		id: "skill-2",
		paceLayer: "innovation",
		lifecycleState: "draft",
	} as const;

	it("blocks an agent record-layer apply without a premortem", () => {
		expect(() =>
			assertSkillPromotionPremortem({
				existing: recordExisting,
				targetLifecycleState: undefined,
				premortem: undefined,
				skipReason: undefined,
				operatorAuthority: false,
			}),
		).toThrowError(/premortem/);
	});

	it("blocks a human record-layer apply without premortem or skip reason", () => {
		expect(() =>
			assertSkillPromotionPremortem({
				existing: recordExisting,
				targetLifecycleState: undefined,
				premortem: undefined,
				skipReason: undefined,
				operatorAuthority: true,
			}),
		).toThrowError(/premortem/);
	});

	it("accepts a valid premortem from an agent and returns the audit line", () => {
		const result = assertSkillPromotionPremortem({
			existing: recordExisting,
			targetLifecycleState: "crystallized",
			premortem: validPremortem,
			skipReason: undefined,
			operatorAuthority: false,
		});
		expect(result.required).toBe(true);
		expect(result.provided).toBe(true);
		expect(result.skipped).toBe(false);
		expect(result.auditLine).toContain("Premortem (Klein 2007)");
		expect(result.auditLine).toContain("Rollback:");
	});

	it("lets an operator skip with an explicit reason (logged into the audit line)", () => {
		const result = assertSkillPromotionPremortem({
			existing: recordExisting,
			targetLifecycleState: undefined,
			premortem: undefined,
			skipReason: "Emergency re-promotion after verified rollback drill",
			operatorAuthority: true,
		});
		expect(result.skipped).toBe(true);
		expect(result.auditLine).toContain("Premortem skipped by operator");
		expect(result.auditLine).toContain("rollback drill");
	});

	it("rejects an agent trying to use the skip lane", () => {
		expect(() =>
			assertSkillPromotionPremortem({
				existing: recordExisting,
				targetLifecycleState: undefined,
				premortem: undefined,
				skipReason: "I promise this is fine, no premortem needed",
				operatorAuthority: false,
			}),
		).toThrowError(/operator-only/);
	});

	it("rejects a premortem with fewer than 2 distinct failure modes", () => {
		expect(() =>
			assertSkillPromotionPremortem({
				existing: recordExisting,
				targetLifecycleState: "crystallized",
				premortem: {
					failureModes: [
						"The workflow schema drifts",
						"the workflow schema drifts",
					],
					rollback: validPremortem.rollback,
				},
				skipReason: undefined,
				operatorAuthority: false,
			}),
		).toThrowError(/distinct failureModes/);
	});

	it("rejects a premortem with a trivial rollback plan", () => {
		expect(() =>
			assertSkillPromotionPremortem({
				existing: recordExisting,
				targetLifecycleState: "crystallized",
				premortem: {
					failureModes: validPremortem.failureModes,
					rollback: "revert",
				},
				skipReason: undefined,
				operatorAuthority: false,
			}),
		).toThrowError(/rollback plan/);
	});

	it("passes through non-record promotions without requiring anything", () => {
		const result = assertSkillPromotionPremortem({
			existing: draftExisting,
			targetLifecycleState: undefined,
			premortem: undefined,
			skipReason: undefined,
			operatorAuthority: false,
		});
		expect(result).toEqual({
			required: false,
			provided: false,
			skipped: false,
			auditLine: null,
		});
	});

	it("still records a voluntary premortem on non-record promotions", () => {
		const result = assertSkillPromotionPremortem({
			existing: draftExisting,
			targetLifecycleState: undefined,
			premortem: validPremortem,
			skipReason: undefined,
			operatorAuthority: false,
		});
		expect(result.required).toBe(false);
		expect(result.provided).toBe(true);
		expect(result.auditLine).toContain("Premortem (Klein 2007)");
	});

	it("previews without blocking on dryRun", () => {
		const result = assertSkillPromotionPremortem({
			existing: recordExisting,
			targetLifecycleState: undefined,
			premortem: undefined,
			skipReason: undefined,
			operatorAuthority: false,
			dryRun: true,
		});
		expect(result.required).toBe(true);
		expect(result.auditLine).toBeNull();
	});
});
