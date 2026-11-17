import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	listDecisionLearningHistory,
	listLearningInteractions,
} from "./learning-feedback";

// The surfaces named in the WHERE of the two indexes.
const DECISION_LEARNING_SURFACES = [
	"decision_capture",
	"agent_session_import",
	"activity_feed",
	"focus_feed",
	"decision_deck",
	"decision_deck_action",
	"work_outcome",
	"outbound_outcome",
	"work_fix",
	"decision_learning",
	"decision_edit_preference",
	"card_context",
];

const PERSONAL = "idx_learning_event_decision_history_personal";
const SHARED = "idx_learning_event_decision_history_shared";

type Statistics = "none" | "analysed" | "analysed before the migration";

function fixture(statistics: Statistics) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id, organization_id, actor_type, client_event_id, event_kind, scope_kind, scope_id, surface, metadata, occurred_at, created_at)
		VALUES (?, ?, 'user', ?, ?, ?, ?, ?, '{}', ?, ?)`);
	const scopes = [
		["personal", "ada"],
		["personal", "grace"],
		["personal", "linus"],
		["project", "project-example"],
		["organization", "org-example"],
		["tedi", "tedi-example"],
		["workflow", "workflow-example"],
	] as const;
	const surfaces = [...DECISION_LEARNING_SURFACES, "request_filing", "other"];
	const kinds = ["delivered", "accepted", "edited", "delivered"] as const;
	// Every scope, surface and kind in turn, one event a minute, so no two
	// events of a tenant share a time and the expected order is exact.
	for (let i = 0; i < 6000; i++) {
		const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
		const [scopeKind, scopeId] = scopes[i % scopes.length]!;
		insert.run(
			`event-${i}`,
			i % 11 === 0 ? "org-other" : "org-example",
			`event-${i}`,
			kinds[i % kinds.length]!,
			scopeKind,
			scopeId,
			surfaces[(i * 5) % surfaces.length]!,
			at,
			at,
		);
	}
	if (statistics !== "none") sqlite.exec("ANALYZE");
	// A database analysed earlier has no statistics for an index created
	// since, which is what the planner sees right after the migration.
	if (statistics === "analysed before the migration")
		sqlite.exec(`DELETE FROM sqlite_stat1 WHERE idx IN ('${PERSONAL}', '${SHARED}');
			ANALYZE sqlite_schema;`);
	const plans: string[] = [];
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail))
			.join(" | ");
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("learning_interaction_events"))
					plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { db, plans, explain, sqlite };
}

/** The read the decision model made before it had its own indexes. */
function previousRead(
	db: ReturnType<typeof fixture>["db"],
	personalScopeId: string | null,
	limit: number,
) {
	return listLearningInteractions(db, {
		organizationId: "org-example",
		personalScopeId,
		surfaces: [...DECISION_LEARNING_SURFACES],
		excludeFeedImpressions: true,
		limit,
	});
}

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "analysed" },
	{ statistics: "analysed before the migration" },
])("decision history, statistics: $statistics", ({ statistics }) => {
	it("returns one person's history exactly as the tenant-wide read did", async () => {
		const { db, plans } = fixture(statistics);
		for (const limit of [5, 40, 500, 2000]) {
			const expected = await previousRead(db, "ada", limit);
			plans.length = 0;
			const rows = await listDecisionLearningHistory(db, {
				organizationId: "org-example",
				personalScopeId: "ada",
				limit,
			});
			expect(rows).toEqual(expected);
			expect(rows.length).toBeGreaterThan(0);
			// Each half walks its own index in time order; nothing reads the
			// tenant's other events.
			expect(plans).toHaveLength(1);
			expect(plans[0]).toContain(
				`SEARCH learning_interaction_events USING INDEX ${SHARED} (organization_id=?)`,
			);
			expect(plans[0]).toContain(
				`SEARCH learning_interaction_events USING INDEX ${PERSONAL} (organization_id=? AND scope_id=?)`,
			);
			expect(plans[0]).not.toMatch(/SCAN learning_interaction_events/);
		}
		const all = await previousRead(db, "ada", 2000);
		// The fixture exercises every fence: another person's events, Feed
		// impressions, other surfaces and another tenant are all left out.
		expect(all.some((row) => row.scopeKind === "personal")).toBe(true);
		expect(all.some((row) => row.scopeKind !== "personal")).toBe(true);
		expect(
			all.every(
				(row) =>
					row.organizationId === "org-example" &&
					(row.scopeKind !== "personal" || row.scopeId === "ada") &&
					!(row.surface === "focus_feed" && row.eventKind === "delivered") &&
					row.surface !== "request_filing" &&
					row.surface !== "other",
			),
		).toBe(true);
	});

	it("returns only shared history when no person is given", async () => {
		const { db, plans } = fixture(statistics);
		for (const limit of [5, 500, 2000]) {
			const expected = await previousRead(db, null, limit);
			plans.length = 0;
			const rows = await listDecisionLearningHistory(db, {
				organizationId: "org-example",
				personalScopeId: null,
				limit,
			});
			expect(rows).toEqual(expected);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.scopeKind !== "personal")).toBe(true);
			expect(plans).toEqual([
				`SEARCH learning_interaction_events USING INDEX ${SHARED} (organization_id=?)`,
			]);
		}
	});

	it("is not offered to reads that do not state the decision-history condition", async () => {
		const { db, plans, explain } = fixture(statistics);
		// SQLite refuses a partial index whose condition the query does not
		// imply, whatever the statistics say.
		for (const index of [PERSONAL, SHARED]) {
			expect(() =>
				explain(
					`SELECT id FROM learning_interaction_events INDEXED BY ${index} WHERE organization_id = ? ORDER BY occurred_at DESC`,
				),
			).toThrow(/no query solution/);
			expect(() =>
				explain(
					`SELECT id FROM learning_interaction_events INDEXED BY ${index} WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND surface IN (?, ?) ORDER BY occurred_at DESC`,
				),
			).toThrow(/no query solution/);
		}
		// The general list, with the same filters as bound values, keeps its
		// plan.
		await previousRead(db, "ada", 50);
		await previousRead(db, null, 50);
		await listLearningInteractions(db, {
			organizationId: "org-example",
			personalScopeId: "ada",
			surfaces: ["decision_deck_action", "decision_deck"],
			limit: 50,
		});
		expect(plans.length).toBe(3);
		for (const plan of plans) {
			expect(plan).not.toContain(PERSONAL);
			expect(plan).not.toContain(SHARED);
		}
	});

	it("still answers on a database that does not have the indexes yet", async () => {
		const { db, sqlite } = fixture(statistics);
		sqlite.exec(`DROP INDEX ${PERSONAL}; DROP INDEX ${SHARED};`);
		for (const personalScopeId of ["ada", null])
			expect(
				await listDecisionLearningHistory(db, {
					organizationId: "org-example",
					personalScopeId,
					limit: 40,
				}),
			).toEqual(await previousRead(db, personalScopeId, 40));
	});
});
