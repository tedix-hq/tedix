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
import type {
	WalletBudgetScope,
	WalletRefusalCode,
	WalletHoldInput,
	WalletHoldResult,
	WalletSettleHoldInput,
	WalletSettleHoldResult,
} from "@tedix/api-contract/schemas/billing-wallet";
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
		`wallet:v1:${organizationId}`,
	);
}

type EventRow = {
	event_id: string;
	kind: "code_run" | "ai";
	tedi_id: string | null;
	user_id: string | null;
	credits: number;
	anonymous_loads: number;
	named_loads: number;
	settled: number;
	period_start: string;
	period_end: string;
	at: number;
	flush_id: string | null;
};

/** Runs inside the Durable Object; one instance per organization. */
export class BillingWallet {
	readonly #storage: DurableObjectStorage;
	readonly #env: { DB?: D1Database };
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
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_events (
			event_id TEXT PRIMARY KEY,
			tedi_id TEXT,
			user_id TEXT,
			credits INTEGER NOT NULL,
			micro_usd_per_eur INTEGER NOT NULL,
			anonymous_loads INTEGER NOT NULL DEFAULT 0,
			named_loads INTEGER NOT NULL DEFAULT 0,
			settled INTEGER NOT NULL DEFAULT 0,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			at INTEGER NOT NULL,
			flush_id TEXT,
			flushed_at INTEGER
		)`);
		const columns = new Set(
			storage.sql
				.exec<{ name: string }>("PRAGMA table_info(wallet_events)")
				.toArray()
				.map((column) => column.name),
		);
		if (!columns.has("kind"))
			storage.sql.exec(
				"ALTER TABLE wallet_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'code_run'",
			);
		if (!columns.has("expires_at"))
			storage.sql.exec(
				"ALTER TABLE wallet_events ADD COLUMN expires_at INTEGER",
			);
		if (!columns.has("hold_context"))
			storage.sql.exec(
				"ALTER TABLE wallet_events ADD COLUMN hold_context TEXT",
			);
		if (!columns.has("idempotency_key"))
			storage.sql.exec(
				"ALTER TABLE wallet_events ADD COLUMN idempotency_key TEXT",
			);
		storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS wallet_events_pending ON wallet_events (flushed_at, at)",
		);
		// Which credit budgets each charge counts against, and what each budget
		// has spent once flushed. Budgets of a Work tree outlive the 48 h events.
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_event_budgets (
			event_id TEXT NOT NULL,
			budget_id TEXT NOT NULL,
			PRIMARY KEY (event_id, budget_id)
		)`);
		storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS wallet_event_budgets_budget ON wallet_event_budgets (budget_id)",
		);
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_budget_spend (
			budget_id TEXT PRIMARY KEY,
			micro_credits INTEGER NOT NULL
		)`);
		// 80% and 100% crossings waiting for the alarm to tell owners, once
		// per budget, limit and percent.
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_budget_alerts (
			budget_id TEXT NOT NULL,
			limit_micros INTEGER NOT NULL,
			percent INTEGER NOT NULL,
			spent_micros INTEGER NOT NULL,
			work_item_id TEXT,
			at INTEGER NOT NULL,
			delivered_at INTEGER,
			PRIMARY KEY (budget_id, limit_micros, percent)
		)`);
		storage.sql.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS wallet_events_idempotency ON wallet_events (idempotency_key)",
		);
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
		const known = this.#storage.sql
			.exec<{ credits: number }>(
				"SELECT credits FROM wallet_events WHERE event_id = ?",
				input.eventId,
			)
			.toArray()[0];
		if (known) return { allowed: true, replayed: true, credits: known.credits };
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
		this.#storage.sql.exec(
			`INSERT INTO wallet_events (event_id, tedi_id, user_id, credits, micro_usd_per_eur, period_start, period_end, at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			input.eventId,
			input.tediId,
			input.userId,
			credits,
			snapshot.creditFx.microUsdPerEur,
			snapshot.periodStart,
			snapshot.periodEnd,
			nowMs,
		);
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
		this.#storage.sql.exec(
			`INSERT INTO wallet_events (event_id, kind, idempotency_key, tedi_id, user_id, credits, micro_usd_per_eur, period_start, period_end, at, expires_at, hold_context)
			 VALUES (?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.holdId,
			input.idempotencyKey,
			input.tediId,
			input.userId,
			input.credits,
			snapshot.creditFx.microUsdPerEur,
			snapshot.periodStart,
			snapshot.periodEnd,
			nowMs,
			expiresAtMs,
			JSON.stringify({
				runId: input.runId ?? null,
				metadata: input.metadata ?? {},
			}),
		);
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
		const released = this.#storage.sql.exec(
			"DELETE FROM wallet_events WHERE event_id = ? AND kind = 'ai' AND settled = 0",
			input.holdId,
		).rowsWritten;
		if (released > 0) this.#uncount(input.holdId);
		return { released: released > 0 };
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
		const row = this.#storage.sql
			.exec<{
				event_id: string;
				credits: number;
				expires_at: number;
				settled: number;
				flush_id: string | null;
			}>(
				"SELECT event_id, credits, expires_at, settled, flush_id FROM wallet_events WHERE idempotency_key = ?",
				input.idempotencyKey,
			)
			.toArray()[0];
		if (!row) return null;
		const nowMs = Date.now();
		if (row.event_id !== input.holdId && !row.settled && !row.flush_id) {
			const expiresAt = Date.parse(input.expiresAt);
			this.#storage.sql.exec(
				"UPDATE wallet_events SET event_id = ?, expires_at = ? WHERE event_id = ?",
				input.holdId,
				expiresAt,
				row.event_id,
			);
			this.#storage.sql.exec(
				"UPDATE wallet_event_budgets SET event_id = ? WHERE event_id = ?",
				input.holdId,
				row.event_id,
			);
			return {
				allowed: true,
				holdId: input.holdId,
				credits: row.credits,
				expiresAt: input.expiresAt,
				replayed: false,
			};
		}
		if (!row.settled && row.expires_at <= nowMs)
			return { allowed: false, code: "monthly_credit_limit_reached" };
		return {
			allowed: true,
			holdId: row.event_id,
			credits: row.credits,
			expiresAt: new Date(row.expires_at).toISOString(),
			replayed: true,
		};
	}

	/** Charge a model call's actual provider cost, rounded per call; replays return the first result. */
	async settleHold(
		input: WalletSettleHoldInput,
	): Promise<WalletSettleHoldResult> {
		const row = this.#storage.sql
			.exec<{
				credits: number;
				fx: number;
				settled: number;
				period_start: string;
				period_end: string;
				hold_context: string | null;
			}>(
				"SELECT credits, micro_usd_per_eur AS fx, settled, period_start, period_end, hold_context FROM wallet_events WHERE event_id = ? AND kind = 'ai'",
				input.holdId,
			)
			.toArray()[0];
		if (!row) return { found: false };
		const context = JSON.parse(row.hold_context ?? "{}") as {
			runId?: string | null;
			metadata?: Record<string, unknown>;
		};
		const period = {
			periodStart: row.period_start,
			periodEnd: row.period_end,
			runId: context.runId ?? null,
			metadata: context.metadata ?? {},
		};
		if (row.settled) return { found: true, credits: row.credits, ...period };
		const credits = aiCreditsForProviderCost(input.providerCostMicros, row.fx);
		this.#storage.sql.exec(
			"UPDATE wallet_events SET credits = ?, settled = 1 WHERE event_id = ?",
			credits,
			input.holdId,
		);
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
		const live =
			"flushed_at IS NULL AND (kind = 'code_run' OR settled = 1 OR expires_at > ?)";
		const pending = (filter: string, ...args: unknown[]) =>
			this.#storage.sql
				.exec<{ total: number | null }>(
					`SELECT SUM(credits) AS total FROM wallet_events WHERE ${live}${filter}`,
					nowMs,
					...args,
				)
				.one().total ?? 0;
		const pool = creditRefusalReason(
			{
				...snapshot,
				availableCredits: snapshot.availableCredits - pending(""),
				tediUsedCredits:
					snapshot.tediUsedCredits +
					(subject.tediId ? pending(" AND tedi_id = ?", subject.tediId) : 0),
				memberUsedCredits:
					snapshot.memberUsedCredits +
					(subject.userId ? pending(" AND user_id = ?", subject.userId) : 0),
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
		return (
			this.#storage.sql.exec(
				`INSERT OR IGNORE INTO wallet_budget_alerts (budget_id, limit_micros, percent, spent_micros, work_item_id, at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				budget.id,
				budget.limitMicros,
				percent,
				Math.round(spentMicros),
				workItemId,
				nowMs,
			).rowsWritten > 0
		);
	}

	/** Millionths of a credit a budget has spent: flushed plus unflushed live charges. */
	#spent(budgetId: string, nowMs: number): number {
		return (
			this.#flushedSpend(budgetId) +
			(this.#storage.sql
				.exec<{ total: number | null }>(
					`SELECT SUM(e.credits) AS total FROM wallet_events e
					 JOIN wallet_event_budgets b ON b.event_id = e.event_id
					 WHERE b.budget_id = ? AND e.flushed_at IS NULL
					   AND (e.kind = 'code_run' OR e.settled = 1 OR e.expires_at > ?)`,
					budgetId,
					nowMs,
				)
				.one().total ?? 0) *
				MICROS_PER_CREDIT
		);
	}

	/** Millionths of a credit each budget has spent: flushed plus unflushed live charges. */
	budgetSpend(input: { budgetIds: string[] }): Record<string, number> {
		const nowMs = Date.now();
		return Object.fromEntries(
			input.budgetIds.slice(0, 100).map((id) => [id, this.#spent(id, nowMs)]),
		);
	}

	#flushedSpend(budgetId: string): number {
		return (
			this.#storage.sql
				.exec<{ micro_credits: number }>(
					"SELECT micro_credits FROM wallet_budget_spend WHERE budget_id = ?",
					budgetId,
				)
				.toArray()[0]?.micro_credits ?? 0
		);
	}

	#countAgainst(eventId: string, budgets: WalletBudget[]) {
		for (const budget of budgets)
			this.#storage.sql.exec(
				"INSERT OR IGNORE INTO wallet_event_budgets (event_id, budget_id) VALUES (?, ?)",
				eventId,
				budget.id,
			);
	}

	#uncount(eventId: string) {
		this.#storage.sql.exec(
			"DELETE FROM wallet_event_budgets WHERE event_id = ?",
			eventId,
		);
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
			const refunded = this.#storage.sql.exec(
				"DELETE FROM wallet_events WHERE event_id = ? AND kind = 'code_run' AND flush_id IS NULL",
				input.eventId,
			).rowsWritten;
			if (refunded > 0) this.#uncount(input.eventId);
			return { ok: true };
		}
		const row = this.#storage.sql
			.exec<{ fx: number }>(
				"SELECT micro_usd_per_eur AS fx FROM wallet_events WHERE event_id = ? AND kind = 'code_run' AND flush_id IS NULL",
				input.eventId,
			)
			.toArray()[0];
		if (!row) return { ok: false };
		this.#storage.sql.exec(
			`UPDATE wallet_events SET anonymous_loads = ?, named_loads = ?, settled = 1, credits = ?
			 WHERE event_id = ?`,
			input.anonymousLoads,
			input.namedLoads,
			aiCreditsForProviderCost(loads * DYNAMIC_WORKER_COST_USD_MICROS, row.fx),
			input.eventId,
		);
		return { ok: true };
	}

	async alarm(): Promise<void> {
		const organizationId = this.#storage.kv.get<string>(ORG_KEY);
		if (!organizationId || !this.#env.DB) return;
		const nowMs = Date.now();
		const alertsLeft = await this.#deliverAlerts(organizationId, nowMs);
		// Claim a batch once; a failed flush retries the same flush id, so the
		// consumption source refs dedupe in D1.
		this.#storage.sql.exec(
			`UPDATE wallet_events SET flush_id = ?
			 WHERE flush_id IS NULL AND flushed_at IS NULL
			   AND NOT EXISTS (SELECT 1 FROM wallet_events WHERE flush_id IS NOT NULL AND flushed_at IS NULL)
			   AND (settled = 1 OR (kind = 'code_run' AND at < ?))`,
			`${organizationId}:${nowMs}`,
			nowMs - UNSETTLED_GRACE_MS,
		);
		const rows = this.#storage.sql
			.exec<EventRow>(
				"SELECT * FROM wallet_events WHERE flush_id IS NOT NULL AND flushed_at IS NULL",
			)
			.toArray();
		if (rows.length > 0) {
			try {
				await postWalletFlush(createDbClient(this.#env.DB), {
					organizationId,
					flushId: rows[0]!.flush_id!,
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
			// Same synchronous block as marking the events flushed, so a budget's
			// spend moves from pending to flushed exactly once.
			this.#storage.sql.exec(
				`INSERT INTO wallet_budget_spend (budget_id, micro_credits)
				 SELECT b.budget_id, SUM(e.credits) * ${MICROS_PER_CREDIT}
				 FROM wallet_event_budgets b JOIN wallet_events e ON e.event_id = b.event_id
				 WHERE e.flush_id = ? AND e.flushed_at IS NULL
				 GROUP BY b.budget_id
				 ON CONFLICT (budget_id) DO UPDATE SET micro_credits = micro_credits + excluded.micro_credits`,
				rows[0]!.flush_id,
			);
			this.#storage.sql.exec(
				"UPDATE wallet_events SET flushed_at = ? WHERE flush_id = ? AND flushed_at IS NULL",
				nowMs,
				rows[0]!.flush_id,
			);
			// The D1 pool now includes these credits; a cached snapshot would
			// count them twice.
			this.#snapshots.clear();
			this.#flushes += 1;
		}
		this.#storage.sql.exec(
			"DELETE FROM wallet_events WHERE flushed_at IS NOT NULL AND flushed_at < ?",
			nowMs - EVENT_RETENTION_MS,
		);
		// A model call never settled within the retention window is not
		// charged; its usage still reaches the provider ledger for review.
		this.#storage.sql.exec(
			"DELETE FROM wallet_events WHERE kind = 'ai' AND settled = 0 AND expires_at < ?",
			nowMs - EVENT_RETENTION_MS,
		);
		this.#storage.sql.exec(
			"DELETE FROM wallet_event_budgets WHERE event_id NOT IN (SELECT event_id FROM wallet_events)",
		);
		this.#storage.sql.exec(
			// Undelivered ones too: an alert that fails for two days is dropped.
			"DELETE FROM wallet_budget_alerts WHERE COALESCE(delivered_at, at) < ?",
			nowMs - EVENT_RETENTION_MS,
		);
		if (alertsLeft) {
			await this.#storage.setAlarm(nowMs + RETRY_DELAY_MS);
			return;
		}
		const next = this.#storage.sql
			.exec<{ at: number | null; flushed: number | null }>(
				`SELECT MIN(CASE WHEN flushed_at IS NULL THEN at END) AS at,
				        MIN(flushed_at) AS flushed FROM wallet_events`,
			)
			.one();
		if (next.at !== null)
			await this.#storage.setAlarm(
				Math.max(
					nowMs + 1_000,
					Math.min(next.at + FLUSH_DELAY_MS, nowMs + FLUSH_DELAY_MS),
				),
			);
		else if (next.flushed !== null)
			await this.#storage.setAlarm(next.flushed + EVENT_RETENTION_MS);
	}

	/** Tell owners about queued crossings; true when some must be retried. */
	async #deliverAlerts(organizationId: string, nowMs: number) {
		const alerts = this.#storage.sql
			.exec<{
				budget_id: string;
				limit_micros: number;
				percent: 80 | 100;
				spent_micros: number;
				work_item_id: string | null;
			}>(
				"SELECT budget_id, limit_micros, percent, spent_micros, work_item_id FROM wallet_budget_alerts WHERE delivered_at IS NULL ORDER BY at LIMIT 20",
			)
			.toArray();
		if (alerts.length === 0) return false;
		const db = createDbClient(this.#env.DB!);
		let left = false;
		for (const alert of alerts) {
			try {
				await deliverCreditBudgetAlert(db, {
					orgId: organizationId,
					envelopeId: alert.budget_id,
					limitMicros: alert.limit_micros,
					percent: alert.percent,
					spentMicros: alert.spent_micros,
					workItemId: alert.work_item_id,
					now: new Date(nowMs).toISOString(),
				});
				this.#storage.sql.exec(
					"UPDATE wallet_budget_alerts SET delivered_at = ? WHERE budget_id = ? AND limit_micros = ? AND percent = ?",
					nowMs,
					alert.budget_id,
					alert.limit_micros,
					alert.percent,
				);
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
function flushGroups(rows: EventRow[]): WalletFlushGroup[] {
	const groups = new Map<string, WalletFlushGroup>();
	for (const row of rows) {
		const key = [
			row.kind,
			row.period_start,
			row.period_end,
			row.tedi_id ?? "",
			row.user_id ?? "",
		].join("|");
		const group = groups.get(key) ?? {
			key,
			kind: row.kind,
			tediId: row.tedi_id,
			userId: row.user_id,
			periodStart: row.period_start,
			periodEnd: row.period_end,
			credits: 0,
			anonymousLoads: 0,
			namedLoads: 0,
			runs: 0,
			firstAt: new Date(row.at).toISOString(),
		};
		group.credits += row.credits;
		if (row.kind === "code_run")
			group.anonymousLoads += row.settled ? row.anonymous_loads : 1;
		group.namedLoads += row.named_loads;
		group.runs += 1;
		const at = new Date(row.at).toISOString();
		if (at < group.firstAt) group.firstAt = at;
		groups.set(key, group);
	}
	return [...groups.values()];
}
