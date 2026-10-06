import assert from "node:assert/strict";
import {
	isDurableObjectDeploymentResetError,
	isTransientWorkflowRedriveError,
	recoverDurableObjectDeploymentReset,
} from "./durable-object-recovery";

assert.equal(
	isDurableObjectDeploymentResetError(
		new Error("Durable Object reset because its code was updated."),
	),
	true,
);
assert.equal(
	isDurableObjectDeploymentResetError(new Error("provider timeout")),
	false,
);

let recoveryCalls = 0;
const recovered = await recoverDurableObjectDeploymentReset(async () => {
	recoveryCalls += 1;
	if (recoveryCalls === 1) {
		throw new Error("Durable Object reset because its code was updated.");
	}
	return "recovered";
});
assert.equal(recovered, "recovered");
assert.equal(recoveryCalls, 2);

let failureCalls = 0;
await assert.rejects(
	recoverDurableObjectDeploymentReset(async () => {
		failureCalls += 1;
		throw new Error("tool failed after an external write");
	}),
	/external write/,
);
assert.equal(failureCalls, 1);

// (b) DEPLOY-WINDOW DO RESETS: the workflow SETTLE path re-drives a broader set
// of transient runtime losses than the immediate one-shot RPC recovery — the
// deploy `code was updated` reset (the observed objective-review /
// skill-development cron failure), isolate OOM, and internal storage reset.
for (const message of [
	"Durable Object reset because its code was updated.",
	"The isolate exceeded its memory limit and was reset",
	"Worker exceeded memory limit",
	"out of memory",
	"internal error: durable object was reset",
]) {
	assert.equal(
		isTransientWorkflowRedriveError(new Error(message)),
		true,
		`transient runtime loss re-drives: ${message}`,
	);
}
// A genuine turn failure is NOT a transient reset — it must still seal failure.
for (const message of [
	"provider timeout",
	"Execution timed out after 600000ms",
	"cron_tool_failure",
	"empty_assistant_message",
	"tool failed after an external write",
]) {
	assert.equal(
		isTransientWorkflowRedriveError(new Error(message)),
		false,
		`a real turn failure does not re-drive: ${message}`,
	);
}

console.log("PASS: Durable Object deployment reset recovery");
