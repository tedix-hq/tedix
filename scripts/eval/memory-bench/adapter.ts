import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Fact } from "./fixtures";

export async function adapter(root: string) {
	const load = (path: string) =>
		import(pathToFileURL(resolve(root, path)).href);
	const [
		entities,
		{ createDbClient },
		{ memoryFacts, memoryEdges },
		{ createD1Facade },
		{ schemaDdl },
		assembly,
		lessonQueries,
		lessonSelection,
		hook,
	] = await Promise.all([
		load("packages/db/src/schema/memory-entities.ts"),
		load("packages/db/src/client.ts"),
		load("packages/db/src/schema/memory-graph.ts"),
		load("packages/db/src/test/d1-facade.ts"),
		load("packages/db/src/test/schema-ddl.ts"),
		load("apps/api/src/services/memory-graph-context-assembly.ts"),
		load("packages/db/src/queries/memory-graph/agent-lessons.ts"),
		load("apps/api/src/rpc/routers/agent-session-lessons.ts"),
		load("packages/cli/src/hooks/prompt-context.ts"),
	]);
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts));
	sqlite.exec(schemaDdl(memoryEdges));
	for (const name of [
		"memoryEntities",
		"memoryEntityMentions",
		"memoryEntityAliases",
		"memoryEntityResolutions",
	])
		sqlite.exec(schemaDdl(entities[name]));
	for (const directory of readdirSync(resolve(root, "packages/db/drizzle"))
		.filter((name) => name.includes("memory-fact-hybrid-recall"))
		.sort()) {
		sqlite.exec(
			readFileSync(
				resolve(root, "packages/db/drizzle", directory, "migration.sql"),
				"utf8",
			),
		);
	}
	const db = createDbClient(createD1Facade(sqlite));
	const hybridPath = "packages/db/src/queries/memory-graph/hybrid-recall.ts";
	if (existsSync(resolve(root, hybridPath))) {
		const arms = await load(hybridPath),
			scope = { orgId: "org_fable_unseeded" };
		// The orchestrator intentionally fails soft; schema failures must fail this benchmark.
		await arms.lexicalRecall(db, scope, "fixture");
		await arms.graphRecall(db, scope, "fixture");
		await arms.temporalRecall(db, scope, "2026-04-01");
	}
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts (id,organization_id,content,fact_type,confidence,visibility,status,review_status,use_policy,valid_to,topic_key,metadata,created_at,valid_from) VALUES (?,?,?,'preference',?,'org','active','confirmed',?,?,?,?,?,?)`,
	);
	function seed(facts: Fact[]) {
		for (const f of facts) {
			insert.run(
				f.id,
				f.org,
				f.content,
				f.confidence ?? 0.8,
				f.topicKey ? "can_use_as_instruction" : "can_use_as_evidence",
				f.validTo ?? null,
				f.topicKey ?? null,
				JSON.stringify(f.metadata ?? {}),
				"2026-01-01T00:00:00Z",
				f.date ?? "2026-01-01T00:00:00Z",
			);
			for (const name of [
				...new Set(
					[f.entity, ...(f.content.match(/Mira-\d+-\d+/g) ?? [])].filter(
						(v): v is string => Boolean(v),
					),
				),
			]) {
				const entityId = `entity:${f.org}:${name}`,
					mentionId = `mention:${f.id}:${name}`;
				sqlite
					.prepare(
						"INSERT OR IGNORE INTO memory_entities(id,organization_id,entity_type,display_name,normalized_name,created_at,updated_at) VALUES (?,?,'other',?,?,'2026-01-01','2026-01-01')",
					)
					.run(entityId, f.org, name, name.toLowerCase());
				sqlite
					.prepare(
						"INSERT INTO memory_entity_mentions(id,organization_id,occurrence_key,source_fact_id,surface_form,normalized_form,proposed_type,extractor,extractor_version,confidence,created_at) VALUES (?,?,?,?,?,?,'other','fictional-fixture','1',1,'2026-01-01')",
					)
					.run(mentionId, f.org, mentionId, f.id, name, name.toLowerCase());
				sqlite
					.prepare(
						"INSERT INTO memory_entity_resolutions(id,organization_id,mention_id,entity_id,decision_id,resolution_kind,confidence,valid_from,created_at) VALUES (?,?,?,?,?,'linked',1,'2026-01-01T00:00:00Z','2026-01-01')",
					)
					.run(
						`resolution:${mentionId}`,
						f.org,
						mentionId,
						entityId,
						`decision:${mentionId}`,
					);
			}
		}
	}
	const promptSelector = existsSync(
		resolve(root, "packages/cli/src/hooks/lesson-selection.ts"),
	)
		? await load("packages/cli/src/hooks/lesson-selection.ts")
		: null;
	return {
		db,
		sqlite,
		seed,
		assembly,
		lessonQueries,
		lessonSelection,
		hook,
		promptSelector,
		edge(source: string, target: string, relation: string) {
			sqlite
				.prepare(
					"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES (?,?,?,?)",
				)
				.run(`${source}:${target}:${relation}`, source, target, relation);
		},
		async recall(org: string, text: string) {
			sqlite.prepare("UPDATE memory_facts SET last_accessed_at = NULL").run();
			const start = performance.now();
			const result = await assembly.assembleContext(db, {
				orgId: org,
				tediId: "fictional-eval-tedi",
				query: text,
				maxTokens: 4000,
			});
			return {
				ids: result.sources.map((s: { factId: string }) => s.factId),
				ms: performance.now() - start,
				block: result.context,
				provenance: result.sources.map(
					(s: { factId: string; provenance?: unknown }) => ({
						factId: s.factId,
						provenance: s.provenance,
					}),
				),
			};
		},
		close() {
			sqlite.close();
		},
	};
}
