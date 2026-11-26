/** Canonical billing provider-usage queries. */

import {
	DYNAMIC_WORKER_PROVIDER,
	DYNAMIC_WORKER_COST_USD_MICROS,
} from "@tedix/api-contract/utils/credit-pricing";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	eq,
	gte,
	lt,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonType } from "../../core-store/dialect";
import {
	type BillingProviderUsage,
	billingProviderUsage as schemaBillingProviderUsage,
	billingUsageQuarantines as schemaBillingUsageQuarantines,
} from "../../schema/billing";
import { batchNonEmpty } from "../../utils/batch";

const postgres = (db: object) => coreStore(db) === "postgres";
/** json_type text on D1; #>> text on Postgres. */
function jgetText(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	return jsonRead(db, doc, path, "text");
}
function jgetNumber(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	return jsonRead(db, doc, path, "number");
}
/** json_type normalized to jsonb_typeof vocabulary on both stores. */
function jtype(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	return jsonType(db, doc, path);
}
/** json_valid + object guard producing a jsonb/text document on both stores. */
function jsonDocument(db: object, doc: SQLWrapper): SQL {
	return postgres(db)
		? sql`CASE WHEN pg_input_is_valid(${doc}::text, 'jsonb') AND jsonb_typeof(${doc}) = 'object' THEN ${doc} ELSE '{}'::jsonb END`
		: sql`CASE WHEN json_valid(${doc}) THEN CASE WHEN json_type(${doc}) = 'object' THEN ${doc} ELSE '{}' END ELSE '{}' END`;
}
/** SQLite json_type 'integer' excludes reals; Postgres jsonb keeps the literal text. */
function jinteger(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	if (!postgres(db))
		return sql`json_type(${doc}, ${`$.${path.join(".")}`}) = 'integer'`;
	return sql`(jsonb_typeof(${doc} #> ${`{${path.join(",")}}`}::text[]) = 'number' AND (${doc} #>> ${`{${path.join(",")}}`}::text[]) ~ '^-?[0-9]+$')`;
}

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
	const usage = coreTable(db, schemaBillingProviderUsage);
	const duplicateConditions = [];
	if (input.gatewayLogId) {
		duplicateConditions.push(eq(usage.gatewayLogId, input.gatewayLogId));
	}
	if (input.providerUsageId) {
		duplicateConditions.push(eq(usage.providerUsageId, input.providerUsageId));
	}
	const [existing] = await db
		.select()
		.from(usage)
		.where(or(...duplicateConditions))
		.limit(1);
	if (existing) return existing;

	const [created] = await db
		.insert(usage)
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
		.from(usage)
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
		reason: (typeof schemaBillingUsageQuarantines.$inferInsert)["reason"];
		sourceSnapshotAt: string;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	}>,
): Promise<number> {
	const quarantines = coreTable(db, schemaBillingUsageQuarantines);
	let inserted = 0;
	// Seven bound values per row; ten stays below D1's 100-variable ceiling.
	const chunkSize = postgres(db) ? 200 : 10;
	for (let offset = 0; offset < rows.length; offset += chunkSize) {
		const chunk = rows.slice(offset, offset + chunkSize);
		if (chunk.length === 0) continue;
		const created = await db
			.insert(quarantines)
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
			.returning({ id: quarantines.id });
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
	const usage = coreTable(db, schemaBillingProviderUsage);
	const orgFilter = options.organizationId
		? [eq(usage.organizationId, options.organizationId)]
		: [];

	const [current] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${usage.providerCostMicros}), 0)`,
			quantity: sql<number>`COALESCE(SUM(${usage.quantity}), 0)`,
		})
		.from(usage)
		.where(
			and(
				...orgFilter,
				eq(usage.usageKind, options.usageKind),
				gte(usage.occurredAt, windowStart.toISOString()),
			),
		);

	const [baseline] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${usage.providerCostMicros}), 0)`,
		})
		.from(usage)
		.where(
			and(
				...orgFilter,
				eq(usage.usageKind, options.usageKind),
				gte(usage.occurredAt, baselineStart.toISOString()),
				lt(usage.occurredAt, windowStart.toISOString()),
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
	const usage = coreTable(db, schemaBillingProviderUsage);
	const [total] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${usage.providerCostMicros}), 0)`,
			rows: sql<number>`COUNT(*)`,
		})
		.from(usage)
		.where(
			and(
				eq(usage.usageKind, "workstation_compute"),
				gte(usage.occurredAt, periodStart),
				lt(usage.occurredAt, periodEnd),
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
	const usage = coreTable(db, schemaBillingProviderUsage);
	const rows = await db
		.select({
			id: usage.id,
			metadata: usage.metadata,
			organizationId: usage.organizationId,
			quantity: usage.quantity,
		})
		.from(usage)
		.where(
			and(
				eq(usage.usageKind, "workstation_compute"),
				gte(usage.occurredAt, options.periodStart),
				lt(usage.occurredAt, options.periodEnd),
			),
		)
		.orderBy(usage.id)
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
	const usage = coreTable(db, schemaBillingProviderUsage);
	let updated = 0;
	for (let index = 0; index < allocations.length; index += CHUNK) {
		const chunk = allocations.slice(index, index + CHUNK);
		await db.batch(
			batchNonEmpty(
				chunk.map((allocation) =>
					db
						.update(usage)
						.set({
							metadata: allocation.metadata,
							providerCostMicros: allocation.providerCostMicros,
							providerCostQuality: "provider_reconciled",
						})
						.where(eq(usage.id, allocation.id)),
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

/** instr() 1-based substring position on both stores. */
function instrText(db: object, haystack: SQLWrapper, needle: string): SQL {
	return postgres(db)
		? sql`strpos(${haystack}, ${needle})`
		: sql`instr(${haystack}, ${needle})`;
}
/** trim() with an explicit code-point set on both stores. */
function trimChars(db: object, value: SQLWrapper, chars: string): SQL {
	return postgres(db)
		? sql`btrim(${value}, ${chars})`
		: sql`trim(${value}, ${chars})`;
}
/** julianday() instant comparisons on both stores. */
function instant(db: object, value: SQLWrapper): SQL {
	return postgres(db)
		? sql`CASE WHEN pg_input_is_valid(${value}, 'timestamp with time zone') THEN CASE WHEN ${value} ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN ${value}::timestamptz ELSE ${value}::timestamp AT TIME ZONE 'UTC' END END`
		: sql`julianday(${value})`;
}
const EVIDENCE_TRIM_CHARS = String.fromCodePoint(
	9,
	10,
	11,
	12,
	13,
	32,
	160,
	5760,
	8192,
	8193,
	8194,
	8195,
	8196,
	8197,
	8198,
	8199,
	8200,
	8201,
	8202,
	8232,
	8233,
	8239,
	8287,
	12288,
	65279,
);

/** SQLite date parsing alone accepts non-ISO strings. Keep stored allocation
 * evidence closed to explicit timestamp syntax before comparing instants. */
function allocationTimestamp(
	db: DbClient,
	column: "allocation_start" | "allocation_end",
) {
	const v = sql.identifier(column);
	if (postgres(db))
		return sql`(${v} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
 AND pg_input_is_valid(${v}, 'timestamp with time zone'))`;
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
	const pg = postgres(db);
	const usage = coreTable(db, schemaBillingProviderUsage);
	const scoped = db.$with("scoped").as(
		db
			.select({
				quantity: usage.quantity,
				cost: sql<number>`${usage.providerCostMicros}`.as("cost"),
				quality: sql<string>`${usage.providerCostQuality}`.as("quality"),
				occurred: sql<string>`${usage.occurredAt}`.as("occurred"),
				evidence: jsonDocument(db, usage.metadata).as("evidence"),
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
				chargePeriod: jgetText(db, scoped.evidence, [
					"allocation",
					"chargePeriod",
				]).as("charge_period"),
				chargeTotal: jgetNumber(db, scoped.evidence, [
					"allocation",
					"chargeTotalMicros",
				]).as("charge_total"),
				share: jgetNumber(db, scoped.evidence, [
					"allocation",
					"shareBasisPoints",
				]).as("share"),
				numericOk: sql<number>`CASE WHEN ${
					pg
						? sql`pg_typeof(${scoped.quantity}) IN ('smallint','integer','bigint')`
						: sql`typeof(${scoped.quantity}) = 'integer'`
				} AND ${scoped.quantity} BETWEEN 0 AND 9007199254740991
 AND ${
		pg
			? sql`pg_typeof(${scoped.cost}) IN ('smallint','integer','bigint')`
			: sql`typeof(${scoped.cost}) = 'integer'`
 } AND ${scoped.cost} BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END`.as(
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
				allocationStart: (pg
					? sql`substr(${fields.chargePeriod}, 1, GREATEST(${instrText(db, fields.chargePeriod, "..")} - 1, 0))`
					: sql`substr(${fields.chargePeriod}, 1, ${instrText(db, fields.chargePeriod, "..")} - 1)`
				).as("allocation_start"),
				allocationEnd:
					sql<string>`substr(${fields.chargePeriod}, ${instrText(db, fields.chargePeriod, "..")} + 2)`.as(
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
 AND ${jtype(db, p.evidence, ["pricingStatus"])} = 'string' AND ${jgetText(db, p.evidence, ["pricingStatus"])} = 'allocated'
 AND ${jtype(db, p.evidence, ["allocation"])} = 'object'
 AND ${jgetText(db, p.evidence, ["allocation", "basis"])} = 'workstation_lease_wall_clock_share'
 AND ${jtype(db, p.evidence, ["allocation", "chargeSourceRef"])} = 'string' AND length(${trimChars(db, jgetText(db, p.evidence, ["allocation", "chargeSourceRef"]), EVIDENCE_TRIM_CHARS)}) > 0
 AND ${jtype(db, p.evidence, ["allocation", "chargePeriod"])} = 'string' AND ${instrText(db, p.chargePeriod, "..")} > 0 AND ${instrText(db, p.allocationEnd, "..")} = 0
 AND ${allocationTimestamp(db, "allocation_start")} AND ${allocationTimestamp(db, "allocation_end")}
 AND ${instant(db, p.allocationStart)} < ${instant(db, p.allocationEnd)}
 AND ${instant(db, p.occurred)} >= ${instant(db, p.allocationStart)} AND ${instant(db, p.occurred)} < ${instant(db, p.allocationEnd)}
 AND ${jinteger(db, p.evidence, ["allocation", "chargeTotalMicros"])} AND ${p.chargeTotal} BETWEEN 0 AND 9007199254740991 AND ${p.cost} <= ${p.chargeTotal}
 AND ${jinteger(db, p.evidence, ["allocation", "shareBasisPoints"])} AND ${p.share} BETWEEN 0 AND 10000
 THEN 'reconciled' WHEN ${p.quality} = 'estimated' THEN 'pending' ELSE 'unproven' END`.as(
					"category",
				),
			})
			.from(p),
	);
	const c = classified;
	// Group once by category instead of one SUM(CASE category ...) per output:
	// SQLite inlines the CTEs, so every reference to the category re-ran the
	// whole JSON classification for each row (about 290 ms a call in
	// production on 21 Nov 2026, enough to tip main D1 into overload).
	const groups = await db
		.with(scoped, fields, periods, classified)
		.select({
			category: c.category,
			numericOk: c.numericOk,
			rows: sql<number>`COUNT(*)`,
			// Postgres SUM(bigint) is numeric and drivers return it as text;
			// float8 keeps the totals numeric for the safe-integer checks below.
			seconds: sql<number>`COALESCE(SUM(${c.quantity})${pg ? sql`::float8` : sql``}, 0)`,
			cost: sql<number>`COALESCE(SUM(${c.cost})${pg ? sql`::float8` : sql``}, 0)`,
		})
		.from(c)
		.groupBy(c.category, c.numericOk);
	const totals: Record<string, number> = {
		total_rows: 0,
		total_seconds: 0,
		invalid_rows: 0,
		reconciled_rows: 0,
		reconciled_seconds: 0,
		reconciled_cost: 0,
		pending_rows: 0,
		pending_seconds: 0,
		unproven_rows: 0,
		unproven_seconds: 0,
	};
	const add = (key: string, value: unknown) => {
		totals[key] = (totals[key] ?? 0) + (value as number);
	};
	for (const group of groups) {
		const { category, numericOk, rows, seconds, cost } = group as Record<
			string,
			unknown
		>;
		if (
			typeof rows !== "number" ||
			!Number.isSafeInteger(rows) ||
			rows < 0 ||
			!["reconciled", "pending", "unproven"].includes(category as string)
		)
			throw new Error("Unsafe workstation usage numeric evidence");
		add("total_rows", rows);
		add(`${category}_rows`, rows);
		if (numericOk !== 1) {
			add("invalid_rows", rows);
			continue;
		}
		add("total_seconds", seconds);
		add(`${category}_seconds`, seconds);
		if (category === "reconciled") add("reconciled_cost", cost);
	}
	const row = totals as Record<string, unknown>;
	if (
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

/**
 * Allocate in one statement: tens of thousands of daily loads must not require
 * one D1 subrequest per row. A row carries `quantity` loads (one row per run
 * and identity), so shares are per load unit, not per row. The windowed share
 * key keeps the count and ordered remainder split on the same snapshot,
 * including during late arrivals.
 */
export async function applyDynamicWorkerCostAllocation(
	db: DbClient,
	input: {
		periodStart: string;
		periodEnd: string;
		totalCostMicros: number;
		billedQuantity: number | null;
		evidenceRef: string;
	},
) {
	if (!Number.isSafeInteger(input.totalCostMicros) || input.totalCostMicros < 0)
		throw new Error("Invalid Dynamic Worker charge");
	const billed =
		input.billedQuantity !== null &&
		Number.isSafeInteger(input.billedQuantity) &&
		input.billedQuantity > 0
			? input.billedQuantity
			: null;
	if (billed !== null && !Number.isSafeInteger(input.totalCostMicros * billed))
		throw new Error(
			"Dynamic Worker allocation exceeds safe monetary precision",
		);

	// A bound JS number can arrive as REAL, which would turn the integer share
	// split into fractions; cast the validated safe integers back.
	const billedSql = sql`CAST(${billed} AS INTEGER)`;
	const totalSql = sql`CAST(${input.totalCostMicros} AS INTEGER)`;
	const unitSql = sql`CAST(${DYNAMIC_WORKER_COST_USD_MICROS} AS INTEGER)`;
	const pg = postgres(db);
	const usage = coreTable(db, schemaBillingProviderUsage);
	const targets = db.$with("worker_targets").as(
		db
			.select({
				id: usage.id,
				metadata: usage.metadata,
				quantity: usage.quantity,
				// Units through this row in id order; the row owns load units
				// (cumulative - quantity, cumulative].
				cumulative:
					sql<number>`SUM(${usage.quantity}) OVER (ORDER BY ${usage.id} ROWS UNBOUNDED PRECEDING)`.as(
						"cumulative",
					),
				n: sql<number>`SUM(${usage.quantity}) OVER ()`.as("n"),
			})
			.from(usage)
			.where(
				and(
					eq(usage.provider, DYNAMIC_WORKER_PROVIDER),
					sql`${usage.organizationId} IS NOT NULL`,
					sql`${usage.quantity} > 0`,
					sql`${jgetText(db, usage.metadata, ["identity"])} = 'anonymous'`,
					gte(usage.occurredAt, input.periodStart),
					lt(usage.occurredAt, input.periodEnd),
				),
			),
	);
	// SQLite `/` is float division and `%` is fmod; Postgres integer `/` and `%`
	// truncate, so the share math is spelled out in float8 there. LEAST/GREATEST
	// replace SQLite's two-argument MIN/MAX.
	const least = (a: SQLWrapper, b: SQLWrapper) =>
		pg ? sql`LEAST(${a}, ${b})` : sql`MIN(${a}, ${b})`;
	const greatest = (a: SQLWrapper, b: SQLWrapper) =>
		pg ? sql`GREATEST(${a}, ${b})` : sql`MAX(${a}, ${b})`;
	const shareDiv = (numerator: SQLWrapper, denominator: SQLWrapper) =>
		pg
			? sql`(${numerator})::float8 / ${denominator}`
			: sql`${numerator} / ${denominator}`;
	const modulo = (value: SQLWrapper, divisor: SQLWrapper) =>
		pg
			? sql`(${value} - trunc((${value}) / (${divisor})) * (${divisor}))`
			: sql`${value} % ${divisor}`;
	const totals = db.$with("worker_totals").as(
		db
			.select({
				id: targets.id,
				metadata: targets.metadata,
				quantity: targets.quantity,
				cumulative: targets.cumulative,
				n: targets.n,
				allocated:
					sql<number>`CASE WHEN ${billedSql} IS NULL THEN 0 ELSE ${shareDiv(sql`${totalSql} * ${least(targets.n, billedSql)}`, billedSql)} END`.as(
						"allocated",
					),
			})
			.from(targets),
	);
	const updates = db.$with("worker_updates").as(
		db
			.select({
				id: totals.id,
				// Each load unit gets allocated / n; the first allocated % n units
				// in id order get one extra micro.
				cost: sql<number>`CASE WHEN ${billedSql} IS NULL THEN ${unitSql} * ${totals.quantity}
   ELSE ${totals.quantity} * (${shareDiv(totals.allocated, totals.n)})
    + ${greatest(sql`0`, sql`${least(totals.cumulative, modulo(totals.allocated, totals.n))} - (${totals.cumulative} - ${totals.quantity})`)} END${pg ? sql`::bigint` : sql``}`.as(
					"cost",
				),
				quality: sql<
					BillingProviderUsage["providerCostQuality"]
				>`CASE WHEN ${billedSql} IS NULL THEN 'estimated' ELSE 'provider_reconciled' END`.as(
					"quality",
				),
				evidence: pg
					? sql<
							Record<string, JsonValue>
						>`jsonb_set(jsonb_set(${totals.metadata}, '{pricingStatus}', to_jsonb(CASE WHEN ${billedSql} IS NULL THEN 'pending' ELSE 'allocated' END)), '{allocation}', jsonb_build_object(
   'basis', 'anonymous_worker_load_share', 'chargePeriod', CAST(${`${input.periodStart}..${input.periodEnd}`} AS text),
   'chargeSourceRef', CAST(${input.evidenceRef} AS text), 'chargeTotalMicros', ${totalSql},
   'billedQuantity', ${billedSql}, 'recordedQuantity', ${totals.n}
  ))`.as("evidence")
					: sql<
							Record<string, JsonValue>
						>`json_set(${totals.metadata}, '$.pricingStatus', CASE WHEN ${billedSql} IS NULL THEN 'pending' ELSE 'allocated' END, '$.allocation', json_object(
   'basis', 'anonymous_worker_load_share', 'chargePeriod', ${`${input.periodStart}..${input.periodEnd}`},
   'chargeSourceRef', ${input.evidenceRef}, 'chargeTotalMicros', ${totalSql},
   'billedQuantity', ${billedSql}, 'recordedQuantity', ${totals.n}
  ))`.as("evidence"),
			})
			.from(totals),
	);
	await db
		.with(targets, totals, updates)
		.update(usage)
		.set({
			providerCostMicros: sql`${updates.cost}`,
			providerCostQuality: sql`${updates.quality}`,
			metadata: sql`${updates.evidence}`,
		})
		.from(updates)
		.where(
			and(
				eq(usage.id, updates.id),
				sql`(${usage.providerCostMicros} != ${updates.cost} OR ${usage.providerCostQuality} != ${updates.quality} OR ${usage.metadata} != ${updates.evidence})`,
			),
		);
}

/** Provider totals must come from allocated rows, never customer estimates. */
export async function sumDynamicWorkerAllocatedCost(
	db: DbClient,
	input: { periodStart: string; periodEnd: string },
) {
	const usage = coreTable(db, schemaBillingProviderUsage);
	const [row] = await db
		.select({
			micros: sql<number>`COALESCE(SUM(${usage.providerCostMicros}), 0)`,
			rows: sql<number>`COUNT(*)`,
		})
		.from(usage)
		.where(
			and(
				eq(usage.provider, DYNAMIC_WORKER_PROVIDER),
				eq(usage.providerCostQuality, "provider_reconciled"),
				sql`${usage.organizationId} IS NOT NULL`,
				gte(usage.occurredAt, input.periodStart),
				lt(usage.occurredAt, input.periodEnd),
				sql`${jgetText(db, usage.metadata, ["allocation", "chargePeriod"])} = ${`${input.periodStart}..${input.periodEnd}`}`,
			),
		);
	return { micros: Number(row?.micros ?? 0), rows: Number(row?.rows ?? 0) };
}
