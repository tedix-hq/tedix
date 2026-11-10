import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listUnlabelledDecisionDeferrals } from "./decision-learning";

it("finds deferrals through the surface index, not by scanning every learning event", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"decision_exposures"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	await listUnlabelledDecisionDeferrals(db as never, "2026-01-01T00:00:00Z");
	const plan = plans.join("\n");
	expect(plan).toMatch(
		/SEARCH learning_interaction_events USING INDEX idx_learning_event_surface_occurred \(surface=\?/,
	);
	expect(plan).not.toMatch(/SCAN learning_interaction_events/);
});
