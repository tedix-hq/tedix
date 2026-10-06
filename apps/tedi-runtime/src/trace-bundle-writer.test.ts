/**
 * Trace-bundle writer regression: the assembled file set, the R2 key layout, and
 * the load-bearing guarantee that redaction is APPLIED on write (a secret in the
 * evidence must not reach R2 in the clear). Redaction internals are covered by
 * `@tedix/context-core` trace-safety.test.ts; this guards the wiring.
 * Run: `bun run src/trace-bundle-writer.test.ts`.
 */
import assert from "node:assert/strict";
import { TEDIX_REDACTED } from "@tedix/context-core/trace-safety";
import {
	assembleTraceBundleFiles,
	type TraceBundleEvidence,
	traceBundlePrefix,
	writeTraceBundle,
} from "./trace-bundle-writer";

const baseEvidence: TraceBundleEvidence = {
	tediId: "tedi_cto",
	orgId: "org_tedix",
	conversationId: "cto:agent:main:main",
	runId: "tedi_cto:chat:msg-123",
	harnessVersionId: "hv_01",
	runtimeKind: "agent",
	systemPrompt: "You are CTO.",
	userText: "hello",
	assistantText: "hi there",
	outcome: "success",
	createdAt: "2026-05-31T00:00:00.000Z",
};

// ── assembly: file set + manifest provenance ─────────────────────────────────
{
	const files = assembleTraceBundleFiles(baseEvidence);
	const names = files.map((f) => f.name).sort();
	assert.deepEqual(names, [
		"context.md",
		"manifest.json",
		"outcome.json",
		"output.md",
		"prompt.json",
	]);
	const manifest = files.find((f) => f.name === "manifest.json")!
		.content as Record<string, unknown>;
	assert.equal(manifest.runId, baseEvidence.runId);
	assert.equal(manifest.harnessVersionId, "hv_01");
	assert.equal(manifest.traceSafetyPolicyId, "trace_policy_v1");
	assert.equal(manifest.runtimeKind, "agent");
}

// ── directives file only present when there are directives ───────────────────
{
	const withDir = assembleTraceBundleFiles({
		...baseEvidence,
		directives: [{ kind: "ALWAYS", text: "cite sources" }],
	});
	assert.ok(withDir.some((f) => f.name === "directives.jsonl"));
}

// ── memory-hits.jsonl present only when there are memory hits ────────────────
{
	const noHits = assembleTraceBundleFiles(baseEvidence);
	assert.ok(
		!noHits.some((f) => f.name === "memory-hits.jsonl"),
		"no memory hits → no memory-hits file (back-compatible)",
	);

	const withHits = assembleTraceBundleFiles({
		...baseEvidence,
		memoryHits: [
			{
				summary: "Cloud Infrastructure",
				domain: "Cloud Infrastructure",
				source: "brain-digest",
			},
			{ factId: "fact_42", dropped: true, source: "brain-digest" },
		],
	});
	const memFile = withHits.find((f) => f.name === "memory-hits.jsonl");
	assert.ok(memFile, "memory-hits.jsonl present");
	const memLines = (memFile!.content as string).split("\n");
	assert.equal(memLines.length, 2, "one jsonl line per memory hit");
	const first = JSON.parse(memLines[0]!) as Record<string, unknown>;
	assert.equal(first.domain, "Cloud Infrastructure");
	assert.equal(first.source, "brain-digest");
	assert.equal(first.dropped, false, "non-dropped hit defaults dropped:false");
	const second = JSON.parse(memLines[1]!) as Record<string, unknown>;
	assert.equal(second.factId, "fact_42");
	assert.equal(second.dropped, true);
	assert.equal(second.summary, null, "absent summary serialized as null");
}

// ── skills.jsonl present only when there are skill/guidance hits ─────────────
{
	const noSkills = assembleTraceBundleFiles(baseEvidence);
	assert.ok(
		!noSkills.some((f) => f.name === "skills.jsonl"),
		"no skills → no skills file (back-compatible)",
	);

	const withSkills = assembleTraceBundleFiles({
		...baseEvidence,
		skills: [
			{
				kind: "skill",
				name: "deploy-runbook",
				summary: "Steps to deploy a worker safely",
				uri: "skill://deploy-runbook",
				serverName: "tedix",
			},
		],
	});
	const skillFile = withSkills.find((f) => f.name === "skills.jsonl");
	assert.ok(skillFile, "skills.jsonl present");
	const skillLines = (skillFile!.content as string).split("\n");
	assert.equal(skillLines.length, 1, "one jsonl line per skill");
	const parsed = JSON.parse(skillLines[0]!) as Record<string, unknown>;
	assert.equal(parsed.kind, "skill");
	assert.equal(parsed.name, "deploy-runbook");
	assert.equal(parsed.uri, "skill://deploy-runbook");
	assert.equal(parsed.serverName, "tedix");
}

// ── tool-calls.jsonl + scores.json present only when there are tool steps ────
{
	const noSteps = assembleTraceBundleFiles(baseEvidence);
	assert.ok(
		!noSteps.some((f) => f.name === "tool-calls.jsonl"),
		"no steps → no tool-calls file",
	);

	const withSteps = assembleTraceBundleFiles({
		...baseEvidence,
		toolSteps: [
			{
				stepNumber: 0,
				finishReason: "tool-calls",
				toolNames: ["memory_search"],
				toolCallCount: 1,
				toolResultCount: 1,
				usage: { totalTokens: 1200 },
			},
			{
				stepNumber: 1,
				finishReason: "stop",
				toolNames: [],
				toolCallCount: 0,
				toolResultCount: 0,
				usage: { totalTokens: 800 },
			},
		],
	});
	const toolFile = withSteps.find((f) => f.name === "tool-calls.jsonl");
	assert.ok(toolFile, "tool-calls.jsonl present");
	assert.equal(
		(toolFile!.content as string).split("\n").length,
		2,
		"one jsonl line per step",
	);
	const scores = withSteps.find((f) => f.name === "scores.json")!
		.content as Record<string, number>;
	assert.equal(scores.steps, 2);
	assert.equal(scores.toolCalls, 1);
	assert.equal(scores.totalTokens, 2000, "token usage rolled up across steps");
}

// ── recovery.json present only on the recovery-exhaustion path ───────────────
{
	const noRecovery = assembleTraceBundleFiles(baseEvidence);
	assert.ok(
		!noRecovery.some((f) => f.name === "recovery.json"),
		"no recovery → no recovery file",
	);

	const withRecovery = assembleTraceBundleFiles({
		...baseEvidence,
		outcome: "failure",
		assistantText: "",
		recovery: {
			recoveryRootRequestId: "rr_root_1",
			incidentId: "inc_42",
			reason: "max_attempts_exceeded",
			attempts: 3,
			maxAttempts: 3,
			recoveryKind: "continue",
			partialTextLength: 1234,
			interrupted: true,
		},
	});
	const recFile = withRecovery.find((f) => f.name === "recovery.json");
	assert.ok(recFile, "recovery.json present");
	const rec = recFile!.content as Record<string, unknown>;
	assert.equal(rec.recoveryRootRequestId, "rr_root_1");
	assert.equal(rec.incidentId, "inc_42");
	assert.equal(rec.reason, "max_attempts_exceeded");
	assert.equal(rec.maxAttempts, 3);
	assert.equal(rec.recoveryKind, "continue");
	assert.equal(rec.partialTextLength, 1234);
	// linkage back to the run/version/conversation
	assert.equal(rec.runId, baseEvidence.runId);
	assert.equal(rec.harnessVersionId, baseEvidence.harnessVersionId);
	assert.equal(rec.conversationId, baseEvidence.conversationId);
	// the bundle never carries partial text content, only its length
	assert.ok(
		!("partialText" in rec) && !("partialTextPrefix" in rec),
		"no partial text content in bundle",
	);
}

// ── prefix layout ────────────────────────────────────────────────────────────
assert.equal(
	traceBundlePrefix("tedi_cto", "tedi_cto:chat:msg-123"),
	"tedi_cto/harness/runs/tedi_cto:chat:msg-123",
);

// ── writeTraceBundle APPLIES redaction before R2 put (the security wiring) ────
{
	const puts: Array<{ key: string; body: string }> = [];
	const fakeBucket = {
		put: async (key: string, body: string) => {
			puts.push({ key, body: String(body) });
			return undefined;
		},
	} as unknown as R2Bucket;

	const leaky: TraceBundleEvidence = {
		...baseEvidence,
		userText: "my key is sk_live_0123456789abcdef and Bearer abc.def",
		assistantText: "ok",
	};
	const uri = await writeTraceBundle({
		bucket: fakeBucket,
		evidence: leaky,
		knownSecrets: ["topsecretvalue"],
	});

	assert.equal(
		uri,
		"r2://tedix-tedi-production/tedi_cto/harness/runs/tedi_cto:chat:msg-123/",
	);
	assert.ok(puts.length >= 5, "all bundle files written");
	// every R2 key is under the run prefix
	assert.ok(
		puts.every((p) =>
			p.key.startsWith("tedi_cto/harness/runs/tedi_cto:chat:msg-123/"),
		),
	);
	// NO raw secret reaches R2 in any file
	const allBodies = puts.map((p) => p.body).join("\n");
	assert.ok(
		!allBodies.includes("sk_live_0123456789abcdef"),
		"sk_ key never written raw",
	);
	assert.ok(
		!/Bearer abc\.def/.test(allBodies),
		"bearer token never written raw",
	);
	assert.ok(allBodies.includes(TEDIX_REDACTED), "redaction sentinel present");
}

// ── no bucket writes → null uri (caller leaves bundleUri unset) ──────────────
{
	const failBucket = {
		put: async () => {
			throw new Error("r2 down");
		},
	} as unknown as R2Bucket;
	const uri = await writeTraceBundle({
		bucket: failBucket,
		evidence: baseEvidence,
	});
	assert.equal(
		uri,
		null,
		"no files written → null uri, not an empty-folder pointer",
	);
}

console.log("trace-bundle-writer.test.ts: all assertions passed");
