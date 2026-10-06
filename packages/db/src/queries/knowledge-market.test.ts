import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	buildKnowledgeMarketReport,
	deriveFactCitationLinks,
	getKnowledgeMarketReport,
	KNOWLEDGE_MARKET_FACT_ID_CHUNK,
	KNOWLEDGE_MARKET_FLOW_GROUP_CAP,
	LOCALNESS_MIN_EXECUTIONS,
	type SkillFlowRow,
	safeExtractFactIds,
} from "./knowledge-market";

const ORG = "org-1";
const A = "tedi-a";
const B = "tedi-b";
const C = "tedi-c";

function baseInput(overrides: {
	flows?: SkillFlowRow[];
	repute?: Parameters<typeof buildKnowledgeMarketReport>[0]["repute"];
	commons?: Parameters<typeof buildKnowledgeMarketReport>[0]["commons"];
	ownership?: Parameters<typeof buildKnowledgeMarketReport>[0]["ownership"];
	factCitations?: Parameters<
		typeof buildKnowledgeMarketReport
	>[0]["factCitations"];
	truncation?: Parameters<typeof buildKnowledgeMarketReport>[0]["truncation"];
}) {
	return {
		orgId: ORG,
		windowDays: 14,
		since: "2026-07-02T00:00:00.000Z",
		generatedAt: "2026-07-16T00:00:00.000Z",
		flows: overrides.flows ?? [],
		repute: overrides.repute ?? [],
		commons: overrides.commons ?? {
			totalCommonsSkills: 0,
			usedCommonsSkills: 0,
		},
		ownership: overrides.ownership ?? [],
		factCitations: overrides.factCitations ?? [],
		truncation: overrides.truncation,
	};
}

function flow(
	userTediId: string | null,
	ownerTediId: string | null,
	executions: number,
	distinctSkills = 1,
): SkillFlowRow {
	return { userTediId, ownerTediId, executions, distinctSkills };
}

describe("repute (sellers with market reputation)", () => {
	it("counts only cross-use, never self-use", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [
					flow(A, A, 10), // self-use — no repute
					flow(B, A, 4, 2), // B uses A's skills — repute for A
				],
				repute: [
					{
						ownerTediId: A,
						skillsUsedByOthers: 2,
						executionsByOthers: 4,
						distinctConsumers: 1,
					},
				],
			}),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		const b = report.tedis.find((tedi) => tedi.tediId === B);
		expect(a?.repute).toMatchObject({
			skillsUsedByOthers: 2,
			executionsByOthers: 4,
			distinctConsumers: 1,
		});
		expect(b?.repute).toMatchObject({
			skillsUsedByOthers: 0,
			executionsByOthers: 0,
			distinctConsumers: 0,
		});
	});

	it("derives fact-citation repute cross-tedi only; commons facts have no seller", () => {
		const links = deriveFactCitationLinks(
			[
				{ tediId: B, evidence: { factIds: ["f1", "f2", "f-unknown"] } },
				{ tediId: A, evidence: { factIds: ["f1"] } }, // A citing its own fact
			],
			new Map<string, string | null>([
				["f1", A],
				["f2", null], // org-scoped fact = commons
			]),
		);
		// Unresolvable f-unknown is dropped, never guessed.
		expect(links).toHaveLength(3);

		const report = buildKnowledgeMarketReport(
			baseInput({ factCitations: links }),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		// Only B's citation of A's fact counts: self-citation and the commons
		// fact are excluded.
		expect(a?.repute.factCitationsByOthers).toBe(1);
		expect(a?.repute.distinctFactCiters).toBe(1);
	});
});

describe("reciprocity (price system)", () => {
	it("computes given/received/balance from directional pair flows", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [
					flow(B, A, 6), // A sells 6 to B
					flow(A, B, 2), // A buys 2 from B
				],
			}),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		const b = report.tedis.find((tedi) => tedi.tediId === B);
		expect(a?.reciprocity).toMatchObject({ given: 6, received: 2 });
		expect(a?.reciprocity.balance).toBe(0.5); // (6-2)/8
		expect(b?.reciprocity).toMatchObject({ given: 2, received: 6 });
		expect(b?.reciprocity.balance).toBe(-0.5);
		expect(a?.reciprocity.flag).toBe("balanced");
	});

	it("flags heavy one-way flows as all_sell / all_buy above the volume floor", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({ flows: [flow(B, A, 10)] }),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		const b = report.tedis.find((tedi) => tedi.tediId === B);
		expect(a?.reciprocity.flag).toBe("all_sell");
		expect(a?.reciprocity.balance).toBe(1);
		expect(b?.reciprocity.flag).toBe("all_buy");
		expect(b?.reciprocity.balance).toBe(-1);
	});

	it("does not flag one-way below the volume floor and marks no-flow tedis inactive", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(B, A, 2), flow(C, C, 5)],
			}),
		);
		expect(
			report.tedis.find((tedi) => tedi.tediId === A)?.reciprocity.flag,
		).toBe("balanced");
		expect(
			report.tedis.find((tedi) => tedi.tediId === C)?.reciprocity.flag,
		).toBe("inactive");
	});

	it("reports directional pair flows with one-way flags", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(B, A, 5, 2), flow(A, B, 1)],
			}),
		);
		expect(report.orgRollup.pairFlows).toEqual([
			{
				ownerTediId: A,
				userTediId: B,
				executions: 5,
				distinctSkills: 2,
				oneWay: false, // reverse flow exists
			},
			{
				ownerTediId: B,
				userTediId: A,
				executions: 1,
				distinctSkills: 1,
				oneWay: false, // below PAIR_ONE_WAY_MIN_FLOW
			},
		]);

		const oneWay = buildKnowledgeMarketReport(
			baseInput({ flows: [flow(B, A, 5)] }),
		);
		expect(oneWay.orgRollup.pairFlows[0]?.oneWay).toBe(true);
	});
});

describe("localness pathology", () => {
	it("flags high self-share with zero commons-share above the execution floor", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(A, A, 8), flow(A, B, 2)], // self 0.8, commons 0, peer 0.2
			}),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		expect(a?.localness).toMatchObject({
			selfShare: 0.8,
			commonsShare: 0,
			peerShare: 0.2,
			flag: true,
		});
	});

	it("does not flag when commons are used or self-share is below threshold", () => {
		const commonsUser = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(A, A, 8), flow(A, null, 2)],
			}),
		);
		expect(
			commonsUser.tedis.find((tedi) => tedi.tediId === A)?.localness.flag,
		).toBe(false);

		const lowSelf = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(A, A, 5), flow(A, B, 5)],
			}),
		);
		expect(
			lowSelf.tedis.find((tedi) => tedi.tediId === A)?.localness.flag,
		).toBe(false);
	});

	it("does not flag below the minimum-executions noise floor", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(A, A, LOCALNESS_MIN_EXECUTIONS - 1)],
			}),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		expect(a?.localness.selfShare).toBe(1);
		expect(a?.localness.flag).toBe(false);
	});

	it("computes commons utilization and dead commons inventory", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				commons: { totalCommonsSkills: 10, usedCommonsSkills: 3 },
			}),
		);
		expect(report.orgRollup.commonsUtilization).toBe(0.3);
		expect(report.orgRollup.commons).toEqual({
			totalSkills: 10,
			usedSkills: 3,
			deadSkills: 7,
		});
	});

	it("returns null shares/utilization instead of fabricating zeros", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({ ownership: [{ tediId: A, ownedSkills: 2 }] }),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		expect(a?.localness.selfShare).toBeNull();
		expect(report.orgRollup.commonsUtilization).toBeNull();
		expect(report.orgRollup.crossUseShare).toBeNull();
	});
});

describe("isolate detection (hoarding / artificial-scarcity proxy)", () => {
	it("flags a tedi with no consumers and no outside use as an isolate", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [
					flow(A, A, 6), // A only uses its own skills
					flow(B, C, 3), // B and C trade
					flow(C, B, 2),
				],
			}),
		);
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		expect(a?.isolate).toBe(true);
		expect(report.orgRollup.isolates).toEqual([A]);
		expect(report.tedis.find((tedi) => tedi.tediId === B)?.isolate).toBe(false);
	});

	it("flags a tedi with dead inventory and no market activity", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({ ownership: [{ tediId: A, ownedSkills: 4 }] }),
		);
		expect(report.orgRollup.isolates).toEqual([A]);
	});

	it("clears the isolate flag on any cross flow in either direction", () => {
		const buying = buildKnowledgeMarketReport(
			baseInput({ flows: [flow(A, null, 1)] }), // commons use = participation
		);
		expect(buying.orgRollup.isolates).toEqual([]);

		const selling = buildKnowledgeMarketReport(
			baseInput({
				flows: [flow(B, A, 1)],
				repute: [
					{
						ownerTediId: A,
						skillsUsedByOthers: 1,
						executionsByOthers: 1,
						distinctConsumers: 1,
					},
				],
			}),
		);
		expect(selling.orgRollup.isolates).toEqual([]);
	});
});

describe("org rollup + caveats", () => {
	it("computes cross-use share over tedi-actor executions and keeps non-tedi actors out of the market", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [
					flow(A, A, 5),
					flow(A, B, 3),
					flow(A, null, 2),
					flow(null, A, 4), // human/org-level report — org total only
				],
			}),
		);
		expect(report.orgRollup.totalSkillExecutions).toBe(14);
		expect(report.orgRollup.tediActorExecutions).toBe(10);
		expect(report.orgRollup.crossUseShare).toBe(0.5); // (3 peer + 2 commons) / 10
		// The null actor never appears as a market participant.
		expect(report.tedis.map((tedi) => tedi.tediId)).toEqual([A, B]);
	});

	it("always carries the honest provenance caveats and appends truncation caveats", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({ truncation: { flows: true, factDecisions: true } }),
		);
		expect(
			report.caveats.some((caveat) => caveat.includes("memory_facts.tedi_id")),
		).toBe(true);
		expect(
			report.caveats.some((caveat) =>
				caveat.includes(`${KNOWLEDGE_MARKET_FLOW_GROUP_CAP} (user, owner)`),
			),
		).toBe(true);
		expect(
			report.caveats.some((caveat) => caveat.includes("Fact-citation scan")),
		).toBe(true);
	});
});

// ============================================================================
// Query bounds and malformed-evidence tolerance
// ============================================================================

describe("D1 bound-parameter budget", () => {
	it("keeps every producer-resolution query under D1's 100-bound-params limit", () => {
		// D1 caps each query at 100 bound parameters. A fact-id chunk must leave
		// room for the organizationId parameter.
		expect(KNOWLEDGE_MARKET_FACT_ID_CHUNK + 1).toBeLessThanOrEqual(100);
	});
});

describe("safeExtractFactIds (malformed and hostile evidence)", () => {
	it("returns [] for non-JSON text, malformed JSON, null, and scalars", () => {
		expect(
			safeExtractFactIds('checked notes mentioning "factIds" only'),
		).toEqual([]);
		expect(safeExtractFactIds('{"factIds": ["f1", ')).toEqual([]);
		expect(safeExtractFactIds(null)).toEqual([]);
		expect(safeExtractFactIds(undefined)).toEqual([]);
		expect(safeExtractFactIds(42)).toEqual([]);
	});

	it("discards double-encoded JSON safely and drops non-string id entries", () => {
		// The extractor does not unwrap double-encoded JSON (outer parse yields
		// a string, not a record) — the contract here is "no ids, no throw".
		expect(
			safeExtractFactIds(JSON.stringify(JSON.stringify({ factIds: ["f1"] }))),
		).toEqual([]);
		expect(
			safeExtractFactIds({ factIds: ["f1", 7, null, "", { nested: true }] }),
		).toEqual(["f1"]);
	});

	it("never throws, even when evidence property access itself throws", () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error("hostile evidence");
				},
				get: () => {
					throw new Error("hostile evidence");
				},
			},
		);
		expect(safeExtractFactIds(hostile)).toEqual([]);
		expect(
			deriveFactCitationLinks(
				[{ tediId: A, evidence: hostile }],
				new Map([["f1", B]]),
			),
		).toEqual([]);
	});
});

describe("builder tolerance of raw D1 row shapes", () => {
	it("tolerates null aggregates, null user AND owner rows, and undefined ids without NaN", () => {
		const report = buildKnowledgeMarketReport(
			baseInput({
				flows: [
					// Hostile: both ids null (commons skill used by a human reporter).
					flow(null, null, 3),
					// Hostile: null aggregate values sneaking through the driver.
					{
						userTediId: A,
						ownerTediId: B,
						executions: null,
						distinctSkills: null,
					} as unknown as SkillFlowRow,
					flow(A, A, 2),
				],
				// Hostile: sum() over empty set = NULL (org with zero commons skills).
				commons: { totalCommonsSkills: 0, usedCommonsSkills: null },
				repute: [
					{
						ownerTediId: undefined,
						skillsUsedByOthers: null,
						executionsByOthers: null,
						distinctConsumers: null,
					} as unknown as Parameters<
						typeof buildKnowledgeMarketReport
					>[0]["repute"][number],
				],
				ownership: [
					{ tediId: null, ownedSkills: null } as unknown as Parameters<
						typeof buildKnowledgeMarketReport
					>[0]["ownership"][number],
				],
			}),
		);

		// Null-id rows count toward org totals but never become participants;
		// the valid ids on the zero-execution row (A, B) still enter the roster.
		expect(report.orgRollup.totalSkillExecutions).toBe(5);
		expect(report.tedis.map((tedi) => tedi.tediId)).toEqual([A, B]);
		expect(report.orgRollup.commonsUtilization).toBeNull();
		expect(report.orgRollup.commons).toEqual({
			totalSkills: 0,
			usedSkills: 0,
			deadSkills: 0,
		});
		// No NaN anywhere in the serialized payload (oRPC output rejects NaN).
		expect(JSON.stringify(report)).not.toContain("null,NaN");
		for (const tedi of report.tedis) {
			for (const value of [
				tedi.ownedSkills,
				tedi.executions.total,
				tedi.repute.skillsUsedByOthers,
				tedi.reciprocity.given,
				tedi.reciprocity.received,
			]) {
				expect(Number.isFinite(value)).toBe(true);
			}
		}
	});
});

// ============================================================================
// End-to-end integration: real SQLite through the D1 facade
// ============================================================================

function marketFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			app_id TEXT,
			title TEXT NOT NULL,
			lifecycle_state TEXT
		);
		CREATE TABLE skill_usage_events (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			skill_id TEXT NOT NULL,
			outcome TEXT NOT NULL DEFAULT 'success',
			created_at TEXT NOT NULL
		);
		CREATE TABLE tedi_rationale_records (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			evidence TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE memory_facts (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("getKnowledgeMarketReport end-to-end (SQLite, hostile evidence shapes)", () => {
	it("survives hostile evidence, >1 fact-id chunk, null actors, and empty commons", async () => {
		const { db, sqlite } = marketFixture();
		const now = new Date().toISOString();
		const insertSkill = sqlite.prepare(
			"INSERT INTO skill_entries (id, organization_id, tedi_id, app_id, title, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertUsage = sqlite.prepare(
			"INSERT INTO skill_usage_events (id, organization_id, tedi_id, skill_id, created_at) VALUES (?, ?, ?, ?, ?)",
		);
		const insertDecision = sqlite.prepare(
			"INSERT INTO tedi_rationale_records (id, tedi_id, org_id, evidence, created_at) VALUES (?, ?, ?, ?, ?)",
		);
		const insertFact = sqlite.prepare(
			"INSERT INTO memory_facts (id, organization_id, tedi_id) VALUES (?, ?, ?)",
		);

		// Skills: A-owned, B-owned, one commons; app-scoped commons row excluded.
		insertSkill.run("skill-a", ORG, A, null, "A's skill", "active");
		insertSkill.run("skill-b", ORG, B, null, "B's skill", "proven");
		insertSkill.run(
			"skill-commons",
			ORG,
			null,
			null,
			"Commons skill",
			"active",
		);
		insertSkill.run("skill-app", ORG, null, "app-1", "App skill", "active");
		// Usage: B uses A's skill (cross), A self-uses, null-actor report.
		insertUsage.run("u1", ORG, B, "skill-a", now);
		insertUsage.run("u2", ORG, B, "skill-a", now);
		insertUsage.run("u3", ORG, A, "skill-a", now);
		insertUsage.run("u4", ORG, null, "skill-commons", now);

		// Decisions with malformed and hostile evidence shapes. The LIKE prefilter
		// requires a fact-key token, so every hostile row carries one.
		insertDecision.run(
			"d1",
			B,
			ORG,
			JSON.stringify({ factIds: ["fact-a1", "fact-commons"] }),
			now,
		);
		insertDecision.run("d2", B, ORG, '{"factIds": ["fact-a1", broken', now);
		insertDecision.run("d3", B, ORG, 'plain text mentioning "factIds"', now);
		insertDecision.run(
			"d4",
			B,
			ORG,
			JSON.stringify(JSON.stringify({ factIds: ["fact-a2"] })),
			now,
		);
		insertDecision.run("d5", A, ORG, null, now);
		// Enough distinct fact ids to force multiple producer-resolution chunks.
		const manyIds = Array.from(
			{ length: KNOWLEDGE_MARKET_FACT_ID_CHUNK * 2 + 5 },
			(_, index) => `fact-bulk-${index}`,
		);
		insertDecision.run("d6", C, ORG, JSON.stringify({ factIds: manyIds }), now);

		// Facts: two A-scoped, one commons, the bulk ids A-scoped; unresolvable
		// ids (extractor output not present here) must be dropped silently.
		insertFact.run("fact-a1", ORG, A);
		insertFact.run("fact-a2", ORG, A);
		insertFact.run("fact-commons", ORG, null);
		for (const id of manyIds) insertFact.run(id, ORG, A);

		const report = await getKnowledgeMarketReport(db, { orgId: ORG });

		// Skill repute: B executed A's skill twice (cross-use only).
		const a = report.tedis.find((tedi) => tedi.tediId === A);
		expect(a?.repute).toMatchObject({
			skillsUsedByOthers: 1,
			executionsByOthers: 2,
			distinctConsumers: 1,
		});
		// Fact repute: d1 ("fact-a1", from B) + d6 bulk ids (from C) — all
		// A-scoped. The commons fact, the malformed/plain rows, and the
		// double-encoded row (extractor discards it) contribute nothing and
		// crash nothing.
		expect(a?.repute.factCitationsByOthers).toBe(1 + manyIds.length);
		expect(a?.repute.distinctFactCiters).toBe(2);
		// Null-actor event counts toward org totals only.
		expect(report.orgRollup.totalSkillExecutions).toBe(4);
		expect(report.orgRollup.tediActorExecutions).toBe(3);
		// Commons inventory: 1 real commons skill (app-scoped excluded), used.
		expect(report.orgRollup.commons.totalSkills).toBe(1);
		expect(report.orgRollup.commonsUtilization).toBe(1);
	});

	it("returns an empty-market report (not a 500) when the org has no data", async () => {
		const { db } = marketFixture();
		const report = await getKnowledgeMarketReport(db, { orgId: "org-empty" });

		expect(report.tedis).toEqual([]);
		expect(report.orgRollup.totalSkillExecutions).toBe(0);
		// Zero commons skills → sum() NULL → still a clean null/0 payload.
		expect(report.orgRollup.commonsUtilization).toBeNull();
		expect(report.orgRollup.commons).toEqual({
			totalSkills: 0,
			usedSkills: 0,
			deadSkills: 0,
		});
		expect(report.orgRollup.isolates).toEqual([]);
	});
});
