import assert from "node:assert/strict";
import {
	MEMORY_SOURCE_EVIDENCE_LIMITS,
	MemorySourceEvidenceSchema,
} from "@tedix/api-contract/schemas/memory-graph";
import {
	buildMemorySourceEvidence,
	buildObserverInput,
	digestObserverToolResult,
	ensureTerminalEpisodeObservation,
	observerToolEvidenceFromSteps,
} from "./observer-execution-evidence";

const runId = "tedi:mcp:observer-grounding";
const evidence = observerToolEvidenceFromSteps(runId, [
	{
		stepNumber: 3,
		finishReason: "facet-tool-proxy",
		toolNames: ["tedix_mcp_code"],
		toolCallCount: 1,
		toolResultCount: 1,
		resultDigest: "sha256:abc",
	},
	{
		stepNumber: 4,
		finishReason: "facet-tool-error",
		toolNames: ["broken_tool"],
		toolCallCount: 1,
		toolResultCount: 1,
	},
]);

assert.deepEqual(evidence, [
	{
		ref: `${runId}:step:3:0:tedix_mcp_code`,
		tool: "tedix_mcp_code",
		outcome: "succeeded",
		resultDigest: "sha256:abc",
	},
	{
		ref: `${runId}:step:4:0:broken_tool`,
		tool: "broken_tool",
		outcome: "failed",
	},
]);

const input = buildObserverInput(
	{ content: "Call the cron tool exactly once.", ts: 1 },
	{
		content: "All crons are healthy.",
		ts: Date.parse("2026-07-18T11:00:00Z"),
	},
	evidence,
);
assert.match(input, /## Canonical execution evidence/);
assert.match(input, /"tool":"tedix_mcp_code","outcome":"succeeded"/);
assert.doesNotMatch(input, /cron-api-secret-value/);

const secretDigest = await digestObserverToolResult({
	secret: "cron-api-secret-value",
	count: 6,
});
assert.match(secretDigest ?? "", /^sha256:[0-9a-f]{64}$/);
assert.doesNotMatch(secretDigest ?? "", /cron-api-secret-value/);

const firstDigest = await digestObserverToolResult({ ok: true, count: 6 });
const secondDigest = await digestObserverToolResult({ ok: true, count: 6 });
assert.match(firstDigest ?? "", /^sha256:[0-9a-f]{64}$/);
assert.equal(firstDigest, secondDigest);
assert.equal(await digestObserverToolResult({ value: 1n }), undefined);

const fallbackEpisode = ensureTerminalEpisodeObservation(
	[],
	{ content: "Run a production cron health check.", ts: 1 },
	{
		content: '{"cronCount":6,"overdueCount":0}',
		ts: Date.parse("2026-07-18T13:25:45Z"),
	},
	evidence,
);
assert.equal(fallbackEpisode.length, 1);
assert.equal(fallbackEpisode[0]?.type, "episode");
assert.equal(fallbackEpisode[0]?.outcomeStatus, "partial");
assert.match(
	fallbackEpisode[0]?.details.join(" ") ?? "",
	/2 total, 1 succeeded, 1 failed/,
);

const authoredEpisode = {
	date: "2026-07-18",
	time: "13:25",
	priority: "high" as const,
	type: "episode" as const,
	content: "Observer-grounded episode",
	details: [],
	outcomeStatus: "success" as const,
};
assert.deepEqual(
	ensureTerminalEpisodeObservation(
		[authoredEpisode],
		{ content: "request", ts: 1 },
		{ content: "response", ts: 2 },
	),
	[authoredEpisode],
);

console.log("observer execution evidence tests passed");

const embeddedUser = {
	content:
		'Tedix embedded user message v1: "From now on, use Spanish."\n\nHost context: SECRET_SCOPE actor=owner tenant=8042',
	ts: 1,
	sessionKey: "embed:fixture",
};
const embeddedInput = buildObserverInput(embeddedUser, {
	content: "Understood.",
	ts: 2,
});
assert.match(embeddedInput, /From now on, use Spanish/);
assert.doesNotMatch(
	embeddedInput,
	/SECRET_SCOPE|actor=|tenant=|embedded user message/,
);
const embeddedFallback = ensureTerminalEpisodeObservation([], embeddedUser, {
	content: "Understood.",
	ts: 2,
});
assert.doesNotMatch(
	JSON.stringify(embeddedFallback),
	/SECRET_SCOPE|actor=|tenant=/,
);
assert.match(JSON.stringify(embeddedFallback), /From now on, use Spanish/);
const legacyEmbedded = buildObserverInput(
	{ ...embeddedUser, content: "Legacy unstructured host scope SECRET_SCOPE" },
	{ content: "Answer.", ts: 2 },
);
assert.doesNotMatch(legacyEmbedded, /SECRET_SCOPE/);

const bundle = buildMemorySourceEvidence(
	{
		content: `Rotate the Example Co key. Bearer abcdefghijklmnop1234 ${"u".repeat(5000)} final ask`,
		ts: 1,
	},
	{
		content: `Rotated it. ${"a".repeat(6000)} Example Co now uses key v2.`,
		ts: 2,
	},
	[
		...evidence,
		...Array.from({ length: 20 }, (_, index) => ({
			ref: `${runId}:step:9:${index}:t`,
			tool: `tool_${index}_${"x".repeat(80)}`,
			outcome: "unknown" as const,
		})),
	],
);
assert.ok(bundle);
assert.doesNotMatch(JSON.stringify(bundle), /abcdefghijklmnop1234/);
assert.ok(
	bundle.userTurn.length <= MEMORY_SOURCE_EVIDENCE_LIMITS.userTurnChars,
);
assert.ok(
	(bundle.assistantReply ?? "").length <=
		MEMORY_SOURCE_EVIDENCE_LIMITS.assistantReplyChars,
);
// Elision keeps both ends: the request's ask and the reply's conclusion.
assert.match(bundle.userTurn, /^Rotate the Example Co key/);
assert.match(bundle.userTurn, /final ask$/);
assert.match(bundle.assistantReply ?? "", /now uses key v2\.$/);
assert.equal(
	bundle.toolReceipts?.length,
	MEMORY_SOURCE_EVIDENCE_LIMITS.toolReceipts,
);
assert.deepEqual(bundle.toolReceipts?.[0], {
	tool: "tedix_mcp_code",
	outcome: "succeeded",
});
// Receipts stay content-free: no refs or result digests.
assert.doesNotMatch(JSON.stringify(bundle), /sha256:abc|step:3/);
assert.ok(MemorySourceEvidenceSchema.safeParse(bundle).success);
assert.equal(
	buildMemorySourceEvidence({ content: "  ", ts: 1 }, { content: "Hi", ts: 2 }),
	undefined,
);
const embeddedBundle = buildMemorySourceEvidence(embeddedUser, {
	content: "Understood.",
	ts: 2,
});
assert.match(embeddedBundle?.userTurn ?? "", /From now on, use Spanish/);
assert.doesNotMatch(JSON.stringify(embeddedBundle), /SECRET_SCOPE|tenant=/);
