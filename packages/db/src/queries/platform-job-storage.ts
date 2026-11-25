import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import {
	billingProviderUsage,
	billingSettlementCursors,
	billingUsageCharges,
	billingUsageQuarantines,
} from "../schema/billing";
import { organizations } from "../schema/organizations";
import {
	gatewayLogIngestionCursors,
	type NewGatewayLogIngestionCursor,
	type TediCallCost,
	tediCallCosts,
	tedis,
} from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";

const callRowid = sql<number>`${tediCallCosts}.rowid`;

export interface UnsettledGatewayCall {
	rowid: number;
	call: TediCallCost;
}

async function selectUnsettledBillableGatewayCalls(
	db: DbClient,
	limit: number,
	range: { afterRowid: number; throughRowid: number } | null,
	unreserved = false,
): Promise<UnsettledGatewayCall[]> {
	return db
		.select({ rowid: callRowid.as("call_rowid"), call: tediCallCosts })
		.from(tediCallCosts)
		.leftJoin(
			billingUsageCharges,
			eq(billingUsageCharges.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.leftJoin(
			billingUsageQuarantines,
			eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.where(
			and(
				...(range
					? [
							gt(callRowid, range.afterRowid),
							lte(callRowid, range.throughRowid),
						]
					: []),
				isNotNull(tediCallCosts.orgId),
				unreserved
					? isNull(tediCallCosts.billingReservationId)
					: isNotNull(tediCallCosts.billingReservationId),
				isNull(tediCallCosts.usageKind),
				eq(tediCallCosts.success, true),
				isNull(billingUsageCharges.id),
				isNull(billingUsageQuarantines.id),
			),
		)
		.orderBy(
			...(range
				? [asc(callRowid)]
				: [asc(tediCallCosts.snapshotAt), asc(tediCallCosts.gatewayLogId)]),
		)
		.limit(limit);
}

/** Full-ledger read: every reserved token call with no charge or quarantine. */
export async function listUnsettledBillableGatewayCalls(
	db: DbClient,
	limit: number,
): Promise<TediCallCost[]> {
	const rows = await selectUnsettledBillableGatewayCalls(db, limit, null);
	return rows.map(({ call }) => call);
}

const UNSETTLED_GATEWAY_CURSOR = "unsettled_gateway_calls";
const UNRESERVED_GATEWAY_CURSOR = "legacy_unreserved_gateway_calls";
/** Most rowids one incremental tick may walk past the watermark. */
export const UNSETTLED_GATEWAY_SCAN_WINDOW = 20_000;
/** Time between completed historical recovery passes. */
export const UNSETTLED_GATEWAY_FULL_SWEEP_MS = 24 * 60 * 60 * 1_000;

export interface UnsettledGatewayCallScan {
	/** Omitted by older callers for the reserved-token settlement queue. */
	queue?: "legacy";
	/** `full` starts a paged backstop at rowid zero; `incremental` continues it. */
	mode: "full" | "incremental";
	/** Cursor observed before reading; the commit applies only on top of it. */
	expected: { afterRowid: number; fullSweepAt: string } | null;
	limit: number;
	/** Last rowid the read covered when it returned fewer than `limit` calls. */
	throughRowid: number;
	/** True when rows above `throughRowid` were not examined yet. */
	moreAbove: boolean;
	calls: UnsettledGatewayCall[];
	/** Independent historical recovery never holds new calls behind old pages. */
	backstop?: UnsettledGatewayCallScan;
	currentCalls?: UnsettledGatewayCall[];
	isBackstop?: true;
}

/**
 * Read the next settlement batch without scanning settled history.
 *
 * Reserved token rows are never updated after insert (only provider-unit
 * receipts are, and those carry a usage kind), so insertion order is a safe
 * watermark: a late Gateway row with an old `snapshot_at` still gets a rowid
 * above the cursor. One read covers at most `scanWindow` rowids. Once per
 * `fullSweepMs`, a separate backstop restarts at rowid zero. It uses the same
 * bounded pages without blocking the current queue behind historical rows.
 */
export async function scanUnsettledBillableGatewayCalls(
	db: DbClient,
	options: {
		limit: number;
		now: string;
		scanWindow?: number;
		fullSweepMs?: number;
	},
): Promise<UnsettledGatewayCallScan> {
	return scanGatewayCalls(db, options, false);
}

/** Unreserved token rows use their own watermark; provider receipts stay excluded. */
export async function scanUnreservedGatewayCalls(
	db: DbClient,
	options: Parameters<typeof scanUnsettledBillableGatewayCalls>[1],
): Promise<UnsettledGatewayCallScan> {
	// This job runs daily, so a daily backstop would never use its watermark.
	return scanGatewayCalls(
		db,
		{ fullSweepMs: 7 * UNSETTLED_GATEWAY_FULL_SWEEP_MS, ...options },
		true,
	);
}

async function scanGatewayCalls(
	db: DbClient,
	options: Parameters<typeof scanUnsettledBillableGatewayCalls>[1],
	unreserved: boolean,
): Promise<UnsettledGatewayCallScan> {
	const scanWindow = options.scanWindow ?? UNSETTLED_GATEWAY_SCAN_WINDOW;
	const fullSweepMs = options.fullSweepMs ?? UNSETTLED_GATEWAY_FULL_SWEEP_MS;
	const [cursor] = await db
		.select({
			afterRowid: billingSettlementCursors.afterRowid,
			fullSweepAt: billingSettlementCursors.fullSweepAt,
		})
		.from(billingSettlementCursors)
		.where(
			eq(
				billingSettlementCursors.name,
				unreserved ? UNRESERVED_GATEWAY_CURSOR : UNSETTLED_GATEWAY_CURSOR,
			),
		)
		.limit(1);
	// Read the head before the batch: a row inserted after this point gets a
	// higher rowid, so it is never behind the cursor this scan commits.
	const [head] = await db
		.select({ rowid: sql<number | null>`max(${callRowid})` })
		.from(tediCallCosts);
	const headRowid = head?.rowid ?? 0;
	const expected = cursor ?? null;
	const restart = !expected || expected.afterRowid > headRowid;
	const afterRowid = restart ? 0 : expected.afterRowid;
	const throughRowid = Math.min(headRowid, afterRowid + scanWindow);
	const calls = await selectUnsettledBillableGatewayCalls(
		db,
		options.limit,
		{ afterRowid, throughRowid },
		unreserved,
	);
	const scan: UnsettledGatewayCallScan = {
		...(unreserved ? { queue: "legacy" as const } : {}),
		mode: restart ? "full" : "incremental",
		expected,
		limit: options.limit,
		throughRowid,
		moreAbove: throughRowid < headRowid,
		calls,
	};
	// Bootstrap already visits history. Later backstops have their own cursor,
	// so a multi-tick recovery cannot delay newly inserted billable calls.
	if (restart) return scan;
	const [backstopCursor] = await db
		.select({
			afterRowid: billingSettlementCursors.afterRowid,
			fullSweepAt: billingSettlementCursors.fullSweepAt,
		})
		.from(billingSettlementCursors)
		.where(
			eq(
				billingSettlementCursors.name,
				(unreserved ? UNRESERVED_GATEWAY_CURSOR : UNSETTLED_GATEWAY_CURSOR) +
					":backstop",
			),
		)
		.limit(1);
	const sweepAt = backstopCursor?.fullSweepAt ?? expected.fullSweepAt;
	if (sweepAt && Date.parse(options.now) - Date.parse(sweepAt) < fullSweepMs)
		return scan;
	const sweepAfter =
		sweepAt || (backstopCursor?.afterRowid ?? 0) > headRowid
			? 0
			: (backstopCursor?.afterRowid ?? 0);
	const sweepThrough = Math.min(headRowid, sweepAfter + scanWindow);
	const backstop: UnsettledGatewayCallScan = {
		...(unreserved ? { queue: "legacy" as const } : {}),
		isBackstop: true,
		mode: backstopCursor?.fullSweepAt === "" ? "incremental" : "full",
		expected: backstopCursor ?? null,
		limit: options.limit,
		throughRowid: sweepThrough,
		moreAbove: sweepThrough < headRowid,
		calls: await selectUnsettledBillableGatewayCalls(
			db,
			options.limit,
			{ afterRowid: sweepAfter, throughRowid: sweepThrough },
			unreserved,
		),
	};
	return {
		...scan,
		currentCalls: calls,
		backstop,
		calls: [
			...new Map(
				[...calls, ...backstop.calls].map((call) => [call.rowid, call]),
			).values(),
		],
	};
}

/**
 * Move the watermark past what a scan examined. A transiently failed call holds
 * the watermark just below it for one more incremental attempt; a call that
 * fails again from the held position is left to the next full sweep, so one
 * poison row never stalls the queue. A full page advances only through its
 * last returned row; the next tick continues that bounded backstop.
 */
export async function commitUnsettledBillableGatewayScan(
	db: DbClient,
	scan: UnsettledGatewayCallScan,
	input: { failedRowids: number[]; now: string; scanWindow?: number },
): Promise<boolean> {
	if (scan.backstop) {
		const backstopCommitted = await commitUnsettledBillableGatewayScan(
			db,
			scan.backstop,
			input,
		);
		const currentCommitted = await commitUnsettledBillableGatewayScan(
			db,
			{ ...scan, backstop: undefined, calls: scan.currentCalls! },
			input,
		);
		return backstopCommitted && currentCommitted;
	}
	const cursorName =
		(scan.queue === "legacy"
			? UNRESERVED_GATEWAY_CURSOR
			: UNSETTLED_GATEWAY_CURSOR) + (scan.isBackstop ? ":backstop" : "");
	const complete = scan.calls.length < scan.limit;
	const examined = complete
		? scan.throughRowid
		: (scan.calls.at(-1)?.rowid ?? scan.throughRowid);
	const floor =
		scan.mode === "incremental" && scan.expected
			? scan.expected.afterRowid
			: -1;
	const retry = input.failedRowids.filter(
		(rowid) => rowid - 1 > floor && rowid <= examined,
	);
	let afterRowid = retry.length > 0 ? Math.min(...retry) - 1 : examined;
	let fullSweepAt = scan.expected?.fullSweepAt ?? input.now;
	if (scan.isBackstop) {
		const finished = complete && !scan.moreAbove && retry.length === 0;
		fullSweepAt = finished ? input.now : "";
		if (finished) afterRowid = 0;
	}
	if (!scan.expected) {
		const rows = await db
			.insert(billingSettlementCursors)
			.values({
				name: cursorName,
				afterRowid,
				fullSweepAt,
				updatedAt: input.now,
			})
			.onConflictDoNothing({ target: billingSettlementCursors.name })
			.returning({ name: billingSettlementCursors.name });
		return rows.length === 1;
	}
	const rows = await db
		.update(billingSettlementCursors)
		.set({ afterRowid, fullSweepAt, updatedAt: input.now })
		.where(
			and(
				eq(billingSettlementCursors.name, cursorName),
				eq(billingSettlementCursors.afterRowid, scan.expected.afterRowid),
				eq(billingSettlementCursors.fullSweepAt, scan.expected.fullSweepAt),
			),
		)
		.returning({ name: billingSettlementCursors.name });
	return rows.length === 1;
}

export async function listUnrecordedProviderUsageCalls(
	db: DbClient,
	limit: number,
): Promise<TediCallCost[]> {
	const rows = await db
		.select({ call: tediCallCosts })
		.from(tediCallCosts)
		.leftJoin(
			billingProviderUsage,
			eq(billingProviderUsage.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.leftJoin(
			billingUsageQuarantines,
			eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.where(
			and(
				eq(tediCallCosts.success, true),
				isNotNull(tediCallCosts.usageKind),
				isNotNull(tediCallCosts.usageUnit),
				isNotNull(tediCallCosts.usageQuantity),
				isNull(billingProviderUsage.id),
				isNull(billingUsageQuarantines.id),
			),
		)
		.orderBy(asc(tediCallCosts.snapshotAt), asc(tediCallCosts.gatewayLogId))
		.limit(limit);
	return rows.map(({ call }) => call);
}

export async function loadKnownGatewayAttributionIds(
	db: DbClient,
	input: { organizationIds: string[]; tediIds: string[] },
): Promise<{ organizationIds: string[]; tediIds: string[] }> {
	// D1 caps bound parameters at 100 per statement; chunk each IN() list.
	const organizationRows: Array<{ id: string }> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.organizationIds)],
		50,
	)) {
		organizationRows.push(
			...(await db
				.select({ id: organizations.id })
				.from(organizations)
				.where(inArray(organizations.id, chunk))),
		);
	}
	const tediRows: Array<{ id: string }> = [];
	for (const chunk of chunkForBoundParams([...new Set(input.tediIds)], 50)) {
		tediRows.push(
			...(await db
				.select({ id: tedis.id })
				.from(tedis)
				.where(inArray(tedis.id, chunk))),
		);
	}
	return {
		organizationIds: organizationRows.map(({ id }) => id),
		tediIds: tediRows.map(({ id }) => id),
	};
}

export async function getGatewayLogIngestionCursor(
	db: DbClient,
	gatewayId: string,
) {
	const [row] = await db
		.select()
		.from(gatewayLogIngestionCursors)
		.where(eq(gatewayLogIngestionCursors.gatewayId, gatewayId))
		.limit(1);
	return row ?? null;
}

/**
 * Advance only from the exact cursor observed before the page was fetched.
 * Two cron fires may ingest the same rows, but only one can acknowledge them;
 * the loser must re-read rather than page on a stale provider offset.
 */
export async function advanceGatewayLogIngestionCursor(
	db: DbClient,
	input: Required<
		Pick<
			NewGatewayLogIngestionCursor,
			"gatewayId" | "lastLogCreatedAt" | "lastLogId" | "updatedAt"
		>
	> & {
		expected: Pick<
			NewGatewayLogIngestionCursor,
			"lastLogCreatedAt" | "lastLogId"
		> | null;
	},
): Promise<boolean> {
	if (
		input.expected &&
		input.lastLogCreatedAt <= input.expected.lastLogCreatedAt
	)
		return false;
	if (!input.expected) {
		const rows = await db
			.insert(gatewayLogIngestionCursors)
			.values({
				gatewayId: input.gatewayId,
				lastLogCreatedAt: input.lastLogCreatedAt,
				lastLogId: input.lastLogId,
				updatedAt: input.updatedAt,
			})
			.onConflictDoNothing({ target: gatewayLogIngestionCursors.gatewayId })
			.returning({ gatewayId: gatewayLogIngestionCursors.gatewayId });
		return rows.length === 1;
	}
	const rows = await db
		.update(gatewayLogIngestionCursors)
		.set({
			lastLogCreatedAt: input.lastLogCreatedAt,
			lastLogId: input.lastLogId,
			updatedAt: input.updatedAt,
		})
		.where(
			and(
				eq(gatewayLogIngestionCursors.gatewayId, input.gatewayId),
				eq(
					gatewayLogIngestionCursors.lastLogCreatedAt,
					input.expected.lastLogCreatedAt,
				),
				eq(gatewayLogIngestionCursors.lastLogId, input.expected.lastLogId),
				lt(gatewayLogIngestionCursors.lastLogCreatedAt, input.lastLogCreatedAt),
			),
		)
		.returning({ gatewayId: gatewayLogIngestionCursors.gatewayId });
	return rows.length === 1;
}
