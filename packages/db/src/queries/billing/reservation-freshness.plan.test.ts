import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	getBillingReservationFreshness,
	listBillingUsageReservations,
} from "./reservations";

const NEWEST = "idx_billing_reservation_newest";
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");

/** The read as it was: the newest reservation and a count over 30 days. */
const LEGACY = `SELECT MAX(created_at) AS newest, COUNT(*) AS total
	FROM billing_usage_reservations WHERE created_at >= ?`;

type Statistics =
	| "none"
	| "production-sized"
	| "analysed before the index"
	| "analysed";

function fixture(statistics: Statistics, withIndex = true) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(
		"INSERT INTO billing_usage_reservations (id, organization_id, plan_version_id, tedi_id, status, source, provider, model, period_start, period_end, idempotency_key, expires_at, created_at) VALUES (?, ?, 'plan-example', ?, ?, 'tedi', 'example', 'example', '2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', ?, ?, ?)",
	);
	const statuses = ["reserved", "settled", "released", "rejected", "expired"];
	const add = (id: string, createdAt: string, index = 0) =>
		insert.run(
			id,
			`org-${index % 4}`,
			index % 3 ? `tedi-${index % 9}` : null,
			statuses[index % statuses.length]!,
			id,
			createdAt,
			createdAt,
		);
	// Three months of admissions in four organizations, oldest 100 days ago
	// and newest two hours ago, in every status.
	for (let i = 0; i < 3000; i++)
		add(
			`reservation-${i}`,
			new Date(NOW - 2 * 60 * 60_000 - i * 48 * 60_000).toISOString(),
			i,
		);
	// A row written by the column default, which has no "T" and no zone.
	add("default-clock", "2026-11-10 08:00:00", 1);
	// Exactly 30 days before NOW.
	add("on-the-boundary", new Date(NOW - 30 * DAY).toISOString(), 2);

	if (!withIndex) sqlite.exec(`DROP INDEX ${NEWEST}`);
	// The table held about 172,000 rows on 17 Nov 2026 (what the old read
	// walked per call). These statistics give the older indexes that size
	// and, like a database that has not been analysed since the migration,
	// hold no row for the new one. The per-key figures are estimates.
	if (statistics === "production-sized")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'billing_usage_reservations';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('billing_usage_reservations','uniq_billing_reservation_idempotency','172142 1'),
				('billing_usage_reservations','idx_billing_reservation_org_status','172142 1700 600 1'),
				('billing_usage_reservations','idx_billing_reservation_status_expiry','172142 34000 1'),
				('billing_usage_reservations','idx_billing_reservation_plan','172142 21000'),
				('billing_usage_reservations','idx_billing_reservation_tedi_created','172142 400 1'),
				('billing_usage_reservations','idx_billing_reservation_org_created','172142 1700 1'),
				('billing_usage_reservations','idx_billing_reservation_trace','172142 2'),
				('billing_usage_reservations','idx_billing_reservation_org_run','172142 1700 3');
			ANALYZE sqlite_schema;`);
	else if (statistics !== "none") {
		sqlite.exec("ANALYZE");
		if (statistics === "analysed before the index")
			sqlite.exec(
				`DELETE FROM sqlite_stat1 WHERE idx = '${NEWEST}'; ANALYZE sqlite_schema;`,
			);
	}

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
				if (query.includes("billing_usage_reservations"))
					plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	const legacy = (nowMs: number) =>
		sqlite.prepare(LEGACY).get(new Date(nowMs - 30 * DAY).toISOString()) as {
			newest: string | null;
			total: number;
		};
	return { sqlite, db, plans, explain, legacy };
}

/** Clocks with the newest reservation inside the window, near its edge and outside it. */
const CLOCKS = [
	NOW,
	NOW + 5 * DAY,
	NOW + 30 * DAY - 3 * 60 * 60_000,
	NOW + 30 * DAY + 2 * 60 * 60_000,
	NOW + 400 * DAY,
	NOW - 60 * DAY,
	NOW - 100 * DAY,
	NOW - 200 * DAY,
];

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-sized" },
	{ statistics: "analysed before the index" },
	{ statistics: "analysed" },
])("reservation freshness, statistics: $statistics", ({ statistics }) => {
	it("reads the newest reservation from the end of its index and returns what the table walk returned", async () => {
		const { db, plans, legacy } = fixture(statistics);
		const seen = new Set<string | null>();
		for (const nowMs of CLOCKS) {
			const before = legacy(nowMs);
			plans.length = 0;
			const freshness = await getBillingReservationFreshness(db, nowMs);
			expect(freshness).toEqual({ maxCreatedAt: before.newest });
			// The check treated "no reservation counted" and "no newest
			// reservation" alike; they are the same fact.
			expect(before.total === 0).toBe(freshness.maxCreatedAt === null);
			expect(plans).toEqual([
				`SEARCH billing_usage_reservations USING COVERING INDEX ${NEWEST} (created_at>?)`,
			]);
			seen.add(freshness.maxCreatedAt);
		}
		expect(seen.has(null)).toBe(true);
		expect(seen.has(new Date(NOW - 2 * 60 * 60_000).toISOString())).toBe(true);
	});

	it("includes a reservation created exactly 30 days ago", async () => {
		const { sqlite, db } = fixture(statistics);
		const boundary = new Date(NOW - 30 * DAY).toISOString();
		sqlite
			.prepare("DELETE FROM billing_usage_reservations WHERE created_at > ?")
			.run(boundary);
		expect(await getBillingReservationFreshness(db, NOW)).toEqual({
			maxCreatedAt: boundary,
		});
		expect(await getBillingReservationFreshness(db, NOW + 1)).toEqual({
			maxCreatedAt: null,
		});
	});

	it("holds every reservation in the index and offers it to no other read", async () => {
		const { sqlite, db, plans, explain } = fixture(statistics);
		const count = (query: string) => Number(sqlite.prepare(query).get()?.total);
		expect(
			count(
				`SELECT COUNT(*) AS total FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE +created_at >= ''`,
			),
		).toBe(count("SELECT COUNT(*) AS total FROM billing_usage_reservations"));

		await listBillingUsageReservations(db, { organizationId: "org-1" });
		await listBillingUsageReservations(db, {
			organizationId: "org-1",
			status: "reserved",
			limit: 5,
		});
		expect(plans).toHaveLength(2);
		for (const plan of plans) expect(plan).not.toContain(NEWEST);
		// SQLite refuses a partial index whose condition the query does not
		// state, so this cannot change with the statistics. A comparison with
		// a parameter or with another constant does not state it.
		for (const query of [
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE created_at >= ?`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE created_at >= '' AND created_at >= ?`,
			`SELECT MAX(created_at) FROM billing_usage_reservations INDEXED BY ${NEWEST}`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} ORDER BY created_at DESC LIMIT 1`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE organization_id = ? AND created_at >= ? AND created_at < ?`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE organization_id = ? AND status IN ('reserved', 'settled') AND created_at >= '2026-11-17' AND created_at < '2026-11-18'`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE tedi_id = ? AND created_at >= ? ORDER BY created_at`,
			`SELECT id FROM billing_usage_reservations INDEXED BY ${NEWEST} WHERE status = 'reserved' AND expires_at < ?`,
		])
			expect(() => explain(query)).toThrow(/no query solution/);
	});
});

it("answers the same on a database that does not have the index yet", async () => {
	const { db, legacy } = fixture("analysed", false);
	for (const nowMs of CLOCKS)
		expect(await getBillingReservationFreshness(db, nowMs)).toEqual({
			maxCreatedAt: legacy(nowMs).newest,
		});
});
