import { describe, expect, it } from "vite-plus/test";
import { applyWorkflowExecutionHeaders } from "./handler";

const caller = {
	authType: "service" as const,
	skillRunId: "run-1",
	skillId: "skill-1",
	workflowStepId: "step-1",
	workflowStepName: "fetch offers",
	workflowStepCount: 2,
	workflowStepAttempt: 3,
	workflowCallId: "call-1",
	workflowIdempotencyKey: "idem-1",
};

describe("workflow execution header forwarding", () => {
	it("forwards provenance and idempotency to trusted Tedix services", () => {
		const headers: Record<string, string> = {};
		applyWorkflowExecutionHeaders(headers, caller, {
			includeTedixProvenance: true,
		});

		expect(headers).toEqual({
			"Idempotency-Key": "idem-1",
			"X-Idempotency-Key": "idem-1",
			"X-Tedix-Skill-Run-Id": "run-1",
			"X-Tedix-Skill-Id": "skill-1",
			"X-Tedix-Workflow-Step-Id": "step-1",
			"X-Tedix-Workflow-Step-Name": "fetch%20offers",
			"X-Tedix-Workflow-Step-Count": "2",
			"X-Tedix-Workflow-Step-Attempt": "3",
			"X-Tedix-Workflow-Call-Id": "call-1",
		});
	});

	it("sends only the provider-facing key to third-party origins", () => {
		const headers: Record<string, string> = {};
		applyWorkflowExecutionHeaders(headers, caller, {
			includeTedixProvenance: false,
		});

		expect(headers).toEqual({
			"Idempotency-Key": "idem-1",
			"X-Idempotency-Key": "idem-1",
		});
	});
});
