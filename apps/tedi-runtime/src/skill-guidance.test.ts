/**
 * Offline assertions for skill-guidance surfacing on the isolate tedi.
 *
 * Tests:
 * 1. DoSkillGuidanceStore — save/load behaviour (in-memory SQL runner).
 * 3. Prompt block formatting — the compact guidance text shape produced by
 *    buildAndCacheSkillGuidance (tested by reproducing the logic inline).
 * 4. read_skill ChatToolSpec shape — registration contract.
 * 5. SkillGuidanceTurnGate — per-turn freshness: cached block served without a
 *    blocking round trip, refresh behind the turn, bounded negative cache.
 *
 * Run directly: `bun run src/skill-guidance.test.ts`.
 * No vitest/cloudflare:workers harness needed — fully offline.
 */
import assert from "node:assert/strict";
import {
	DoSkillGuidanceStore,
	SKILL_GUIDANCE_EMPTY_TTL_MS,
	SKILL_GUIDANCE_MAX_ENTRIES,
	SkillGuidanceTurnGate,
	selectGuidanceSkills,
} from "./skill-guidance-store-do";

// ── Minimal in-memory SQL runner (mirrors the test harness in other store tests)

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

		if (query.startsWith("INSERT INTO skill_guidance")) {
			const table = tables.get("skill_guidance") ?? [];
			const [id, guidance_text, updated_at] = values as [
				string,
				string,
				number,
			];
			const existing = table.findIndex((r) => r.id === id);
			if (existing >= 0) {
				table[existing] = { id, guidance_text, updated_at };
			} else {
				table.push({ id, guidance_text, updated_at });
			}
			tables.set("skill_guidance", table);
			return [] as unknown as T[];
		}

		if (
			query.startsWith("SELECT guidance_text, updated_at FROM skill_guidance")
		) {
			const [idVal] = values;
			const table = tables.get("skill_guidance") ?? [];
			return table.filter((r) => r.id === idVal) as unknown as T[];
		}

		return [] as unknown as T[];
	}

	return { sql };
}

// ── 1. Store save / load

{
	const runner = makeSqlRunner();
	const store = new DoSkillGuidanceStore(runner);
	assert.equal(store.load(), null, "empty store returns null");
}

{
	const runner = makeSqlRunner();
	const store = new DoSkillGuidanceStore(runner);
	const text =
		"You have 2 platform skill(s) available. Use `read_skill` to load.\n- skill retail-domain-policy: retail policy.\n- skill git-workflow: git flow.";
	store.save(text);
	const loaded = store.load();
	assert.ok(loaded !== null, "loaded should not be null after save");
	assert.equal(loaded.text, text, "round-trip: text matches");
	assert.ok(
		typeof loaded.updatedAt === "number" && loaded.updatedAt > 0,
		"updatedAt should be a positive number",
	);
}

{
	const runner = makeSqlRunner();
	const store = new DoSkillGuidanceStore(runner);
	store.save("first version");
	store.save("second version");
	const loaded = store.load();
	assert.ok(loaded !== null);
	assert.equal(
		loaded.text,
		"second version",
		"overwrite replaces previous value",
	);
}

{
	// Idempotent schema creation
	const runner = makeSqlRunner();
	const store = new DoSkillGuidanceStore(runner);
	assert.equal(store.load(), null, "first load: no throw");
	assert.equal(store.load(), null, "second load: no throw");
	store.save("text");
	assert.equal(store.load()?.text, "text", "load after save");
}

// ── 3. Prompt block format

/**
 * Reproduce the guidance text formatting logic from buildAndCacheSkillGuidance
 * so we can validate it offline without instantiating the DO.
 */
function buildGuidanceTextFromEntries(
	entries: Array<{
		id: string;
		slug?: string | null;
		title: string;
		summary?: string | null;
		description?: string | null;
		lifecycleState?: string | null;
	}>,
): string {
	if (entries.length === 0) return "";
	const lines: string[] = [
		`You have ${entries.length} platform skill(s) available. Use \`read_skill\` to load the full procedure for any skill listed below before following it.`,
	];
	for (const entry of entries) {
		const slug = entry.slug ?? entry.id;
		const summary = entry.summary ?? entry.description ?? "(no summary)";
		const state = entry.lifecycleState ? ` [${entry.lifecycleState}]` : "";
		lines.push(`- skill ${slug}: ${summary}${state}`);
	}
	return lines.join("\n");
}

{
	const text = buildGuidanceTextFromEntries([
		{
			id: "id-1",
			slug: "retail-domain-policy",
			title: "Retail Domain Policy",
			summary: "Retail policy procedure.",
		},
		{
			id: "id-2",
			slug: "git-workflow",
			title: "Git Workflow",
			summary: "Standard git flow.",
		},
	]);
	assert.ok(
		text.startsWith("You have 2 platform skill(s) available."),
		"header mentions count",
	);
	assert.ok(text.includes("read_skill"), "header mentions read_skill");
}

{
	const text = buildGuidanceTextFromEntries([
		{
			id: "id-1",
			slug: "retail-domain-policy",
			title: "Retail Domain Policy",
			summary: "Retail policy.",
		},
	]);
	const lines = text.split("\n");
	assert.equal(lines.length, 2, "one header line + one skill line");
	assert.ok(
		lines[1]!.startsWith("- skill retail-domain-policy:"),
		"skill line: '- skill <slug>:'",
	);
	assert.ok(
		lines[1]!.includes("Retail policy."),
		"skill line includes summary",
	);
}

{
	const text = buildGuidanceTextFromEntries([
		{
			id: "uuid-abc",
			slug: null,
			title: "No Slug Skill",
			summary: "A skill without a slug.",
		},
	]);
	assert.ok(
		text.includes("- skill uuid-abc:"),
		"falls back to id when slug is null",
	);
}

{
	const text = buildGuidanceTextFromEntries([
		{
			id: "id-1",
			slug: "proven-skill",
			title: "Proven",
			summary: "A proven skill.",
			lifecycleState: "proven",
		},
	]);
	assert.ok(text.includes("[proven]"), "includes lifecycleState");
}

{
	const text = buildGuidanceTextFromEntries([]);
	assert.equal(text, "", "empty entries produces empty string");
}

// ── 4. read_skill ChatToolSpec shape

function makeReadSkillSpec() {
	return {
		type: "function" as const,
		function: {
			name: "read_skill",
			description:
				"Read the full content (SKILL.md procedure + metadata) for one of your platform skills by slug or id. " +
				"Use this after reviewing the skill summaries in your system prompt to load the procedure you need before following it. " +
				"Returns the skill body, frontmatter, tags, and lifecycle state.",
			parameters: {
				type: "object",
				properties: {
					slug: {
						type: "string",
						description: "Skill slug (preferred, from the guidance summary)",
					},
					id: {
						type: "string",
						description: "Skill UUID (alternative to slug)",
					},
				},
				additionalProperties: false,
			},
		},
	};
}

{
	const spec = makeReadSkillSpec();
	assert.equal(spec.function.name, "read_skill", "name is 'read_skill'");
}

{
	const spec = makeReadSkillSpec();
	const props = spec.function.parameters.properties as Record<
		string,
		{ type: string; description: string }
	>;
	assert.ok("slug" in props, "has slug parameter");
	assert.ok("id" in props, "has id parameter");
}

{
	const spec = makeReadSkillSpec();
	const params = spec.function.parameters as { required?: string[] };
	assert.ok(
		!params.required || params.required.length === 0,
		"no required parameters (both slug and id are optional)",
	);
}

// ── selectGuidanceSkills: which skills the wall may advertise.
// Driven directly rather than reproduced inline, so the rules cannot drift
// away from the DO the way the prompt-shape assertions above can.

const OWNER = "tedi-owner";
const other = { tediId: "tedi-other", lifecycleState: "active" };

{
	// The regression this exists for: `skills/listByOrg` with a tediId defaults
	// to `ne(lifecycleState, "draft")`, which lets ARCHIVED and STALE through.
	// A production tedi's only advertised skill was an archived one, while its
	// retrieval corpus was empty — steered at a dead skill and nothing else.
	const picked = selectGuidanceSkills(
		[
			{ tediId: OWNER, lifecycleState: "archived" },
			{ tediId: OWNER, lifecycleState: "stale" },
			{ tediId: OWNER, lifecycleState: "draft" },
		],
		OWNER,
	);
	assert.equal(picked.length, 0, "archived/stale/draft are never advertised");
}

{
	const picked = selectGuidanceSkills(
		[
			{ tediId: OWNER, lifecycleState: "active" },
			{ tediId: OWNER, lifecycleState: "proven" },
			{ tediId: OWNER, lifecycleState: "crystallized" },
		],
		OWNER,
	);
	assert.equal(picked.length, 3, "active/proven/crystallized are advertised");
}

{
	// Unscoped org catalogs measurably degraded task performance (12/12 -> 1/4).
	const picked = selectGuidanceSkills(
		[{ tediId: OWNER, lifecycleState: "active" }, other],
		OWNER,
	);
	assert.equal(picked.length, 1, "only tedi-owned skills are advertised");
	assert.equal(
		picked[0]!.tediId,
		OWNER,
		"the surviving entry is the owned one",
	);
}

{
	const many = Array.from({ length: SKILL_GUIDANCE_MAX_ENTRIES + 5 }, () => ({
		tediId: OWNER,
		lifecycleState: "active",
	}));
	assert.equal(
		selectGuidanceSkills(many, OWNER).length,
		SKILL_GUIDANCE_MAX_ENTRIES,
		"advertised set stays hard-capped",
	);
}

{
	const picked = selectGuidanceSkills(
		[{ tediId: OWNER, lifecycleState: null }, { tediId: OWNER }],
		OWNER,
	);
	assert.equal(picked.length, 0, "missing lifecycle is not injectable");
}

// ── 5. Per-turn freshness gate
//
// The catalog used to refresh only on the 4-hour scheduled task, so a skill a
// tedi recorded could be invisible to it for four hours. The gate makes the
// refresh per-turn without putting a blocking platform round trip in front of
// every turn.

/** Drive the gate deterministically: controllable clock and drained background. */
function makeGateHarness(catalog: { text: string }) {
	const background: Promise<unknown>[] = [];
	let builds = 0;
	let nowMs = 1_000;
	const gate = new SkillGuidanceTurnGate({
		build: async () => {
			builds += 1;
			return catalog.text;
		},
		background: (task) => {
			background.push(task);
		},
		now: () => nowMs,
	});
	return {
		gate,
		buildCount: () => builds,
		advance: (ms: number) => {
			nowMs += ms;
		},
		/** Settle every refresh started behind a turn. */
		drain: async () => {
			await Promise.all(background.splice(0));
		},
	};
}

{
	// A skill recorded DURING a session is visible on the next turn: the turn
	// that recorded it still serves the old block (it must not block), the
	// refresh runs behind that turn, and the following turn sees the new skill.
	const catalog = { text: "- skill alpha: first" };
	const h = makeGateHarness(catalog);

	// Cold cache → one blocking build, exactly as before.
	const turn1 = await h.gate.textForTurn("");
	assert.equal(turn1, "- skill alpha: first", "cold cache builds blocking");
	assert.equal(h.buildCount(), 1, "cold start costs exactly one build");

	// Turn 2 records a new skill mid-turn; the block it was handed is the cached
	// one and the turn paid nothing for it.
	const turn2 = await h.gate.textForTurn(catalog.text);
	assert.equal(turn2, "- skill alpha: first", "warm cache serves immediately");
	catalog.text = "- skill alpha: first\n- skill beta: recorded this session";
	await h.drain();

	// Turn 3 — the next turn — sees it. Four hours earlier than the old clock.
	const turn3 = await h.gate.textForTurn(catalog.text);
	assert.match(
		turn3,
		/skill beta/,
		"a skill recorded in-session lands next turn",
	);
}

{
	// Cost guard: a warm turn never waits on the platform, and turns that land
	// while a refresh is still in flight do not each start another one.
	let builds = 0;
	const pending: Array<(text: string) => void> = [];
	const gate = new SkillGuidanceTurnGate({
		build: () => {
			builds += 1;
			return new Promise<string>((resolve) => {
				pending.push(resolve);
			});
		},
		background: () => {},
	});
	const cached = "- skill alpha: first";
	// Each of these resolves without awaiting the (still pending) refresh — that
	// is the whole cost argument for doing this per turn.
	assert.equal(
		await gate.textForTurn(cached),
		cached,
		"warm turn does not block",
	);
	assert.equal(
		await gate.textForTurn(cached),
		cached,
		"warm turn does not block",
	);
	assert.equal(
		await gate.textForTurn(cached),
		cached,
		"warm turn does not block",
	);
	assert.equal(builds, 1, "turns overlapping one refresh share it");
	for (const resolve of pending.splice(0)) resolve("- skill alpha: first");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(
		await gate.textForTurn(cached),
		cached,
		"warm turn does not block",
	);
	assert.equal(builds, 2, "a settled refresh lets the next turn start one");
}

{
	// Negative cache: an empty catalog must not cost a lookup every turn. This
	// is strictly cheaper than the previous code, where an empty (falsy) block
	// re-ran the full build on every single turn.
	const h = makeGateHarness({ text: "" });
	assert.equal(
		await h.gate.textForTurn(""),
		"",
		"empty catalog yields no block",
	);
	assert.equal(h.buildCount(), 1, "the empty verdict costs one lookup");
	assert.equal(await h.gate.textForTurn(""), "", "still empty");
	assert.equal(await h.gate.textForTurn(""), "", "still empty");
	assert.equal(
		h.buildCount(),
		1,
		"later turns are served from the negative cache",
	);

	// Bounded, not permanent — the young tedi's FIRST skill must not wait for a
	// DO eviction.
	h.advance(SKILL_GUIDANCE_EMPTY_TTL_MS + 1);
	assert.equal(await h.gate.textForTurn(""), "", "negative cache expires");
	assert.equal(
		h.buildCount(),
		2,
		"an expired negative cache pays for one lookup",
	);
}

{
	// A failing platform read degrades to the cached block; it never throws into
	// the turn and never poisons the cache.
	const gate = new SkillGuidanceTurnGate({
		build: async () => {
			throw new Error("platform down");
		},
		background: () => {},
	});
	assert.equal(
		await gate.textForTurn("- skill alpha: first"),
		"- skill alpha: first",
	);
	assert.equal(
		await gate.textForTurn(""),
		"",
		"a failed cold build yields no block",
	);
}

assert.equal(
	SKILL_GUIDANCE_EMPTY_TTL_MS,
	10 * 60 * 1000,
	"SKILL_GUIDANCE_EMPTY_TTL_MS is 10 minutes",
);

console.log("skill-guidance.test.ts: all assertions passed");
