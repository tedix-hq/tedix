/**
 * Reads and writes of one organization wallet's Durable Object SQLite
 * (`wallet-store/schema.ts`). Every function is synchronous: the wallet runs
 * its checks and writes for one charge without yielding to another request.
 */
import {
	and,
	asc,
	eq,
	gt,
	isNotNull,
	isNull,
	lt,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { WalletStoreDb } from "../../wallet-store/store";
import {
	walletBudgetAlerts,
	walletBudgetSpend,
	walletEventBudgets,
	walletEvents,
} from "../../wallet-store/schema";

export type WalletEvent = typeof walletEvents.$inferSelect;
export type WalletBudgetAlert = typeof walletBudgetAlerts.$inferSelect;

const MICROS_PER_CREDIT = 1_000_000;

/** Charges and holds that still count: unflushed, and a hold only while settled or unexpired. */
function live(nowMs: number) {
	return and(
		isNull(walletEvents.flushedAt),
		or(
			eq(walletEvents.kind, "code_run"),
			eq(walletEvents.settled, true),
			gt(walletEvents.expiresAt, nowMs),
		),
	);
}

const creditSum =
	sql<number>`coalesce(sum(${walletEvents.credits}), 0)`.mapWith(Number);

export function findWalletEventCredits(
	db: WalletStoreDb,
	eventId: string,
): number | undefined {
	return db
		.select({ credits: walletEvents.credits })
		.from(walletEvents)
		.where(eq(walletEvents.eventId, eventId))
		.get()?.credits;
}

export function insertWalletEvent(
	db: WalletStoreDb,
	event: typeof walletEvents.$inferInsert,
): void {
	db.insert(walletEvents).values(event).run();
}

/** Delete an unsettled hold; true when there was one. */
export function deleteUnsettledHold(
	db: WalletStoreDb,
	holdId: string,
): boolean {
	return (
		db
			.delete(walletEvents)
			.where(
				and(
					eq(walletEvents.eventId, holdId),
					eq(walletEvents.kind, "ai"),
					eq(walletEvents.settled, false),
				),
			)
			.returning({ eventId: walletEvents.eventId })
			.all().length > 0
	);
}

export function findWalletEventByIdempotencyKey(
	db: WalletStoreDb,
	idempotencyKey: string,
) {
	return db
		.select({
			eventId: walletEvents.eventId,
			credits: walletEvents.credits,
			expiresAt: walletEvents.expiresAt,
			settled: walletEvents.settled,
			flushId: walletEvents.flushId,
		})
		.from(walletEvents)
		.where(eq(walletEvents.idempotencyKey, idempotencyKey))
		.get();
}

/** Give an unsettled hold, and the budgets it counts against, a new hold id. */
export function moveWalletHold(
	db: WalletStoreDb,
	p: { fromId: string; toId: string; expiresAtMs: number },
): void {
	db.update(walletEvents)
		.set({ eventId: p.toId, expiresAt: p.expiresAtMs })
		.where(eq(walletEvents.eventId, p.fromId))
		.run();
	db.update(walletEventBudgets)
		.set({ eventId: p.toId })
		.where(eq(walletEventBudgets.eventId, p.fromId))
		.run();
}

export function findWalletHold(db: WalletStoreDb, holdId: string) {
	return db
		.select({
			credits: walletEvents.credits,
			fx: walletEvents.microUsdPerEur,
			settled: walletEvents.settled,
			periodStart: walletEvents.periodStart,
			periodEnd: walletEvents.periodEnd,
			holdContext: walletEvents.holdContext,
		})
		.from(walletEvents)
		.where(and(eq(walletEvents.eventId, holdId), eq(walletEvents.kind, "ai")))
		.get();
}

export function settleWalletHold(
	db: WalletStoreDb,
	p: { holdId: string; credits: number },
): void {
	db.update(walletEvents)
		.set({ credits: p.credits, settled: true })
		.where(eq(walletEvents.eventId, p.holdId))
		.run();
}

/** Credits of live unflushed charges and holds, optionally for one tedi or member. */
export function pendingWalletCredits(
	db: WalletStoreDb,
	p: { nowMs: number; tediId?: string; userId?: string },
): number {
	return (
		db
			.select({ total: creditSum })
			.from(walletEvents)
			.where(
				and(
					live(p.nowMs),
					p.tediId === undefined
						? undefined
						: eq(walletEvents.tediId, p.tediId),
					p.userId === undefined
						? undefined
						: eq(walletEvents.userId, p.userId),
				),
			)
			.get()?.total ?? 0
	);
}

/** Millionths of a credit a budget has spent: flushed plus live unflushed charges. */
export function walletBudgetSpent(
	db: WalletStoreDb,
	p: { budgetId: string; nowMs: number },
): number {
	const flushed =
		db
			.select({ microCredits: walletBudgetSpend.microCredits })
			.from(walletBudgetSpend)
			.where(eq(walletBudgetSpend.budgetId, p.budgetId))
			.get()?.microCredits ?? 0;
	const pending =
		db
			.select({ total: creditSum })
			.from(walletEvents)
			.innerJoin(
				walletEventBudgets,
				eq(walletEventBudgets.eventId, walletEvents.eventId),
			)
			.where(and(eq(walletEventBudgets.budgetId, p.budgetId), live(p.nowMs)))
			.get()?.total ?? 0;
	return flushed + pending * MICROS_PER_CREDIT;
}

export function countWalletEventAgainst(
	db: WalletStoreDb,
	p: { eventId: string; budgetIds: string[] },
): void {
	if (p.budgetIds.length === 0) return;
	db.insert(walletEventBudgets)
		.values(p.budgetIds.map((budgetId) => ({ eventId: p.eventId, budgetId })))
		.onConflictDoNothing()
		.run();
}

export function uncountWalletEvent(db: WalletStoreDb, eventId: string): void {
	db.delete(walletEventBudgets)
		.where(eq(walletEventBudgets.eventId, eventId))
		.run();
}

/** Queue a budget crossing for the alarm; false when it was already queued. */
export function queueWalletBudgetAlert(
	db: WalletStoreDb,
	alert: Omit<typeof walletBudgetAlerts.$inferInsert, "deliveredAt">,
): boolean {
	return (
		db
			.insert(walletBudgetAlerts)
			.values(alert)
			.onConflictDoNothing()
			.returning({ budgetId: walletBudgetAlerts.budgetId })
			.all().length > 0
	);
}

export function listUndeliveredWalletBudgetAlerts(
	db: WalletStoreDb,
	limit: number,
): WalletBudgetAlert[] {
	return db
		.select()
		.from(walletBudgetAlerts)
		.where(isNull(walletBudgetAlerts.deliveredAt))
		.orderBy(asc(walletBudgetAlerts.at))
		.limit(limit)
		.all();
}

export function markWalletBudgetAlertDelivered(
	db: WalletStoreDb,
	p: {
		budgetId: string;
		limitMicros: number;
		percent: 80 | 100;
		nowMs: number;
	},
): void {
	db.update(walletBudgetAlerts)
		.set({ deliveredAt: p.nowMs })
		.where(
			and(
				eq(walletBudgetAlerts.budgetId, p.budgetId),
				eq(walletBudgetAlerts.limitMicros, p.limitMicros),
				eq(walletBudgetAlerts.percent, p.percent),
			),
		)
		.run();
}

/** Delete an unflushed Code Mode charge; true when there was one. */
export function deleteUnflushedCodeRun(
	db: WalletStoreDb,
	eventId: string,
): boolean {
	return (
		db
			.delete(walletEvents)
			.where(
				and(
					eq(walletEvents.eventId, eventId),
					eq(walletEvents.kind, "code_run"),
					isNull(walletEvents.flushId),
				),
			)
			.returning({ eventId: walletEvents.eventId })
			.all().length > 0
	);
}

/** The rate an unflushed Code Mode charge was priced at, if it exists. */
export function findUnflushedCodeRunFx(
	db: WalletStoreDb,
	eventId: string,
): number | undefined {
	return db
		.select({ fx: walletEvents.microUsdPerEur })
		.from(walletEvents)
		.where(
			and(
				eq(walletEvents.eventId, eventId),
				eq(walletEvents.kind, "code_run"),
				isNull(walletEvents.flushId),
			),
		)
		.get()?.fx;
}

export function settleWalletCodeRun(
	db: WalletStoreDb,
	p: {
		eventId: string;
		anonymousLoads: number;
		namedLoads: number;
		credits: number;
	},
): void {
	db.update(walletEvents)
		.set({
			anonymousLoads: p.anonymousLoads,
			namedLoads: p.namedLoads,
			settled: true,
			credits: p.credits,
		})
		.where(eq(walletEvents.eventId, p.eventId))
		.run();
}

/**
 * Claim settled charges (and Code Mode charges never settled before
 * `unsettledBeforeMs`) for one flush, unless an earlier claim is still
 * unflushed: a failed flush retries the same claim. Returns the claimed rows.
 */
export function claimWalletFlush(
	db: WalletStoreDb,
	p: { flushId: string; unsettledBeforeMs: number },
): WalletEvent[] {
	const claimed = alias(walletEvents, "claimed");
	db.update(walletEvents)
		.set({ flushId: p.flushId })
		.where(
			and(
				isNull(walletEvents.flushId),
				isNull(walletEvents.flushedAt),
				notExists(
					db
						.select({ eventId: claimed.eventId })
						.from(claimed)
						.where(and(isNotNull(claimed.flushId), isNull(claimed.flushedAt))),
				),
				or(
					eq(walletEvents.settled, true),
					and(
						eq(walletEvents.kind, "code_run"),
						lt(walletEvents.at, p.unsettledBeforeMs),
					),
				),
			),
		)
		.run();
	return db
		.select()
		.from(walletEvents)
		.where(and(isNotNull(walletEvents.flushId), isNull(walletEvents.flushedAt)))
		.all();
}

/**
 * Mark a claim flushed and move its budgets' spend from pending to flushed in
 * the same synchronous block, so each charge counts exactly once.
 */
export function recordWalletFlush(
	db: WalletStoreDb,
	p: { flushId: string; nowMs: number },
): void {
	const spent = db
		.select({ budgetId: walletEventBudgets.budgetId, total: creditSum })
		.from(walletEventBudgets)
		.innerJoin(
			walletEvents,
			eq(walletEvents.eventId, walletEventBudgets.eventId),
		)
		.where(
			and(eq(walletEvents.flushId, p.flushId), isNull(walletEvents.flushedAt)),
		)
		.groupBy(walletEventBudgets.budgetId)
		.all();
	for (const { budgetId, total } of spent) {
		const microCredits = total * MICROS_PER_CREDIT;
		db.insert(walletBudgetSpend)
			.values({ budgetId, microCredits })
			.onConflictDoUpdate({
				target: walletBudgetSpend.budgetId,
				set: {
					microCredits: sql`${walletBudgetSpend.microCredits} + ${microCredits}`,
				},
			})
			.run();
	}
	db.update(walletEvents)
		.set({ flushedAt: p.nowMs })
		.where(
			and(eq(walletEvents.flushId, p.flushId), isNull(walletEvents.flushedAt)),
		)
		.run();
}

/**
 * Drop events flushed before `beforeMs`, holds never settled that expired
 * before it (their usage still reaches the provider ledger for review), budget
 * links left without an event, and alerts queued or delivered before it.
 */
export function pruneWalletStore(db: WalletStoreDb, beforeMs: number): void {
	db.delete(walletEvents)
		.where(
			and(
				isNotNull(walletEvents.flushedAt),
				lt(walletEvents.flushedAt, beforeMs),
			),
		)
		.run();
	db.delete(walletEvents)
		.where(
			and(
				eq(walletEvents.kind, "ai"),
				eq(walletEvents.settled, false),
				lt(walletEvents.expiresAt, beforeMs),
			),
		)
		.run();
	db.delete(walletEventBudgets)
		.where(
			notInArray(
				walletEventBudgets.eventId,
				db.select({ eventId: walletEvents.eventId }).from(walletEvents),
			),
		)
		.run();
	db.delete(walletBudgetAlerts)
		.where(
			lt(
				sql`coalesce(${walletBudgetAlerts.deliveredAt}, ${walletBudgetAlerts.at})`,
				beforeMs,
			),
		)
		.run();
}

/** The oldest unflushed event and the oldest flushed one, for the next alarm. */
export function walletAlarmMarks(db: WalletStoreDb): {
	unflushedAt: number | null;
	flushedAt: number | null;
} {
	return (
		db
			.select({
				unflushedAt: sql<
					number | null
				>`min(case when ${walletEvents.flushedAt} is null then ${walletEvents.at} end)`,
				flushedAt: sql<number | null>`min(${walletEvents.flushedAt})`,
			})
			.from(walletEvents)
			.get() ?? { unflushedAt: null, flushedAt: null }
	);
}
