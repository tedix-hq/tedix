/**
 * Unit tests for the Observer parser's self-owner guard.
 *
 * The guard is the runaway-proof line behind the prompt: a model-emitted
 * first-person ownerHint ("self"/"me"/"I'll …") canonicalizes to the sentinel
 * ownerHint="self" ONLY for a genuine first-person commitment to a concrete,
 * scoped deliverable; procedural / monitoring / tool-invocation / conditional
 * self-talk has its self-owner STRIPPED to undefined (degrades to working
 * memory via the unchanged commitment gate). Non-self owners pass through.
 *
 * Pure, offline — exercises `parseTaskIntents` directly.
 */

import { describe, expect, it } from "vite-plus/test";
import { parseObserverResult, parseTaskIntents } from "./observer.js";

function rawIntent(
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	return {
		title: "Do a thing",
		kind: "candidate",
		source: "observer",
		confidence: 0.9,
		requiresConfirmation: false,
		evidence: [],
		ownerHint: "self",
		...overrides,
	};
}

function parseOne(overrides: Record<string, unknown>) {
	const [intent] = parseTaskIntents([rawIntent(overrides)]);
	return intent;
}

// The five runaway titles that flooded promotion, each emitted by the model with
// ownerHint="self". Every one fails the positive predicate (no commitment marker
// + no build/change verb) and independently hits the reject set.
const RUNAWAY_TITLES = [
	"Run node scripts/check-deploy.mjs",
	"Inspect latest deploy-workers.yml run",
	"Verify latest main deploy run",
	"Escalate a deploy finding to home.ask",
	"Notify home once if a deploy finding lands",
];

describe("parseTaskIntents self-owner guard", () => {
	it("genuine first-person concrete commitment -> ownerHint='self'", () => {
		expect(parseOne({ title: "I'll refactor the auth module" }).ownerHint).toBe(
			"self",
		);
		expect(
			parseOne({ title: "I'm going to migrate the orders schema" }).ownerHint,
		).toBe("self");
		expect(
			parseOne({ title: "Let me implement the retry handler" }).ownerHint,
		).toBe("self");
	});

	it("canonicalizes any self-token (me/myself/i) for a genuine commitment", () => {
		for (const ownerHint of ["self", "me", "myself", "i", "I'll"]) {
			expect(
				parseOne({ ownerHint, title: "I'll rewrite the billing client" })
					.ownerHint,
			).toBe("self");
		}
	});

	it("strips self-owner from each runaway procedural title", () => {
		for (const title of RUNAWAY_TITLES) {
			expect(parseOne({ title, ownerHint: "self" }).ownerHint).toBeUndefined();
		}
	});

	it("strips self-owner from procedural self-talk even with a commitment marker", () => {
		// marker present, but action verb is monitoring -> not a deliverable
		expect(
			parseOne({ title: "Let me verify the latest deploy run" }).ownerHint,
		).toBeUndefined();
		// marker + build verb, but a tool/route token -> procedural invocation
		expect(
			parseOne({ title: "I'll wire up home.ask for escalation" }).ownerHint,
		).toBeUndefined();
		// marker + build verb, but conditional/contingent phrasing
		expect(
			parseOne({ title: "I'll add a fallback once if a deploy finding lands" })
				.ownerHint,
		).toBeUndefined();
	});

	it("strips a bare-verb commitment with no scoped subject", () => {
		expect(
			parseOne({ title: "I'll refactor", ownerHint: "self" }).ownerHint,
		).toBeUndefined();
	});

	it("preserves a non-self owner unchanged", () => {
		expect(
			parseOne({ title: "Ship the migration", ownerHint: "cto" }).ownerHint,
		).toBe("cto");
		// a non-self owner is never reinterpreted as a self-commitment
		expect(
			parseOne({ title: "I'll refactor the auth module", ownerHint: "cto" })
				.ownerHint,
		).toBe("cto");
	});

	it("a missing/blank ownerHint stays undefined", () => {
		expect(
			parseOne({ title: "I'll refactor the auth module", ownerHint: "" })
				.ownerHint,
		).toBeUndefined();
		const { ownerHint } = parseOne({ title: "I'll refactor the auth module" });
		expect(ownerHint).toBe("self"); // sanity: default fixture owner is "self"
	});
});

describe("parseObserverResult episode outcomes", () => {
	it("keeps only valid outcomeStatus values on episode observations", () => {
		const parsed = parseObserverResult(
			JSON.stringify({
				observations: [
					{
						date: "2026-07-18",
						time: "12:00",
						priority: "low",
						type: "episode",
						content: "Cron health read completed.",
						details: [],
						outcomeStatus: "success",
					},
					{
						date: "2026-07-18",
						time: "12:00",
						priority: "medium",
						type: "episode",
						content: "Deployment settlement was ambiguous.",
						details: [],
						outcomeStatus: "unverified",
					},
					{
						date: "2026-07-18",
						time: "12:00",
						priority: "high",
						type: "technical",
						content: "A technical fact is not a terminal episode.",
						details: [],
						outcomeStatus: "success",
					},
				],
			}),
		);

		expect(parsed.observations[0]?.outcomeStatus).toBe("success");
		expect(parsed.observations[1]?.outcomeStatus).toBeUndefined();
		expect(parsed.observations[2]?.outcomeStatus).toBeUndefined();
	});
});
