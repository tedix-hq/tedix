import { describe, expect, it } from "vite-plus/test";
import {
	DelegationWorkOrderSchema,
	EnqueueHomeMessageInputSchema,
	RespondHomeApprovalInputSchema,
} from "./kernel-runtime";

const baseWorkOrder = {
	targetTediId: "tedi-1",
	objective: "Fix the approval inbox read.",
	outputContract: "A commit sha plus the passing reproduction.",
	executionRequirement: {
		surface: "native",
		requiredCapabilities: [],
		fallbackSurface: null,
		prohibitedSurfaces: [],
		satisfiable: true,
		reason: "operator-directed",
	},
	contract: {
		successCriteria: [],
		budgetHint: "",
		deadlineHint: "",
		failurePolicy: "fail_closed",
	},
	outputSchema: null,
	sourceContent: "fix the approval inbox read",
};

describe("Home Work continuation", () => {
	it("validates explicit metadata.workItemId while preserving other metadata", () => {
		expect(
			EnqueueHomeMessageInputSchema.safeParse({
				content: "continue",
				metadata: { workItemId: 42 },
			}).success,
		).toBe(false);
		expect(
			EnqueueHomeMessageInputSchema.parse({
				content: "continue",
				metadata: { workItemId: "fixture-work", source: "fixture" },
			}).metadata,
		).toEqual({ workItemId: "fixture-work", source: "fixture" });
	});
});

describe("verifyCommand", () => {
	it("is optional and trimmed on the work order and the Home submit input", () => {
		expect(DelegationWorkOrderSchema.parse(baseWorkOrder)).not.toHaveProperty(
			"verifyCommand",
		);
		expect(
			DelegationWorkOrderSchema.parse({
				...baseWorkOrder,
				verifyCommand: "  bun run test:run  ",
			}).verifyCommand,
		).toBe("bun run test:run");
		expect(
			EnqueueHomeMessageInputSchema.parse({
				content: "fix it",
				delegateToTediId: "tedi-1",
				verifyCommand: " tedix work approval-list ",
			}).verifyCommand,
		).toBe("tedix work approval-list");
	});

	it("rejects an empty or oversized verify command", () => {
		expect(
			DelegationWorkOrderSchema.safeParse({
				...baseWorkOrder,
				verifyCommand: "   ",
			}).success,
		).toBe(false);
		expect(
			DelegationWorkOrderSchema.safeParse({
				...baseWorkOrder,
				verifyCommand: "x".repeat(501),
			}).success,
		).toBe(false);
		expect(
			EnqueueHomeMessageInputSchema.safeParse({
				content: "fix it",
				verifyCommand: "",
			}).success,
		).toBe(false);
		expect(
			EnqueueHomeMessageInputSchema.safeParse({
				content: "fix it",
				verifyCommand: 42,
			}).success,
		).toBe(false);
	});
});

describe("Home execution policy", () => {
	it("defaults to normal and accepts the observe-only ceiling", () => {
		expect(
			EnqueueHomeMessageInputSchema.parse({ content: "route this" })
				.executionPolicy,
		).toBe("normal");
		expect(
			EnqueueHomeMessageInputSchema.parse({
				content: "route this",
				executionPolicy: "observe_only",
			}).executionPolicy,
		).toBe("observe_only");
	});

	it("rejects unknown execution policies", () => {
		expect(
			EnqueueHomeMessageInputSchema.safeParse({
				content: "route this",
				executionPolicy: "execute_anyway",
			}).success,
		).toBe(false);
	});
});

describe("recorded Home approval continuation input", () => {
	const resume = {
		runId: "fictional-run",
		resumeOnly: true,
		approvalEventId: "fictional-event",
		expectedWorkItemVersion: 2,
	};
	it("accepts a receipt-only request without a new decision", () => {
		const parsed = RespondHomeApprovalInputSchema.parse(resume);
		expect(parsed).toEqual(resume);
		expect("decision" in parsed).toBe(false);
	});
	it.each([
		"decision",
		"note",
		"edits",
		"assignmentIds",
		"delegateRecommendation",
	])("rejects a mixed resume and %s request", (field) => {
		const values = {
			decision: "approve",
			note: "another decision",
			edits: {},
			assignmentIds: [],
			delegateRecommendation: true,
		};
		expect(
			RespondHomeApprovalInputSchema.safeParse({
				...resume,
				[field]: values[field as keyof typeof values],
			}).success,
		).toBe(false);
	});
	it("preserves ordinary approve and reject requests", () => {
		for (const decision of ["approve", "reject"])
			expect(
				RespondHomeApprovalInputSchema.parse({
					runId: "fictional-run",
					decision,
					note: "operator decision",
				}),
			).toEqual({
				runId: "fictional-run",
				decision,
				note: "operator decision",
			});
	});
});
