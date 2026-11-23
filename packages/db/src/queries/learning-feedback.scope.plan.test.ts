import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listLearningInteractions } from "./learning-feedback";

it("seeks shared and personal history past a large private backlog", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(schemaDdl(learningInteractionEvents));
		const insert = sqlite.prepare(`INSERT INTO learning_interaction_events
			(id, organization_id, actor_type, client_event_id, event_kind, scope_kind, scope_id, surface, occurred_at, created_at)
			VALUES (?, ?, 'user', ?, 'accepted', ?, ?, 'decision_capture', ?, ?)`);
		sqlite.exec("BEGIN");
		for (let i = 0; i < 56_600; i++) {
			const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
			insert.run(
				`event-${i}`,
				i < 500 || i >= 600 ? "org-example" : "org-other",
				`event-${i}`,
				i < 500 && i % 2 === 0 ? "project" : "personal",
				i < 600 ? "ada" : "grace",
				at,
				at,
			);
		}
		sqlite.exec("COMMIT; ANALYZE");
		const statements: string[] = [];
		const db = createDbClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => statements.push(statement),
			}),
		);
		const explain = (statement: string) =>
			sqlite
				.prepare(`EXPLAIN QUERY PLAN ${statement}`)
				.all(...Array((statement.match(/\?/g) ?? []).length).fill(null))
				.map((row) => String(row.detail))
				.join(" | ");
		// The former OR predicate must walk all 56k newer private events.
		const previous = `SELECT id FROM learning_interaction_events
			WHERE organization_id = ? AND (scope_kind <> 'personal' OR (scope_kind = 'personal' AND scope_id = ?))
			ORDER BY occurred_at DESC LIMIT ?`;
		expect(explain(previous)).toContain("idx_learning_event_org_occurred");
		for (const personalScopeId of ["ada", null]) {
			for (const window of [
				{},
				{
					since: "2026-01-01T01:00:00.000Z",
					until: "2026-01-01T05:00:00.000Z",
				},
			]) {
				statements.length = 0;
				const rows = await listLearningInteractions(db, {
					organizationId: "org-example",
					personalScopeId,
					limit: 200,
					...window,
				});
				const expected = sqlite
					.prepare(
						previous.replace(
							"ORDER BY",
							"AND occurred_at >= ? AND occurred_at <= ? ORDER BY",
						),
					)
					.all(
						"org-example",
						personalScopeId,
						window.since ?? "",
						window.until ?? "9999",
						200,
					);
				expect(rows.map((row) => row.id)).toEqual(
					expected.map((row) => row.id),
				);
				expect(rows.length).toBeGreaterThan(0);
				expect(statements).toHaveLength(1);
				const plan = explain(statements[0]!);
				expect(plan).toContain(
					"SEARCH learning_interaction_events USING INDEX idx_learning_event_shared_occurred (organization_id=?",
				);
				if (personalScopeId)
					expect(plan).toContain(
						"SEARCH learning_interaction_events USING INDEX idx_learning_event_scope_occurred (organization_id=? AND scope_kind=? AND scope_id=?",
					);
				expect(plan).not.toMatch(
					/SCAN learning_interaction_events|idx_learning_event_org_occurred/,
				);
			}
		}
	} finally {
		sqlite.close();
	}
});
