import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryFacts, memoryEdges } from "../schema/memory-graph";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	decisionLessonEvidence,
	listApprovedAgentLessons,
} from "./memory-graph/agent-lessons";

const ORG = "fictional-orchard";
function setup(plans: string[] = []) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [memoryFacts, memoryEdges, learningInteractionEvents])
		sqlite.exec(schemaDdl(table));
	const db = createDbClient(
		createD1Facade(
			{
				prepare(query) {
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
					return sqlite.prepare(query);
				},
				exec: (query) => sqlite.exec(query),
			},
			{ maxBoundParams: 100 },
		),
	);
	const fact = (
		id: string,
		content: string,
		metadata = {},
		org = ORG,
		topic: string | null = null,
	) =>
		sqlite
			.prepare(
				`INSERT INTO memory_facts (id, organization_id, content, fact_type, status, review_status, use_policy, topic_key, visibility, metadata) VALUES (?, ?, ?, 'preference', 'active', 'confirmed', 'requires_user_confirmation', ?, 'org', ?)`,
			)
			.run(id, org, content, topic, JSON.stringify(metadata));
	const event = (
		id: string,
		answer: string,
		kind = "answered",
		at = "2026-10-01T00:00:00Z",
		target = id,
		org = ORG,
	) =>
		sqlite
			.prepare(
				`INSERT INTO learning_interaction_events (id, organization_id, actor_type, actor_id, client_event_id, event_kind, scope_kind, scope_id, surface, target_type, target_id, metadata, occurred_at, created_at) VALUES (?, ?, 'user', 'user-orchard', ?, ?, 'personal', 'user-orchard', 'decision_capture', 'work_interaction', ?, ?, ?, ?)`,
			)
			.run(id, org, id, kind, target, JSON.stringify({ answer }), at, at);
	const lesson = (
		sources: Array<{ kind: string; id: string; quote: string }>,
	) =>
		fact(
			"lesson",
			"Use batches for writes.",
			{
				learningFeed: {
					autoConfirmed: true,
					evidence: {
						version: 1,
						state: "live",
						supportCount: sources.length,
						sources,
					},
				},
			},
			ORG,
			"learning-feed:decision:orchard:general:database",
		);
	const read = () => listApprovedAgentLessons(db, ORG, "learning-feed:");
	return { db, sqlite, fact, event, lesson, read };
}

describe("lesson evidence lifecycle", () => {
	it("seeks corrections by exact target and time instead of scanning later org events", async () => {
		const plans: string[] = [];
		const { db, event } = setup(plans);
		event("decision", "Always verify before release.");
		expect(
			(await decisionLessonEvidence(db, ORG, ["decision"])).supportCount,
		).toBe(1);
		expect(plans).toContainEqual(
			expect.stringMatching(
				/SEARCH c USING INDEX idx_learning_event_target_occurred .*target_type=\? AND target_id=\? AND occurred_at>\?/,
			),
		);
	});
	it.each(["valid_to", "archived_at"])(
		"holds and queues a lesson when a source gets %s, without disabling auto-confirmation",
		async (column) => {
			const { sqlite, fact, lesson, read } = setup();
			fact("source", "Use batches for writes.");
			lesson([
				{ kind: "fact", id: "source", quote: "Use batches for writes." },
			]);
			expect((await read()).map((l) => l.id)).toEqual(["lesson"]);
			sqlite.exec(
				`UPDATE memory_facts SET ${column} = '2026-10-02T00:00:00Z' WHERE id = 'source'`,
			);
			expect(await read()).toEqual([]);
			const metadata = JSON.parse(
				String(
					sqlite
						.prepare("SELECT metadata FROM memory_facts WHERE id = 'lesson'")
						.get()?.metadata,
				),
			);
			expect(metadata.learningFeed).toMatchObject({
				autoConfirmed: true,
				evidence: { state: "held" },
			});
			expect(metadata.learningFeed.evidence.redistillRequestedAt).toBeTruthy();
		},
	);
	it.each(["contradicts", "supersedes"])(
		"checks %s edges in the source tenant only",
		async (relation) => {
			const { sqlite, fact, lesson, read } = setup();
			fact("source", "Use batches for writes.");
			fact(
				"correction",
				"Use a single conditional write.",
				{},
				"fictional-other",
			);
			lesson([
				{ kind: "fact", id: "source", quote: "Use batches for writes." },
			]);
			sqlite
				.prepare(
					"INSERT INTO memory_edges (id, source_fact_id, target_fact_id, relation_type, strength) VALUES ('edge', 'correction', 'source', ?, 1)",
				)
				.run(relation);
			expect(await read()).toHaveLength(1);
			sqlite
				.prepare(
					"UPDATE memory_facts SET organization_id = ? WHERE id = 'correction'",
				)
				.run(ORG);
			expect(await read()).toEqual([]);
		},
	);
	it("holds cross-tenant sources", async () => {
		const { fact, lesson, read } = setup();
		fact("source", "Use batches for writes.", {}, "fictional-other");
		lesson([{ kind: "fact", id: "source", quote: "Use batches for writes." }]);
		expect(await read()).toEqual([]);
	});
	it("holds a source changed in place and does not update other facts while queueing", async () => {
		const { sqlite, fact, lesson, read } = setup();
		fact("source", "Use batches for writes.");
		fact("other", "Another fact.", {}, "fictional-other");
		lesson([{ kind: "fact", id: "source", quote: "Use batches for writes." }]);
		sqlite.exec(
			"UPDATE memory_facts SET content = 'Use a conditional update instead.' WHERE id = 'source'",
		);
		expect(await read()).toEqual([]);
		expect(
			sqlite
				.prepare("SELECT metadata FROM memory_facts WHERE id = 'other'")
				.get()?.metadata,
		).toBe("{}");
	});
	it("keeps canonical quotes and counts, excluding decisions superseded by a correction", async () => {
		const { db, event, lesson, read } = setup();
		event(
			"decision-1",
			"Always use batches for writes.",
			"answered",
			"2026-10-01T00:00:00Z",
			"request-1",
		);
		const evidence = await decisionLessonEvidence(db, ORG, [
			"decision-1",
			"decision-1",
		]);
		expect(evidence).toMatchObject({
			supportCount: 1,
			state: "live",
			sources: [{ id: "decision-1", quote: "Always use batches for writes." }],
		});
		lesson(evidence.sources);
		expect(await read()).toHaveLength(1);
		event(
			"correction-2",
			"Never use batches for this conditional update.",
			"edited",
			"2026-10-02T00:00:00Z",
			"request-1",
		);
		expect(await read()).toEqual([]);
		expect(
			(
				await decisionLessonEvidence(db, ORG, ["decision-1", "correction-2"])
			).sources.map((s) => s.id),
		).toEqual(["correction-2"]);
	});
	it("chunks more than 100 cited decisions under D1's parameter ceiling", async () => {
		const { db, event } = setup();
		const ids = Array.from({ length: 123 }, (_, i) => `event-${i}`);
		ids.forEach((id) => event(id, `Always verify ${id} before release.`));
		expect((await decisionLessonEvidence(db, ORG, ids)).supportCount).toBe(123);
	});
});
