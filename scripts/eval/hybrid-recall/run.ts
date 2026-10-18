/** Offline quality/latency eval. No model calls, network or tenant writes. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createDbClient } from "../../../packages/db/src/client";
import {
	memoryFacts,
	memoryEdges,
} from "../../../packages/db/src/schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
	memoryEntityAliases,
} from "../../../packages/db/src/schema/memory-entities";
import { createD1Facade } from "../../../packages/db/src/test/d1-facade";
import { schemaDdl } from "../../../packages/db/src/test/schema-ddl";
import { searchFactsWithVisibility } from "../../../packages/db/src/queries/memory-graph/fact-search";
import {
	legacyRecallScore,
	recallMemoryFacts,
} from "../../../apps/api/src/services/memory-hybrid-recall";
import fixture from "./fixture.json";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=OFF");
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
const db = createDbClient(createD1Facade(sqlite));
const insert = sqlite.prepare(
	"INSERT INTO memory_facts(id,organization_id,content,fact_type,confidence,visibility,review_status,memory_scope,use_policy,valid_from,created_at) VALUES (?,'fictional-larch',?,'technical',?,'org','confirmed','org','can_use_as_evidence',?,?)",
);
for (const fact of fixture.facts)
	insert.run(
		fact.id,
		fact.content,
		fact.confidence,
		fact.validFrom,
		fact.validFrom,
	);
for (const entity of fixture.entities) {
	sqlite
		.prepare(
			"INSERT INTO memory_entities(id,organization_id,entity_type,display_name,normalized_name,created_at,updated_at) VALUES (?,'fictional-larch','project',?,?,'2026-09-01','2026-09-01')",
		)
		.run(entity.id, entity.name, entity.name.toLowerCase());
	sqlite
		.prepare(
			"INSERT INTO memory_entity_mentions(id,organization_id,occurrence_key,source_fact_id,surface_form,normalized_form,proposed_type,extractor,extractor_version,confidence,created_at) VALUES (?,'fictional-larch',?,?,?,?,'project','fixture','1',1,'2026-09-01')",
		)
		.run(
			entity.id,
			entity.id,
			entity.factId,
			entity.name,
			entity.name.toLowerCase(),
		);
	sqlite
		.prepare(
			"INSERT INTO memory_entity_resolutions(id,organization_id,mention_id,entity_id,decision_id,resolution_kind,confidence,valid_from,created_at) VALUES (?,'fictional-larch',?,?,?,'linked',1,'2026-09-01','2026-09-01')",
		)
		.run(entity.id, entity.id, entity.id, entity.id);
}
for (const [i, edge] of fixture.edges.entries())
	sqlite
		.prepare(
			"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES (?,?,?,?)",
		)
		.run(`edge-${i}`, edge.source, edge.target, edge.relation);
sqlite.exec(
	readFileSync(
		new URL(
			"../../../packages/db/drizzle/20261018155133_memory-fact-hybrid-recall/migration.sql",
			import.meta.url,
		),
		"utf8",
	),
);
sqlite.exec(
	readFileSync(
		new URL(
			"../../../packages/db/drizzle/20261018172259_memory-fact-hybrid-recall-projection/migration.sql",
			import.meta.url,
		),
		"utf8",
	),
);
const rounds = Number(process.argv[2] ?? 10);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100)
	throw new Error("rounds must be 1..100");
const result: Record<string, unknown> = {
	fixture: {
		facts: fixture.facts.length,
		queries: fixture.queries.length,
		rounds,
	},
	mode: "offline D1 facade; semantic and reranker unavailable; no Cloud latency claim",
};
for (const mode of ["before", "after"] as const) {
	const samples: number[] = [];
	let recall = 0,
		mrr = 0;
	const details = [];
	for (let round = 0; round < rounds; round++)
		for (const test of fixture.queries) {
			const start = performance.now();
			const ids =
				mode === "before"
					? (
							await searchFactsWithVisibility(db, {
								orgId: "fictional-larch",
								visibilityTediId: "fictional-tedi",
								limit: 100,
								minConfidence: 0.3,
							})
						)
							.map((fact) => ({
								id: fact.id,
								score: legacyRecallScore(fact, test.query),
							}))
							.sort((a, b) => b.score - a.score)
							.slice(0, 5)
							.map((x) => x.id)
					: (
							await recallMemoryFacts(db, {
								orgId: "fictional-larch",
								tediId: "fictional-tedi",
								query: test.query,
								now: fixture.now,
								topK: 5,
							})
						).map((x) => x.factId);
			samples.push(performance.now() - start);
			const hits = test.expected.filter((id) => ids.includes(id)).length;
			recall += hits / test.expected.length;
			const rank = ids.findIndex((id) => test.expected.includes(id));
			mrr += rank < 0 ? 0 : 1 / (rank + 1);
			if (round === 0)
				details.push({ query: test.query, expected: test.expected, ids });
		}
	samples.sort((a, b) => a - b);
	result[mode] = {
		recallAt5: recall / samples.length,
		mrrAt5: mrr / samples.length,
		p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
		p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
		details,
	};
}
console.log(JSON.stringify(result, null, 2));
sqlite.close();
