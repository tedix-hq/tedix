/**
 * Documentation guard for the Observer prompt's ownerHint="self" guidance.
 *
 * The deterministic CODE line (the parser self-owner guard + commitment gate) is
 * exercised in observer.test.ts and brain-bridge/task-bridge.test.ts. This file
 * locks the PROMPT-SIDE recall source: the Observer system prompt must keep
 * documenting (1) the ownerHint="self" sentinel and that it is for a genuine
 * first-person commitment only, and (2) the runaway procedural self-talk
 * counter-examples it must NOT self-own. If a future edit deletes the guidance,
 * the model stops emitting "self" correctly and the guard silently degrades —
 * this test fails first.
 *
 * Pure, offline — asserts against the exported prompt string.
 */

import { describe, expect, it } from "vite-plus/test";
import { OBSERVER_SYSTEM_PROMPT } from "./prompts.js";

describe("OBSERVER_SYSTEM_PROMPT ownerHint='self' guidance", () => {
	it("documents the self sentinel as a genuine first-person commitment", () => {
		expect(OBSERVER_SYSTEM_PROMPT).toContain('ownerHint="self"');
		expect(OBSERVER_SYSTEM_PROMPT.toLowerCase()).toContain(
			"first-person commitment",
		);
		// The positive example the guard promotes.
		expect(OBSERVER_SYSTEM_PROMPT).toContain("I'll refactor the auth module");
	});

	it("lists the runaway procedural counter-examples that are NOT self-owned", () => {
		// Each is procedural/monitoring/routing self-talk the model must NOT mark
		// ownerHint="self"; the prompt names them so the model learns the line.
		const counterExamples = [
			"Run node scripts/check-deploy.mjs",
			"Inspect latest deploy run",
			"Escalate a finding to home.ask",
		];
		for (const example of counterExamples) {
			expect(OBSERVER_SYSTEM_PROMPT).toContain(example);
		}
	});

	it("explicitly forbids self-owning procedural / tool-invocation self-talk", () => {
		const prompt = OBSERVER_SYSTEM_PROMPT.toLowerCase();
		expect(prompt).toContain('do not set ownerhint="self"');
		// The procedural verb families the parser also rejects.
		for (const verb of ["procedural", "monitoring", "inspection", "routing"]) {
			expect(prompt).toContain(verb);
		}
	});
});

describe("OBSERVER_SYSTEM_PROMPT canonical execution evidence", () => {
	it("treats execution receipts as authoritative without inferring result content", () => {
		expect(OBSERVER_SYSTEM_PROMPT).toContain("Canonical execution evidence");
		expect(OBSERVER_SYSTEM_PROMPT).toContain("Never contradict those records");
		expect(OBSERVER_SYSTEM_PROMPT).toContain(
			"does not reveal or prove the result's contents",
		);
		expect(OBSERVER_SYSTEM_PROMPT).toContain("do not infer that no tools ran");
	});
});
