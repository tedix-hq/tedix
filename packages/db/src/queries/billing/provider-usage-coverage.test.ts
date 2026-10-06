import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { billingProviderUsage } from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getWorkstationCostCoverage } from "./provider-usage";

const window = {
	organizationId: "fictional-org",
	periodStart: "2026-09-01T00:00:00.000Z",
	periodEnd: "2026-10-01T00:00:00.000Z",
};
const evidence = {
	pricingStatus: "allocated",
	allocation: {
		basis: "workstation_lease_wall_clock_share",
		chargeSourceRef: "fictional-bill",
		chargePeriod: "2026-08-28T00:00:00.000Z..2026-09-28T00:00:00.000Z",
		chargeTotalMicros: 1000,
		shareBasisPoints: 5000,
	},
};
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(billingProviderUsage));
	const db = createDbClient(createD1Facade(sqlite));
	let seq = 0;
	function insert(patch: Record<string, unknown> = {}) {
		const row = {
			id: `row-${++seq}`,
			organization_id: window.organizationId,
			created_at: "2026-09-20T00:00:00.000Z",
			customer_metering_ready: 0,
			provider: "cloudflare",
			model: "container:standard-1",
			usage_kind: "workstation_compute",
			unit: "compute_seconds",
			quantity: 10,
			provider_cost_micros: 500,
			provider_cost_quality: "provider_reconciled",
			occurred_at: "2026-09-20T00:00:00.000Z",
			metadata: JSON.stringify(evidence),
			...patch,
		};
		const keys = Object.keys(row);
		sqlite
			.prepare(
				`INSERT INTO billing_provider_usage (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
			)
			.run(...(Object.values(row) as never[]));
	}
	return { sqlite, db, insert };
}
describe("recorded workstation allocated coverage", () => {
	it("scopes organization, provider units and lease-end half-open window without writes", async () => {
		const f = fixture();
		f.insert();
		f.insert({ provider_cost_quality: "estimated", provider_cost_micros: 0 });
		f.insert({ provider_cost_quality: "unknown" });
		for (const patch of [
			{ organization_id: "another-org" },
			{ organization_id: null },
			{ provider: "cloudflare-containers" },
			{ unit: "seconds" },
			{ usage_kind: "voice_stt" },
			{ occurred_at: window.periodEnd },
			{ occurred_at: "2026-08-31T23:59:59.999Z" },
		])
			f.insert(patch);
		f.insert({ occurred_at: window.periodStart, provider_cost_micros: 0 });
		const before = f.sqlite.prepare("SELECT total_changes() AS n").get();
		const r = await getWorkstationCostCoverage(f.db, window);
		expect(r.total).toEqual({ rowCount: 4, leaseSeconds: 40 });
		expect(r.reconciled.rowCount).toBe(2);
		expect(r.pending.rowCount).toBe(1);
		expect(r.unproven.rowCount).toBe(1);
		expect(r.knownAttributedCostMicros).toBe(500);
		expect(r.status).toBe("partial");
		expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
			before,
		);
		f.sqlite.close();
	});
	it("empty usage is unknown rather than free; allocated zero is evidenced", async () => {
		const f = fixture();
		expect(
			(await getWorkstationCostCoverage(f.db, window))
				.knownAttributedCostMicros,
		).toBeNull();
		f.insert({
			provider_cost_micros: 0,
			metadata: JSON.stringify({
				...evidence,
				allocation: { ...evidence.allocation, shareBasisPoints: 0 },
			}),
		});
		expect(await getWorkstationCostCoverage(f.db, window)).toMatchObject({
			knownAttributedCostMicros: 0,
			status: "recorded_rows_reconciled",
		});
		f.sqlite.close();
	});
	const badMetadata = [
		"{",
		"null",
		"[]",
		"{}",
		JSON.stringify({ ...evidence, pricingStatus: "pending_allocation" }),
		...[
			{ basis: "other" },
			{ chargeSourceRef: " " },
			{ chargeSourceRef: "\t\n\u00a0\ufeff" },
			{ chargePeriod: "" },
			{ chargePeriod: "2026-09-01..2026-10-01" },
			{ chargePeriod: "2026-09-01T00:00:00Z..2026-09-01T00:00:00Z" },
			{ chargePeriod: "2026-10-01T00:00:00Z..2026-09-01T00:00:00Z" },
			{ chargePeriod: "2026-08-01T00:00:00Z..2026-09-01T00:00:00Z" },
			{ chargePeriod: "2026-09-01T00:00:00Z..2026-10-01T00:00:00Z..x" },
			{ chargeTotalMicros: -1 },
			{ chargeTotalMicros: 1.5 },
			{ chargeTotalMicros: "1000" },
			{ chargeTotalMicros: Number.MAX_SAFE_INTEGER + 1 },
			{ chargeTotalMicros: 499 },
			{ shareBasisPoints: -1 },
			{ shareBasisPoints: 10001 },
			{ shareBasisPoints: 0.1 },
			{ shareBasisPoints: null },
		].map((patch) =>
			JSON.stringify({
				...evidence,
				allocation: { ...evidence.allocation, ...patch },
			}),
		),
	];
	for (const metadata of badMetadata)
		it(`keeps malformed allocation unproven: ${metadata}`, async () => {
			const f = fixture();
			f.insert({ metadata });
			expect(await getWorkstationCostCoverage(f.db, window)).toMatchObject({
				knownAttributedCostMicros: null,
				unproven: { rowCount: 1, leaseSeconds: 10 },
			});
			f.sqlite.close();
		});
	for (const patch of [
		{ quantity: -1 },
		{ quantity: 0.5 },
		{ quantity: Number.MAX_SAFE_INTEGER + 1 },
		{ provider_cost_micros: -1 },
		{ provider_cost_micros: 0.5 },
		{ provider_cost_micros: Number.MAX_SAFE_INTEGER + 1 },
	])
		it(`refuses unsafe source numbers ${JSON.stringify(patch)}`, async () => {
			const f = fixture();
			f.insert(patch);
			await expect(getWorkstationCostCoverage(f.db, window)).rejects.toThrow();
			f.sqlite.close();
		});
	it("refuses unsafe aggregate quantity/cost, including individually safe rows", async () => {
		const f = fixture();
		f.insert({ quantity: Number.MAX_SAFE_INTEGER });
		f.insert();
		await expect(getWorkstationCostCoverage(f.db, window)).rejects.toThrow();
		f.sqlite.close();
	});
	it("compares ISO allocation instants across offsets", async () => {
		const f = fixture();
		f.insert({
			metadata: JSON.stringify({
				...evidence,
				allocation: {
					...evidence.allocation,
					chargePeriod: "2026-09-01T01:00:00+01:00..2026-10-01T01:00:00+01:00",
				},
			}),
		});
		expect(
			(await getWorkstationCostCoverage(f.db, window)).reconciled.rowCount,
		).toBe(1);
		f.sqlite.close();
	});
	it("rejects reversed or invalid query windows", async () => {
		const f = fixture();
		for (const patch of [
			{ periodEnd: window.periodStart },
			{ periodStart: "bad" },
			{ organizationId: " " },
		])
			await expect(
				getWorkstationCostCoverage(f.db, { ...window, ...patch }),
			).rejects.toThrow();
		f.sqlite.close();
	});
	it("aggregates the full recorded window beyond allocator's 500-row batch", async () => {
		const f = fixture();
		for (let n = 0; n < 501; n++)
			f.insert({ provider_cost_quality: "estimated", provider_cost_micros: 0 });
		expect(await getWorkstationCostCoverage(f.db, window)).toMatchObject({
			total: { rowCount: 501, leaseSeconds: 5010 },
			pending: { rowCount: 501, leaseSeconds: 5010 },
			knownAttributedCostMicros: null,
		});
		f.sqlite.close();
	});
	it("refuses reconciled subtotal overflow without unsafe perrow evidence", async () => {
		const f = fixture();
		const metadata = JSON.stringify({
			...evidence,
			allocation: {
				...evidence.allocation,
				chargeTotalMicros: Number.MAX_SAFE_INTEGER,
			},
		});
		f.insert({ metadata, provider_cost_micros: Number.MAX_SAFE_INTEGER });
		f.insert({ metadata, provider_cost_micros: 1 });
		await expect(getWorkstationCostCoverage(f.db, window)).rejects.toThrow();
		f.sqlite.close();
	});
	for (const end of [
		"2026-09-31T00:00:00Z",
		"2026-09-28T24:00:00Z",
		"2026-09-28T00:60:00Z",
		"2026-09-28T00:00:60Z",
		"2026-09-28T00:00:00+24:00",
	])
		it(`invalid ISO allocation remains unproven: ${end}`, async () => {
			const f = fixture();
			f.insert({
				metadata: JSON.stringify({
					...evidence,
					allocation: {
						...evidence.allocation,
						chargePeriod: `2026-09-01T00:00:00Z..${end}`,
					},
				}),
			});
			expect(
				(await getWorkstationCostCoverage(f.db, window)).reconciled.rowCount,
			).toBe(0);
			f.sqlite.close();
		});
});
