import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	gatewayLogIngestionCursors,
	type TediCallCost,
	tediCallCosts,
} from "../schema/tedis";
import {
	billingProviderUsage,
	billingSettlementCursors,
	billingUsageCharges,
	billingUsageQuarantines,
	billingUsageReservations,
} from "../schema/billing";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { recordBillingUsageQuarantines } from "./billing/provider-usage";
import {
	advanceGatewayLogIngestionCursor,
	commitUnsettledBillableGatewayScan,
	getGatewayLogIngestionCursor,
	listUnrecordedProviderUsageCalls,
	listUnsettledBillableGatewayCalls,
	scanUnsettledBillableGatewayCalls,
} from "./platform-job-storage";

describe("durable unpriced gateway holds", () => {
	it.each([false, true])(
		"advances a bounded queue without changing source evidence or reservations (units=%s)",
		async (units) => {
			const sqlite = new DatabaseSync(":memory:");
			try {
				sqlite.exec("PRAGMA foreign_keys = OFF;");
				sqlite.exec(
					schemaDdl(
						tediCallCosts,
						billingProviderUsage,
						billingUsageCharges,
						billingUsageQuarantines,
						billingUsageReservations,
					),
				);
				const db = createDbClient(createD1Facade(sqlite));
				sqlite.exec(
					`INSERT INTO billing_usage_reservations (id, organization_id, plan_version_id, source, provider, model, period_start, period_end, idempotency_key, expires_at, estimated_charge_micros, created_at, updated_at) VALUES ('reservation', 'org', 'plan', 'kernel', 'workers-ai', 'model', '2026-09-01', '2026-10-01', 'reservation', '2026-09-30', 123, '2026-09-01', '2026-09-01')`,
				);
				for (const [id, quality, timestamp] of [
					["held", "quarantined_no_pricing", "2026-09-01"],
					["valid", "ok", "2026-09-02"],
				]) {
					sqlite
						.prepare(
							`INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, org_id, billing_reservation_id, snapshot_at, model, provider, success, data_quality, input_tokens, total_tokens, estimated_cost_usd, usage_kind, usage_unit, usage_quantity) VALUES (?, ?, 'gateway', ?, 'reservation', ?, 'model', 'workers-ai', 1, ?, 100, 100, 0, ?, ?, ?)`,
						)
						.run(
							id,
							id,
							units ? null : "org",
							timestamp,
							quality,
							units ? "voice_tts" : null,
							units ? "characters" : null,
							units ? 42 : null,
						);
				}
				const sourceBefore = sqlite
					.prepare("SELECT * FROM tedi_call_costs ORDER BY id")
					.all();
				const reservationsBefore = sqlite
					.prepare("SELECT * FROM billing_usage_reservations")
					.all();
				const read = units
					? listUnrecordedProviderUsageCalls
					: listUnsettledBillableGatewayCalls;
				expect((await read(db, 1)).map((row) => row.gatewayLogId)).toEqual([
					"held",
				]);
				const hold = {
					gatewayLogId: "held",
					organizationId: units ? null : "org",
					reason: "unpriced_usage" as const,
					sourceSnapshotAt: "2026-09-01",
					createdAt: "2026-09-20",
					metadata: { billingReservationId: "reservation" },
				};
				expect(await recordBillingUsageQuarantines(db, [hold])).toBe(1);
				expect(await recordBillingUsageQuarantines(db, [hold])).toBe(0);
				expect((await read(db, 1)).map((row) => row.gatewayLogId)).toEqual([
					"valid",
				]);
				expect(
					sqlite.prepare("SELECT * FROM tedi_call_costs ORDER BY id").all(),
				).toEqual(sourceBefore);
				expect(
					sqlite.prepare("SELECT * FROM billing_usage_reservations").all(),
				).toEqual(reservationsBefore);
				expect(
					sqlite.prepare("SELECT * FROM billing_usage_charges").all(),
				).toEqual([]);
				expect(
					sqlite.prepare("SELECT * FROM billing_provider_usage").all(),
				).toEqual([]);
			} finally {
				sqlite.close();
			}
		},
	);
});

describe("unsettled gateway call watermark", () => {
	type Tick = (now: string) => Promise<number>;
	const LIMIT = 6;
	const SCAN_WINDOW = 10;
	const SWEEP_MS = 5 * 60 * 60 * 1_000;

	/**
	 * One ledger history, applied tick by tick: billable rows, rows that are
	 * not this queue's (no reservation, provider units, failed, unattributed),
	 * late Gateway rows whose snapshot predates everything settled so far, and
	 * calls whose settlement fails transiently a given number of times.
	 */
	function history(tick: number) {
		const rows: Array<{
			id: string;
			snapshotAt: string;
			cost: number;
			reservation?: string | null;
			usageKind?: string | null;
			success?: number;
			orgId?: string | null;
			failures?: number;
		}> = [];
		if (tick >= 12) return rows;
		for (let i = 0; i < 4; i++) {
			rows.push({
				id: `t${tick}-${i}`,
				snapshotAt: `2026-09-${String(10 + tick).padStart(2, "0")}T00:0${i}:00Z`,
				cost: tick * 10 + i + 0.25,
				failures: i === 1 && tick % 3 === 0 ? 1 : i === 2 && tick === 4 ? 4 : 0,
			});
		}
		rows.push(
			{
				id: `t${tick}-noreserve`,
				snapshotAt: "2026-09-01",
				cost: 9,
				reservation: null,
			},
			{
				id: `t${tick}-units`,
				snapshotAt: "2026-09-01",
				cost: 9,
				usageKind: "voice_tts",
			},
			{ id: `t${tick}-failed`, snapshotAt: "2026-09-01", cost: 9, success: 0 },
			{
				id: `t${tick}-unattributed`,
				snapshotAt: "2026-09-01",
				cost: 9,
				orgId: null,
			},
		);
		if (tick % 4 === 2) {
			rows.push({
				id: `t${tick}-late`,
				snapshotAt: "2026-08-01T00:00:00Z",
				cost: 0.5,
			});
		}
		return rows;
	}

	function ledger() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				tediCallCosts,
				billingUsageCharges,
				billingUsageQuarantines,
				billingSettlementCursors,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		const failuresLeft = new Map<string, number>();
		const insert = (tick: number) => {
			for (const row of history(tick)) {
				failuresLeft.set(row.id, row.failures ?? 0);
				sqlite
					.prepare(
						`INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, org_id, billing_reservation_id, snapshot_at, model, provider, success, data_quality, total_tokens, estimated_cost_usd, usage_kind) VALUES (?, ?, 'gateway', ?, ?, ?, 'model', 'workers-ai', ?, 'ok', 1, ?, ?)`,
					)
					.run(
						row.id,
						row.id,
						row.orgId === undefined ? "org" : row.orgId,
						row.reservation === undefined ? "reservation" : row.reservation,
						row.snapshotAt,
						row.success ?? 1,
						row.cost,
						row.usageKind ?? null,
					);
			}
		};
		/** Settle one call: a transient failure leaves no row, success is durable. */
		const settle = (call: TediCallCost, now: string) => {
			const left = failuresLeft.get(call.gatewayLogId) ?? 0;
			if (left > 0) {
				failuresLeft.set(call.gatewayLogId, left - 1);
				return false;
			}
			sqlite
				.prepare(
					"INSERT INTO billing_usage_quarantines (id, gateway_log_id, organization_id, reason, source_snapshot_at, metadata, created_at) VALUES (?, ?, 'org', 'unpriced_usage', ?, '{}', ?)",
				)
				.run(`q-${call.gatewayLogId}`, call.gatewayLogId, call.snapshotAt, now);
			return true;
		};
		const settledTotals = () =>
			sqlite
				.prepare(
					"SELECT count(*) AS calls, round(sum(c.estimated_cost_usd), 6) AS cost, group_concat(c.gateway_log_id) AS ids FROM (SELECT c.* FROM billing_usage_quarantines q JOIN tedi_call_costs c ON c.gateway_log_id = q.gateway_log_id ORDER BY c.gateway_log_id) c",
				)
				.get();
		return { sqlite, db, insert, settle, settledTotals };
	}

	const at = (tick: number) =>
		new Date(Date.UTC(2026, 9, 1, tick)).toISOString();

	async function run(
		makeTick: (l: ReturnType<typeof ledger>) => Tick,
		ticks: number,
	) {
		const l = ledger();
		const tick = makeTick(l);
		for (let t = 0; t < ticks; t++) {
			l.insert(t);
			await tick(at(t));
		}
		const totals = l.settledTotals();
		l.sqlite.close();
		return totals;
	}

	const fullReadTick =
		(l: ReturnType<typeof ledger>): Tick =>
		async (now) => {
			const calls = await listUnsettledBillableGatewayCalls(l.db, LIMIT);
			for (const call of calls) l.settle(call, now);
			return calls.length;
		};

	type Window = { mode: string; after: number; through: number };
	const watermarkTick =
		(windows: Window[]) =>
		(l: ReturnType<typeof ledger>): Tick =>
		async (now) => {
			const scan = await scanUnsettledBillableGatewayCalls(l.db, {
				limit: LIMIT,
				now,
				scanWindow: SCAN_WINDOW,
				fullSweepMs: SWEEP_MS,
			});
			windows.push({
				mode: scan.mode,
				after: scan.expected?.afterRowid ?? 0,
				through: scan.throughRowid,
			});
			const failedRowids = scan.calls
				.filter(({ call }) => !l.settle(call, now))
				.map(({ rowid }) => rowid);
			await commitUnsettledBillableGatewayScan(l.db, scan, {
				failedRowids,
				now,
				scanWindow: SCAN_WINDOW,
			});
			return scan.calls.length;
		};

	it("settles exactly the calls and totals the full-ledger read settles", async () => {
		const windows: Window[] = [];
		const full = await run(fullReadTick, 60);
		const watermark = await run(watermarkTick(windows), 60);

		expect(watermark).toEqual(full);
		// 12 ticks x 4 billable calls + 3 late rows; nothing outside the queue.
		expect(full).toMatchObject({ calls: 51 });
		expect(String((full as { ids: string }).ids)).not.toMatch(
			/noreserve|units|failed|unattributed/,
		);
		// The watermark carried the ticks while rows were still arriving, and
		// no incremental read walked more than its window.
		expect(
			windows.slice(1, 12).filter((w) => w.mode === "incremental").length,
		).toBeGreaterThanOrEqual(6);
		for (const w of windows.filter((w) => w.mode === "incremental")) {
			expect(w.through - w.after).toBeLessThanOrEqual(SCAN_WINDOW);
		}
	});

	it("settles a late-arriving row on the next incremental tick", async () => {
		const windows: Window[] = [];
		const l = ledger();
		const tick = watermarkTick(windows)(l);
		try {
			for (let t = 0; t < 2; t++) {
				l.insert(t);
				for (let drain = 0; drain < 3; drain++) await tick(at(t));
			}
			l.insert(2);
			await tick(at(2));
			expect(windows.at(-1)?.mode).toBe("incremental");
			const ids = String((l.settledTotals() as { ids: string }).ids).split(",");
			expect(ids).toContain("t2-late");
			// A one-off transient failure is retried before the next full sweep.
			expect(windows.filter((w) => w.mode === "full")).toHaveLength(1);
			expect(ids).toContain("t0-1");
		} finally {
			l.sqlite.close();
		}
	});
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(gatewayLogIngestionCursors));
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

describe("gateway log cursor CAS", () => {
	it("admits one first writer per gateway and isolates another gateway", async () => {
		const { sqlite, db } = fixture();
		try {
			const input = {
				gatewayId: "default",
				expected: null,
				lastLogCreatedAt: "2026-09-24T00:00:01.000Z",
				lastLogId: "first",
				updatedAt: "2026-09-24T00:00:02.000Z",
			};
			const [first, second] = await Promise.all([
				advanceGatewayLogIngestionCursor(db, input),
				advanceGatewayLogIngestionCursor(db, { ...input, lastLogId: "rival" }),
			]);
			expect([first, second].sort()).toEqual([false, true]);
			expect(
				await advanceGatewayLogIngestionCursor(db, {
					...input,
					gatewayId: "tedix-llm-production",
				}),
			).toBe(true);
			expect(
				(await getGatewayLogIngestionCursor(db, "default"))?.lastLogId,
			).toBe(first ? "first" : "rival");
		} finally {
			sqlite.close();
		}
	});

	it("rejects stale, regressing, and same-timestamp advances", async () => {
		const { sqlite, db } = fixture();
		try {
			const start = {
				gatewayId: "default",
				expected: null,
				lastLogCreatedAt: "2026-09-24T00:00:01.000Z",
				lastLogId: "one",
				updatedAt: "2026-09-24T00:00:02.000Z",
			};
			expect(await advanceGatewayLogIngestionCursor(db, start)).toBe(true);
			const expected = {
				lastLogCreatedAt: start.lastLogCreatedAt,
				lastLogId: start.lastLogId,
			};
			expect(
				await advanceGatewayLogIngestionCursor(db, {
					...start,
					expected,
					lastLogCreatedAt: "2026-09-24T00:00:03.000Z",
					lastLogId: "three",
				}),
			).toBe(true);
			for (const change of [
				{
					expected,
					lastLogCreatedAt: "2026-09-24T00:00:04.000Z",
					lastLogId: "stale",
				},
				{
					expected: {
						lastLogCreatedAt: "2026-09-24T00:00:03.000Z",
						lastLogId: "wrong",
					},
					lastLogCreatedAt: "2026-09-24T00:00:04.000Z",
					lastLogId: "wrong-id",
				},
				{
					expected: {
						lastLogCreatedAt: "2026-09-24T00:00:03.000Z",
						lastLogId: "three",
					},
					lastLogCreatedAt: "2026-09-24T00:00:03.000Z",
					lastLogId: "tie",
				},
			]) {
				expect(
					await advanceGatewayLogIngestionCursor(db, { ...start, ...change }),
				).toBe(false);
			}
			expect(await getGatewayLogIngestionCursor(db, "default")).toMatchObject({
				lastLogCreatedAt: "2026-09-24T00:00:03.000Z",
				lastLogId: "three",
			});
		} finally {
			sqlite.close();
		}
	});
});
