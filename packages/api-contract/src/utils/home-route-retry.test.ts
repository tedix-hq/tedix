import { describe, expect, it } from "vite-plus/test";
import { isHomeRouteRetryable } from "./home-route-retry";

const run = {
	status: "failed",
	metadata: {
		kernelRoute: null,
		bodyExecutionResult: { error: { kind: "model", retryable: true } },
		redriveInput: {
			content: "Stage a Work proposal for the fictional project.",
		},
	},
};

describe("Home routing retry eligibility", () => {
	it("supports saved failures from before the retry marker existed", () => {
		expect(isHomeRouteRetryable(run)).toBe(true);
	});
	it.each(["running", "completed", "canceled", "requires_approval"])(
		"rejects %s runs",
		(status) => {
			expect(isHomeRouteRetryable({ ...run, status })).toBe(false);
		},
	);
	it.each([
		"childRunId",
		"delegatedTediId",
		"delegationWorkOrder",
		"approvalRequestId",
		"homePlan",
		"kernelWriteProposal",
		"kernelRoute",
	])("rejects a selected action: %s", (key) => {
		expect(
			isHomeRouteRetryable({
				...run,
				metadata: { ...run.metadata, [key]: { id: "fictional-action" } },
			}),
		).toBe(false);
	});
	it("rejects billing failures and missing replay inputs", () => {
		expect(
			isHomeRouteRetryable({
				...run,
				metadata: {
					...run.metadata,
					bodyExecutionResult: { error: { kind: "policy", retryable: false } },
				},
			}),
		).toBe(false);
		expect(
			isHomeRouteRetryable({
				...run,
				metadata: { ...run.metadata, redriveInput: null },
			}),
		).toBe(false);
		expect(
			isHomeRouteRetryable({ ...run, childRunId: "fictional-child" }),
		).toBe(false);
	});
});
