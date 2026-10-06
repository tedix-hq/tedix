import assert from "node:assert/strict";
import {
	AskRequestSchema,
	buildReasonSessionKey,
	callIdentity,
	PLATFORM_REASON_MANIFEST,
	REASON_DEFAULT_MAX_CALLS,
	REASON_MAX_CALLS_CEILING,
	REASON_METHOD,
	REASON_NAMESPACE,
	resolveReasonBudget,
} from "../src/reason-core";

// ---------------------------------------------------------------------------
// env.REASON is a cost-and-blindness contract as much as an API. What is worth
// pinning here is not "does it call a model" but: what a manifest is allowed to
// grant, what a durable RETRY is allowed to cost, and whether two reasoners in
// a fan-out can see each other. All three are pure.
// ---------------------------------------------------------------------------

// --- Budget: undeclared must fail closed --------------------------------------

for (const manifest of [
	{},
	{ reason: undefined },
	{ reason: null },
	{ reason: false },
	{ reason: { enabled: false } },
]) {
	const resolved = resolveReasonBudget(manifest);
	assert.equal(
		resolved.enabled,
		false,
		`undeclared reason must not grant a fan-out: ${JSON.stringify(manifest)}`,
	);
	assert.equal(resolved.maxCalls, 0);
}

// Enabled without a number takes the conservative default, never the ceiling.
assert.deepEqual(resolveReasonBudget({ reason: true }), {
	enabled: true,
	maxCalls: REASON_DEFAULT_MAX_CALLS,
});
assert.deepEqual(resolveReasonBudget({ reason: {} }), {
	enabled: true,
	maxCalls: REASON_DEFAULT_MAX_CALLS,
});

// A declared budget is honored...
assert.equal(resolveReasonBudget({ reason: { maxCalls: 3 } }).maxCalls, 3);
// ...but clamped. The engine retries steps, so an unbounded fan-out inside a
// retried step multiplies and can exhaust a tedi's daily budget. Nothing a
// tenant writes may raise this.
assert.equal(
	resolveReasonBudget({ reason: { maxCalls: 100_000 } }).maxCalls,
	REASON_MAX_CALLS_CEILING,
);
for (const bad of [0, -5, Number.NaN, "many", {}]) {
	assert.equal(
		resolveReasonBudget({ reason: { maxCalls: bad } }).maxCalls,
		REASON_DEFAULT_MAX_CALLS,
		`nonsense budget must fall back, not be trusted: ${String(bad)}`,
	);
}

// --- The platform grant is exactly one method ---------------------------------

// A workflow declares that it wants to REASON, not that it may call
// tedi.run_tedi_turn generally. Routing this through the skill's own manifest
// would hand every reasoning workflow a general tedi-messaging capability it
// never asked for — a strictly larger grant than the feature needs.
assert.deepEqual(PLATFORM_REASON_MANIFEST.mcp, {
	[REASON_NAMESPACE]: [REASON_METHOD],
});
assert.equal(PLATFORM_REASON_MANIFEST.network, false);
// Reasoning returns text. Only env.EVIDENCE decides whether a claim is
// supported, and it re-reads host-sealed records rather than trusting a reply,
// so a confident fan-out still cannot mint grounding.
assert.equal(PLATFORM_REASON_MANIFEST.grounding.required, false);
assert.equal(PLATFORM_REASON_MANIFEST.expectedAnnotations.destructive, false);

// --- Identity: fan-out is independent, retries are not fresh samples ----------

const STEP = {
	stepName: "judge",
	stepCount: 0,
	stepType: "do" as const,
	attempt: 1,
	phase: "do",
	ordinal: 0,
};

const a = callIdentity("run-1", "a", STEP);
const b = callIdentity("run-1", "b", STEP);
assert.notEqual(a, b, "distinct fan-out keys must be distinct reasoners");

// The lean prefix is load-bearing: a tedi runtime routes it to a per-session
// tool-free facet with empty state. Distinct suffixes are distinct child
// Durable Objects, which is what makes Promise.all genuinely parallel AND what
// keeps two reasoners in the same fan-out from reading each other.
assert.ok(buildReasonSessionKey(a).startsWith("workflow:synth:"));
assert.notEqual(buildReasonSessionKey(a), buildReasonSessionKey(b));

// The ATTEMPT is deliberately excluded, matching the env.MCP idempotency
// doctrine: a durable retry of the same logical call presents the same
// identity instead of silently re-billing. Fresh samples come from a different
// `key` — that is the whole contract, and it is why `key` rather than `attempt`
// carries fan-out identity.
assert.equal(
	callIdentity("run-1", "a", { ...STEP, attempt: 7 }),
	a,
	"a retry must not become a new billable sample",
);
// Step coordinates DO separate calls: the same key in a different step is a
// different question.
assert.notEqual(callIdentity("run-1", "a", { ...STEP, stepCount: 1 }), a);
assert.notEqual(callIdentity("run-2", "a", STEP), a);

// --- Request validation -------------------------------------------------------

assert.equal(AskRequestSchema.safeParse({ prompt: "q" }).success, true);
assert.equal(AskRequestSchema.safeParse({}).success, false);
assert.equal(AskRequestSchema.safeParse({ prompt: "" }).success, false);
// A fan-out key lands in both a session key and an artifact path, so it stays
// an inert identifier rather than anything traversal-shaped.
for (const key of ["../../escape", "a/b", "with space", "x".repeat(65)]) {
	assert.equal(
		AskRequestSchema.safeParse({ prompt: "q", key }).success,
		false,
		`key must be rejected: ${key}`,
	);
}
assert.equal(
	AskRequestSchema.safeParse({ prompt: "q", key: "refute-1.a_B" }).success,
	true,
);

console.log("skill-runtime reason tests passed");
