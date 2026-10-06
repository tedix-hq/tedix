import assert from "node:assert/strict";
import {
	decideWorkflowStartReconciliation,
	WORKFLOW_START_WATCHDOG_MAX_RESTARTS,
	type WorkflowDispatchContext,
} from "./workflow-start-watchdog";

const base: WorkflowDispatchContext = {
	runId: "run-1",
	sessionKey: "session-1",
	userText: "work",
	userTs: 1,
	admittedAt: 1,
	restartCount: 0,
};

assert.deepEqual(
	decideWorkflowStartReconciliation({
		context: { ...base, startedAt: 2 },
		status: "running",
	}),
	{ action: "ignore" },
);
assert.deepEqual(
	decideWorkflowStartReconciliation({ context: base, status: "queued" }),
	{ action: "restart", nextRestartCount: 1 },
);
assert.equal(
	decideWorkflowStartReconciliation({
		context: { ...base, restartCount: WORKFLOW_START_WATCHDOG_MAX_RESTARTS },
		status: "running",
	}).action,
	"fail",
);
assert.equal(
	decideWorkflowStartReconciliation({ context: base, status: "errored" })
		.action,
	"fail",
);
assert.deepEqual(
	decideWorkflowStartReconciliation({ context: base, status: "complete" }),
	{
		action: "fail",
		reason: "workflow settled complete before confirming its first checkpoint",
	},
);

console.log("PASS: workflow start watchdog decisions");
