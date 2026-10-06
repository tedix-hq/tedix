/**
 * Offline assertions for the act-time skill-retrieval corpus (AWM/Memp
 * "retrieve" leg — DO-side half).
 *
 * Tests:
 * 1. buildRetrievalCorpus — lifecycle gating (never drafts), org-scoped rows
 *    kept (localness fix), content capping, corpus size cap.
 * 2. DoSkillRetrievalCorpusStore — save/load round-trip (in-memory SQL runner).
 * 3. parseSkillRetrievalKnobs — defaults, clamps, kill switch.
 *
 * Run directly: `bun run src/skill-retrieval-corpus.test.ts`.
 * No vitest/cloudflare:workers harness needed — fully offline.
 */
import assert from "node:assert/strict";
import type { SkillSearchEntry } from "./brain/platform-client";
import {
	SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP,
	SKILL_RETRIEVAL_DEFAULT_TOP_K,
	SKILL_RETRIEVAL_MAX_TOP_K,
} from "@tedix/context-core/skill-retrieval";
import {
	buildRetrievalCorpus,
	DoSkillRetrievalCorpusStore,
	SKILL_RETRIEVAL_CORPUS_MAX_CONTENT_CHARS,
	SKILL_RETRIEVAL_CORPUS_MAX_SKILLS,
	parseSkillRetrievalKnobs,
} from "./skill-retrieval-corpus-store-do";

// ── 1. buildRetrievalCorpus

function entry(overrides: Partial<SkillSearchEntry>): SkillSearchEntry {
	return {
		id: crypto.randomUUID(),
		title: "Weekly report",
		slug: "weekly-report",
		summary: "Compile the weekly report",
		lifecycleState: "active",
		...overrides,
	};
}

{
	const corpus = buildRetrievalCorpus([
		entry({ lifecycleState: "draft", slug: "a-draft" }),
		entry({ lifecycleState: "active", slug: "b-active" }),
		entry({ lifecycleState: "proven", slug: "c-proven" }),
		entry({ lifecycleState: "crystallized", slug: "d-crystallized" }),
		entry({ lifecycleState: "stale", slug: "e-stale" }),
		entry({ lifecycleState: "archived", slug: "f-archived" }),
		entry({ lifecycleState: null, slug: "g-null" }),
	]);
	assert.deepEqual(
		corpus.map((s) => s.slug).sort(),
		["b-active", "c-proven", "d-crystallized"],
		"only execute-to-promote lifecycles enter the corpus — never drafts",
	);
	console.log("PASS: corpus lifecycle gating");
}

{
	// Org-scoped mined workflows (tediId null) MUST be kept — the guidance
	// block's tedi-owned filter is exactly the localness pathology this fixes.
	const orgScoped = entry({
		slug: "org-mined",
		tediId: null,
		lifecycleState: "proven",
		toolIds: ["list_invoices", "send_reminder"],
	});
	const corpus = buildRetrievalCorpus([orgScoped]);
	assert.equal(
		corpus.length,
		1,
		"org-scoped (tediId null) rows are retrievable",
	);
	assert.deepEqual(corpus[0]!.toolIds, ["list_invoices", "send_reminder"]);
	console.log("PASS: org-scoped mined workflows enter the corpus");
}

{
	const long = "x".repeat(SKILL_RETRIEVAL_CORPUS_MAX_CONTENT_CHARS * 3);
	const corpus = buildRetrievalCorpus([entry({ content: long })]);
	assert.equal(
		corpus[0]!.content!.length,
		SKILL_RETRIEVAL_CORPUS_MAX_CONTENT_CHARS,
		"stored content is capped",
	);
	console.log("PASS: corpus content cap");
}

{
	const many = Array.from(
		{ length: SKILL_RETRIEVAL_CORPUS_MAX_SKILLS + 20 },
		() => entry({}),
	);
	assert.equal(
		buildRetrievalCorpus(many).length,
		SKILL_RETRIEVAL_CORPUS_MAX_SKILLS,
		"corpus size is capped",
	);
	console.log("PASS: corpus size cap");
}

// ── 2. Store save / load (mirrors the skill-guidance store test harness)

interface Row {
	[key: string]: string | number | boolean | null;
}

function makeSqlRunner() {
	const tables = new Map<string, Row[]>();

	function sql<T = Row>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[] {
		const query = strings.raw.join("?").trim();

		if (query.startsWith("CREATE TABLE")) {
			const match = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
			if (match) tables.set(match[1]!, tables.get(match[1]!) ?? []);
			return [] as unknown as T[];
		}

		if (query.startsWith("INSERT INTO skill_retrieval_corpus")) {
			const table = tables.get("skill_retrieval_corpus") ?? [];
			const [id, corpus_json, updated_at] = values as [string, string, number];
			const existing = table.findIndex((r) => r.id === id);
			if (existing >= 0) {
				table[existing] = { id, corpus_json, updated_at };
			} else {
				table.push({ id, corpus_json, updated_at });
			}
			tables.set("skill_retrieval_corpus", table);
			return [] as unknown as T[];
		}

		if (
			query.startsWith(
				"SELECT corpus_json, updated_at FROM skill_retrieval_corpus",
			)
		) {
			const [idVal] = values;
			const table = tables.get("skill_retrieval_corpus") ?? [];
			return table.filter((r) => r.id === idVal) as unknown as T[];
		}

		return [] as unknown as T[];
	}

	return { sql };
}

{
	const store = new DoSkillRetrievalCorpusStore(makeSqlRunner());
	assert.equal(store.load(), null, "empty store returns null");
}

{
	const store = new DoSkillRetrievalCorpusStore(makeSqlRunner());
	const corpus = buildRetrievalCorpus([
		entry({ slug: "one", lifecycleState: "proven" }),
		entry({ slug: "two", lifecycleState: "active" }),
	]);
	store.save(corpus);
	const loaded = store.load();
	assert.ok(loaded !== null, "loaded should not be null after save");
	assert.deepEqual(
		loaded.skills.map((s) => s.slug),
		["one", "two"],
		"round-trip: skills match",
	);
	assert.ok(loaded.updatedAt > 0, "updatedAt is stamped");
	store.save([]);
	assert.deepEqual(
		store.load()?.skills,
		[],
		"overwrite replaces the corpus (empty corpus is a valid no-skills state)",
	);
	console.log("PASS: corpus store round-trip");
}

// ── 3. Knob parsing (Worker vars surface)

{
	assert.deepEqual(
		parseSkillRetrievalKnobs({}),
		{
			topK: SKILL_RETRIEVAL_DEFAULT_TOP_K,
			minOverlap: SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP,
		},
		"unset vars → defaults",
	);
	assert.deepEqual(
		parseSkillRetrievalKnobs({
			TEDI_SKILL_RETRIEVAL_TOP_K: "3",
			TEDI_SKILL_RETRIEVAL_MIN_OVERLAP: "4",
		}),
		{ topK: 3, minOverlap: 4 },
		"explicit vars parse",
	);
	assert.equal(
		parseSkillRetrievalKnobs({ TEDI_SKILL_RETRIEVAL_TOP_K: "99" }).topK,
		SKILL_RETRIEVAL_MAX_TOP_K,
		"K clamps to the hard ceiling",
	);
	assert.equal(
		parseSkillRetrievalKnobs({ TEDI_SKILL_RETRIEVAL_TOP_K: "0" }).topK,
		0,
		"K=0 is the kill switch",
	);
	assert.equal(
		parseSkillRetrievalKnobs({ TEDI_SKILL_RETRIEVAL_MIN_OVERLAP: "-2" })
			.minOverlap,
		1,
		"floor clamps to ≥ 1",
	);
	assert.deepEqual(
		parseSkillRetrievalKnobs({
			TEDI_SKILL_RETRIEVAL_TOP_K: "banana",
			TEDI_SKILL_RETRIEVAL_MIN_OVERLAP: "",
		}),
		{
			topK: SKILL_RETRIEVAL_DEFAULT_TOP_K,
			minOverlap: SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP,
		},
		"unparseable vars fall back to defaults (fail-soft)",
	);
	console.log("PASS: knob parsing defaults, clamps, kill switch");
}

console.log("skill-retrieval-corpus.test.ts: all assertions passed");
