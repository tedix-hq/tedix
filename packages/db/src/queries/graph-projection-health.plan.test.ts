import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	type GraphProjectionManagedCountAttempt,
	clearGraphProjectionManagedCountAttempt,
	getGraphProjectionCanonicalManagedCounts,
	getGraphProjectionCanonicalSample,
	getGraphProjectionManagedCountAttempt,
	recordGraphProjectionManagedCountAttempt,
} from "./graph-projection-health";

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const plans = new Map<string, string>();
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (/^select/i.test(query))
					plans.set(
						query,
						sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail))
							.join(" | "),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans };
}

describe("exact projection inventory", () => {
	it("reads the decision total from the maintained counter and matches a count of the records", async () => {
		const { sqlite, db, plans } = fixture();
		const insert = sqlite.prepare(
			"INSERT INTO tedi_rationale_records (id, tedi_id, org_id, action, rationale, category, created_at) VALUES (?, 'tedi', ?, 'action', 'why', 'custom', '2026-11-16')",
		);
		const counted = (orgId: string) =>
			Number(
				sqlite
					.prepare(
						"SELECT count(*) AS total FROM tedi_rationale_records WHERE org_id = ?",
					)
					.get(orgId)?.total,
			);
		const decisions = async (orgId: string) => {
			const counts = await getGraphProjectionCanonicalManagedCounts(db, orgId);
			// Outcome, owner and completion are one per decision.
			expect(counts.decisionOutcomes).toBe(counts.decisions);
			expect(counts.decisionOwners).toBe(counts.decisions);
			expect(counts.decisionCompletions).toBe(counts.decisions);
			return counts.decisions;
		};
		expect(await decisions("org-example")).toBe(0);
		for (let i = 0; i < 7; i++) insert.run(`decision-${i}`, "org-example");
		for (let i = 0; i < 3; i++) insert.run(`other-${i}`, "org-other");
		expect(await decisions("org-example")).toBe(7);
		expect(await decisions("org-other")).toBe(3);
		sqlite.exec(
			"UPDATE tedi_rationale_records SET outcome = 'done' WHERE id = 'decision-1'",
		);
		sqlite.exec(
			"DELETE FROM tedi_rationale_records WHERE id IN ('decision-0', 'other-0')",
		);
		for (const orgId of ["org-example", "org-other", "org-none"])
			expect(await decisions(orgId)).toBe(counted(orgId));
		expect(await decisions("org-example")).toBe(6);

		const statements = [...plans.keys()];
		expect(
			statements.filter((query) => query.includes('"tedi_rationale_records"')),
		).toEqual([]);
		expect(
			plans.get(
				statements.find((query) => query.includes('"rationale_org_counts"'))!,
			),
		).toBe(
			"SEARCH rationale_org_counts USING INDEX sqlite_autoindex_rationale_org_counts_1 (org_id=?)",
		);
	});

	it("keeps one organization's last uncertified inventory until it is cleared", async () => {
		const { sqlite, db } = fixture();
		const counts = await getGraphProjectionCanonicalManagedCounts(
			db,
			"org-example",
		);
		const attempt: GraphProjectionManagedCountAttempt = {
			checkedAt: "2026-11-17T06:00:00.000Z",
			attempts: 1,
			canonical: { ...counts, facts: 12 },
			projected: { ...counts, facts: 11 },
			compared: true,
		};
		expect(
			await getGraphProjectionManagedCountAttempt(db, "org-example"),
		).toBeNull();
		await recordGraphProjectionManagedCountAttempt(db, "org-example", attempt);
		await recordGraphProjectionManagedCountAttempt(db, "org-example", {
			...attempt,
			attempts: 2,
		});
		await recordGraphProjectionManagedCountAttempt(db, "org-other", {
			...attempt,
			compared: false,
		});
		expect(
			await getGraphProjectionManagedCountAttempt(db, "org-example"),
		).toEqual({ ...attempt, attempts: 2 });
		expect(
			await getGraphProjectionManagedCountAttempt(db, "org-other"),
		).toEqual({ ...attempt, compared: false });
		await clearGraphProjectionManagedCountAttempt(db, "org-example");
		expect(
			await getGraphProjectionManagedCountAttempt(db, "org-example"),
		).toBeNull();
		expect(
			await getGraphProjectionManagedCountAttempt(db, "org-other"),
		).not.toBeNull();

		// A value that cannot be read back whole counts as nothing stored.
		for (const through of [
			"not json",
			"null",
			JSON.stringify({ ...attempt, canonical: { facts: 1 } }),
			JSON.stringify({ ...attempt, attempts: "2" }),
		]) {
			sqlite
				.prepare(
					"UPDATE platform_cron_checkpoints SET through = ? WHERE schedule_id LIKE '%org-other'",
				)
				.run(through);
			expect(
				await getGraphProjectionManagedCountAttempt(db, "org-other"),
			).toBeNull();
		}
	});
});

describe("current fact sample", () => {
	it("uses the covering partial index without sorting and preserves null and tied timestamps", async () => {
		const { sqlite, db, plans } = fixture();
		const insert = sqlite.prepare(`INSERT INTO memory_facts
			(id, organization_id, content, fact_type, updated_at, created_at, archived_at, valid_to)
			VALUES (?, ?, 'fact', 'technical', ?, ?, ?, ?)`);
		for (let i = 0; i < 1000; i++)
			insert.run(
				`old-${i}`,
				"org-example",
				"2026-01-01",
				"2026-01-01",
				null,
				null,
			);
		insert.run("a", "org-example", "2026-11-18", "2026-11-17", null, null);
		insert.run("b", "org-example", "2026-11-18", "2026-11-17", null, null);
		insert.run("c", "org-example", "2026-11-18", "2026-11-18", null, null);
		insert.run("legacy", "org-example", null, "2026-11-19", null, null);
		insert.run(
			"archived",
			"org-example",
			"2026-11-20",
			"2026-11-20",
			"2026-11-21",
			null,
		);
		insert.run(
			"ended",
			"org-example",
			"2026-11-20",
			"2026-11-20",
			null,
			"2026-11-21",
		);
		insert.run("foreign", "org-other", "2026-11-20", "2026-11-20", null, null);
		expect(
			(await getGraphProjectionCanonicalSample(db, "org-example", 3)).map(
				(row) => row.id,
			),
		).toEqual(["c", "b", "a"]);
		const rows = await getGraphProjectionCanonicalSample(
			db,
			"org-example",
			2000,
		);
		expect(rows).toHaveLength(100);
		sqlite.exec("DELETE FROM memory_facts WHERE id LIKE 'old-%'");
		expect(
			(await getGraphProjectionCanonicalSample(db, "org-example", 10)).at(-1),
		).toEqual({ id: "legacy", canonicalUpdatedAt: "2026-11-19" });
		for (const plan of plans.values()) {
			expect(plan).toContain("idx_memory_facts_org_current_sample");
			expect(plan).not.toContain("TEMP B-TREE");
			expect(plan).not.toContain("SCAN");
		}
	});
});
