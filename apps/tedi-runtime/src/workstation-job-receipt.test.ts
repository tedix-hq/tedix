import { strict as assert } from "node:assert";
import { withCompletionEvidence } from "@tedix/api-contract/schemas/execution-evidence";
import {
	compactPublicWorkstationJobReadReceipt,
	sanitizePublicWorkstationJobReceipt,
} from "./workstation-job-receipt";

const result = sanitizePublicWorkstationJobReceipt({
	jobId: "job-1",
	processId: "job-1",
	job: {
		id: "job-1",
		processId: "job-1",
		process: { id: "job-1", pid: 42 },
		error: "process not found: job-1",
		evidence: {
			eventType: "workstation.process.started",
			processId: "job-1",
		},
	},
});

assert.deepEqual(result, {
	jobId: "job-1",
	id: "job-1",
	error: "job not found: job-1",
	evidence: { eventType: "workstation.job.started" },
});

const compactReadReceipt = compactPublicWorkstationJobReadReceipt({
	ok: true,
	found: true,
	job: {
		id: "test-1",
		command: "large command that the polling caller already knows",
		context: { repeated: "large authority projection" },
		terminal: true,
		running: false,
		exitCode: 0,
		stdoutBytes: 9_000,
		stderrBytes: 0,
		stdoutTail: `discarded-${"x".repeat(9_000)}`,
		stderrTail: "",
		artifactRefs: ["r2://complete-stdout"],
	},
	workstation: { metadata: { repeated: "large workstation projection" } },
	workstationLease: { metadata: { repeated: "large lease projection" } },
});
assert.equal(compactReadReceipt.ok, true);
assert.equal(compactReadReceipt.found, true);
assert.equal(compactReadReceipt.terminal, true);
assert.equal(compactReadReceipt.exitCode, 0);
assert.deepEqual(compactReadReceipt.artifactRefs, ["r2://complete-stdout"]);
assert.equal("command" in compactReadReceipt, false);
assert.equal("context" in compactReadReceipt, false);
assert.equal("workstation" in compactReadReceipt, false);
assert.equal("workstationLease" in compactReadReceipt, false);
assert.match(
	String(compactReadReceipt.stdoutTail),
	/^\[Truncated: showing last 8000 of 9010 chars;/,
);
assert.equal(
	String(compactReadReceipt.stdoutTail).endsWith("x".repeat(8_000)),
	true,
);

assert.deepEqual(
	sanitizePublicWorkstationJobReceipt({
		ok: true,
		found: true,
		job: {
			id: "typecheck-1",
			terminal: true,
			exitCode: 1,
			running: false,
		},
	}),
	{
		ok: true,
		found: true,
		id: "typecheck-1",
		terminal: true,
		exitCode: 1,
		running: false,
	},
);

for (const observation of ["unavailable", "generation_replaced"]) {
	assert.deepEqual(
		compactPublicWorkstationJobReadReceipt({ ok: false, observation }),
		{ ok: false, observation },
	);
}
assert.deepEqual(
	compactPublicWorkstationJobReadReceipt({
		ok: false,
		observation: "raw private provider error",
	}),
	{ ok: false },
);

for (const compact of [compactPublicWorkstationJobReadReceipt]) {
	for (const [status, label, detail] of [
		[403, "Forbidden", "workstation participant reviewer is not active"],
		[409, "Conflict", "process dependencies are not ready"],
	] as const) {
		assert.deepEqual(
			compact({
				ok: false,
				status,
				error: label,
				body: {
					error: detail,
					retryable: false,
					command: "private command",
					credentials: { password: "must-not-leak" },
					workstationLease: { metadata: "large private envelope" },
				},
			}),
			{
				ok: false,
				error: detail.replace("process", "job"),
				status,
				retryable: false,
			},
		);
	}
	const redacted = compact({
		ok: false,
		error: "Conflict",
		body: { error: `Bearer privatecredential ${"x".repeat(3_000)}` },
	});
	assert.equal(String(redacted.error).includes("privatecredential"), false);
	assert.equal(String(redacted.error).length, 2_000);
	assert.deepEqual(
		compact({ ok: false, error: "Forbidden", body: "private raw body" }),
		{ ok: false, error: "Forbidden" },
	);
	assert.deepEqual(
		compact({ ok: true, body: { error: "not a failure", retryable: true } }),
		{ ok: true },
	);
}

const failedReceipt = sanitizePublicWorkstationJobReceipt({
	ok: true,
	found: true,
	job: {
		id: "typecheck-1",
		terminal: true,
		exitCode: 1,
		running: false,
	},
});
const failedEvidence = withCompletionEvidence(
	"workstation_read_job",
	failedReceipt,
	{ key: "workstation_read_job:typecheck-1" },
).completionEvidence as { status: string; supportedClaims: string[] };
assert.equal(failedEvidence.status, "failed");
assert.deepEqual(failedEvidence.supportedClaims, []);

const canceledEvidence = withCompletionEvidence(
	"workstation_read_job",
	sanitizePublicWorkstationJobReceipt({
		ok: true,
		found: true,
		job: {
			id: "canceled-1",
			terminal: true,
			exitCode: null,
			running: false,
			canceled: true,
		},
	}),
	{ key: "workstation_read_job:canceled-1" },
).completionEvidence as { status: string; supportedClaims: string[] };
assert.equal(canceledEvidence.status, "canceled");
assert.deepEqual(canceledEvidence.supportedClaims, []);

const timedOutEvidence = withCompletionEvidence(
	"workstation_read_job",
	sanitizePublicWorkstationJobReceipt({
		ok: true,
		found: true,
		job: {
			id: "timeout-1",
			terminal: true,
			exitCode: null,
			running: false,
			timedOut: true,
		},
	}),
	{ key: "workstation_read_job:timeout-1" },
).completionEvidence as { status: string; supportedClaims: string[] };
assert.equal(timedOutEvidence.status, "failed");
assert.deepEqual(timedOutEvidence.supportedClaims, []);

// A tedi-runtime request timeout is not a job failure: the marker and the wait
// duration survive compaction so the exec tool can return a running receipt.
assert.deepEqual(
	compactPublicWorkstationJobReadReceipt({
		ok: false,
		error: "workstation process/status timed out after 120000ms",
		requestTimedOut: true,
		waitedMs: 120_000,
	}),
	{
		ok: false,
		error: "workstation job/status timed out after 120000ms",
		requestTimedOut: true,
		waitedMs: 120_000,
	},
);
