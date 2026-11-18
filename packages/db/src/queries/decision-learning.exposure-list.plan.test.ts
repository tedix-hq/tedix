import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listDecisionInstrumentation } from "./decision-learning";

const INDEX = "idx_decision_exposure_org_actor_time";
const NOW = "2026-11-18T12:00:00.000Z";

function fixture(analysed: boolean | "before migration") {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(`INSERT INTO decision_exposures
		(id, organization_id, actor_id, card_id, session_id, class_id, snapshot, context, occurred_at, expires_at)
		VALUES (?, ?, ?, ?, 'session-example', ?, '{}', '{}', ?, ?)`);
	for (let i = 0; i < 4000; i++) {
		insert.run(
			`exposure-${String(i).padStart(5, "0")}`,
			i % 7 === 0 ? "org-other" : "org-example",
			i % 5 === 0 ? "grace" : "ada",
			`card-${i % 11}`,
			`class-${i % 3}`,
			// Equal timestamps exercise the ascending ID tie-break.
			new Date(Date.parse(NOW) - Math.floor(i / 3) * 60_000).toISOString(),
			i % 4 === 0 ? NOW : i % 4 === 1 ? "2026-11-17" : "2026-12-01",
		);
	}
	if (analysed) sqlite.exec("ANALYZE");
	if (analysed === "before migration")
		sqlite.exec(
			`DELETE FROM sqlite_stat1 WHERE idx = '${INDEX}'; ANALYZE sqlite_schema;`,
		);
	const queries: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				queries.push(query);
			},
		}),
	);
	return { sqlite, db, queries };
}

describe.each([false, true, "before migration"] as const)(
	"decision exposure list, analysed=%s",
	(analysed) => {
		it.each([undefined, "class-1"])(
			"reads a person's newest exposures in index order, class=%s",
			async (classId) => {
				const { sqlite, db, queries } = fixture(analysed);
				const result = await listDecisionInstrumentation(db, {
					organizationId: "org-example",
					actorId: "ada",
					classId,
					now: NOW,
					limit: 40,
				});
				expect(result.exposures).toHaveLength(40);
				const query = queries.find((query) =>
					query.includes('from "decision_exposures"'),
				)!;
				const plan = sqlite
					.prepare(`EXPLAIN QUERY PLAN ${query}`)
					.all("org-example", "ada", NOW, ...(classId ? [classId] : []), 40)
					.map((row) => String(row.detail))
					.join(" | ");
				expect(plan).toContain(
					`USING INDEX ${INDEX} (organization_id=? AND actor_id=?)`,
				);
				expect(plan).not.toMatch(/SCAN decision_exposures|TEMP B-TREE/);
				expect(
					sqlite
						.prepare(
							`SELECT count(*) AS total FROM decision_exposures INDEXED BY ${INDEX} WHERE +occurred_at >= ''`,
						)
						.get()?.total,
				).toBe(4000);
				expect(() =>
					sqlite.prepare(
						`SELECT id FROM decision_exposures INDEXED BY ${INDEX} WHERE organization_id = ? AND actor_id = ? AND card_id = ?`,
					),
				).toThrow(/no query solution/);
			},
		);

		it("preserves expiry, tenant, actor, card, class and limit behavior, including before migration", async () => {
			const { sqlite, db } = fixture(analysed);
			for (const filters of [
				{},
				{ cardId: "card-2" },
				{ classId: "class-1" },
				{ cardId: "card-2", classId: "class-1" },
			]) {
				for (const limit of [0, 1, 40, 1000]) {
					const input = {
						organizationId: "org-example",
						actorId: "ada",
						now: NOW,
						limit,
						...filters,
					};
					const indexed = await listDecisionInstrumentation(db, input);
					const expected = sqlite
						.prepare(`SELECT id FROM decision_exposures
					WHERE organization_id = ? AND actor_id = ? AND expires_at > ?
					${filters.cardId ? "AND card_id = ?" : ""}
					${filters.classId ? "AND class_id = ?" : ""}
					ORDER BY occurred_at DESC, id ASC LIMIT ?`)
						.all(
							"org-example",
							"ada",
							NOW,
							...(filters.cardId ? [filters.cardId] : []),
							...(filters.classId ? [filters.classId] : []),
							limit,
						)
						.map((row) => row.id);
					expect(indexed.exposures.map((row) => row.id)).toEqual(expected);
				}
			}
			const input = {
				organizationId: "org-example",
				actorId: "ada",
				now: NOW,
				limit: 40,
			};
			const before = await listDecisionInstrumentation(db, input);
			sqlite.exec(`DROP INDEX IF EXISTS ${INDEX}`);
			expect(await listDecisionInstrumentation(db, input)).toEqual(before);
		});
	},
);
