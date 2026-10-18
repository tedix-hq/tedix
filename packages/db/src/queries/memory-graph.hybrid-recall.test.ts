import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryFacts, memoryEdges } from "../schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
	memoryEntityAliases,
} from "../schema/memory-entities";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	backfillFactSearch,
	fallbackRecall,
	graphRecall,
	hydrateRecall,
	lexicalRecall,
	recallWindow,
	temporalRecall,
} from "./memory-graph/hybrid-recall";

const migration = readFileSync(
	new URL(
		"../../drizzle/20261018155133_memory-fact-hybrid-recall/migration.sql",
		import.meta.url,
	),
	"utf8",
);
const scope = {
	orgId: "fictional-a",
	tediId: "tedi-a",
	now: "2026-10-18T12:00:00.000Z",
};
function fixture(onPrepare?: (query: string) => void) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			memoryFacts,
			memoryEdges,
			memoryEntities,
			memoryEntityMentions,
			memoryEntityResolutions,
			memoryEntityAliases,
		),
	);
	sqlite.exec(migration);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261018170409_memory-recall-time-ranges/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const db = createDbClient(createD1Facade(sqlite, { onPrepare }));
	const add = (
		id: string,
		content: string,
		org = "fictional-a",
		more: Record<string, string> = {},
	) => {
		sqlite
			.prepare(
				`INSERT INTO memory_facts(id,organization_id,content,fact_type,visibility,confidence,valid_from,created_at,review_status,memory_scope,use_policy) VALUES (?,?,?,'technical','org',0.8,'2026-10-17','2026-10-17','confirmed','org','can_use_as_evidence')`,
			)
			.run(id, org, content);
		for (const [column, value] of Object.entries(more))
			sqlite
				.prepare(`UPDATE memory_facts SET ${column}=? WHERE id=?`)
				.run(value, id);
	};
	return { sqlite, db, add };
}
describe("canonical hybrid recall D1 queries", () => {
	it("seeks tenant time ranges before canonical eligibility checks", async () => {
		const prepared: string[] = [];
		const { db, add, sqlite } = fixture((query) => prepared.push(query));
		add("recent", "cobalt launch");
		add("foreign", "cobalt launch", "fictional-b");
		expect(
			(await temporalRecall(db, scope, "yesterday")).map((f) => f.factId),
		).toEqual(["recent"]);
		const query = prepared.find((query) => query.includes("temporal_fact_id"))!;
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array(query.match(/\?/g)?.length ?? 0).fill(null));
		for (const index of [
			"idx_memory_facts_org_recall_time",
			"idx_memory_facts_org_recall_until",
			"sqlite_autoindex_memory_facts_1",
		])
			expect(plan.some((row) => String(row.detail).includes(index))).toBe(true);
		expect(
			plan.some((row) =>
				String(row.detail).includes("idx_memory_facts_archived"),
			),
		).toBe(false);
	});
	it("filters inactive BM25 matches before limiting candidates", async () => {
		const { db, add } = fixture();
		for (let i = 0; i < 520; i++)
			add(`inactive-${i}`, "cobalt", undefined, { valid_to: "2026-10-17" });
		add("usable", "cobalt launch instructions remain available after archival");
		expect(
			(await lexicalRecall(db, scope, "cobalt")).map((f) => f.factId),
		).toEqual(["usable"]);
	});
	it("uses the evidence lane's validator for lessons recalled through the shared fact path", async () => {
		const { db, sqlite, add } = fixture();
		add("source", "cobalt deployment evidence", undefined, {
			valid_to: "2026-10-17",
		});
		add("lesson", "cobalt deployment rule", undefined, {
			metadata: JSON.stringify({
				learningFeed: {
					autoConfirmed: true,
					evidence: {
						version: 1,
						state: "live",
						supportCount: 1,
						sources: [
							{
								kind: "fact",
								id: "source",
								quote: "cobalt deployment evidence",
							},
						],
					},
				},
			}),
		});
		expect(await hydrateRecall(db, scope, ["lesson"])).toEqual([]);
		expect(
			sqlite
				.prepare(
					"SELECT json_extract(metadata, '$.learningFeed.evidence.state') AS state FROM memory_facts WHERE id='lesson'",
				)
				.get(),
		).toEqual({ state: "held" });
		expect(await lexicalRecall(db, scope, "cobalt")).toEqual([]);
		expect(await fallbackRecall(db, scope)).toEqual([]);
	});
	it("does not let an invalidated contradiction suppress its active replacement with the same timestamp", async () => {
		const { db, sqlite, add } = fixture();
		add("alpha-current", "Vessel-3 launch uses Opal Dock");
		add("zulu-old", "Vessel-3 launch used Quartz Dock", undefined, {
			valid_to: "2026-10-17",
		});
		sqlite.exec(
			"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES ('s','alpha-current','zulu-old','supersedes'),('c','alpha-current','zulu-old','contradicts')",
		);
		expect(
			(await lexicalRecall(db, scope, "Vessel-3")).map((fact) => fact.factId),
		).toEqual(["alpha-current"]);
	});
	it("preserves numbered entity names in FTS queries", async () => {
		const { db, add } = fixture();
		add("v3", "Vessel-3 departs from Opal Dock");
		add("v4", "Vessel-4 departs from Quartz Dock");
		expect(
			(await lexicalRecall(db, scope, "Vessel-3")).map((fact) => fact.factId),
		).toEqual(["v3"]);
	});
	it("syncs insert, content update, delete and idempotent backfill with tenant isolation", async () => {
		const { sqlite, db, add } = fixture();
		add("a", "cobalt launch checklist");
		add("b", "cobalt secret checklist", "fictional-b");
		expect(
			(await lexicalRecall(db, scope, "cobalt")).map((x) => x.factId),
		).toEqual(["a"]);
		sqlite
			.prepare(
				"UPDATE memory_facts SET content='amber launch checklist' WHERE id='a'",
			)
			.run();
		expect(await lexicalRecall(db, scope, "cobalt")).toEqual([]);
		expect(
			(await lexicalRecall(db, scope, "amber")).map((x) => x.factId),
		).toEqual(["a"]);
		sqlite.prepare("DELETE FROM memory_fact_fts WHERE fact_id='a'").run();
		expect(await backfillFactSearch(db, scope.orgId)).toBe(1);
		expect(await backfillFactSearch(db, scope.orgId)).toBe(0);
		sqlite.prepare("DELETE FROM memory_facts WHERE id='a'").run();
		expect(await lexicalRecall(db, scope, "amber")).toEqual([]);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM memory_fact_fts").get(),
		).toEqual({ n: 1 });
	});
	it("excludes private, expired, future, invalidated, superseded and older contradicted facts in every arm", async () => {
		const { sqlite, db, add } = fixture();
		add("old", "cobalt obsolete");
		add("new", "cobalt current", undefined, { valid_from: "2026-10-18" });
		add("invalid", "cobalt invalid", undefined, { valid_to: "2026-10-16" });
		add("future", "cobalt future", undefined, { valid_from: "2027-01-01" });
		add("private", "cobalt private", undefined, {
			visibility: "private",
			tedi_id: "other",
		});
		add("expired", "cobalt expired", undefined, {
			metadata: '{"expiresAt":"2026-10-16"}',
		});
		add("superseded", "cobalt superseded");
		sqlite.exec(
			"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES ('c','old','new','contradicts'),('s','new','superseded','supersedes')",
		);
		const ids = [
			"old",
			"new",
			"invalid",
			"future",
			"private",
			"expired",
			"superseded",
		];
		expect((await hydrateRecall(db, scope, ids)).map((x) => x.id)).toEqual([
			"new",
		]);
		expect(
			(await hydrateRecall(db, scope, ids))[0]!.replacesFactIds.sort(),
		).toEqual(["old", "superseded"]);
		expect(
			(await lexicalRecall(db, scope, "cobalt")).map((x) => x.factId),
		).toEqual(["new"]);
		expect(
			(await temporalRecall(db, scope, "today")).map((x) => x.factId),
		).toEqual(["new"]);
	});
	it("hydrates external IDs through primary keys with tenant scope and bounded parameters", async () => {
		const prepared: string[] = [];
		const { db, add, sqlite } = fixture((query) => prepared.push(query));
		add("a", "cobalt");
		add("b", "cobalt", "fictional-b");
		expect(
			(
				await hydrateRecall(db, scope, [
					"b",
					"a",
					...Array.from({ length: 180 }, (_, i) => `absent-${i}`),
				])
			).map((f) => f.id),
		).toEqual(["a"]);
		const query = prepared.find((query) =>
			query.includes("replaces_fact_ids"),
		)!;
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array(query.match(/\?/g)?.length ?? 0).fill(null));
		expect(
			plan.some((row) =>
				String(row.detail).includes(
					"USING INDEX sqlite_autoindex_memory_facts_1 (id=?)",
				),
			),
		).toBe(true);
		expect(
			plan.some((row) =>
				String(row.detail).includes("idx_memory_facts_archived"),
			),
		).toBe(false);
	});
	it("uses accepted entity names for BM25 and one-hop graph recall, and syncs renames/revocations", async () => {
		const { sqlite, db, add } = fixture();
		add("seed", "refinery planning");
		add("hop", "delivery deadline");
		add("other", "cross tenant", "fictional-b");
		sqlite.exec(`INSERT INTO memory_entities(id,organization_id,entity_type,display_name,normalized_name,created_at,updated_at) VALUES ('ent','fictional-a','organization','Cobalt Foundry','cobalt foundry','2026-10-17','2026-10-17');
		INSERT INTO memory_entity_mentions(id,organization_id,occurrence_key,source_fact_id,surface_form,normalized_form,proposed_type,extractor,extractor_version,confidence,created_at) VALUES ('mention','fictional-a','one','seed','Cobalt','cobalt','organization','fixture','1',0.9,'2026-10-17');
		INSERT INTO memory_entity_resolutions(id,organization_id,mention_id,entity_id,decision_id,resolution_kind,confidence,valid_from,created_at) VALUES ('resolution','fictional-a','mention','ent','decision','linked',0.9,'2026-10-17','2026-10-17');
		INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES ('hop','seed','hop','related_to'),('bad','seed','other','related_to');`);
		expect(
			(await lexicalRecall(db, scope, "Cobalt")).map((f) => f.factId),
		).toEqual(["seed"]);
		expect(
			(await graphRecall(db, scope, "Cobalt Foundry"))
				.map((f) => f.factId)
				.sort(),
		).toEqual(["hop", "seed"]);
		expect(await graphRecall(db, scope, "Cobalt Foundry2")).toEqual([]);
		sqlite.exec(
			"UPDATE memory_facts SET memory_scope='graph',use_policy='do_not_inject_automatically' WHERE id='seed'",
		);
		expect(
			(await graphRecall(db, scope, "Cobalt Foundry")).map(
				(fact) => fact.factId,
			),
		).toEqual(["hop"]);
		sqlite.exec(
			"UPDATE memory_facts SET memory_scope='org',use_policy='can_use_as_evidence' WHERE id='seed'",
		);
		sqlite.exec(
			"UPDATE memory_facts SET visibility='private',tedi_id='another-tedi' WHERE id='seed'",
		);
		expect(await graphRecall(db, scope, "Cobalt Foundry")).toEqual([]);
		sqlite.exec(
			"UPDATE memory_facts SET visibility='org',tedi_id=NULL WHERE id='seed'",
		);
		sqlite.exec(
			"UPDATE memory_entities SET display_name='Amber Foundry' WHERE id='ent'",
		);
		expect(await lexicalRecall(db, scope, "Cobalt")).toEqual([]);
		expect(
			(await lexicalRecall(db, scope, "Amber")).map((f) => f.factId),
		).toEqual(["seed"]);
		sqlite.exec(
			"UPDATE memory_entity_resolutions SET status='revoked',valid_to='2026-10-18' WHERE id='resolution'",
		);
		expect(await lexicalRecall(db, scope, "Amber")).toEqual([]);
	});
	it("parses calendar cues deterministically and does not treat invalid dates as a cue", () => {
		expect(recallWindow("yesterday", new Date(scope.now))).toEqual({
			from: "2026-10-17T00:00:00.000Z",
			to: "2026-10-18T00:00:00.000Z",
		});
		expect(recallWindow("on 2026-02-30", new Date(scope.now))).toBeUndefined();
	});
});
