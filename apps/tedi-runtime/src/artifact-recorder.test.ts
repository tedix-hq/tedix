/**
 * Regression coverage for turn-summary artifact recording.
 * Run: `bun run src/artifact-recorder.test.ts`.
 */
import assert from "node:assert/strict";
import {
	recordDeliverableArtifact,
	recordTurnSummaryArtifact,
	recordWorkstationProcessArtifactRefs,
	resolveWorkstationProcessArtifactRunId,
	trustedExistingWorkstationArtifactIds,
	trustedPersistedWorkstationArtifactIds,
	turnSummaryArtifactId,
} from "./artifact-recorder";

function makeInput(overrides: Record<string, unknown> = {}) {
	return {
		tediId: "echo",
		conversationId: "conversation-1",
		runId: "isolate-run-turn-1",
		turnId: "turn-1",
		observerSummary: {
			observations: ["user asked for a smoke test"],
			currentTasks: ["record the turn summary"],
			suggestedResponse: "COLD_SMOKE_OK",
		},
		userText: "Reply with exactly: COLD_SMOKE_OK",
		assistantText: "COLD_SMOKE_OK",
		...overrides,
	};
}

{
	const puts: Array<{ key: string; value: string; options: unknown }> = [];
	const records: Array<Record<string, unknown>> = [];
	const bucket = {
		put: async (key: string, value: string, options: unknown) => {
			puts.push({ key, value, options });
		},
	};
	const platform = {
		recordArtifact: async (input: Record<string, unknown>) => {
			records.push(input);
			return {
				artifact: {
					uri: "r2://tedix-tedi-production/echo/artifacts/turn_summary/digest/body.json",
				},
			};
		},
	};

	const artifactId = await recordTurnSummaryArtifact(
		makeInput({ bucket, platform }) as never,
	);

	assert.equal(artifactId, turnSummaryArtifactId("isolate-run-turn-1"));
	assert.notEqual(
		artifactId,
		"isolate-run-turn-1:artifact:turn_summary",
		"private writes cannot collide with pre-cutover URI-only claims",
	);
	assert.equal(puts.length, 0, "does not write a mutable legacy R2 alias");

	assert.equal(records.length, 1, "records exactly one platform artifact row");
	assert.equal(records[0]?.id, artifactId);
	assert.equal(records[0]?.tediId, "echo");
	assert.equal(records[0]?.conversationId, "conversation-1");
	assert.equal(records[0]?.runId, "isolate-run-turn-1");
	assert.equal(records[0]?.kind, "log");
	assert.equal(records[0]?.name, "turn_summary/turn-1.json");
	assert.equal(records[0]?.mimeType, "application/json");
	assert.equal(records[0]?.uri, undefined);
	assert.equal(typeof records[0]?.content, "string");
	assert.deepEqual(records[0]?.metadata, {
		subKind: "turn_summary",
		producer: "isolate-do",
		turnId: "turn-1",
		observationCount: 1,
		hasCurrentTasks: true,
		hasSuggestedResponse: true,
	});
}

{
	const warnings: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	try {
		const records: Array<Record<string, unknown>> = [];
		const bucket = {
			put: async () => {
				throw new Error("R2 unavailable");
			},
		};
		const platform = {
			recordArtifact: async (input: Record<string, unknown>) => {
				records.push(input);
			},
		};

		const artifactId = await recordTurnSummaryArtifact(
			makeInput({ bucket, platform }) as never,
		);

		assert.equal(
			artifactId,
			turnSummaryArtifactId("isolate-run-turn-1"),
			"R2 failure does not prevent platform artifact recording",
		);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.uri, undefined);
		assert.equal(warnings.length, 0, "legacy bucket is never called");
	} finally {
		console.warn = originalWarn;
	}
}

// ── recordDeliverableArtifact ─────────────────────────────────────────────
{
	const puts: Array<{ key: string; value: string; options: unknown }> = [];
	const records: Array<Record<string, unknown>> = [];
	const bucket = {
		put: async (key: string, value: string, options: unknown) => {
			puts.push({ key, value, options });
		},
	};
	const platform = {
		recordArtifact: async (input: Record<string, unknown>) => {
			records.push(input);
			return {
				artifact: {
					uri: "r2://tedix-tedi-production/echo/artifacts/deliverable/digest/report.md",
				},
			};
		},
	};

	const result = await recordDeliverableArtifact({
		platform,
		bucket,
		tediId: "echo",
		conversationId: "conversation-1",
		runId: "run-7",
		name: "weekly-trend-report.md",
		content: "# Weekly Trend Report\n\nMovers...",
		description: "Weekly winners/losers interpretation",
	} as never);

	assert.equal(result.ok, true);
	assert.equal(
		result.artifactId,
		"run-7:artifact:v2:deliverable:weekly-trend-report.md",
		"deterministic deliverable id keyed on (runId, name)",
	);
	assert.notEqual(
		result.artifactId,
		"run-7:artifact:deliverable:weekly-trend-report.md",
		"private deliverables cannot collide with pre-cutover URI-only claims",
	);
	assert.equal(result.name, "weekly-trend-report.md");
	assert.equal(puts.length, 0, "does not write a mutable legacy R2 alias");
	assert.equal(records.length, 1);
	assert.equal(records[0]?.id, result.artifactId);
	assert.equal(records[0]?.kind, "document", "defaults kind to document");
	assert.equal(records[0]?.name, "weekly-trend-report.md");
	assert.equal(records[0]?.mimeType, "text/markdown; charset=utf-8");
	assert.equal(records[0]?.uri, undefined);
	assert.equal(records[0]?.content, "# Weekly Trend Report\n\nMovers...");
	assert.equal(
		result.uri,
		"r2://tedix-tedi-production/echo/artifacts/deliverable/digest/report.md",
	);
	assert.deepEqual(records[0]?.metadata, {
		subKind: "deliverable",
		producer: "tedi-tool",
		description: "Weekly winners/losers interpretation",
	});
}

// path-traversal in `name` is sanitized to a safe basename; bad kind → document
{
	const puts: Array<{ key: string }> = [];
	const records: Array<Record<string, unknown>> = [];
	const bucket = {
		put: async (key: string) => {
			puts.push({ key });
		},
	};
	const platform = {
		recordArtifact: async (input: Record<string, unknown>) => {
			records.push(input);
		},
	};
	const result = await recordDeliverableArtifact({
		platform,
		bucket,
		tediId: "echo",
		name: "../../etc/passwd",
		content: "x",
		kind: "not-a-real-kind",
	} as never);
	assert.equal(result.ok, true);
	assert.equal(puts.length, 0, "does not write the sanitized legacy alias");
	assert.equal(
		result.name,
		"passwd",
		"returns the recorded name, not the requested path",
	);
	assert.equal(
		records[0]?.kind,
		"document",
		"unknown kind falls back to document",
	);
}

// Legacy bucket failures are irrelevant because publication is API-owned.
{
	const warnings: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	try {
		const records: Array<Record<string, unknown>> = [];
		const bucket = {
			put: async () => {
				throw new Error("R2 unavailable");
			},
		};
		const platform = {
			recordArtifact: async (input: Record<string, unknown>) => {
				records.push(input);
			},
		};
		const result = await recordDeliverableArtifact({
			platform,
			bucket,
			tediId: "echo",
			runId: "run-7",
			name: "report.md",
			content: "x",
		} as never);
		assert.equal(result.ok, true, "record succeeds without calling legacy R2");
		assert.equal(
			result.uri,
			undefined,
			"drops uri when the body wasn't written",
		);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.uri, undefined);
		assert.equal(warnings.length, 0, "legacy bucket is never called");
	} finally {
		console.warn = originalWarn;
	}
}

// ── recordWorkstationProcessArtifactRefs ─────────────────────────────────
assert.equal(
	resolveWorkstationProcessArtifactRunId({
		activeRunId: "child-run-active",
		evidenceKernelRunId: "child-run-evidence",
		inputKernelRunId: "synthetic-process-run",
	}),
	"synthetic-process-run",
	"an explicit process scope wins over mutable active-turn state",
);
console.log(
	"PASS: explicit Kernel process scope precedes mutable active state",
);
assert.equal(
	resolveWorkstationProcessArtifactRunId({
		activeRunId: "stale-active-run",
		evidenceKernelRunId: "child-run-evidence",
		inputWorkItemId: "direct-work-item",
	}),
	"work-item:direct-work-item",
	"an explicit direct Work Item wins over stale active-turn state",
);
console.log(
	"PASS: explicit Work Item process scope precedes stale active state",
);
assert.equal(
	resolveWorkstationProcessArtifactRunId({
		activeRunId: "stale-active-run",
		evidenceWorkItemId: "persisted-work-item",
	}),
	"work-item:persisted-work-item",
	"persisted process evidence wins over a later unrelated active turn",
);
console.log("PASS: persisted process scope precedes a later unrelated turn");
const persistedAliasInput = {
	persistence: {
		status: "skipped",
		reason: "evidence_already_persisted",
	},
	artifactRefs: [
		"r2://bucket/evidence.json",
		"r2://bucket/stdout.log",
		"artifact://child-run:artifact:workstation_process:job:evidence",
	],
	runId: "child-run",
	processId: "job",
};
assert.deepEqual(
	trustedPersistedWorkstationArtifactIds({
		...persistedAliasInput,
		persistedEvidenceReadback: true,
	}),
	["child-run:artifact:workstation_process:job:evidence"],
	"only an exact source-derived alias is trusted from an authoritative readback",
);
assert.deepEqual(
	trustedPersistedWorkstationArtifactIds({
		...persistedAliasInput,
		persistedEvidenceReadback: false,
	}),
	[],
	"aliases without the authoritative persisted readback never suppress repair",
);
assert.deepEqual(
	trustedExistingWorkstationArtifactIds({
		persistence: {
			status: "failed",
			artifactIds: [
				"child-run:artifact:workstation_process:job:evidence",
				"other-run:artifact:workstation_process:job:stdout",
			],
		},
		artifactRefs: persistedAliasInput.artifactRefs,
		runId: "child-run",
		processId: "job",
	}),
	["child-run:artifact:workstation_process:job:evidence"],
	"partial repair trusts only exact canonical ids from the edge result",
);
assert.equal(
	resolveWorkstationProcessArtifactRunId({
		activeRunId: "active-child-run",
	}),
	"active-child-run",
	"the active child remains the fallback when no explicit or persisted scope exists",
);

{
	const records: Array<Record<string, unknown>> = [];
	const platform = {
		recordArtifact: async (input: Record<string, unknown>) => {
			records.push(input);
		},
	};

	const result = await recordWorkstationProcessArtifactRefs({
		platform,
		tediId: "cto",
		conversationId: "cto:agent:main:main",
		runId: "child-run-1",
		processId: "install-deps",
		artifactRefs: [
			"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/evidence.json",
			"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/stdout.log",
			"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/stderr.log",
		],
		evidence: {
			eventType: "workstation.process.completed",
			workstationId: "ws-coding-cto",
			leaseId: "lease-1",
			sessionId: "session-1",
			profileId: "general",
			processId: "install-deps",
			workItemId: "wi-1",
			kernelRunId: "child-run-1",
			traceId: "trace-1",
			exitCode: 0,
			canceled: false,
			timedOut: false,
		},
		traceBundleId: "trace-bundle-1",
	} as never);

	assert.equal(result.ok, true);
	assert.deepEqual(result.artifactIds, [
		"child-run-1:artifact:workstation_process:install-deps:evidence",
		"child-run-1:artifact:workstation_process:install-deps:stdout",
		"child-run-1:artifact:workstation_process:install-deps:stderr",
	]);
	assert.equal(records.length, 3);
	assert.deepEqual(
		records.map((record) => record.name),
		[
			"workstation_process/install-deps/evidence.json",
			"workstation_process/install-deps/stdout.log",
			"workstation_process/install-deps/stderr.log",
		],
	);
	assert.deepEqual(
		records.map((record) => record.mimeType),
		[
			"application/json",
			"text/plain; charset=utf-8",
			"text/plain; charset=utf-8",
		],
	);
	assert.deepEqual(
		records.map((record) => record.runId),
		["child-run-1", "child-run-1", "child-run-1"],
	);
	assert.deepEqual(records[0]?.metadata, {
		subKind: "workstation_process",
		producer: "workstation-adapter",
		source: "workstation_process",
		processId: "install-deps",
		refType: "evidence",
		eventType: "workstation.process.completed",
		workItemId: "wi-1",
		kernelRunId: "child-run-1",
		traceId: "trace-1",
		traceBundleId: "trace-bundle-1",
		workstationId: "ws-coding-cto",
		leaseId: "lease-1",
		sessionId: "session-1",
		profileId: "general",
		exitCode: 0,
		canceled: false,
		timedOut: false,
		ref: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/evidence.json",
	});
}

{
	const records: Array<Record<string, unknown>> = [];
	const prefix = "child-run-1:artifact:workstation_process:install-deps";
	const sourceRefs = [
		"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/evidence.json",
		"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/stdout.log",
		"r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/coding/processes/install-deps/terminal/stderr.log",
	];
	const aliases = [
		`artifact://${prefix}:evidence`,
		`artifact://${prefix}:stdout`,
		`artifact://${prefix}:stderr`,
	];
	const result = await recordWorkstationProcessArtifactRefs({
		platform: {
			recordArtifact: async (input: Record<string, unknown>) => {
				records.push(input);
			},
		},
		tediId: "cto",
		conversationId: "cto:agent:main:delegation-1",
		runId: "child-run-1",
		processId: "install-deps",
		artifactRefs: [...sourceRefs, ...aliases],
		persistedArtifactIds: [`${prefix}:evidence`],
	} as never);
	assert.equal(result.ok, true);
	assert.deepEqual(result.artifactIds, [
		`${prefix}:evidence`,
		`${prefix}:stdout`,
		`${prefix}:stderr`,
	]);
	assert.equal(
		records.length,
		2,
		"only genuinely missing source rows are repaired",
	);
	assert.deepEqual(
		records.map((record) => record.id),
		[`${prefix}:stdout`, `${prefix}:stderr`],
	);
}

{
	const records: Array<Record<string, unknown>> = [];
	const platform = {
		recordArtifact: async (input: Record<string, unknown>) => {
			records.push(input);
		},
	};

	const result = await recordWorkstationProcessArtifactRefs({
		platform,
		tediId: "cto",
		conversationId: "cto:agent:main:delegation-1",
		runId: "child-run-1",
		processId: "install-deps",
		artifactRefs: ["", "r2://bucket/stdout.log", "r2://bucket/stdout.log"],
	} as never);

	assert.equal(result.ok, true);
	assert.deepEqual(result.artifactIds, [
		"child-run-1:artifact:workstation_process:install-deps:stdout",
	]);
	assert.equal(records.length, 1, "empty and duplicate refs are skipped");
	assert.equal(records[0]?.conversationId, "cto:agent:main:delegation-1");
}

{
	const records: Array<Record<string, unknown>> = [];
	const result = await recordWorkstationProcessArtifactRefs({
		platform: {
			recordArtifact: async (input: Record<string, unknown>) => {
				records.push(input);
			},
		},
		tediId: "cto",
		conversationId: "",
		runId: "child-run-1",
		processId: "install-deps",
		artifactRefs: ["r2://bucket/stdout.log"],
	} as never);
	assert.deepEqual(result.artifactIds, []);
	assert.deepEqual(records, [], "detached reads cannot create unowned claims");
}

console.log("artifact-recorder.test.ts: ok");

{
	const controller = new AbortController();
	let puts = 0;
	let records = 0;
	const input = makeInput({
		signal: controller.signal,
		bucket: {
			put: async () => {
				puts++;
			},
		},
		platform: {
			recordArtifact: async () => {
				records++;
				controller.abort(new Error("learning deadline"));
			},
		},
	});
	await assert.rejects(
		recordTurnSummaryArtifact(input as never),
		/learning deadline/,
	);
	assert.equal(puts, 0, "the mutable legacy R2 write is never started");
	assert.equal(
		records,
		1,
		"an already-started artifact RPC cannot be rolled back",
	);
	await assert.rejects(
		recordTurnSummaryArtifact(input as never),
		/learning deadline/,
	);
	assert.equal(records, 1, "an expired turn cannot begin another artifact RPC");
}
