import assert from "node:assert/strict";
import { computerExecutionModelOutput as project } from "./computer-execution-model-output";

for (const running of [true, false]) {
	const retained = {
		executionId: "unobserved",
		observation: "unavailable",
		terminal: false,
		running,
		status: "running",
		hint: "the process keeps running",
		job: { running, status: "running" },
	};
	const before = JSON.stringify(retained);
	const projected = JSON.parse(project({ output: retained }).value);
	assert.equal(projected.outcome, "unknown");
	assert.equal(projected.executionId, "unobserved");
	assert.equal(Object.hasOwn(projected, "running"), false);
	assert.equal(projected.status, undefined);
	assert.equal(projected.job, undefined);
	assert.match(projected.hint, /do not repeat the command or poll/);
	assert.equal(JSON.stringify(retained), before);
}
// Terminal evidence wins; an unrelated marker cannot relabel its outcome.
const terminalObservation = {
	executionId: "done",
	terminal: true,
	running: false,
	observation: "unavailable",
	exitCode: 0,
};
assert.deepEqual(
	JSON.parse(project({ output: terminalObservation }).value),
	terminalObservation,
);

const raw = {
	executionId: "exact-id",
	terminal: true,
	exitCode: 1,
	stdout: "head" + "x".repeat(73_604) + "tail",
	stderr: "e".repeat(15_000),
	artifactRefs: ["r2://retained/stdout.log"],
};
const before = JSON.stringify(raw);
const preview = JSON.parse(project({ output: raw }).value);
assert.equal(
	JSON.stringify(raw),
	before,
	"projection never changes retained receipt",
);
assert.equal(preview.executionId, raw.executionId);
assert.equal(preview.exitCode, 1);
assert.deepEqual(preview.artifactRefs, raw.artifactRefs);
assert.ok(preview.stdout.startsWith("head") && preview.stdout.endsWith("tail"));
assert.ok(preview.stdout.length < 4_100 && preview.stderr.length < 4_100);
assert.equal(preview.modelPreview.truncated, true);
assert.equal(
	preview.modelPreview.omittedCharacters.stdout,
	raw.stdout.length - 4_000,
);
assert.match(preview.modelPreview.instruction, /do not rerun/);
for (const receipt of [
	{ running: true, executionId: "pending" },
	{ ok: false, outcome: "unknown", executionId: "unknown", error: "transport" },
	{ terminal: true, exitCode: 0, stdout: "PASS", stderr: "" },
	{
		ok: false,
		executionId: "cancel-unconfirmed",
		requestTimedOut: true,
		terminal: false,
		exitCode: null,
		error: "Cancellation could not be confirmed",
	},
	{
		ok: true,
		executionId: "canceled",
		terminal: true,
		canceled: true,
		timedOut: false,
		exitCode: null,
	},
	{
		ok: false,
		executionId: "timed-out",
		terminal: true,
		timedOut: true,
		exitCode: 124,
	},
	{
		ok: false,
		executionId: "lost-container",
		observation: "generation_replaced",
		containerExitContext: "Container generation replaced before observation",
		exitCode: null,
		instruction: "Do not repeat the command",
	},
	{
		ok: false,
		executed: false,
		pending: true,
		error: "Computer is starting",
		context: { leaseId: "retain-refusal-context" },
	},
	{
		matches: [{ file: "example.ts", line: 1, text: "example" }],
		totalMatches: 20,
		filesWithMatches: 3,
		truncated: true,
		errors: [{ file: "missing.ts", error: "not found" }],
	},
]) {
	assert.deepEqual(JSON.parse(project({ output: receipt }).value), receipt);
}

// Source-shaped synthetic receipt: exercise metadata duplication without
// pretending these bytes or timings came from a production execution.
const syntheticReceipt = {
	executionId: "exact-id",
	id: "exact-id",
	processId: "exact-id",
	process: null,
	command: "printf 'PASS\\n'",
	context: { runId: "admitted-run", workItemId: "admitted-work" },
	evidence: {
		command: "printf 'PASS\\n'",
		context: { runId: "admitted-run", workItemId: "admitted-work" },
		artifactRefs: ["r2://retained/stdout.log"],
	},
	roundTrip: {
		dispatchMs: 100,
		waitMs: 200,
		readMs: 50,
		totalMs: 350,
		workstation: { "prepare.egressPolicy": 10 },
	},
	ok: true,
	running: false,
	terminal: true,
	exitCode: 0,
	stdout: "PASS\n",
	stderr: "",
	stdoutBytes: 5,
	stderrBytes: 0,
	stdoutTruncated: false,
	stderrTruncated: false,
	stdoutPath: "/tmp/jobs/exact-id/stdout",
	stderrPath: "/tmp/jobs/exact-id/stderr",
	artifactRefs: ["r2://retained/stdout.log"],
	artifactWriteStatus: { status: "persisted" },
	artifactRowPersistence: {
		status: "failed",
		error: "Artifact index unavailable",
	},
	workstationEvidencePersistence: {
		status: "failed",
		error: "Ledger unavailable",
	},
	// New failure details must not disappear merely because the projector has
	// not yet been updated to name them.
	failureDetail: { code: "index_unavailable", retryable: true },
};
const retained = JSON.stringify(syntheticReceipt);
const compact = JSON.parse(project({ output: syntheticReceipt }).value);
for (const field of [
	"id",
	"processId",
	"process",
	"command",
	"context",
	"evidence",
	"roundTrip",
])
	assert.equal(Object.hasOwn(compact, field), false, field);
for (const field of [
	"executionId",
	"ok",
	"running",
	"terminal",
	"exitCode",
	"stdout",
	"stderr",
	"stdoutBytes",
	"stderrBytes",
	"stdoutTruncated",
	"stderrTruncated",
	"stdoutPath",
	"stderrPath",
	"artifactRefs",
	"artifactWriteStatus",
	"artifactRowPersistence",
	"workstationEvidencePersistence",
	"failureDetail",
] as const)
	assert.deepEqual(compact[field], syntheticReceipt[field], field);
assert.equal(JSON.stringify(syntheticReceipt), retained);

const job = {
	id: "nested-execution",
	command: "printf 'PASS\\n'",
	context: { kernelRunId: "admitted-run" },
	terminal: true,
	exitCode: 0,
	stdoutTail: "head" + "x".repeat(12_000) + "tail",
	stderrTail: "",
	artifactRefs: ["r2://retained/stdout.log"],
};
const { stdoutTail, stderrTail, ...jobFields } = job;
const waitReceipt = {
	...jobFields,
	ok: true,
	found: true,
	executionId: job.id,
	stdout: stdoutTail,
	stderr: stderrTail,
	job,
};
const waitBefore = JSON.stringify(waitReceipt);
const waitPreview = JSON.parse(project({ output: waitReceipt }).value);
assert.equal(
	waitPreview.job,
	undefined,
	"the identical job is fully redundant",
);
assert.ok(waitPreview.stdout.length < 4_100);
assert.equal(waitPreview.stdoutTail, undefined);
assert.equal(JSON.stringify(waitReceipt), waitBefore);

const conflictingReceipt = {
	executionId: "root-execution",
	ok: false,
	terminal: false,
	exitCode: null,
	error: "Root observation failed",
	stdout: "root output",
	job: {
		id: "different-execution",
		command: "private command",
		context: { kernelRunId: "private-context" },
		terminal: true,
		exitCode: 7,
		error: "Job execution failed",
		stdoutTail: "j".repeat(12_000),
		stderrTail: "e".repeat(14_000),
		artifactRefs: ["r2://job/stdout.log"],
		artifactWriteStatus: { status: "failed", error: "Object write failed" },
	},
};
const conflictBefore = JSON.stringify(conflictingReceipt);
const conflict = JSON.parse(project({ output: conflictingReceipt }).value);
assert.equal(conflict.terminal, false);
assert.equal(conflict.exitCode, null);
assert.equal(conflict.error, "Root observation failed");
assert.equal(conflict.job.id, "different-execution");
assert.equal(conflict.job.terminal, true);
assert.equal(conflict.job.exitCode, 7);
assert.equal(conflict.job.error, "Job execution failed");
assert.deepEqual(
	conflict.job.artifactRefs,
	conflictingReceipt.job.artifactRefs,
);
assert.deepEqual(
	conflict.job.artifactWriteStatus,
	conflictingReceipt.job.artifactWriteStatus,
);
assert.equal(conflict.job.command, undefined);
assert.equal(conflict.job.context, undefined);
assert.ok(conflict.job.stdout.length < 4_100);
assert.ok(conflict.job.stderr.length < 4_100);
assert.equal(conflict.job.stdoutTail, undefined);
assert.equal(conflict.job.modelPreview.omittedCharacters.stderr, 10_000);
assert.equal(JSON.stringify(conflictingReceipt), conflictBefore);

// Distinct tail/text values can be evidence of an inconsistent receipt; keep
// both visibly bounded instead of silently choosing one of them.
const distinctStreams = JSON.parse(
	project({
		output: {
			executionId: "different-streams",
			job: { stdout: "a".repeat(8_000), stdoutTail: "b".repeat(9_000) },
		},
	}).value,
);
assert.ok(distinctStreams.job.stdout.length < 4_100);
assert.ok(distinctStreams.job.stdoutTail.length < 4_100);
assert.equal(
	distinctStreams.job.modelPreview.omittedCharacters.stdoutTail,
	5_000,
);

const samePreview = JSON.parse(
	project({
		output: {
			executionId: "same-preview",
			stdout: "a".repeat(3_000) + "root" + "z".repeat(3_000),
			job: { stdoutTail: "a".repeat(3_000) + "diff" + "z".repeat(3_000) },
		},
	}).value,
);
assert.ok(
	samePreview.job,
	"distinct raw streams stay distinct even when their bounded previews match",
);
assert.equal(samePreview.job.stdout, samePreview.stdout);

console.log(
	`computer execution model output OK: bounded previews, intact receipts; synthetic receipt ${retained.length} -> ${JSON.stringify(compact).length} chars`,
);
console.log(
	`synthetic duplicated wait receipt ${waitBefore.length} -> ${JSON.stringify(waitPreview).length} chars`,
);
