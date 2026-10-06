/**
 * Tests for the BLIND-VERIFICATION guard on cognitive system-prompt addenda
 * (`cognitive-addenda.ts` + the shared `isBlindVerificationSession` session-key
 * convention).
 *
 * The bug this pins: the evidence judge is deliberately the SAME tedi that wrote
 * the interpretation, asked one closed question about one cited passage. It is
 * only a judge while it is BLIND. `do.ts` injected the brain digest (the tedi's
 * accumulated beliefs) into EVERY turn, so the judge was handed the very causal
 * story it invented last week and could rubber-stamp a page that never stated
 * it. A judge that reads its own memory is not a judge.
 *
 * The DO itself needs Cloudflare bindings, so (like `empty-round-guard.test.ts`)
 * we test the extracted composer `do.ts` actually calls — the guard, the source
 * ordering, and the fail-soft behavior — rather than instantiating the DO.
 *
 * Run: `bun run src/cognitive-addenda.test.ts`
 */

import assert from "node:assert/strict";
import {
	EVIDENCE_JUDGE_SESSION_PREFIX,
	isBlindVerificationSession,
	isWorkflowSynthesisSession,
	WORKFLOW_SYNTH_SESSION_PREFIX,
} from "@tedix/api-contract/utils/runtime-identity";
import {
	type CognitiveAddendaSources,
	composeCognitiveAddenda,
	isHomeDelegationWorkOrder,
} from "./cognitive-addenda";

// ── The producer's key shape ─────────────────────────────────────────────────
// `createMcpJudge` (apps/skill-runtime/src/evidence.ts) mints exactly this:
//   `${EVIDENCE_JUDGE_SESSION_PREFIX}${runId}:${claimIds.join(",")}`
const RUN_ID = "01JCB4Q9V4Z1J8B3N2K6X7Y5T0";
const JUDGE_SESSION_KEY = `${EVIDENCE_JUDGE_SESSION_PREFIX}${RUN_ID}:claim-1,claim-2`;

assert.equal(
	EVIDENCE_JUDGE_SESSION_PREFIX,
	"evidence:judge:",
	"prefix is the wire-format the evidence bridge emits — changing it un-blinds the judge",
);
assert.equal(
	isBlindVerificationSession(JUDGE_SESSION_KEY),
	true,
	"the real evidence-judge session key is blind",
);
assert.equal(
	isBlindVerificationSession(`${EVIDENCE_JUDGE_SESSION_PREFIX}${RUN_ID}:c1`),
	true,
	"single-claim judge batch is blind",
);

// ── Normal turns are NOT blind (this must change behavior for nobody else) ────
for (const normal of [
	"agent:main:main", // default agent session
	"os:user-42", // Home / Tedix OS chat
	"chat:abc123",
	"telegram:99887766",
	"__throwaway:codex-smoke", // ephemeral, a DIFFERENT convention
	// The JUDGMENT-writing session consumes verdicts and SHOULD keep its memory:
	// only the judge that reads the passage is blinded.
	"acme:judgment:2026-07-11",
	"evidence:summary:run-1", // adjacent evidence session, not a judge
	"my-evidence:judge:spoof", // prefix must anchor at position 0
	"evidence:judge", // no trailing colon → not the producer's shape
	`${EVIDENCE_JUDGE_SESSION_PREFIX}`, // prefix with nothing after it
	"",
]) {
	assert.equal(
		isBlindVerificationSession(normal),
		false,
		`normal session key must not be blinded: ${JSON.stringify(normal)}`,
	);
}
assert.equal(isBlindVerificationSession(undefined), false);
assert.equal(isBlindVerificationSession(null), false);
console.log(
	"PASS: isBlindVerificationSession matches only the judge key shape",
);

// ── Lean workflow-synthesis keys ──────────────────────────────────────────────
assert.equal(WORKFLOW_SYNTH_SESSION_PREFIX, "workflow:synth:");
assert.equal(
	isWorkflowSynthesisSession("workflow:synth:grounding-review:r1"),
	true,
	"a workflow:synth:* key is a lean synthesis turn",
);
for (const plain of [
	"agent:main:main",
	"grounding-review:r1", // pre-conversion key shape — NOT lean
	"workflow:synth", // no trailing colon → not the producer's shape
	`${WORKFLOW_SYNTH_SESSION_PREFIX}`, // prefix with nothing after it
	"",
]) {
	assert.equal(
		isWorkflowSynthesisSession(plain),
		false,
		`plain session key must not be lean synthesis: ${JSON.stringify(plain)}`,
	);
}
console.log("PASS: isWorkflowSynthesisSession matches only workflow:synth:*");

assert.equal(
	isHomeDelegationWorkOrder(
		"[HOME DELEGATION WORK ORDER run:auto:tedi]\nObjective: inspect a workflow",
	),
	true,
);
assert.equal(
	isHomeDelegationWorkOrder("Inspect a workflow from Tedix OS"),
	false,
);

// ── Composer: a blind session gets NO addenda and performs NO memory read ─────
function trackingSources(): {
	sources: CognitiveAddendaSources;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		sources: {
			directives: async () => {
				calls.push("directives");
				return "## Directives\nALWAYS cite the source.";
			},
			brainDigest: async () => {
				calls.push("brainDigest");
				return "## Memory\nDemand rose because of the heatwave.";
			},
			skillGuidance: async () => {
				calls.push("skillGuidance");
				return "## Skills\nprice-watch";
			},
			retrievedSkills: async () => {
				calls.push("retrievedSkills");
				return "## Retrieved Skills (act-time match: 1)\nprice-watch steps";
			},
		},
	};
}

{
	const { sources, calls } = trackingSources();
	const addenda = await composeCognitiveAddenda({
		sessionKey: JUDGE_SESSION_KEY,
		sources,
	});
	assert.equal(addenda, "", "blind verification turn gets no addenda at all");
	assert.deepEqual(
		calls,
		[],
		"blind turn must not even CALL the sources — no memory read, not a read-and-discard",
	);
	console.log("PASS: blind session → no addenda, no cognitive reads");
}

// ── Composer: a lean workflow-synthesis session is gated the same way ─────────
{
	const { sources, calls } = trackingSources();
	const addenda = await composeCognitiveAddenda({
		sessionKey: `${WORKFLOW_SYNTH_SESSION_PREFIX}grounding-review:${RUN_ID}`,
		sources,
	});
	assert.equal(addenda, "", "lean synthesis turn gets no addenda at all");
	assert.deepEqual(
		calls,
		[],
		"lean synthesis turn must not even CALL the sources — the ~22k-token haul is the cost being cut",
	);
	console.log("PASS: workflow:synth session → no addenda, no cognitive reads");
}

// ── Composer: a normal session still gets everything, in order ────────────────
{
	const { sources, calls } = trackingSources();
	const addenda = await composeCognitiveAddenda({
		sessionKey: "os:user-42",
		sources,
	});
	assert.deepEqual(calls, [
		"directives",
		"brainDigest",
		"skillGuidance",
		"retrievedSkills",
	]);
	assert.equal(
		addenda,
		[
			"## Directives\nALWAYS cite the source.",
			"## Memory\nDemand rose because of the heatwave.",
			"## Skills\nprice-watch",
			"## Retrieved Skills (act-time match: 1)\nprice-watch steps",
		].join("\n\n"),
		"normal turn: all four blocks, joined with a blank line",
	);
	console.log(
		"PASS: normal session → directives + brain digest + skills + retrieved skills",
	);
}

// An explicit Home work order keeps personal memory and operational skill
// guidance (static + act-time retrieved) while skipping learned preferences
// that could redirect it.
{
	const { sources, calls } = trackingSources();
	const addenda = await composeCognitiveAddenda({
		sessionKey: "agent:main:main",
		skipDirectives: true,
		sources,
	});
	assert.deepEqual(calls, ["brainDigest", "skillGuidance", "retrievedSkills"]);
	assert.equal(
		addenda,
		[
			"## Memory\nDemand rose because of the heatwave.",
			"## Skills\nprice-watch",
			"## Retrieved Skills (act-time match: 1)\nprice-watch steps",
		].join("\n\n"),
	);
	console.log("PASS: Home delegation → memory + skill guidance, no directives");
}

// A turn with no session key at all (a caller that cannot supply one) keeps the
// old behavior: addenda are injected. Blinding is opt-IN by key, never by absence.
{
	const { sources } = trackingSources();
	const addenda = await composeCognitiveAddenda({
		sessionKey: undefined,
		sources,
	});
	assert.ok(
		addenda.includes("## Memory"),
		"missing session key must not accidentally blind a normal turn",
	);
	console.log("PASS: absent session key → addenda still injected");
}

// ── Composer: empty blocks are dropped; a failing block never breaks the turn ─
{
	const errors: string[] = [];
	const addenda = await composeCognitiveAddenda({
		sessionKey: "agent:main:main",
		sources: {
			directives: async () => "",
			brainDigest: async () => {
				throw new Error("digest store offline");
			},
			skillGuidance: async () => "## Skills\nprice-watch",
			retrievedSkills: async () => "",
		},
		onError: (block) => errors.push(block),
	});
	assert.equal(
		addenda,
		"## Skills\nprice-watch",
		"empty block dropped, failing block skipped, turn still runs",
	);
	assert.deepEqual(
		errors,
		["brainDigest"],
		"the failure is reported, not swallowed",
	);
	console.log("PASS: fail-soft per block");
}

console.log("PASS: cognitive-addenda blind-verification guard");

// Independent reads overlap; skill retrieval must await guidance's corpus warm.
{
	let releaseDirectives!: (text: string) => void;
	let releaseBrain!: (text: string) => void;
	let releaseGuidance!: (text: string) => void;
	const calls: string[] = [];
	let report:
		| import("./cognitive-addenda").CognitiveCompositionReport
		| undefined;
	const composed = composeCognitiveAddenda({
		sessionKey: "chat:parallel",
		runId: "run-parallel",
		sources: {
			directives: () => {
				calls.push("directives");
				return new Promise((resolve) => {
					releaseDirectives = resolve;
				});
			},
			brainDigest: () => {
				calls.push("brainDigest");
				return new Promise((resolve) => {
					releaseBrain = resolve;
				});
			},
			skillGuidance: () => {
				calls.push("skillGuidance");
				return new Promise((resolve) => {
					releaseGuidance = resolve;
				});
			},
			retrievedSkills: async () => {
				calls.push("retrievedSkills");
				return "RETRIEVED_PRIVATE_TEXT";
			},
		},
		onComposition: (value) => {
			report = value;
		},
	});
	assert.deepEqual(calls, ["directives", "brainDigest", "skillGuidance"]);
	releaseGuidance("GUIDANCE_PRIVATE_TEXT");
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	assert.deepEqual(calls, [
		"directives",
		"brainDigest",
		"skillGuidance",
		"retrievedSkills",
	]);
	releaseBrain("BRAIN_PRIVATE_TEXT");
	releaseDirectives("DIRECTIVES_PRIVATE_TEXT");
	assert.equal(
		await composed,
		"DIRECTIVES_PRIVATE_TEXT\n\nBRAIN_PRIVATE_TEXT\n\nGUIDANCE_PRIVATE_TEXT\n\nRETRIEVED_PRIVATE_TEXT",
	);
	assert.equal(report?.runId, "run-parallel");
	assert.equal(report?.blocks.length, 4);
	assert.ok(report?.blocks.every((block) => block.status === "included"));
	assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TEXT/);
}

// Empty, failed and intentionally withheld sources are different observations.
{
	const reports: import("./cognitive-addenda").CognitiveCompositionReport[] =
		[];
	const sources = {
		directives: async () => "never called",
		brainDigest: async () => "",
		skillGuidance: async () => {
			throw new Error("source unavailable");
		},
		retrievedSkills: async () => "retained",
	};
	const result = await composeCognitiveAddenda({
		sessionKey: "chat:work-order",
		runId: "run-status",
		skipDirectives: true,
		sources,
		onError: () => {},
		onComposition: (r) => reports.push(r),
	});
	assert.equal(result, "retained");
	assert.deepEqual(
		reports[0]?.blocks.map((block) => block.status),
		["withheld", "empty", "failed", "included"],
	);
	assert.ok(reports[0]?.blocks[0]?.reason);
	const blind = await composeCognitiveAddenda({
		sessionKey: JUDGE_SESSION_KEY,
		runId: "run-blind",
		sources,
		onComposition: (r) => reports.push(r),
	});
	assert.equal(blind, "");
	assert.ok(reports[1]?.blocks.every((block) => block.status === "withheld"));
}
