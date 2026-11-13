import { describe, expect, it } from "vite-plus/test";
import {
	parseToolPolicyMetadata,
	withDerivedToolOperationalRiskPolicy,
	withoutToolClassDeclaration,
} from "../schemas/tools";
import {
	declaredAutoApproval,
	declaredToolClass,
	NEVER_AUTO_APPROVED_ACTIONS,
	toolClassDeclarationGap,
	wireDeclaredToolClass,
} from "./tool-declared-class";

const policy = (value: Record<string, unknown>) => ({
	"com.tedix/policy": value,
});
const bounded = { riskTier: "bounded_write", blastRadius: "single_resource" };

describe("declared tool class", () => {
	it("needs the marker, the write class and the tier", () => {
		const meta = policy({ ...bounded, declared: true });
		expect(declaredToolClass({ writeCapability: "write", meta })).toEqual({
			writeCapability: "write",
			...bounded,
		});
		expect(declaredToolClass({ writeCapability: null, meta })).toBeNull();
		expect(
			declaredToolClass({ writeCapability: "write", meta: policy(bounded) }),
		).toBeNull();
		expect(
			declaredToolClass({
				writeCapability: "write",
				meta: policy({ declared: true }),
			}),
		).toBeNull();
	});

	it("reads the listed class only with its write class", () => {
		expect(
			wireDeclaredToolClass(
				policy({ ...bounded, declared: true, writeCapability: "write" }),
			)?.writeCapability,
		).toBe("write");
		expect(
			wireDeclaredToolClass(policy({ ...bounded, declared: true })),
		).toBeNull();
	});

	it("lets only a bounded ordinary write run on automatic approval", () => {
		const eligible = (
			writeCapability: "read" | "write" | "destructive",
			riskTier:
				| "read"
				| "bounded_write"
				| "high_impact_write"
				| "external_side_effect",
		) =>
			declaredAutoApproval({
				writeCapability,
				riskTier,
				blastRadius: "single_resource",
			}).eligible;
		expect(eligible("write", "bounded_write")).toBe(true);
		expect(eligible("destructive", "bounded_write")).toBe(false);
		expect(eligible("destructive", "high_impact_write")).toBe(false);
		expect(eligible("write", "high_impact_write")).toBe(false);
		expect(eligible("write", "external_side_effect")).toBe(false);
		expect(eligible("read", "read")).toBe(false);
	});

	it("names the five actions that always ask", () => {
		expect(NEVER_AUTO_APPROVED_ACTIONS.map((action) => action.id)).toEqual([
			"delete",
			"external_send",
			"spend",
			"code_execution",
			"sharing_change",
		]);
	});

	it("reports what a row still has to state", () => {
		expect(toolClassDeclarationGap({ writeCapability: null })).toContain(
			"no write class",
		);
		expect(toolClassDeclarationGap({ writeCapability: "read" })).toBeNull();
		expect(toolClassDeclarationGap({ writeCapability: "write" })).toContain(
			"no risk tier",
		);
		expect(
			toolClassDeclarationGap({
				writeCapability: "write",
				meta: policy(bounded),
			}),
		).toBeNull();
		expect(
			toolClassDeclarationGap({
				writeCapability: "destructive",
				meta: policy(bounded),
			}),
		).toContain("declared destructive");
		expect(
			toolClassDeclarationGap({
				writeCapability: "read",
				meta: policy(bounded),
			}),
		).toContain("declared read");
	});

	it("never turns a derived tier into a declaration", () => {
		const derived = withDerivedToolOperationalRiskPolicy({
			writeCapability: "write",
			meta: policy({ declared: true, writeCapability: "read" }),
		});
		expect(parseToolPolicyMetadata(derived)).toEqual(bounded);
		expect(
			declaredToolClass({ writeCapability: "write", meta: derived }),
		).toBeNull();
	});

	it("removes a declaration from metadata Tedix did not write", () => {
		const upstream = policy({ ...bounded, declared: true, owner: "them" });
		expect(withoutToolClassDeclaration(upstream)).toEqual(
			policy({ ...bounded, owner: "them" }),
		);
		const plain = { other: 1 };
		expect(withoutToolClassDeclaration(plain)).toBe(plain);
		expect(withoutToolClassDeclaration(null)).toBeNull();
	});
});
