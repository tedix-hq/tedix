import { describe, expect, it } from "vite-plus/test";
import {
	classifyContextTurn,
	CONTEXT_SEGMENT_CATALOG,
	CONTEXT_SEGMENT_IDS,
	CONTEXT_TURN_KINDS,
	contextSegmentDefinition,
	contextSegmentsForTurn,
} from "./context-catalog";

describe("context catalog integrity", () => {
	/**
	 * Catalog/engine parity, the check a comparable coding agent's reminder suite keeps. The
	 * failure it catches is silent in both directions: a block declared but
	 * never produced looks like a dark cognitive input, and a block produced but
	 * never declared bypasses every withholding rule below.
	 */
	it("declares exactly the known segment ids, once each", () => {
		expect(CONTEXT_SEGMENT_CATALOG.map((entry) => entry.id)).toEqual([
			...CONTEXT_SEGMENT_IDS,
		]);
		expect(new Set(CONTEXT_SEGMENT_CATALOG.map((e) => e.id)).size).toBe(
			CONTEXT_SEGMENT_CATALOG.length,
		);
	});

	it("gives every segment a purpose", () => {
		for (const entry of CONTEXT_SEGMENT_CATALOG) {
			expect(entry.purpose.trim().length).toBeGreaterThan(0);
		}
	});

	/** A withholding rule without a reason becomes undeletable. */
	it("gives every withholding rule a reason and a known turn kind", () => {
		for (const entry of CONTEXT_SEGMENT_CATALOG) {
			for (const rule of entry.withheldFrom) {
				expect(CONTEXT_TURN_KINDS).toContain(rule.kind);
				expect(rule.because.trim().length).toBeGreaterThan(0);
			}
		}
	});

	it("resolves a definition by id and rejects an unknown one", () => {
		expect(contextSegmentDefinition("directives").id).toBe("directives");
		expect(() => contextSegmentDefinition("nope" as never)).toThrow(
			/Unknown context segment/,
		);
	});
});

describe("contextSegmentsForTurn", () => {
	it("gives a standard turn every block, in catalog order", () => {
		expect(contextSegmentsForTurn("standard")).toEqual([
			"directives",
			"brainDigest",
			"skillGuidance",
			"retrievedSkills",
		]);
	});

	/**
	 * The scoping rule: an explicit operator work order keeps identity, memory
	 * and operational guidance, but not learned preferences that could redirect
	 * it.
	 */
	it("withholds only directives from a Home delegation work order", () => {
		expect(contextSegmentsForTurn("home-delegation-work-order")).toEqual([
			"brainDigest",
			"skillGuidance",
			"retrievedSkills",
		]);
	});

	/**
	 * The correctness boundary. A blind evidence judge that reads its own
	 * accumulated belief is not a judge — it rubber-stamps the causal story it
	 * invented earlier.
	 */
	it("withholds everything from a lean turn", () => {
		expect(contextSegmentsForTurn("lean")).toEqual([]);
	});

	it("never returns a block the catalog withholds from that kind", () => {
		for (const kind of CONTEXT_TURN_KINDS) {
			for (const id of contextSegmentsForTurn(kind)) {
				const withheld = contextSegmentDefinition(id).withheldFrom.map(
					(rule) => rule.kind,
				);
				expect(withheld).not.toContain(kind);
			}
		}
	});
});

describe("classifyContextTurn", () => {
	it("classifies an ordinary turn as standard", () => {
		expect(
			classifyContextTurn({
				isLeanContextSession: false,
				isHomeDelegationWorkOrder: false,
			}),
		).toBe("standard");
	});

	it("classifies a work order when it is not lean", () => {
		expect(
			classifyContextTurn({
				isLeanContextSession: false,
				isHomeDelegationWorkOrder: true,
			}),
		).toBe("home-delegation-work-order");
	});

	/**
	 * Precedence matters and is asserted rather than assumed: lean is a
	 * correctness boundary, the work-order rule is a scoping preference. A
	 * contaminated blind verdict is worse than a narrowly scoped one.
	 */
	it("lets lean win over the work-order rule", () => {
		expect(
			classifyContextTurn({
				isLeanContextSession: true,
				isHomeDelegationWorkOrder: true,
			}),
		).toBe("lean");
	});
});
