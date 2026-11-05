/** Canonical billing provider-usage queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingProviderUsage,
	billingProviderUsage,
	billingUsageQuarantines,
} from "../../schema/billing";
import { batchNonEmpty } from "../../utils/batch";

export async function recordBillingProviderUsage(
	db: DbClient,
	input: {
		id: string;
		organizationId?: string | null;
		tediId?: string | null;
		reservationId?: string | null;
		gatewayLogId?: string | null;
		providerUsageId?: string | null;
		provider: string;
		model: string;
		usageKind: BillingProviderUsage["usageKind"];
		unit: BillingProviderUsage["unit"];
		quantity: number;
		providerCostMicros: number;
		providerCostQuality: BillingProviderUsage["providerCostQuality"];
		occurredAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingProviderUsage> {
	if (
		!Number.isSafeInteger(input.quantity) ||
		input.quantity <= 0 ||
		!Number.isSafeInteger(input.providerCostMicros) ||
		input.providerCostMicros < 0
	) {
		throw new Error(
			"Provider usage requires positive integer quantity and non-negative integer cost micros",
		);
	}
	if (!input.gatewayLogId && !input.providerUsageId) {
		throw new Error(
			"gatewayLogId or providerUsageId is required for provider usage",
		);
	}
	const duplicateConditions = [];
	if (input.gatewayLogId) {
		duplicateConditions.push(
			eq(billingProviderUsage.gatewayLogId, input.gatewayLogId),
		);
	}
	if (input.providerUsageId) {
		duplicateConditions.push(
			eq(billingProviderUsage.providerUsageId, input.providerUsageId),
		);
	}
	const [existing] = await db
		.select()
		.from(billingProviderUsage)
		.where(or(...duplicateConditions))
		.limit(1);
	if (existing) return existing;

	const [created] = await db
		.insert(billingProviderUsage)
		.values({
			id: input.id,
			organizationId: input.organizationId ?? null,
			tediId: input.tediId ?? null,
			reservationId: input.reservationId ?? null,
			gatewayLogId: input.gatewayLogId ?? null,
			providerUsageId: input.providerUsageId ?? null,
			provider: input.provider,
			model: input.model,
			usageKind: input.usageKind,
			unit: input.unit,
			quantity: input.quantity,
			providerCostMicros: input.providerCostMicros,
			providerCostQuality: input.providerCostQuality,
			customerMeteringReady: false,
			occurredAt: input.occurredAt,
			metadata: input.metadata ?? {},
			createdAt: input.now,
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;

	const [raced] = await db
		.select()
		.from(billingProviderUsage)
		.where(or(...duplicateConditions))
		.limit(1);
	if (!raced) throw new Error("Failed to record provider usage");
	return raced;
}

export async function recordBillingUsageQuarantines(
	db: DbClient,
	rows: Array<{
		gatewayLogId: string;
		organizationId?: string | null;
		reason: (typeof billingUsageQuarantines.$inferInsert)["reason"];
		sourceSnapshotAt: string;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	}>,
): Promise<number> {
	let inserted = 0;
	// Seven bound values per row; ten stays below D1's 100-variable ceiling.
	for (let offset = 0; offset < rows.length; offset += 10) {
		const chunk = rows.slice(offset, offset + 10);
		if (chunk.length === 0) continue;
		const created = await db
			.insert(billingUsageQuarantines)
			.values(
				chunk.map((row) => ({
					id: `gateway:${row.gatewayLogId}`,
					gatewayLogId: row.gatewayLogId,
					organizationId: row.organizationId ?? null,
					reason: row.reason,
					sourceSnapshotAt: row.sourceSnapshotAt,
					metadata: row.metadata ?? {},
					createdAt: row.createdAt,
				})),
			)
			.onConflictDoNothing()
			.returning({ id: billingUsageQuarantines.id });
		inserted += created.length;
	}
	return inserted;
}

/** Daily provider-unit spend with the same anomaly shape as token spend. */
export interface DailyProviderUnitSpend {
	usageKind: BillingProviderUsage["usageKind"];
	asOf: string;
	dailyMicros: number;
	dailyQuantity: number;
	sevenDayAvgDailyMicros: number;
	/** 0 = normal, 0.5 = >2x baseline, 1 = >3x baseline. */
	anomalyScore: number;
}

/**
 * Daily spend for one provider-usage kind, for anomaly detection.
 *
 * `getDailySpendRate` only reads `tedi_call_costs`, so the 9am cost-anomaly
 * check has been blind to every non-token compute class — including workstation
 * containers, the one class a tedi escalates to deliberately and the one where a
 * leaked lease burns money with no conversation to attribute it to.
 *
 * Baseline is the 7 days BEFORE the current window, matching the token check, so
 * the two scores mean the same thing when they appear side by side.
 */
export async function getDailyProviderUnitSpend(
	db: DbClient,
	options: {
		usageKind: BillingProviderUsage["usageKind"];
		organizationId?: string | null;
		now?: string;
		lookbackDays?: number;
	},
): Promise<DailyProviderUnitSpend> {
	const now = options.now ? new Date(options.now) : new Date();
	const lookbackDays = options.lookbackDays ?? 1;
	const windowStart = new Date(
		now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
	);
	const baselineStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
	const orgFilter = options.organizationId
		? [eq(billingProviderUsage.organizationId, options.organizationId)]
		: [];

	const [current] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${billingProviderUsage.providerCostMicros}), 0)`,
			quantity: sql<number>`COALESCE(SUM(${billingProviderUsage.quantity}), 0)`,
		})
		.from(billingProviderUsage)
		.where(
			and(
				...orgFilter,
				eq(billingProviderUsage.usageKind, options.usageKind),
				gte(billingProviderUsage.occurredAt, windowStart.toISOString()),
			),
		);

	const [baseline] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${billingProviderUsage.providerCostMicros}), 0)`,
		})
		.from(billingProviderUsage)
		.where(
			and(
				...orgFilter,
				eq(billingProviderUsage.usageKind, options.usageKind),
				gte(billingProviderUsage.occurredAt, baselineStart.toISOString()),
				lt(billingProviderUsage.occurredAt, windowStart.toISOString()),
			),
		);

	const dailyMicros = Number(current?.micros ?? 0);
	const sevenDayAvgDailyMicros = Number(baseline?.micros ?? 0) / 7;
	// No baseline means no history to be anomalous against — a first-ever row is
	// not a spike, and scoring it as one would make the very first workstation
	// lease page someone.
	const anomalyScore =
		sevenDayAvgDailyMicros <= 0
			? 0
			: dailyMicros > sevenDayAvgDailyMicros * 3
				? 1
				: dailyMicros > sevenDayAvgDailyMicros * 2
					? 0.5
					: 0;

	return {
		anomalyScore,
		asOf: now.toISOString(),
		dailyMicros,
		dailyQuantity: Number(current?.quantity ?? 0),
		sevenDayAvgDailyMicros,
		usageKind: options.usageKind,
	};
}

/**
 * Total attributed workstation container cost in a charge period.
 *
 * The counterpart to Cloudflare's account-level Containers figure: they say
 * what the account was billed, this says how much of it we could attribute to a
 * tenant. The gap is the unattributed remainder.
 */
export async function sumWorkstationComputeMicros(
	db: DbClient,
	periodStart: string,
	periodEnd: string,
): Promise<{ micros: number; rows: number }> {
	const [total] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${billingProviderUsage.providerCostMicros}), 0)`,
			rows: sql<number>`COUNT(*)`,
		})
		.from(billingProviderUsage)
		.where(
			and(
				eq(billingProviderUsage.usageKind, "workstation_compute"),
				gte(billingProviderUsage.occurredAt, periodStart),
				lt(billingProviderUsage.occurredAt, periodEnd),
			),
		);
	return { micros: Number(total?.micros ?? 0), rows: Number(total?.rows ?? 0) };
}

export interface WorkstationComputeAllocationTarget {
	id: string;
	organizationId: string | null;
	quantity: number;
	metadata: Record<string, JsonValue>;
}

/**
 * Workstation container rows eligible to receive a share of a Containers bill.
 *
 * Ordered by id so the allocator's largest-remainder tie-break is stable across
 * reruns: the same period must always distribute the same rounding cents to the
 * same rows, or replaying a settled window would silently move cost between
 * tenants.
 */
export async function listWorkstationComputeForAllocation(
	db: DbClient,
	options: { periodStart: string; periodEnd: string; limit: number },
): Promise<WorkstationComputeAllocationTarget[]> {
	const rows = await db
		.select({
			id: billingProviderUsage.id,
			metadata: billingProviderUsage.metadata,
			organizationId: billingProviderUsage.organizationId,
			quantity: billingProviderUsage.quantity,
		})
		.from(billingProviderUsage)
		.where(
			and(
				eq(billingProviderUsage.usageKind, "workstation_compute"),
				gte(billingProviderUsage.occurredAt, options.periodStart),
				lt(billingProviderUsage.occurredAt, options.periodEnd),
			),
		)
		.orderBy(billingProviderUsage.id)
		.limit(options.limit);
	return rows.map((row) => ({
		id: row.id,
		metadata: row.metadata ?? {},
		organizationId: row.organizationId,
		quantity: Number(row.quantity ?? 0),
	}));
}

/**
 * Write allocated container cost onto existing `workstation_compute` rows.
 *
 * An UPDATE rather than a new row on purpose: the lease row already carries the
 * org, tedi, Work Item, and quantity, and it is unique on
 * `provider_usage_id`. Inserting a parallel priced row would double the
 * attributed quantity and break the very reconciliation this feeds.
 *
 * `db.batch()` is the transaction primitive here — D1 rejects `BEGIN`, so
 * `db.transaction()` would fail at runtime while passing every local test.
 */
export async function applyWorkstationComputeCostAllocation(
	db: DbClient,
	allocations: {
		id: string;
		providerCostMicros: number;
		metadata: Record<string, JsonValue>;
	}[],
): Promise<number> {
	if (allocations.length === 0) return 0;
	// Each statement binds 4 parameters, far under D1's 100-per-statement cap;
	// the chunk exists to keep one batch payload bounded on a backlog replay.
	const CHUNK = 25;
	let updated = 0;
	for (let index = 0; index < allocations.length; index += CHUNK) {
		const chunk = allocations.slice(index, index + CHUNK);
		await db.batch(
			batchNonEmpty(
				chunk.map((allocation) =>
					db
						.update(billingProviderUsage)
						.set({
							metadata: allocation.metadata,
							providerCostMicros: allocation.providerCostMicros,
							providerCostQuality: "provider_reconciled",
						})
						.where(eq(billingProviderUsage.id, allocation.id)),
				),
			),
		);
		updated += chunk.length;
	}
	return updated;
}

export interface WorkstationCostCoverageResult {
	periodStart: string;
	periodEnd: string;
	observedAt: string;
	unit: "compute_seconds";
	basis: "recorded_lease_end_wall_clock";
	status: "none" | "partial" | "recorded_rows_reconciled";
	knownAttributedCostMicros: number | null;
	total: { rowCount: number; leaseSeconds: number };
	reconciled: { rowCount: number; leaseSeconds: number };
	pending: { rowCount: number; leaseSeconds: number };
	unproven: { rowCount: number; leaseSeconds: number };
}

/** SQLite date parsing alone accepts non-ISO strings. Keep stored allocation
 * evidence closed to explicit timestamp syntax before comparing instants. */
function allocationTimestamp(column: "allocation_start" | "allocation_end") {
	const v = sql.identifier(column);
	return sql`(${v} GLOB '????-??-??T??:??:??*'
 AND (substr(${v},1,4) || substr(${v},6,2) || substr(${v},9,2) || substr(${v},12,2) || substr(${v},15,2) || substr(${v},18,2)) NOT GLOB '*[^0-9]*'
 AND date(substr(${v},1,10), '+0 days') = substr(${v},1,10)
 AND CAST(substr(${v},12,2) AS INTEGER) BETWEEN 0 AND 23
 AND CAST(substr(${v},15,2) AS INTEGER) BETWEEN 0 AND 59
 AND CAST(substr(${v},18,2) AS INTEGER) BETWEEN 0 AND 59
 AND (CASE WHEN substr(${v},-1) = 'Z' THEN
 (length(${v}) = 20 OR (length(${v}) > 21 AND substr(${v},20,1) = '.' AND substr(${v},21,length(${v})-21) NOT GLOB '*[^0-9]*'))
 ELSE (substr(${v},-6,1) IN ('+','-') AND substr(${v},-3,1) = ':'
 AND (substr(${v},-5,2) || substr(${v},-2,2)) NOT GLOB '*[^0-9]*'
 AND CAST(substr(${v},-5,2) AS INTEGER) BETWEEN 0 AND 23
 AND CAST(substr(${v},-2,2) AS INTEGER) BETWEEN 0 AND 59
 AND (length(${v}) = 25 OR (length(${v}) > 26 AND substr(${v},20,1) = '.' AND substr(${v},21,length(${v})-26) NOT GLOB '*[^0-9]*'))) END))`;
}

/** One scoped aggregate: no allocation, price reconstruction or financial writes.
 * Lease-end timestamps select the window; seconds are a wall-clock proxy.
 * Evidence establishes stored allocation consistency, not invoice verification.
 */
export async function getWorkstationCostCoverage(
	db: DbClient,
	input: {
		organizationId: string;
		periodStart: string;
		periodEnd: string;
	},
): Promise<WorkstationCostCoverageResult> {
	const start = Date.parse(input.periodStart),
		end = Date.parse(input.periodEnd);
	if (
		!input.organizationId.trim() ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start >= end
	)
		throw new Error("Invalid workstation coverage window or organization");
	const periodStart = new Date(start).toISOString(),
		periodEnd = new Date(end).toISOString();
	const usage = billingProviderUsage;
	const scoped = db.$with("scoped").as(
		db
			.select({
				quantity: usage.quantity,
				cost: sql<number>`${usage.providerCostMicros}`.as("cost"),
				quality: sql<string>`${usage.providerCostQuality}`.as("quality"),
				occurred: sql<string>`${usage.occurredAt}`.as("occurred"),
				evidence:
					sql<string>`CASE WHEN json_valid(${usage.metadata}) THEN CASE WHEN json_type(${usage.metadata}) = 'object' THEN ${usage.metadata} ELSE '{}' END ELSE '{}' END`.as(
						"evidence",
					),
			})
			.from(usage)
			.where(
				and(
					eq(usage.organizationId, input.organizationId),
					gte(usage.occurredAt, periodStart),
					lt(usage.occurredAt, periodEnd),
					sql`${usage.usageKind} = 'workstation_compute' AND ${usage.provider} = 'cloudflare' AND ${usage.unit} = 'compute_seconds'`,
				),
			),
	);
	const fields = db.$with("fields").as(
		db
			.select({
				quantity: scoped.quantity,
				cost: scoped.cost,
				quality: scoped.quality,
				occurred: scoped.occurred,
				evidence: scoped.evidence,
				chargePeriod:
					sql<string>`json_extract(${scoped.evidence}, '$.allocation.chargePeriod')`.as(
						"charge_period",
					),
				chargeTotal:
					sql<number>`json_extract(${scoped.evidence}, '$.allocation.chargeTotalMicros')`.as(
						"charge_total",
					),
				share:
					sql<number>`json_extract(${scoped.evidence}, '$.allocation.shareBasisPoints')`.as(
						"share",
					),
				numericOk:
					sql<number>`CASE WHEN typeof(${scoped.quantity}) = 'integer' AND ${scoped.quantity} BETWEEN 0 AND 9007199254740991
 AND typeof(${scoped.cost}) = 'integer' AND ${scoped.cost} BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END`.as(
						"numeric_ok",
					),
			})
			.from(scoped),
	);
	const periods = db.$with("periods").as(
		db
			.select({
				quantity: fields.quantity,
				cost: fields.cost,
				quality: fields.quality,
				occurred: fields.occurred,
				evidence: fields.evidence,
				chargePeriod: fields.chargePeriod,
				chargeTotal: fields.chargeTotal,
				share: fields.share,
				numericOk: fields.numericOk,
				allocationStart:
					sql<string>`substr(${fields.chargePeriod}, 1, instr(${fields.chargePeriod}, '..') - 1)`.as(
						"allocation_start",
					),
				allocationEnd:
					sql<string>`substr(${fields.chargePeriod}, instr(${fields.chargePeriod}, '..') + 2)`.as(
						"allocation_end",
					),
			})
			.from(fields),
	);
	const p = periods;
	const classified = db.$with("classified").as(
		db
			.select({
				quantity: p.quantity,
				cost: p.cost,
				numericOk: p.numericOk,
				category: sql<string>`CASE WHEN ${p.quality} = 'provider_reconciled'
 AND json_type(${p.evidence}, '$.pricingStatus') = 'text' AND json_extract(${p.evidence}, '$.pricingStatus') = 'allocated'
 AND json_type(${p.evidence}, '$.allocation') = 'object'
 AND json_extract(${p.evidence}, '$.allocation.basis') = 'workstation_lease_wall_clock_share'
 AND json_type(${p.evidence}, '$.allocation.chargeSourceRef') = 'text' AND length(trim(json_extract(${p.evidence}, '$.allocation.chargeSourceRef'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
 AND json_type(${p.evidence}, '$.allocation.chargePeriod') = 'text' AND instr(${p.chargePeriod}, '..') > 0 AND instr(${p.allocationEnd}, '..') = 0
 AND ${allocationTimestamp("allocation_start")} AND ${allocationTimestamp("allocation_end")}
 AND julianday(${p.allocationStart}) < julianday(${p.allocationEnd})
 AND julianday(${p.occurred}) >= julianday(${p.allocationStart}) AND julianday(${p.occurred}) < julianday(${p.allocationEnd})
 AND json_type(${p.evidence}, '$.allocation.chargeTotalMicros') = 'integer' AND ${p.chargeTotal} BETWEEN 0 AND 9007199254740991 AND ${p.cost} <= ${p.chargeTotal}
 AND json_type(${p.evidence}, '$.allocation.shareBasisPoints') = 'integer' AND ${p.share} BETWEEN 0 AND 10000
 THEN 'reconciled' WHEN ${p.quality} = 'estimated' THEN 'pending' ELSE 'unproven' END`.as(
					"category",
				),
			})
			.from(p),
	);
	const c = classified;
	const rows = await db
		.with(scoped, fields, periods, classified)
		.select({
			total_rows: sql<number>`COUNT(*)`,
			total_seconds: sql<number>`COALESCE(SUM(CASE WHEN ${c.numericOk} = 1 THEN ${c.quantity} ELSE 0 END), 0)`,
			invalid_rows: sql<number>`COALESCE(SUM(CASE WHEN ${c.numericOk} = 0 THEN 1 ELSE 0 END), 0)`,
			reconciled_rows: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'reconciled' THEN 1 ELSE 0 END), 0)`,
			reconciled_seconds: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'reconciled' AND ${c.numericOk} = 1 THEN ${c.quantity} ELSE 0 END), 0)`,
			reconciled_cost: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'reconciled' AND ${c.numericOk} = 1 THEN ${c.cost} ELSE 0 END), 0)`,
			pending_rows: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'pending' THEN 1 ELSE 0 END), 0)`,
			pending_seconds: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'pending' AND ${c.numericOk} = 1 THEN ${c.quantity} ELSE 0 END), 0)`,
			unproven_rows: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'unproven' THEN 1 ELSE 0 END), 0)`,
			unproven_seconds: sql<number>`COALESCE(SUM(CASE WHEN ${c.category} = 'unproven' AND ${c.numericOk} = 1 THEN ${c.quantity} ELSE 0 END), 0)`,
		})
		.from(c);
	const row = rows[0] as Record<string, unknown> | undefined;
	if (
		!row ||
		Object.values(row).some(
			(value) =>
				typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
		) ||
		row.invalid_rows !== 0
	)
		throw new Error("Unsafe workstation usage numeric evidence");
	const n = (key: string) => row[key] as number;
	const group = (prefix: string) => ({
		rowCount: n(`${prefix}_rows`),
		leaseSeconds: n(`${prefix}_seconds`),
	});
	return {
		periodStart,
		periodEnd,
		observedAt: new Date().toISOString(),
		unit: "compute_seconds",
		basis: "recorded_lease_end_wall_clock",
		status:
			n("total_rows") === 0
				? "none"
				: n("total_rows") === n("reconciled_rows")
					? "recorded_rows_reconciled"
					: "partial",
		knownAttributedCostMicros:
			n("reconciled_rows") === 0 ? null : n("reconciled_cost"),
		total: group("total"),
		reconciled: group("reconciled"),
		pending: group("pending"),
		unproven: group("unproven"),
	};
}
