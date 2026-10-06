import assert from "node:assert/strict";
import {
	recordDeliverableArtifact,
	recordTurnSummaryArtifact,
	recordWorkstationProcessArtifactRefs,
} from "./artifact-recorder";
import {
	type TraceBundleEvidence,
	writeTraceBundle,
} from "./trace-bundle-writer";

const originalError = console.error;
const originalWarn = console.warn;
const failures: unknown[][] = [];
const warnings: unknown[][] = [];
console.error = (...args: unknown[]) => {
	failures.push(args);
};
console.warn = (...args: unknown[]) => {
	warnings.push(args);
};

const thrown = new Error("prompt sk_private_secret r2://private-bucket/key", {
	cause: new TypeError("upstream payload and caller text"),
});
thrown.name = "provider-private-error-name";

const evidence: TraceBundleEvidence = {
	tediId: "private-tedi",
	conversationId: "private-conversation",
	runId: "private-run",
	harnessVersionId: "version-1",
	runtimeKind: "agent",
	systemPrompt: "private system prompt",
	userText: "private caller text",
	assistantText: "private agent reply",
	outcome: "success",
	createdAt: "2026-09-28T00:00:00Z",
};

try {
	const failedBundle = await writeTraceBundle({
		bucket: {
			put: async () => {
				throw thrown;
			},
		} as unknown as R2Bucket,
		evidence,
	});
	assert.equal(failedBundle, null);

	const assemblyFailure = { ...evidence };
	Object.defineProperty(assemblyFailure, "directives", {
		get() {
			throw thrown;
		},
	});
	const assembled = await writeTraceBundle({
		bucket: {
			put: async () => {
				assert.fail("assembly failure must not write R2");
			},
		} as unknown as R2Bucket,
		evidence: assemblyFailure,
	});
	assert.equal(assembled, null);

	const platform = {
		recordArtifact: async () => {
			throw thrown;
		},
	};
	const summary = await recordTurnSummaryArtifact({
		platform,
		bucket: {} as R2Bucket,
		tediId: "private-tedi",
		conversationId: "private-conversation",
		runId: "private-run",
		turnId: "private-turn",
		observerSummary: { observations: [], currentTasks: [] },
		userText: "private caller text",
		assistantText: "private agent reply",
	} as never);
	assert.equal(summary, null);

	const deliverable = await recordDeliverableArtifact({
		platform,
		bucket: {} as R2Bucket,
		tediId: "private-tedi",
		runId: "private-run",
		name: "private-report.md",
		content: "private caller text",
	} as never);
	assert.deepEqual(deliverable, {
		ok: false,
		error: "artifact_record_failed",
	});

	let calls = 0;
	const workstation = await recordWorkstationProcessArtifactRefs({
		platform: {
			recordArtifact: async () => {
				calls++;
				if (calls === 1) throw thrown;
			},
		},
		tediId: "private-tedi",
		conversationId: "private-conversation",
		runId: "private-run",
		processId: "private-process",
		artifactRefs: [
			"r2://private-bucket/terminal/evidence.json",
			"r2://private-bucket/terminal/stdout.log",
		],
	} as never);
	assert.equal(calls, 2, "continues to register later refs after a failure");
	assert.deepEqual(workstation, {
		ok: false,
		artifactIds: [
			"private-run:artifact:workstation_process:private-process:stdout",
		],
		recorded: 1,
		skipped: 1,
		error: "workstation_artifact_record_failed",
	});

	const events = failures.map(([entry]) => (entry as { event: string }).event);
	for (const event of [
		"tedi.trace.bundle_put_failed",
		"tedi.trace.bundle_write_failed",
		"tedi.artifact.turn_summary_record_failed",
		"tedi.artifact.deliverable_record_failed",
		"tedi.artifact.workstation_record_failed",
	]) {
		assert.ok(events.includes(event), `${event} remains observable`);
	}
	for (const line of failures) {
		assert.equal(line.length, 1);
		const entry = line[0] as Record<string, unknown>;
		assert.deepEqual(Object.keys(entry), ["component", "event", "exception"]);
		assert.equal(entry.component, "tedi-runtime-persistence");
		assert.deepEqual(entry.exception, {
			type: "UnknownThrown",
			cause: { type: "TypeError" },
		});
	}
	assert.deepEqual(warnings, [], "no raw warning side channel remains");
	assert.doesNotMatch(
		JSON.stringify({ failures, deliverable, workstation }),
		/prompt|sk_private_secret|private-bucket|upstream payload|caller text|provider-private-error-name|stack/,
	);
} finally {
	console.error = originalError;
	console.warn = originalWarn;
}

console.log(
	"Tedi trace and artifact failures keep content out of logs and results",
);
