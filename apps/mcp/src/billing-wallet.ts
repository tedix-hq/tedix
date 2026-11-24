/**
 * Per-organization wallet for Code Mode Dynamic Worker loads and model calls.
 *
 * Spend is admitted inside one Durable Object (`wallet:v1:<org>`) instead of
 * D1 reservations. The wallet checks the D1 credit pool snapshot (cached for a
 * minute) minus its own unflushed charges and live holds, records the charge
 * or hold in DO SQLite, and settles it afterwards: a Code Mode run with its
 * actual load count, a model call with its actual provider cost. An alarm
 * flushes settled charges to D1 every few minutes as one credit
 * consumption per subject and period, through the same statements every other
 * meter uses, so the funding split, notices, Stripe export and the pool figure
 * other spenders read are unchanged. Unflushed spend is invisible to other
 * spenders for at most one flush window; that bounded overdraft is accepted.
 */

import { isolateColo } from "@tedix/worker-kit/colo";
import {
	DYNAMIC_WORKER_COST_USD_MICROS,
	aiCreditsForProviderCost,
} from "@tedix/api-contract/utils/credit-pricing";
import { createDbClient } from "@tedix/db/client";
import {
	type CreditPoolSnapshot,
	creditRefusalReason,
	getCreditPoolSnapshot,
} from "@tedix/db/queries/billing/credit-pool";
import {
	postWalletFlush,
	type WalletFlushGroup,
} from "@tedix/db/queries/billing/wallet-flush";
import {
	type CreditBudget,
	findSessionWorkItem,
	getCreditBudgetsForWorkItem,
} from "@tedix/db/queries/work-items/budgets";
import { deliverCreditBudgetAlert } from "@tedix/db/queries/work-items/credit-budget-alerts";
import {
	type WalletEvent,
	claimWalletFlush,
	countWalletEventAgainst,
	deleteUnflushedCodeRun,
	deleteUnsettledHold,
	findUnflushedCodeRunFx,
	findWalletEventByIdempotencyKey,
	findWalletEventCredits,
	findWalletHold,
	insertWalletEvent,
	listUndeliveredWalletBudgetAlerts,
	markWalletBudgetAlertDelivered,
	moveWalletHold,
	pendingWalletCredits,
	pruneWalletStore,
	queueWalletBudgetAlert,
	recordWalletFlush,
	settleWalletCodeRun,
	settleWalletHold,
	uncountWalletEvent,
	walletAlarmMarks,
	walletBudgetSpent,
} from "@tedix/db/queries/durable-sqlite/billing-wallet";
import {
	type WalletStoreDb,
	openWalletStore,
} from "@tedix/db/wallet-store/store";
import type {
	WalletBudgetScope,
	WalletRefusalCode,
	WalletHoldInput,
	WalletHoldResult,
	WalletSettleHoldInput,
	WalletSettleHoldResult,
} from "@tedix/api-contract/schemas/billing-wallet";
import { walletObjectName } from "@tedix/api-contract/utils/wallet-object";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";

const ORG_KEY = "wallet:organization";
const SNAPSHOT_TTL_MS = 60_000;
const FLUSH_DELAY_MS = 5 * 60_000;
const RETRY_DELAY_MS = 60_000;
/** A charge never settled (lost caller) is flushed as one anonymous load after this. */
const UNSETTLED_GRACE_MS = 15 * 60_000;
/** Event ids stay for replay detection this long after their flush. */
const EVENT_RETENTION_MS = 48 * 60 * 60_000;

export type WalletChargeResult =
	| { allowed: true; replayed: boolean; credits: number }
	| { allowed: false; code: WalletRefusalCode; budget?: WalletBudgetScope };

export interface WalletChargeInput {
	organizationId: string;
	eventId: string;
	tediId: string | null;
	userId: string | null;
	/** Spend counts against this Work Item's credit budgets. */
	workItemId?: string | null;
	/** Without a Work Item: the agent session whose one active Attempt names it. */
	agentSessionId?: string | null;
}

const BUDGET_TTL_MS = 60_000;
const MICROS_PER_CREDIT = 1_000_000;
/** An 80% or 100% crossing is told within seconds, not at the next flush. */
const ALERT_DELAY_MS = 5_000;

type WalletBudget = CreditBudget;
type Refusal = {
	code: WalletRefusalCode;
	budget?: WalletBudget;
	spentMicros?: number;
};

export interface WalletSettleInput {
	eventId: string;
	anonymousLoads: number;
	namedLoads: number;
}

export function walletStub(
	env: { MCP_SUBSCRIPTIONS?: DurableObjectNamespace },
	organizationId: string,
) {
	return durableObjectStubByName(
		env.MCP_SUBSCRIPTIONS!,
		env,
		walletObjectName(organizationId),
	);
}

/** Runs inside the Durable Object; one instance per organization. */
export class BillingWallet {
	readonly #storage: DurableObjectStorage;
	readonly #env: { DB?: D1Database };
	readonly #db: WalletStoreDb;
	readonly #sessionWork = new Map<
		string,
		{ workItemId: string | null; fetchedAt: number }
	>();
	readonly #budgetCache = new Map<
		string,
		{ budgets: WalletBudget[]; fetchedAt: number }
	>();
	readonly #snapshots = new Map<
		string,
		{ snapshot: CreditPoolSnapshot | null; fetchedAt: number }
	>();
	/** D1 reads in flight; concurrent cache misses share one. */
	readonly #loads = new Map<string, Promise<unknown>>();
	/** Bumped by each flush: a snapshot read before it must not be cached after it. */
	#flushes = 0;

	constructor(storage: DurableObjectStorage, env: { DB?: D1Database }) {
		this.#storage = storage;
		this.#env = env;
		this.#db = openWalletStore(storage);
	}

	static isWallet(storage: DurableObjectStorage): boolean {
		return storage.kv.get<string>(ORG_KEY) !== undefined;
	}

	async handle(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const body = (await request.json()) as Record<string, unknown>;
		if (path === "/wallet/charge")
			return Response.json(await this.charge(body as never));
		if (path === "/wallet/settle")
			return Response.json(this.settle(body as never));
		if (path === "/wallet/hold")
			return Response.json(await this.hold(body as never));
		if (path === "/wallet/release")
			return Response.json(this.release(body as never));
		if (path === "/wallet/settle-hold")
			return Response.json(await this.settleHold(body as never));
		if (path === "/wallet/budget-spend")
			return Response.json(this.budgetSpend(body as never));
		return Response.json({ error: "Unknown wallet route" }, { status: 404 });
	}

	async charge(input: WalletChargeInput): Promise<WalletChargeResult> {
		const known = findWalletEventCredits(this.#db, input.eventId);
		if (known !== undefined)
			return { allowed: true, replayed: true, credits: known };
		const nowMs = Date.now();
		const timing = this.#timing("charge", nowMs);
		const snapshot = await this.#snapshot(input, nowMs);
		timing.snapshot();
		if (!snapshot?.creditFx)
			return timing.done({
				allowed: false,
				code: "billing_not_configured" as const,
			});
		const { workItemId, budgets } = await this.#budgets(input, nowMs);
		timing.budgets();
		const credits = aiCreditsForProviderCost(
			DYNAMIC_WORKER_COST_USD_MICROS,
			snapshot.creditFx.microUsdPerEur,
		);
		const refusal = this.#refusal(snapshot, input, credits, nowMs, budgets);
		if (refusal)
			return timing.done(await this.#refuse(input, refusal, workItemId, nowMs));
		this.#storage.kv.put(ORG_KEY, input.organizationId);
		this.#countAgainst(input.eventId, budgets);
		insertWalletEvent(this.#db, {
			eventId: input.eventId,
			tediId: input.tediId,
			userId: input.userId,
			credits,
			microUsdPerEur: snapshot.creditFx.microUsdPerEur,
			periodStart: snapshot.periodStart,
			periodEnd: snapshot.periodEnd,
			at: nowMs,
		});
		await this.#scheduleFlush(
			this.#noteCrossings(budgets, workItemId, nowMs)
				? nowMs + ALERT_DELAY_MS
				: nowMs + FLUSH_DELAY_MS,
		);
		return timing.done({ allowed: true, replayed: false, credits });
	}

	/** Hold a model call's estimated credits until its actual cost settles it. */
	async hold(input: WalletHoldInput): Promise<WalletHoldResult> {
		const known = this.#heldFor(input);
		if (known) return known;
		const nowMs = Date.now();
		const expiresAtMs = Date.parse(input.expiresAt);
		const timing = this.#timing("hold", nowMs);
		const snapshot = await this.#snapshot(input, nowMs);
		timing.snapshot();
		if (!snapshot?.creditFx)
			return timing.done({
				allowed: false,
				code: "billing_not_configured" as const,
			});
		const { workItemId, budgets } = await this.#budgets(input, nowMs);
		timing.budgets();
		// A concurrent retry may have held while the reads ran.
		const raced = this.#heldFor(input);
		if (raced) return raced;
		const refusal = this.#refusal(
			snapshot,
			input,
			input.credits,
			nowMs,
			budgets,
		);
		if (refusal)
			return timing.done(await this.#refuse(input, refusal, workItemId, nowMs));
		this.#storage.kv.put(ORG_KEY, input.organizationId);
		this.#countAgainst(input.holdId, budgets);
		insertWalletEvent(this.#db, {
			eventId: input.holdId,
			kind: "ai",
			idempotencyKey: input.idempotencyKey,
			tediId: input.tediId,
			userId: input.userId,
			credits: input.credits,
			microUsdPerEur: snapshot.creditFx.microUsdPerEur,
			periodStart: snapshot.periodStart,
			periodEnd: snapshot.periodEnd,
			at: nowMs,
			expiresAt: expiresAtMs,
			holdContext: {
				runId: input.runId ?? null,
				metadata: input.metadata ?? {},
			},
		});
		await this.#scheduleFlush(
			this.#noteCrossings(budgets, workItemId, nowMs)
				? nowMs + ALERT_DELAY_MS
				: nowMs + FLUSH_DELAY_MS,
		);
		return timing.done({
			allowed: true,
			holdId: input.holdId,
			credits: input.credits,
			expiresAt: input.expiresAt,
			replayed: false,
		});
	}

	/** Logs where a charge or hold spent its time: D1 reads on a cache miss, or the rest. */
	#timing(route: "charge" | "hold", startMs: number) {
		let snapshotMs = 0;
		let budgetsMs = 0;
		let mark = startMs;
		const lap = () => {
			const now = Date.now();
			const ms = now - mark;
			mark = now;
			return ms;
		};
		return {
			snapshot: () => {
				snapshotMs = lap();
			},
			budgets: () => {
				budgetsMs = lap();
			},
			done: <T extends { allowed: boolean; code?: string }>(result: T): T => {
				console.log(
					JSON.stringify({
						_tr: "wallet_admission",
						route,
						outcome: result.allowed ? "allowed" : result.code,
						snapshotMs,
						budgetsMs,
						totalMs: Date.now() - startMs,
						colo: isolateColo() ?? "pending",
					}),
				);
				return result;
			},
		};
	}

	/** One D1 read per key at a time; later callers wait for the same result. */
	#once<T>(key: string, load: () => Promise<T>): Promise<T> {
		const running = this.#loads.get(key);
		if (running) return running as Promise<T>;
		const started = load().finally(() => this.#loads.delete(key));
		this.#loads.set(key, started);
		return started;
	}

	/** Return a hold whose call was never sent. */
	release(input: { holdId: string }): { released: boolean } {
		const released = deleteUnsettledHold(this.#db, input.holdId);
		if (released) uncountWalletEvent(this.#db, input.holdId);
		return { released };
	}

	/**
	 * The existing hold for this admission key, if any. The same hold id is a
	 * retry of the same admission: replay it while unexpired or settled, as the
	 * D1 reservation did. A different id under the same key means the earlier
	 * admission never wrote its dispatch fence (the fence keeps the hold id, and
	 * a retry reuses it), so an unsettled hold moves to the new id and the
	 * caller writes the fence.
	 */
	#heldFor(input: WalletHoldInput): WalletHoldResult | null {
		const row = findWalletEventByIdempotencyKey(this.#db, input.idempotencyKey);
		if (!row) return null;
		const nowMs = Date.now();
		if (row.eventId !== input.holdId && !row.settled && !row.flushId) {
			moveWalletHold(this.#db, {
				fromId: row.eventId,
				toId: input.holdId,
				expiresAtMs: Date.parse(input.expiresAt),
			});
			return {
				allowed: true,
				holdId: input.holdId,
				credits: row.credits,
				expiresAt: input.expiresAt,
				replayed: false,
			};
		}
		// A hold always has an expiry; a missing one is treated as expired.
		const expiresAt = row.expiresAt ?? 0;
		if (!row.settled && expiresAt <= nowMs)
			return { allowed: false, code: "monthly_credit_limit_reached" };
		return {
			allowed: true,
			holdId: row.eventId,
			credits: row.credits,
			expiresAt: new Date(expiresAt).toISOString(),
			replayed: true,
		};
	}

	/** Charge a model call's actual provider cost, rounded per call; replays return the first result. */
	async settleHold(
		input: WalletSettleHoldInput,
	): Promise<WalletSettleHoldResult> {
		const row = findWalletHold(this.#db, input.holdId);
		if (!row) return { found: false };
		const period = {
			periodStart: row.periodStart,
			periodEnd: row.periodEnd,
			runId: row.holdContext?.runId ?? null,
			metadata: row.holdContext?.metadata ?? {},
		};
		if (row.settled) return { found: true, credits: row.credits, ...period };
		const credits = aiCreditsForProviderCost(input.providerCostMicros, row.fx);
		settleWalletHold(this.#db, { holdId: input.holdId, credits });
		await this.#scheduleFlush(Date.now() + FLUSH_DELAY_MS);
		return { found: true, credits, ...period };
	}

	/**
	 * Refusal for `credits` more against the pool minus unflushed charges and
	 * live holds. Synchronous, so after the snapshot await no other request can
	 * interleave before the caller's insert: two admissions cannot both spend
	 * the same last credit.
	 */
	#refusal(
		snapshot: CreditPoolSnapshot,
		subject: { tediId: string | null; userId: string | null },
		credits: number,
		nowMs: number,
		budgets: WalletBudget[],
	): Refusal | null {
		const pending = (filter: { tediId?: string; userId?: string } = {}) =>
			pendingWalletCredits(this.#db, { nowMs, ...filter });
		const pool = creditRefusalReason(
			{
				...snapshot,
				availableCredits: snapshot.availableCredits - pending(),
				tediUsedCredits:
					snapshot.tediUsedCredits +
					(subject.tediId ? pending({ tediId: subject.tediId }) : 0),
				memberUsedCredits:
					snapshot.memberUsedCredits +
					(subject.userId ? pending({ userId: subject.userId }) : 0),
			},
			{ now: new Date(nowMs).toISOString(), credits },
		);
		if (pool) return { code: pool };
		for (const budget of budgets) {
			// An alert-only budget never refuses; it is only told about.
			if (budget.mode !== "stop") continue;
			const spentMicros = this.#spent(budget.id, nowMs);
			if (spentMicros + credits * MICROS_PER_CREDIT > budget.limitMicros)
				return { code: "work_budget_exhausted", budget, spentMicros };
		}
		return null;
	}

	/** A budget refusal is also its 100% crossing: its owners are asked to raise the limit. */
	async #refuse(
		input: { organizationId: string },
		refusal: Refusal,
		workItemId: string | null,
		nowMs: number,
	): Promise<{
		allowed: false;
		code: WalletRefusalCode;
		budget?: WalletBudgetScope;
	}> {
		const { budget, spentMicros } = refusal;
		if (!budget) return { allowed: false, code: refusal.code };
		if (
			budget.alertedPercent < 100 &&
			this.#queueAlert(budget, 100, spentMicros ?? 0, workItemId, nowMs)
		) {
			this.#storage.kv.put(ORG_KEY, input.organizationId);
			await this.#scheduleFlush(nowMs + ALERT_DELAY_MS);
		}
		return {
			allowed: false,
			code: refusal.code,
			budget: { scopeType: budget.scopeType, scopeId: budget.scopeId },
		};
	}

	/** Queue the highest new 80% or 100% crossing of each budget; true if any. */
	#noteCrossings(
		budgets: WalletBudget[],
		workItemId: string | null,
		nowMs: number,
	): boolean {
		let queued = false;
		for (const budget of budgets) {
			if (budget.limitMicros <= 0 || budget.alertedPercent >= 100) continue;
			const spentMicros = this.#spent(budget.id, nowMs);
			const percent =
				spentMicros >= budget.limitMicros
					? 100
					: spentMicros >= budget.limitMicros * 0.8
						? 80
						: 0;
			if (percent !== 0 && percent > budget.alertedPercent)
				queued =
					this.#queueAlert(budget, percent, spentMicros, workItemId, nowMs) ||
					queued;
		}
		return queued;
	}

	#queueAlert(
		budget: WalletBudget,
		percent: 80 | 100,
		spentMicros: number,
		workItemId: string | null,
		nowMs: number,
	): boolean {
		return queueWalletBudgetAlert(this.#db, {
			budgetId: budget.id,
			limitMicros: budget.limitMicros,
			percent,
			spentMicros: Math.round(spentMicros),
			workItemId,
			at: nowMs,
		});
	}

	/** Millionths of a credit a budget has spent: flushed plus unflushed live charges. */
	#spent(budgetId: string, nowMs: number): number {
		return walletBudgetSpent(this.#db, { budgetId, nowMs });
	}

	/** Millionths of a credit each budget has spent: flushed plus unflushed live charges. */
	budgetSpend(input: { budgetIds: string[] }): Record<string, number> {
		const nowMs = Date.now();
		return Object.fromEntries(
			input.budgetIds.slice(0, 100).map((id) => [id, this.#spent(id, nowMs)]),
		);
	}

	#countAgainst(eventId: string, budgets: WalletBudget[]) {
		countWalletEventAgainst(this.#db, {
			eventId,
			budgetIds: budgets.map((budget) => budget.id),
		});
	}

	/** The Work Item's credit budgets, cached briefly; none without a Work Item. */
	async #budgets(
		input: {
			organizationId: string;
			workItemId?: string | null;
			agentSessionId?: string | null;
		},
		nowMs: number,
	): Promise<{ workItemId: string | null; budgets: WalletBudget[] }> {
		if (!this.#env.DB) return { workItemId: null, budgets: [] };
		const db = createDbClient(this.#env.DB);
		let workItemId = input.workItemId ?? null;
		if (!workItemId && input.agentSessionId) {
			const known = this.#sessionWork.get(input.agentSessionId);
			if (known && nowMs - known.fetchedAt < BUDGET_TTL_MS)
				workItemId = known.workItemId;
			else {
				const sessionId = input.agentSessionId;
				workItemId = await this.#once(`session:${sessionId}`, () =>
					findSessionWorkItem(db, {
						orgId: input.organizationId,
						sessionId,
					}),
				);
				this.#sessionWork.set(input.agentSessionId, {
					workItemId,
					fetchedAt: nowMs,
				});
			}
		}
		if (!workItemId) return { workItemId: null, budgets: [] };
		const cached = this.#budgetCache.get(workItemId);
		if (cached && nowMs - cached.fetchedAt < BUDGET_TTL_MS)
			return { workItemId, budgets: cached.budgets };
		const id = workItemId;
		const budgets = await this.#once(`budgets:${id}`, () =>
			getCreditBudgetsForWorkItem(db, {
				orgId: input.organizationId,
				workItemId: id,
			}),
		);
		this.#budgetCache.set(workItemId, { budgets, fetchedAt: nowMs });
		return { workItemId, budgets };
	}

	/** Zero loads refunds the charge; otherwise price the actual loads, rounded per run. */
	settle(input: WalletSettleInput): { ok: boolean } {
		const loads = input.anonymousLoads + input.namedLoads;
		if (loads === 0) {
			if (deleteUnflushedCodeRun(this.#db, input.eventId))
				uncountWalletEvent(this.#db, input.eventId);
			return { ok: true };
		}
		const fx = findUnflushedCodeRunFx(this.#db, input.eventId);
		if (fx === undefined) return { ok: false };
		settleWalletCodeRun(this.#db, {
			eventId: input.eventId,
			anonymousLoads: input.anonymousLoads,
			namedLoads: input.namedLoads,
			credits: aiCreditsForProviderCost(
				loads * DYNAMIC_WORKER_COST_USD_MICROS,
				fx,
			),
		});
		return { ok: true };
	}

	async alarm(): Promise<void> {
		const organizationId = this.#storage.kv.get<string>(ORG_KEY);
		if (!organizationId || !this.#env.DB) return;
		const nowMs = Date.now();
		const alertsLeft = await this.#deliverAlerts(organizationId, nowMs);
		// Claim a batch once; a failed flush retries the same flush id, so the
		// consumption source refs dedupe in D1.
		const rows = claimWalletFlush(this.#db, {
			flushId: `${organizationId}:${nowMs}`,
			unsettledBeforeMs: nowMs - UNSETTLED_GRACE_MS,
		});
		if (rows.length > 0) {
			try {
				await postWalletFlush(createDbClient(this.#env.DB), {
					organizationId,
					flushId: rows[0]!.flushId!,
					groups: flushGroups(rows),
					now: new Date(nowMs).toISOString(),
				});
			} catch (error) {
				console.error("[billing-wallet] flush failed", {
					exception: error instanceof Error ? error.name : typeof error,
					events: rows.length,
				});
				await this.#storage.setAlarm(nowMs + RETRY_DELAY_MS);
				return;
			}
			recordWalletFlush(this.#db, { flushId: rows[0]!.flushId!, nowMs });
			// The D1 pool now includes these credits; a cached snapshot would
			// count them twice.
			this.#snapshots.clear();
			this.#flushes += 1;
		}
		// A model call never settled within the retention window is not charged,
		// and an alert that fails for two days is dropped.
		pruneWalletStore(this.#db, nowMs - EVENT_RETENTION_MS);
		if (alertsLeft) {
			await this.#storage.setAlarm(nowMs + RETRY_DELAY_MS);
			return;
		}
		const next = walletAlarmMarks(this.#db);
		if (next.unflushedAt !== null)
			await this.#storage.setAlarm(
				Math.max(
					nowMs + 1_000,
					Math.min(next.unflushedAt + FLUSH_DELAY_MS, nowMs + FLUSH_DELAY_MS),
				),
			);
		else if (next.flushedAt !== null)
			await this.#storage.setAlarm(next.flushedAt + EVENT_RETENTION_MS);
	}

	/** Tell owners about queued crossings; true when some must be retried. */
	async #deliverAlerts(organizationId: string, nowMs: number) {
		const alerts = listUndeliveredWalletBudgetAlerts(this.#db, 20);
		if (alerts.length === 0) return false;
		const db = createDbClient(this.#env.DB!);
		let left = false;
		for (const alert of alerts) {
			try {
				await deliverCreditBudgetAlert(db, {
					orgId: organizationId,
					envelopeId: alert.budgetId,
					limitMicros: alert.limitMicros,
					percent: alert.percent,
					spentMicros: alert.spentMicros,
					workItemId: alert.workItemId,
					now: new Date(nowMs).toISOString(),
				});
				markWalletBudgetAlertDelivered(this.#db, {
					budgetId: alert.budgetId,
					limitMicros: alert.limitMicros,
					percent: alert.percent,
					nowMs,
				});
			} catch (error) {
				left = true;
				console.error("[billing-wallet] budget alert failed", {
					exception: error instanceof Error ? error.name : typeof error,
					percent: alert.percent,
				});
			}
		}
		// The envelope now records the alert; reread it on the next charge.
		this.#budgetCache.clear();
		return left;
	}

	async #snapshot(
		input: {
			organizationId: string;
			tediId: string | null;
			userId: string | null;
		},
		nowMs: number,
	) {
		const key = `${input.tediId ?? ""}|${input.userId ?? ""}`;
		const cached = this.#snapshots.get(key);
		if (cached && nowMs - cached.fetchedAt < SNAPSHOT_TTL_MS)
			return cached.snapshot;
		const DB = this.#env.DB;
		if (!DB) return null;
		const flushes = this.#flushes;
		const snapshot = await this.#once(`snapshot:${flushes}:${key}`, () =>
			getCreditPoolSnapshot(createDbClient(DB), {
				organizationId: input.organizationId,
				now: new Date(nowMs).toISOString(),
				subject: { tediId: input.tediId, userId: input.userId },
			}),
		);
		// A flush while this read ran: D1 now counts credits the read missed.
		if (flushes === this.#flushes)
			this.#snapshots.set(key, { snapshot, fetchedAt: nowMs });
		return snapshot;
	}

	async #scheduleFlush(at: number) {
		const current = await this.#storage.getAlarm();
		if (current === null || current > at) await this.#storage.setAlarm(at);
	}
}

/** Aggregate claimed events per kind, subject and period; never-settled runs count as one anonymous load. */
function flushGroups(rows: WalletEvent[]): WalletFlushGroup[] {
	const groups = new Map<string, WalletFlushGroup>();
	for (const row of rows) {
		const key = [
			row.kind,
			row.periodStart,
			row.periodEnd,
			row.tediId ?? "",
			row.userId ?? "",
		].join("|");
		const at = new Date(row.at).toISOString();
		const group = groups.get(key) ?? {
			key,
			kind: row.kind,
			tediId: row.tediId,
			userId: row.userId,
			periodStart: row.periodStart,
			periodEnd: row.periodEnd,
			credits: 0,
			anonymousLoads: 0,
			namedLoads: 0,
			runs: 0,
			firstAt: at,
		};
		group.credits += row.credits;
		if (row.kind === "code_run")
			group.anonymousLoads += row.settled ? row.anonymousLoads : 1;
		group.namedLoads += row.namedLoads;
		group.runs += 1;
		if (at < group.firstAt) group.firstAt = at;
		groups.set(key, group);
	}
	return [...groups.values()];
}
