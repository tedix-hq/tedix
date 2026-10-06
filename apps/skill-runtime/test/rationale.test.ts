import assert from "node:assert/strict";
import {
	buildWorkflowRationalePayload,
	RationaleEventSchema,
	workflowRationaleIdempotencyKey,
} from "../src/rationale-payload";

const parsed = RationaleEventSchema.parse({
	gate: "step_do_failure",
	stepName: "publish report",
	stepCount: 2,
	attempt: 3,
	retryable: false,
	durationMs: 42,
	error: {
		name: "McpPermanentError",
		message: "CAPABILITY_NOT_DECLARED: cms.publish",
		code: "CAPABILITY_NOT_DECLARED",
	},
});

assert.deepEqual(parsed, {
	gate: "step_do_failure",
	stepName: "publish report",
	stepCount: 2,
	attempt: 3,
	retryable: false,
	durationMs: 42,
	error: {
		name: "McpPermanentError",
		message: "CAPABILITY_NOT_DECLARED: cms.publish",
		code: "CAPABILITY_NOT_DECLARED",
	},
});

const rationale = buildWorkflowRationalePayload({
	runId: "run-1",
	skillId: "skill-1",
	skillSlug: "weekly-report",
	tediId: "tedi-1",
	orgId: "org-1",
	...parsed,
});

assert.deepEqual(rationale.evidence, {
	kind: "skill_workflow_step",
	skillId: "skill-1",
	skillSlug: "weekly-report",
	runId: "run-1",
	runUri: "skill://runs/run-1",
	stepName: "publish report",
	stepCount: 2,
	error: {
		name: "McpPermanentError",
		message: "CAPABILITY_NOT_DECLARED: cms.publish",
		code: "CAPABILITY_NOT_DECLARED",
	},
	durationMs: 42,
	attempt: 3,
	retryable: false,
	errorArtifactUri:
		"skill://weekly-report/runs/run-1/outputs/x:publish%20report.error.json",
	blameChain: [
		{
			component: "skill",
			id: "skill-1",
			contribution: "high",
			reason: "CAPABILITY_NOT_DECLARED: cms.publish",
		},
	],
});

const pauseGate = {
	runId: "run-1",
	executionEpoch: 2,
	gate: "wait_for_event_pause" as const,
	stepName: "operator approval",
	stepCount: 1,
};
assert.equal(
	await workflowRationaleIdempotencyKey(pauseGate),
	await workflowRationaleIdempotencyKey(pauseGate),
);
assert.notEqual(
	await workflowRationaleIdempotencyKey(pauseGate),
	await workflowRationaleIdempotencyKey({
		...pauseGate,
		gate: "wait_for_event_resume",
	}),
);
assert.notEqual(
	await workflowRationaleIdempotencyKey({
		...pauseGate,
		gate: "step_do_failure",
		attempt: 1,
	}),
	await workflowRationaleIdempotencyKey({
		...pauseGate,
		gate: "step_do_failure",
		attempt: 2,
	}),
);

console.log("workflow rationale tests passed");
