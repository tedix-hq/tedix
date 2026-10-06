/**
 * Pure-logic regression for harness-version component hashing + id derivation.
 *
 * Mirrors the `node:assert` script style of `ledger-mirror.test.ts` (run via
 * `bun run src/harness-version.test.ts`). Covers the bump-detection contract:
 * the component map is order-independent and stable for unchanged inputs, and
 * the derived trace-bundle / event ids match the `{runId}:{seq}` ledger scheme.
 */
import assert from "node:assert/strict";
import {
	buildHarnessComponents,
	componentsEqual,
	loopPolicyComponent,
	parseLoopPolicyComponent,
	runEventIds,
	shortHash,
	traceBundleId,
	traceReferenceEventIds,
} from "@tedix/context-core/harness-version";

const RUN = "5eed0042-0000-4000-8000-000000000042:chat:777";

async function main() {
	// ── shortHash is deterministic + stable across calls ──────────────────────
	assert.equal(
		await shortHash("hello"),
		await shortHash("hello"),
		"shortHash deterministic",
	);
	assert.notEqual(
		await shortHash("hello"),
		await shortHash("world"),
		"shortHash distinguishes inputs",
	);

	// ── Same inputs → identical component map (no spurious bump) ───────────────
	const baseInputs = {
		systemPrompt: "You are a Tedix digital worker.",
		model: "gpt-5.6-terra",
		directiveProvenanceHashes: ["aaa", "bbb"],
		mcpAppSlug: "cto",
		runtimeKind: "agent",
	};
	const a = await buildHarnessComponents(baseInputs);
	const b = await buildHarnessComponents(baseInputs);
	assert.ok(componentsEqual(a, b), "identical inputs → equal components");

	// ── Directive order does not change the set (sorted before hashing) ───────
	const reordered = await buildHarnessComponents({
		...baseInputs,
		directiveProvenanceHashes: ["bbb", "aaa"],
	});
	assert.ok(
		componentsEqual(a, reordered),
		"directive provenance order is insignificant",
	);

	// ── Well-known component keys present ─────────────────────────────────────
	assert.equal(a.model, "gpt-5.6-terra", "model passed through verbatim");
	assert.ok(
		(a.prompt_template ?? "").startsWith("sha256:"),
		"prompt_template hashed",
	);
	assert.ok(
		(a.directive_set ?? "").startsWith("sha256:"),
		"directive_set hashed",
	);
	assert.equal(a.mcp_routing, "cto", "mcp_routing = app slug");
	assert.equal(a.context_policy, "agent", "context_policy = runtime kind");

	// ── loop_policy: absent unless supplied, then stamped as a readable descriptor ─
	assert.equal(
		a.loop_policy,
		undefined,
		"loop_policy absent when not supplied",
	);
	const loopPolicy = { maxSteps: 40, finalStepStop: "toolChoice:none" };
	const withLoop = await buildHarnessComponents({ ...baseInputs, loopPolicy });
	assert.equal(
		withLoop.loop_policy,
		loopPolicyComponent(loopPolicy),
		"loop_policy = stamped descriptor",
	);
	assert.equal(
		withLoop.loop_policy,
		"maxSteps=40;finalStep=toolChoice:none",
		"loop_policy descriptor is human-readable + stable",
	);
	assert.ok(
		!componentsEqual(a, withLoop),
		"adding loop_policy changes the component set",
	);
	// ── A loop-policy change forces a bump (max steps OR stop rule) ────────────
	const stepsChanged = await buildHarnessComponents({
		...baseInputs,
		loopPolicy: { ...loopPolicy, maxSteps: 24 },
	});
	assert.ok(
		!componentsEqual(withLoop, stepsChanged),
		"max-step change → loop_policy bump",
	);
	const stopChanged = await buildHarnessComponents({
		...baseInputs,
		loopPolicy: { ...loopPolicy, finalStepStop: "stepCountIs" },
	});
	assert.ok(
		!componentsEqual(withLoop, stopChanged),
		"final-step stop-rule change → loop_policy bump",
	);

	// ── parseLoopPolicyComponent: byte-symmetric inverse + fail-soft ───────────
	// The READ half the runtime uses to obey a promoted policy variant.
	assert.deepEqual(
		parseLoopPolicyComponent(loopPolicyComponent(loopPolicy)),
		loopPolicy,
		"parse∘serialize round-trips the loop policy",
	);
	assert.deepEqual(
		parseLoopPolicyComponent("maxSteps=24;finalStep=toolChoice:none"),
		{ maxSteps: 24, finalStepStop: "toolChoice:none" },
		"parse reads a promoted variant (finalStep keeps its colon)",
	);
	for (const bad of [
		undefined,
		null,
		"",
		"garbage",
		"maxSteps=;finalStep=toolChoice:none",
		"maxSteps=0;finalStep=toolChoice:none",
		"maxSteps=40;finalStep=",
		"finalStep=toolChoice:none",
	]) {
		assert.equal(
			parseLoopPolicyComponent(bad),
			null,
			`parse is fail-soft on malformed input: ${JSON.stringify(bad)}`,
		);
	}

	// ── Changing any harness input changes the map (forces a bump) ────────────
	const promptChanged = await buildHarnessComponents({
		...baseInputs,
		systemPrompt: "Different prompt",
	});
	assert.ok(
		!componentsEqual(a, promptChanged),
		"prompt change → component bump",
	);
	const modelChanged = await buildHarnessComponents({
		...baseInputs,
		model: "gpt-6",
	});
	assert.ok(!componentsEqual(a, modelChanged), "model change → component bump");
	const directiveChanged = await buildHarnessComponents({
		...baseInputs,
		directiveProvenanceHashes: ["aaa", "ccc"],
	});
	assert.ok(
		!componentsEqual(a, directiveChanged),
		"directive change → component bump",
	);

	// ── componentsEqual ignores key insertion order ───────────────────────────
	assert.ok(
		componentsEqual({ x: "1", y: "2" }, { y: "2", x: "1" }),
		"componentsEqual is order-independent",
	);
	assert.ok(
		!componentsEqual({ x: "1" }, { x: "1", y: "2" }),
		"componentsEqual detects extra keys",
	);

	// ── Deterministic ids match the ledger scheme ─────────────────────────────
	assert.equal(traceBundleId(RUN), `${RUN}:bundle`, "trace bundle id");
	assert.deepEqual(
		traceReferenceEventIds(
			`${RUN}:0`,
			null,
			[`${RUN}:1`, `${RUN}:0`],
			"",
			undefined,
		),
		[`${RUN}:0`, `${RUN}:1`],
		"trace references keep first-seen real event ids",
	);
	assert.deepEqual(
		runEventIds(RUN),
		[`${RUN}:0`, `${RUN}:1`, `${RUN}:2`, `${RUN}:3`],
		"run event ids = seq 0..3",
	);
	assert.deepEqual(
		runEventIds(RUN, { terminalSequence: 2 }),
		[`${RUN}:0`, `${RUN}:1`, `${RUN}:2`],
		"recovery run event ids stop at the mirrored terminal seq",
	);
	assert.deepEqual(
		runEventIds(RUN, { emitConversationCreated: true }),
		[`${RUN}:conv-created`, `${RUN}:0`, `${RUN}:1`, `${RUN}:2`, `${RUN}:3`],
		"first-turn run includes conv-created",
	);

	console.log("harness-version.test.ts: all assertions passed");
}

void main();
