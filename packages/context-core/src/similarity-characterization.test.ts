/**
 * Characterization tests for the text-similarity semantics in context-core.
 *
 * These pin the EXACT numeric behavior of the two tokenizer families that
 * live in this package so the shared-implementation consolidation cannot
 * silently shift a threshold-tuned decision:
 *
 * 1. `significantWords` (text-utils): punctuation → space, length > 2,
 *    large STOP_WORDS set. Used by skill retrieval.
 * 2. The directive matcher's tokenizer (compiler): whitespace split ONLY
 *    (punctuation preserved inside tokens, e.g. `memory_search`),
 *    length > 3, NO stop words. Tuned against
 *    DIRECTIVE_INFLUENCE_MIN_RATIO and DIRECTIVE_MATCH_MIN_OVERLAP.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	type CompiledDirective,
	DIRECTIVE_INFLUENCE_MIN_RATIO,
	directiveInfluenced,
	directiveInfluenceRatio,
	selectMatchingDirectives,
} from "./compiler.js";
import {
	matchKeywordOverlap,
	matchTokens,
	matchWordOverlapRatio,
	significantWords,
	tokenizeWords,
} from "./text-utils.js";

describe("significantWords (text-utils family)", () => {
	it("splits on punctuation, keeps length > 2, drops STOP_WORDS", () => {
		// "check" and "config" are STOP_WORDS; "the" is a stop word; the hyphen
		// splits "memory-search" into two tokens.
		expect(significantWords("Check the memory-search config!")).toEqual([
			"memory",
			"search",
		]);
	});

	it("keeps 3-char tokens (length > 2) unlike the directive matcher", () => {
		expect(significantWords("run ssh now")).toEqual(["run", "ssh", "now"]);
	});
});

describe("directive matcher tokenizer (compiler family)", () => {
	it("preserves punctuation inside tokens: memory_search stays one token", () => {
		// directive tokens (len > 3, whitespace split): {memory_search, before,
		// answering, facts} — 4 tokens. The response echoes exactly one.
		const directive = "memory_search before answering facts";
		expect(directiveInfluenceRatio(directive, "we ran memory_search")).toBe(
			1 / 4,
		);
		// 0.25 < 0.34 — NOT influenced. If the tokenizer ever split on the
		// underscore this would flip to 2/5 = 0.4 → influenced.
		expect(directiveInfluenced(directive, "we ran memory_search")).toBe(false);
	});

	it("influence boundary sits at DIRECTIVE_INFLUENCE_MIN_RATIO", () => {
		const directive = "memory_search before answering facts";
		// {memory_search, then, answering} echoes 2 of 4 → 0.5 ≥ 0.34.
		expect(
			directiveInfluenceRatio(directive, "memory_search then answering"),
		).toBe(1 / 2);
		expect(directiveInfluenced(directive, "memory_search then answering")).toBe(
			true,
		);
		expect(DIRECTIVE_INFLUENCE_MIN_RATIO).toBe(0.34);
	});

	it("does not stop-word filter: 'their' counts toward influence", () => {
		// "their" is a stop word in BOTH other tokenizer families but the
		// directive matcher keeps every whitespace token longer than 3 chars.
		expect(directiveInfluenceRatio("their manifest", "their rules")).toBe(
			1 / 2,
		);
	});
});

function directive(text: string, evidenceCount: number): CompiledDirective {
	return {
		strength: "always",
		directive: text,
		category: "deployment",
		evidenceCount,
		successRate: 1,
		compiledAt: "2026-08-19T00:00:00.000Z",
		rationaleIds: [],
		provenanceHash: "",
		lastMatchedAt: null,
	};
}

describe("selectMatchingDirectives boundaries", () => {
	const query = "validate manifest checkpoints before rollout tonight";

	it("selects at overlap >= 3 with evidence >= 3", () => {
		const d = directive("validate manifest checkpoints early", 3);
		const matches = selectMatchingDirectives([d], query);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.overlap).toBe(3);
	});

	it("rejects at overlap 2", () => {
		const d = directive("validate manifest daily", 3);
		expect(selectMatchingDirectives([d], query)).toHaveLength(0);
	});

	it("rejects sufficient overlap with evidence below 3", () => {
		const d = directive("validate manifest checkpoints early", 2);
		expect(selectMatchingDirectives([d], query)).toHaveLength(0);
	});
});

describe("shared tokenizer core + brain-bridge match preset", () => {
	it("tokenizeWords whitespace mode preserves punctuation inside tokens", () => {
		expect(
			tokenizeWords("Run memory_search now!", {
				minLength: 3,
				split: "whitespace",
			}),
		).toEqual(["memory_search", "now!"]);
	});

	it("matchTokens: length > 3, small stop-word set, punctuation splits", () => {
		// "the"/"that" are match stop words; "now" (3 chars) is too short;
		// "memory_search" splits on the underscore.
		expect(matchTokens("Check that the memory_search runs now")).toEqual([
			"check",
			"memory",
			"search",
			"runs",
		]);
	});

	it("matchKeywordOverlap is directional and counts multiplicity in `a`", () => {
		expect(
			matchKeywordOverlap(
				"manifest manifest manifest failed",
				"prefetch manifest checkpoints nightly",
			),
		).toBe(3);
		expect(
			matchKeywordOverlap(
				"prefetch manifest checkpoints nightly",
				"manifest manifest manifest failed",
			),
		).toBe(1);
	});

	it("matchWordOverlapRatio divides by `a`'s token count (asymmetric)", () => {
		const a = "prefetch manifest hourly";
		const b = "prefetch manifest checkpoints nightly";
		expect(matchWordOverlapRatio(a, b)).toBe(2 / 3);
		expect(matchWordOverlapRatio(b, a)).toBe(2 / 4);
		expect(matchWordOverlapRatio("", b)).toBe(0);
	});
});
