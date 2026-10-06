import assert from "node:assert/strict";
import {
	armWorkflowTerminalReconciliation,
	decideWorkflowTerminalReconciliation,
	turnFailureNoticeText,
	WORKFLOW_TERMINAL_MAX_REDRIVES,
	WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS,
} from "./workflow-terminal-reconciliation";

for (const status of [
	undefined,
	"unknown",
	"queued",
	"running",
	"paused",
	"waiting",
	"waitingForPause",
]) {
	assert.deepEqual(decideWorkflowTerminalReconciliation(status), {
		action: "defer",
	});
}
assert.deepEqual(decideWorkflowTerminalReconciliation("complete"), {
	action: "complete",
});
for (const status of ["errored", "terminated"]) {
	assert.deepEqual(decideWorkflowTerminalReconciliation(status), {
		action: "fail",
	});
}
assert.equal(WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS, 20);

// (b) DEPLOY-WINDOW DO RESETS: a native errored/terminated whose terminal error
// is a transient reset RE-DRIVES (not fail) while re-drives remain.
for (const status of ["errored", "terminated"]) {
	assert.deepEqual(
		decideWorkflowTerminalReconciliation(status, {
			errorIsTransientReset: true,
			redrivesRemaining: true,
		}),
		{ action: "redrive" },
		`a transient-reset ${status} re-drives instead of sealing failure`,
	);
	// Exhausted re-drive budget: seal failure so a poisoned run terminalizes.
	assert.deepEqual(
		decideWorkflowTerminalReconciliation(status, {
			errorIsTransientReset: true,
			redrivesRemaining: false,
		}),
		{ action: "fail" },
		`a transient-reset ${status} with no re-drives left seals failure`,
	);
	// A NON-transient terminal error always seals failure, budget notwithstanding.
	assert.deepEqual(
		decideWorkflowTerminalReconciliation(status, {
			errorIsTransientReset: false,
			redrivesRemaining: true,
		}),
		{ action: "fail" },
		`a real ${status} failure seals failure even with re-drives available`,
	);
}
// The transient bypass never resurrects a completed or non-terminal run.
assert.deepEqual(
	decideWorkflowTerminalReconciliation("complete", {
		errorIsTransientReset: true,
		redrivesRemaining: true,
	}),
	{ action: "complete" },
);
assert.deepEqual(
	decideWorkflowTerminalReconciliation("running", {
		errorIsTransientReset: true,
		redrivesRemaining: true,
	}),
	{ action: "defer" },
);
assert.ok(
	WORKFLOW_TERMINAL_MAX_REDRIVES >= 1,
	"the re-drive budget is a positive bound",
);

{
	let schedules = 0;
	let scheduled: unknown[] = [];
	await armWorkflowTerminalReconciliation(
		"workflow-started-1",
		async (...args) => {
			schedules += 1;
			scheduled = args;
		},
	);
	assert.equal(schedules, 1, "started workflow arms terminal reconciliation");
	assert.deepEqual(scheduled, [
		30,
		"reconcileChatWorkflowTerminal",
		{ workflowInstanceId: "workflow-started-1", attempt: 0 },
		{ idempotent: true, retry: { maxAttempts: 3 } },
	]);
	await armWorkflowTerminalReconciliation(
		"workflow-started-schedule-fails",
		async () => {
			throw new Error("scheduler unavailable");
		},
	);
}

console.log("PASS: workflow terminal reconciliation decisions");

// A turn that dies after admission must never leave the conversation silent.
{
	const notice = turnFailureNoticeText("Error: MCP sync in failure\n  at boot");
	assert.match(notice, /ended without a reply/);
	assert.match(notice, /MCP sync in failure/);
	// Flattened: a raw multi-line stack in a chat bubble is noise.
	assert.ok(!notice.includes("\n"));
}

{
	// Budget exhaustion is expected, not a crash — say so, and say it recovers.
	const notice = turnFailureNoticeText(
		"daily inference budget exhausted for this tedi",
	);
	assert.match(notice, /daily inference budget is exhausted/);
	assert.match(notice, /budget window resets/);
}

{
	// Long errors are clipped so the thread stays readable; the ledger keeps the full text.
	const notice = turnFailureNoticeText("x".repeat(900));
	assert.ok(notice.length < 400);
	assert.match(notice, /\.\.\./);
}

{
	// Never render an empty reason.
	assert.match(turnFailureNoticeText("   "), /unknown error/);
}
