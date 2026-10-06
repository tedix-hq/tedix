import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { gatewayLogIngestionCursors, tediCallCosts } from "../schema/tedis";
import {
	billingProviderUsage,
	billingUsageCharges,
	billingUsageQuarantines,
	billingUsageReservations,
} from "../schema/billing";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { recordBillingUsageQuarantines } from "./billing/provider-usage";
import {
	advanceGatewayLogIngestionCursor,
	getGatewayLogIngestionCursor,
	listUnrecordedProviderUsageCalls,
	listUnsettledBillableGatewayCalls,
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
