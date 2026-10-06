import { selectRetrievedSkillCandidates } from "./skill-retrieval";
import { describe, expect, it } from "vite-plus/test";
import {
	type RetrievableSkill,
	SKILL_RETRIEVAL_DEFAULT_TOP_K,
	SKILL_RETRIEVAL_MAX_BLOCK_TOKENS,
	SKILL_RETRIEVAL_MAX_SKILL_TOKENS,
	SKILL_RETRIEVAL_MAX_TOP_K,
	recencyWeightedSuccessRate,
	selectRetrievedSkills,
	selectSkillsForTurn,
	serializeRetrievedSkills,
} from "./skill-retrieval.js";
import { countTokens } from "./tokens.js";

const NOW = new Date("2026-07-16T12:00:00Z");

let skillSeq = 0;
function skill(overrides: Partial<RetrievableSkill>): RetrievableSkill {
	skillSeq++;
	return {
		id: `skill-${skillSeq}`,
		slug: `skill-${skillSeq}`,
		title: "Weekly pricing report",
		summary: "Compile the weekly pricing report and email it",
		lifecycleState: "active",
		successCount: 0,
		failureCount: 0,
		...overrides,
	};
}

const QUERY = "compile the weekly pricing report and email it to sales";

describe("selectRetrievedSkills — lifecycle gating", () => {
	it("never returns drafts, stale, archived, or unknown lifecycle states", () => {
		const corpus = [
			skill({ lifecycleState: "draft" }),
			skill({ lifecycleState: "stale" }),
			skill({ lifecycleState: "archived" }),
			skill({ lifecycleState: null }),
			skill({ lifecycleState: "bogus" }),
		];
		expect(selectRetrievedSkills(corpus, QUERY, { now: NOW })).toEqual([]);
	});

	it("ranks crystallized > proven > active at equal relevance", () => {
		const active = skill({ slug: "a-active", lifecycleState: "active" });
		const crystallized = skill({
			slug: "b-crystallized",
			lifecycleState: "crystallized",
		});
		const proven = skill({ slug: "c-proven", lifecycleState: "proven" });
		const out = selectRetrievedSkills([active, crystallized, proven], QUERY, {
			topK: 3,
			now: NOW,
		});
		expect(out.map((m) => m.skill.slug)).toEqual([
			"b-crystallized",
			"c-proven",
			"a-active",
		]);
	});

	it("relevance overlap outranks lifecycle priority", () => {
		const relevantActive = skill({
			slug: "relevant-active",
			lifecycleState: "active",
		});
		const vagueCrystallized = skill({
			slug: "vague-crystallized",
			lifecycleState: "crystallized",
			title: "Pricing report helper",
			summary: "Generic pricing report",
		});
		const out = selectRetrievedSkills(
			[vagueCrystallized, relevantActive],
			QUERY,
			{
				topK: 2,
				now: NOW,
			},
		);
		expect(out[0]?.skill.slug).toBe("relevant-active");
		expect(out[0]!.overlap).toBeGreaterThan(out[1]!.overlap);
	});
});

describe("selectRetrievedSkills — K and relevance floor", () => {
	it("respects the default top-K", () => {
		const corpus = Array.from({ length: 6 }, () => skill({}));
		const out = selectRetrievedSkills(corpus, QUERY, { now: NOW });
		expect(out).toHaveLength(SKILL_RETRIEVAL_DEFAULT_TOP_K);
	});

	it("clamps K to the hard ceiling and disables at K=0", () => {
		const corpus = Array.from({ length: 10 }, () => skill({}));
		expect(
			selectRetrievedSkills(corpus, QUERY, { topK: 99, now: NOW }),
		).toHaveLength(SKILL_RETRIEVAL_MAX_TOP_K);
		expect(selectRetrievedSkills(corpus, QUERY, { topK: 0, now: NOW })).toEqual(
			[],
		);
	});

	it("drops skills below the relevance floor", () => {
		const offTopic = skill({
			slug: "off-topic",
			title: "Rotate stale credentials",
			summary: "Rotate the gateway credentials quarterly",
		});
		// One shared significant word ("report") — below the default floor of 2.
		const oneWord = skill({
			slug: "one-word",
			title: "Quarterly finance report",
			summary: "Quarterly finance rollup",
		});
		const out = selectRetrievedSkills([offTopic, oneWord], QUERY, {
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	it("raising the floor excludes weaker matches", () => {
		const strong = skill({ slug: "strong" });
		const weak = skill({
			slug: "weak",
			title: "Email digest",
			summary: "Send an email digest of pricing",
		});
		const loose = selectRetrievedSkills([strong, weak], QUERY, {
			topK: 5,
			minOverlap: 2,
			now: NOW,
		});
		const strict = selectRetrievedSkills([strong, weak], QUERY, {
			topK: 5,
			minOverlap: 4,
			now: NOW,
		});
		expect(loose.length).toBeGreaterThan(strict.length);
		expect(strict.every((m) => m.skill.slug === "strong")).toBe(true);
	});

	it("returns nothing for short queries", () => {
		expect(selectRetrievedSkills([skill({})], "hi", { now: NOW })).toEqual([]);
	});

	it("matches on tags and toolIds (tool-sequence similarity)", () => {
		const mined = skill({
			slug: "mined-routine",
			title: "Mined routine",
			summary: null,
			description: null,
			tags: ["trajectory-mined"],
			toolIds: ["list_invoices", "send_invoice_reminder"],
		});
		const out = selectRetrievedSkills(
			[mined],
			"list the overdue invoices and send an invoice reminder",
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.skill.slug).toBe("mined-routine");
	});
});

describe("recency-weighted success rate", () => {
	it("is 0 with no recorded usage and halves per 14 days", () => {
		expect(
			recencyWeightedSuccessRate(
				{ successCount: 0, failureCount: 0, lastUsedAt: null },
				NOW,
			),
		).toBe(0);
		const fresh = recencyWeightedSuccessRate(
			{
				successCount: 8,
				failureCount: 2,
				lastUsedAt: NOW.toISOString(),
			},
			NOW,
		);
		expect(fresh).toBeCloseTo(0.8, 5);
		const aged = recencyWeightedSuccessRate(
			{
				successCount: 8,
				failureCount: 2,
				lastUsedAt: new Date(NOW.getTime() - 14 * 86_400_000).toISOString(),
			},
			NOW,
		);
		expect(aged).toBeCloseTo(0.4, 5);
	});

	it("breaks overlap+lifecycle ties toward the recently successful skill", () => {
		const recent = skill({
			slug: "recent",
			successCount: 9,
			failureCount: 1,
			lastUsedAt: NOW.toISOString(),
		});
		const dusty = skill({
			slug: "dusty",
			successCount: 9,
			failureCount: 1,
			lastUsedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
		});
		const out = selectRetrievedSkills([dusty, recent], QUERY, {
			topK: 2,
			now: NOW,
		});
		expect(out.map((m) => m.skill.slug)).toEqual(["recent", "dusty"]);
	});
});

describe("serializeRetrievedSkills — shape and token caps", () => {
	it("returns empty string for no matches", () => {
		expect(serializeRetrievedSkills([])).toBe("");
	});

	it("renders title, slug, when-to-use, not-when, and lifecycle", () => {
		const match = selectRetrievedSkills(
			[
				skill({
					slug: "pricing-weekly",
					lifecycleState: "proven",
					successCount: 12,
					failureCount: 1,
					preconditions: { notWhen: ["ad-hoc price checks"] },
					content: "---\ntitle: x\n---\n1. Fetch prices\n2. Send email",
				}),
			],
			QUERY,
			{ now: NOW },
		);
		const block = serializeRetrievedSkills(match);
		expect(block).toContain("## Retrieved Skills (act-time match: 1)");
		expect(block).toContain("skill pricing-weekly [proven, 12ok/1fail]");
		expect(block).toContain("When to use:");
		expect(block).toContain("Not when: ad-hoc price checks");
		expect(block).toContain("1. Fetch prices");
		expect(block).not.toContain("title: x"); // frontmatter stripped
		expect(block).toContain("read_skill");
	});

	it("caps each procedure excerpt at the per-skill token budget", () => {
		const longContent = Array.from(
			{ length: 400 },
			(_, i) => `step ${i}: do a fairly long thing with several words`,
		).join("\n");
		const match = selectRetrievedSkills(
			[skill({ slug: "long", content: longContent })],
			QUERY,
			{
				topK: 1,
				now: NOW,
			},
		);
		const block = serializeRetrievedSkills(match);
		expect(block).toContain("… (truncated");
		// Whole block stays within budget + small structural slack.
		expect(countTokens(block)).toBeLessThanOrEqual(
			SKILL_RETRIEVAL_MAX_SKILL_TOKENS + 120,
		);
	});

	it("enforces the whole-block budget across multiple matches", () => {
		const longContent = Array.from(
			{ length: 400 },
			(_, i) => `step ${i}: do a fairly long thing with several words`,
		).join("\n");
		const matches = selectRetrievedSkills(
			[
				skill({ slug: "a-long", content: longContent }),
				skill({ slug: "b-long", content: longContent }),
				skill({ slug: "c-long", content: longContent }),
			],
			QUERY,
			{ topK: 3, now: NOW },
		);
		expect(matches).toHaveLength(3);
		const block = serializeRetrievedSkills(matches);
		expect(countTokens(block)).toBeLessThanOrEqual(
			SKILL_RETRIEVAL_MAX_BLOCK_TOKENS + 60,
		);
		// First match always survives.
		expect(block).toContain("a-long");
	});

	it("is deterministic for a fixed now", () => {
		const corpus = [
			skill({ slug: "z" }),
			skill({ slug: "a" }),
			skill({ slug: "m" }),
		];
		const first = selectRetrievedSkills(corpus, QUERY, { topK: 3, now: NOW });
		const second = selectRetrievedSkills(corpus, QUERY, { topK: 3, now: NOW });
		expect(first.map((m) => m.skill.slug)).toEqual(
			second.map((m) => m.skill.slug),
		);
		// Full tie on overlap/lifecycle/success → stable slug order.
		expect(first.map((m) => m.skill.slug)).toEqual(["a", "m", "z"]);
	});
});

// ---------------------------------------------------------------------------
// Explicit operator references (composer `/skill <slug>`)
//
// A reference is a STRONGER signal than relevance ranking, fed through this
// same retrieve leg. What must hold: it beats the relevance floor, it does NOT
// beat the lifecycle gate, it shares K and the block budget, and anything that
// does not load is reported rather than silently dropped.
// ---------------------------------------------------------------------------

describe("selectSkillsForTurn — explicit references", () => {
	it("is identical to relevance selection when nothing is referenced", () => {
		const corpus = [skill({}), skill({})];
		const out = selectSkillsForTurn(corpus, QUERY, { now: NOW });
		expect(out.matches).toEqual(
			selectRetrievedSkills(corpus, QUERY, { now: NOW }),
		);
		expect(out.unresolvedReferences).toEqual([]);
	});

	it("injects a referenced skill that the relevance floor would reject", () => {
		const offTopic = skill({
			slug: "rotate-ssl-certs",
			title: "Rotate SSL certificates",
			summary: "Rotate the edge certificates",
		});
		// Proof the floor really does reject it on relevance alone.
		expect(selectRetrievedSkills([offTopic], QUERY, { now: NOW })).toEqual([]);

		const out = selectSkillsForTurn([offTopic], QUERY, {
			referencedSlugs: ["rotate-ssl-certs"],
			now: NOW,
		});
		expect(out.matches).toHaveLength(1);
		expect(out.matches[0]?.skill.slug).toBe("rotate-ssl-certs");
		expect(out.matches[0]?.referenced).toBe(true);
		expect(out.unresolvedReferences).toEqual([]);
	});

	it("injects a reference even when the query is too short to retrieve", () => {
		const target = skill({ slug: "deploy-runbook" });
		expect(selectRetrievedSkills([target], "hi", { now: NOW })).toEqual([]);
		const out = selectSkillsForTurn([target], "hi", {
			referencedSlugs: ["deploy-runbook"],
			now: NOW,
		});
		expect(out.matches.map((m) => m.skill.slug)).toEqual(["deploy-runbook"]);
	});

	it("does NOT let a reference bypass the lifecycle gate", () => {
		const draft = skill({ slug: "half-written", lifecycleState: "draft" });
		const archived = skill({ slug: "retired", lifecycleState: "archived" });
		const out = selectSkillsForTurn([draft, archived], QUERY, {
			referencedSlugs: ["half-written", "retired"],
			now: NOW,
		});
		expect(out.matches).toEqual([]);
		expect(out.unresolvedReferences).toEqual(["half-written", "retired"]);
	});

	it("reports a slug that is not in the corpus, without disabling relevance", () => {
		// A bad reference degrades to ordinary retrieval for the rest of the
		// turn: `real` still ranks in on relevance, unreferenced, and `ghost` is
		// reported so the caller can say it did not load.
		const out = selectSkillsForTurn([skill({ slug: "real" })], QUERY, {
			referencedSlugs: ["ghost"],
			now: NOW,
		});
		expect(out.matches.map((m) => m.skill.slug)).toEqual(["real"]);
		expect(out.matches[0]?.referenced).toBeUndefined();
		expect(out.unresolvedReferences).toEqual(["ghost"]);
	});

	it("ranks references ahead of relevance matches and shares K", () => {
		const referenced = skill({
			slug: "rotate-ssl-certs",
			title: "Rotate SSL certificates",
			summary: "Rotate the edge certificates",
		});
		const relevant = skill({ slug: "pricing-report" });
		const out = selectSkillsForTurn([relevant, referenced], QUERY, {
			referencedSlugs: ["rotate-ssl-certs"],
			topK: 2,
			now: NOW,
		});
		expect(out.matches.map((m) => m.skill.slug)).toEqual([
			"rotate-ssl-certs",
			"pricing-report",
		]);
		expect(out.matches[0]?.referenced).toBe(true);
		expect(out.matches[1]?.referenced).toBeUndefined();
	});

	it("caps references at K and reports the overflow rather than dropping it", () => {
		const corpus = ["a", "b", "c"].map((slug) => skill({ slug }));
		const out = selectSkillsForTurn(corpus, QUERY, {
			referencedSlugs: ["a", "b", "c"],
			topK: 2,
			now: NOW,
		});
		expect(out.matches.map((m) => m.skill.slug)).toEqual(["a", "b"]);
		expect(out.unresolvedReferences).toEqual(["c"]);
	});

	it("never exceeds the shared top-K ceiling", () => {
		const corpus = Array.from({ length: 10 }, (_, i) =>
			skill({ slug: `s${i}` }),
		);
		const out = selectSkillsForTurn(corpus, QUERY, {
			referencedSlugs: corpus.map((s) => s.slug as string),
			topK: 99,
			now: NOW,
		});
		expect(out.matches).toHaveLength(SKILL_RETRIEVAL_MAX_TOP_K);
	});
});

describe("serializeRetrievedSkills — references and legible degradation", () => {
	it("marks operator-referenced skills and tells the model to follow them", () => {
		const out = selectSkillsForTurn(
			[skill({ slug: "deploy-runbook", content: "1. build\n2. ship" })],
			QUERY,
			{ referencedSlugs: ["deploy-runbook"], now: NOW },
		);
		const block = serializeRetrievedSkills(out.matches);
		expect(block).toContain("[operator-referenced]");
		expect(block).toContain("The operator explicitly named");
		expect(block).toContain("1. build");
	});

	it("says nothing about references when none were made", () => {
		const matches = selectRetrievedSkills([skill({})], QUERY, { now: NOW });
		const block = serializeRetrievedSkills(matches);
		expect(block).not.toContain("[operator-referenced]");
		expect(block).not.toContain("The operator explicitly named");
	});

	it("renders an unresolved reference as an explicit instruction to say so", () => {
		const block = serializeRetrievedSkills([], {
			unresolvedReferences: ["ghost"],
		});
		expect(block).toContain("Unresolved Skill References");
		expect(block).toContain("`ghost`");
		expect(block).toContain("Tell the operator plainly");
		// No skills loaded, so no "Retrieved Skills" header claiming a match.
		expect(block).not.toContain("act-time match");
	});

	it("still returns nothing when there is neither a match nor a reference", () => {
		expect(serializeRetrievedSkills([])).toBe("");
		expect(serializeRetrievedSkills([], { unresolvedReferences: [] })).toBe("");
	});

	it("reports a reference the block budget pushed out instead of losing it", () => {
		const big = "x ".repeat(4000);
		const out = selectSkillsForTurn(
			[
				skill({ slug: "first", content: big }),
				skill({ slug: "second", content: big }),
			],
			QUERY,
			{ referencedSlugs: ["first", "second"], topK: 2, now: NOW },
		);
		expect(out.matches).toHaveLength(2);
		const block = serializeRetrievedSkills(out.matches, {
			maxBlockTokens: 400,
			maxSkillTokens: 320,
		});
		expect(block).toContain("skill first");
		expect(block).not.toContain("skill second");
		expect(block).toContain("Unresolved Skill References");
		expect(block).toContain("`second`");
	});
});

it("expands eligible candidates without raising the original prompt top-K ceiling", () => {
	const skills = Array.from({ length: 8 }, (_, i) => ({
		id: `candidate-${i}`,
		title: "Accounting invoice review",
		lifecycleState: i === 7 ? "draft" : "active",
	}));
	expect(
		selectRetrievedSkillCandidates(skills, "Accounting invoice review", {
			topK: 40,
		}),
	).toHaveLength(7);
	expect(
		selectRetrievedSkills(skills, "Accounting invoice review", { topK: 40 }),
	).toHaveLength(5);
});
