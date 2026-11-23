/**
 * Per-organization wallet for Code Mode Dynamic Worker loads.
 *
 * A run is admitted and charged inside one Durable Object (`wallet:v1:<org>`)
 * instead of a D1 reservation plus settlement. The wallet checks the D1 credit
 * pool snapshot (cached for a minute) minus its own unflushed charges, records
 * the charge in DO SQLite, and settles it with the actual load count after the
 * run. An alarm flushes settled charges to D1 every few minutes as one credit
 * consumption per subject and period, through the same statements every other
 * meter uses, so the funding split, notices, Stripe export and the pool figure
 * other spenders read are unchanged. Unflushed spend is invisible to other
 * spenders for at most one flush window; that bounded overdraft is accepted.
 */

import {
	DYNAMIC_WORKER_COST_USD_MICROS,
	aiCreditsForProviderCost,
} from "@tedix/api-contract/utils/credit-pricing";
import { createDbClient } from "@tedix/db/client";
import {
	type CreditPoolSnapshot,
	type CreditRefusalCode,
	creditRefusalReason,
	getCreditPoolSnapshot,
} from "@tedix/db/queries/billing/credit-pool";
import {
	postWalletCodeRunFlush,
	type WalletFlushGroup,
} from "@tedix/db/queries/billing/wallet-flush";
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
	| { allowed: false; code: CreditRefusalCode };

export interface WalletChargeInput {
	organizationId: string;
	eventId: string;
	tediId: string | null;
	userId: string | null;
}

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
	readonly #snapshots = new Map<
		string,
		{ snapshot: CreditPoolSnapshot | null; fetchedAt: number }
	>();

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
		storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS wallet_events_pending ON wallet_events (flushed_at, at)",
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
		const now = new Date(nowMs).toISOString();
		const snapshot = await this.#snapshot(input, nowMs);
		if (!snapshot?.creditFx)
			return { allowed: false, code: "billing_not_configured" };
		const credits = aiCreditsForProviderCost(
			DYNAMIC_WORKER_COST_USD_MICROS,
			snapshot.creditFx.microUsdPerEur,
		);
		// Recomputed after the await, synchronously before the insert, so two
		// concurrent charges cannot both spend the same last credit.
		const pending = (filter: string, ...args: unknown[]) =>
			this.#storage.sql
				.exec<{ total: number | null }>(
					`SELECT SUM(credits) AS total FROM wallet_events WHERE flushed_at IS NULL${filter}`,
					...args,
				)
				.one().total ?? 0;
		const refusal = creditRefusalReason(
			{
				...snapshot,
				availableCredits: snapshot.availableCredits - pending(""),
				tediUsedCredits:
					snapshot.tediUsedCredits +
					(input.tediId ? pending(" AND tedi_id = ?", input.tediId) : 0),
				memberUsedCredits:
					snapshot.memberUsedCredits +
					(input.userId ? pending(" AND user_id = ?", input.userId) : 0),
			},
			{ now, credits },
		);
		if (refusal) return { allowed: false, code: refusal };
		this.#storage.kv.put(ORG_KEY, input.organizationId);
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
		await this.#scheduleFlush(nowMs + FLUSH_DELAY_MS);
		return { allowed: true, replayed: false, credits };
	}

	/** Zero loads refunds the charge; otherwise price the actual loads, rounded per run. */
	settle(input: WalletSettleInput): { ok: boolean } {
		const loads = input.anonymousLoads + input.namedLoads;
		if (loads === 0) {
			this.#storage.sql.exec(
				"DELETE FROM wallet_events WHERE event_id = ? AND flush_id IS NULL",
				input.eventId,
			);
			return { ok: true };
		}
		const row = this.#storage.sql
			.exec<{ fx: number }>(
				"SELECT micro_usd_per_eur AS fx FROM wallet_events WHERE event_id = ? AND flush_id IS NULL",
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
		// Claim a batch once; a failed flush retries the same flush id, so the
		// consumption source refs dedupe in D1.
		this.#storage.sql.exec(
			`UPDATE wallet_events SET flush_id = ?
			 WHERE flush_id IS NULL AND flushed_at IS NULL
			   AND NOT EXISTS (SELECT 1 FROM wallet_events WHERE flush_id IS NOT NULL AND flushed_at IS NULL)
			   AND (settled = 1 OR at < ?)`,
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
				await postWalletCodeRunFlush(createDbClient(this.#env.DB), {
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
			this.#storage.sql.exec(
				"UPDATE wallet_events SET flushed_at = ? WHERE flush_id = ? AND flushed_at IS NULL",
				nowMs,
				rows[0]!.flush_id,
			);
			// The D1 pool now includes these credits; a cached snapshot would
			// count them twice.
			this.#snapshots.clear();
		}
		this.#storage.sql.exec(
			"DELETE FROM wallet_events WHERE flushed_at IS NOT NULL AND flushed_at < ?",
			nowMs - EVENT_RETENTION_MS,
		);
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

	async #snapshot(input: WalletChargeInput, nowMs: number) {
		const key = `${input.tediId ?? ""}|${input.userId ?? ""}`;
		const cached = this.#snapshots.get(key);
		if (cached && nowMs - cached.fetchedAt < SNAPSHOT_TTL_MS)
			return cached.snapshot;
		if (!this.#env.DB) return null;
		const snapshot = await getCreditPoolSnapshot(createDbClient(this.#env.DB), {
			organizationId: input.organizationId,
			now: new Date(nowMs).toISOString(),
			subject: { tediId: input.tediId, userId: input.userId },
		});
		this.#snapshots.set(key, { snapshot, fetchedAt: nowMs });
		return snapshot;
	}

	async #scheduleFlush(at: number) {
		const current = await this.#storage.getAlarm();
		if (current === null || current > at) await this.#storage.setAlarm(at);
	}
}

/** Aggregate claimed events per subject and period; never-settled runs count as one anonymous load. */
function flushGroups(rows: EventRow[]): WalletFlushGroup[] {
	const groups = new Map<string, WalletFlushGroup>();
	for (const row of rows) {
		const key = [
			row.period_start,
			row.period_end,
			row.tedi_id ?? "",
			row.user_id ?? "",
		].join("|");
		const group = groups.get(key) ?? {
			key,
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
		group.anonymousLoads += row.settled ? row.anonymous_loads : 1;
		group.namedLoads += row.named_loads;
		group.runs += 1;
		const at = new Date(row.at).toISOString();
		if (at < group.firstAt) group.firstAt = at;
		groups.set(key, group);
	}
	return [...groups.values()];
}
