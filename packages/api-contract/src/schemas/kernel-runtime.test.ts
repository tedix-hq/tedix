import { describe, expect, it } from "vite-plus/test";
import {
	DelegationWorkOrderSchema,
	EnqueueHomeMessageInputSchema,
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
