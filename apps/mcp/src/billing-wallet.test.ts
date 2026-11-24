import { DatabaseSync } from "node:sqlite";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const snapshot = {
	status: "active",
	periodStart: "2026-11-01T00:00:00.000Z",
	periodEnd: "2026-12-01T00:00:00.000Z",
	availableCredits: 2,
	creditFx: { microUsdPerEur: 1_080_000 },
	tediCap: null,
	tediUsedCredits: 0,
	memberCap: null,
	memberUsedCredits: 0,
};
const getCreditPoolSnapshot = vi.fn(async () => snapshot);
const postWalletFlush = vi.fn(async (_db: unknown, _input: unknown) => {});
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/billing/credit-pool", async (importOriginal) => ({
	creditRefusalReason: (
		(await importOriginal()) as typeof import("@tedix/db/queries/billing/credit-pool")
	).creditRefusalReason,
	getCreditPoolSnapshot,
}));
const getCreditBudgetsForWorkItem = vi.fn(
	async (_db: unknown, _input: unknown) =>
		[] as Array<{
			id: string;
			scopeType: string;
			scopeId: string;
			limitMicros: number;
			mode: "stop" | "alert";
			alertedPercent: number;
		}>,
);
const findSessionWorkItem = vi.fn(
	async (_db: unknown, _input: unknown): Promise<string | null> => null,
);
vi.mock("@tedix/db/queries/work-items/budgets", () => ({
	getCreditBudgetsForWorkItem,
	findSessionWorkItem,
}));
vi.mock("@tedix/db/queries/billing/wallet-flush", () => ({
	postWalletFlush,
}));
const deliverCreditBudgetAlert = vi.fn(
	async (_db: unknown, _alert: { envelopeId: string; percent: number }) => 1,
);
vi.mock("@tedix/db/queries/work-items/credit-budget-alerts", () => ({
	deliverCreditBudgetAlert,
}));

const { BillingWallet } = await import("./billing-wallet");

/** DO SQLite, KV and alarm over a real in-memory SQLite database. */
function fakeStorage(db = new DatabaseSync(":memory:")) {
	const kv = new Map<string, unknown>();
	let alarm: number | null = null;
	return Object.assign(createDurableSqliteFixture(db), {
		kv: {
			get: (key: string) => kv.get(key),
			put: (key: string, value: unknown) => kv.set(key, value),
		},
		getAlarm: async () => alarm,
		setAlarm: async (at: number) => {
			alarm = at;
		},
	}) as unknown as DurableObjectStorage;
}

const member = (eventId: string) => ({
	organizationId: "org-1",
	eventId,
	tediId: null,
	userId: "member-1",
});

describe("billing wallet", () => {
	let wallet: InstanceType<typeof BillingWallet>;
	beforeEach(() => {
		vi.clearAllMocks();
		wallet = new BillingWallet(fakeStorage(), { DB: {} as D1Database });
	});

	it("never lets unflushed charges spend the same credit twice", async () => {
		expect(await wallet.charge(member("run-1"))).toMatchObject({
			allowed: true,
			credits: 1,
		});
		expect(await wallet.charge(member("run-2"))).toMatchObject({
			allowed: true,
		});
		expect(await wallet.charge(member("run-3"))).toEqual({
			allowed: false,
			code: "monthly_credit_limit_reached",
		});
		// A retried charge is the same event, not new spend.
		expect(await wallet.charge(member("run-1"))).toMatchObject({
			allowed: true,
			replayed: true,
		});
	});

	it("refunds a run that loaded no Worker", async () => {
		await wallet.charge(member("run-1"));
		await wallet.charge(member("run-2"));
		wallet.settle({ eventId: "run-1", anonymousLoads: 0, namedLoads: 0 });
		expect(await wallet.charge(member("run-3"))).toMatchObject({
			allowed: true,
		});
	});

	it("flushes one group per subject and retries a failed flush under the same flush id", async () => {
		await wallet.charge(member("run-1"));
		await wallet.charge({ ...member("run-2"), userId: "member-2" });
		wallet.settle({ eventId: "run-1", anonymousLoads: 1, namedLoads: 0 });
		// 3 loads at USD 0.002 = USD 0.006 -> EUR 0.00556 x 2 -> 2 credits, rounded per run.
		wallet.settle({ eventId: "run-2", anonymousLoads: 2, namedLoads: 1 });
		postWalletFlush.mockRejectedValueOnce(new Error("D1 busy"));
		await wallet.alarm();
		await wallet.alarm();
		const [failed, retried] = postWalletFlush.mock.calls.map(
			([, call]) => call as { flushId: string; groups: object[] },
		);
		expect(retried!.flushId).toBe(failed!.flushId);
		expect(retried!.groups).toEqual([
			expect.objectContaining({
				userId: "member-1",
				credits: 1,
				anonymousLoads: 1,
				namedLoads: 0,
			}),
			expect.objectContaining({
				userId: "member-2",
				credits: 2,
				anonymousLoads: 2,
				namedLoads: 1,
			}),
		]);
		// Flushed credits are in D1 now; the wallet stops counting them.
		await wallet.alarm();
		expect(postWalletFlush).toHaveBeenCalledTimes(2);
		expect(await wallet.charge(member("run-3"))).toMatchObject({
			allowed: true,
		});
	});
	it("holds a model call once per key, counts it until it expires, and settles the actual cost", async () => {
		const hold = (key: string, expiresAt = "2099-01-01T00:00:00.000Z") =>
			wallet.hold({
				organizationId: "org-1",
				holdId: `hold-${key}`,
				idempotencyKey: key,
				tediId: null,
				userId: "member-1",
				credits: 1,
				expiresAt,
			});
		expect(await hold("call-1")).toMatchObject({
			allowed: true,
			replayed: false,
		});
		// A retried admission gets the same hold, not a second one.
		expect(await hold("call-1")).toMatchObject({
			holdId: "hold-call-1",
			replayed: true,
		});
		// An expired hold no longer counts against the pool.
		await hold("call-2", "2000-01-01T00:00:00.000Z");
		expect(await hold("call-3")).toMatchObject({ allowed: true });
		expect(await hold("call-4")).toEqual({
			allowed: false,
			code: "monthly_credit_limit_reached",
		});
		// A hold whose call was never sent goes back to the pool.
		expect(wallet.release({ holdId: "hold-call-3" })).toEqual({
			released: true,
		});
		// USD 0.025 -> EUR 0.0231 x 2 -> 5 credits; a replayed settlement returns the first result.
		expect(
			await wallet.settleHold({
				holdId: "hold-call-1",
				providerCostMicros: 25_000,
			}),
		).toMatchObject({ found: true, credits: 5 });
		expect(
			await wallet.settleHold({ holdId: "hold-call-1", providerCostMicros: 1 }),
		).toMatchObject({ found: true, credits: 5 });
		expect(
			await wallet.settleHold({
				holdId: "d1-reservation",
				providerCostMicros: 1,
			}),
		).toEqual({ found: false });
		await wallet.alarm();
		expect(postWalletFlush).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				groups: [
					expect.objectContaining({
						kind: "ai",
						credits: 5,
						userId: "member-1",
					}),
				],
			}),
		);
	});
	it("moves a never-fenced hold to the retry's id and refuses an expired replay", async () => {
		const hold = (holdId: string, expiresAt = "2099-01-01T00:00:00.000Z") =>
			wallet.hold({
				organizationId: "org-1",
				holdId,
				idempotencyKey: "call",
				tediId: null,
				userId: null,
				credits: 1,
				expiresAt,
			});
		await hold("first-attempt");
		// The first attempt crashed before its fence: the retry owns the hold.
		expect(await hold("second-attempt")).toMatchObject({
			holdId: "second-attempt",
			replayed: false,
		});
		expect(
			await wallet.settleHold({
				holdId: "first-attempt",
				providerCostMicros: 1,
			}),
		).toEqual({ found: false });
		// Only one hold exists, so the pool still has room for one more call.
		expect(
			await wallet.hold({
				organizationId: "org-1",
				holdId: "other",
				idempotencyKey: "other-call",
				tediId: null,
				userId: null,
				credits: 1,
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).toMatchObject({ allowed: true });
		expect(
			await wallet.hold({
				organizationId: "org-1",
				holdId: "other",
				idempotencyKey: "other-call",
				tediId: null,
				userId: null,
				credits: 1,
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).toEqual({ allowed: false, code: "monthly_credit_limit_reached" });
	});
	it("stops Work spend at a credit budget across runs and model calls, and keeps flushed spend", async () => {
		getCreditBudgetsForWorkItem.mockResolvedValue([
			{
				id: "budget-project",
				scopeType: "project",
				scopeId: "project-1",
				limitMicros: 2_000_000,
				mode: "stop",
				alertedPercent: 0,
			},
		]);
		const run = (eventId: string) =>
			wallet.charge({ ...member(eventId), workItemId: "work-1" });
		const call = (key: string) =>
			wallet.hold({
				organizationId: "org-1",
				holdId: `hold-${key}`,
				idempotencyKey: key,
				tediId: null,
				userId: "member-1",
				credits: 1,
				expiresAt: "2099-01-01T00:00:00.000Z",
				workItemId: "work-1",
			});
		// The pool has 2 credits too, so widen it: the budget must be what stops spend.
		getCreditPoolSnapshot.mockResolvedValue({
			...snapshot,
			availableCredits: 100,
		});
		wallet = new BillingWallet(fakeStorage(), { DB: {} as D1Database });
		expect(await run("run-1")).toMatchObject({ allowed: true });
		expect(await call("call-1")).toMatchObject({ allowed: true });
		expect(await run("run-2")).toEqual({
			allowed: false,
			code: "work_budget_exhausted",
			budget: { scopeType: "project", scopeId: "project-1" },
		});
		// Spend without a Work Item is not counted against Work budgets.
		expect(await wallet.charge(member("run-other"))).toMatchObject({
			allowed: true,
		});
		// A run that loaded no Worker gives its budget back.
		wallet.settle({ eventId: "run-1", anonymousLoads: 0, namedLoads: 0 });
		expect(await run("run-3")).toMatchObject({ allowed: true });
		expect(wallet.budgetSpend({ budgetIds: ["budget-project"] })).toEqual({
			"budget-project": 2_000_000,
		});
		// Flushed spend still counts: the budget stays spent after the flush.
		wallet.settle({ eventId: "run-3", anonymousLoads: 1, namedLoads: 0 });
		await wallet.settleHold({ holdId: "hold-call-1", providerCostMicros: 1 });
		await wallet.alarm();
		expect(wallet.budgetSpend({ budgetIds: ["budget-project"] })).toEqual({
			"budget-project": 2_000_000,
		});
		expect(await call("call-2")).toMatchObject({
			code: "work_budget_exhausted",
		});
		getCreditPoolSnapshot.mockResolvedValue(snapshot);
		getCreditBudgetsForWorkItem.mockResolvedValue([]);
	});
	it("tells owners once per crossing; an alert-only budget never stops spend", async () => {
		getCreditPoolSnapshot.mockResolvedValue({
			...snapshot,
			availableCredits: 100,
		});
		getCreditBudgetsForWorkItem.mockResolvedValue([
			{
				id: "budget-stop",
				scopeType: "work_item",
				scopeId: "work-1",
				limitMicros: 1_250_000,
				mode: "stop",
				alertedPercent: 0,
			},
			{
				id: "budget-alert",
				scopeType: "project",
				scopeId: "project-1",
				limitMicros: 1_000_000,
				mode: "alert",
				alertedPercent: 0,
			},
		]);
		wallet = new BillingWallet(fakeStorage(), { DB: {} as D1Database });
		const run = (eventId: string) =>
			wallet.charge({ ...member(eventId), workItemId: "work-1" });
		// 1 of 1.25 on the stop budget (80%); 1 of 1 on the alert budget (100%).
		expect(await run("run-1")).toMatchObject({ allowed: true });
		// The stop budget refuses; its refusal is its 100% crossing.
		expect(await run("run-2")).toMatchObject({
			code: "work_budget_exhausted",
			budget: { scopeType: "work_item", scopeId: "work-1" },
		});
		expect(await run("run-3")).toMatchObject({ allowed: false });
		// A failed delivery is retried on the next alarm, not dropped.
		deliverCreditBudgetAlert.mockRejectedValueOnce(new Error("D1 down"));
		await wallet.alarm();
		await wallet.alarm();
		await wallet.alarm();
		const told = deliverCreditBudgetAlert.mock.calls.map(
			([, alert]) => `${alert.envelopeId}:${alert.percent}`,
		);
		expect(new Set(told)).toEqual(
			new Set(["budget-stop:80", "budget-alert:100", "budget-stop:100"]),
		);
		expect(told).toHaveLength(4);
		// Spend without the stop budget runs past the alert budget's limit.
		getCreditBudgetsForWorkItem.mockResolvedValue([
			{
				id: "budget-alert",
				scopeType: "project",
				scopeId: "project-1",
				limitMicros: 1_000_000,
				mode: "alert",
				alertedPercent: 100,
			},
		]);
		wallet = new BillingWallet(fakeStorage(), { DB: {} as D1Database });
		expect(await run("run-4")).toMatchObject({ allowed: true });
		expect(await run("run-5")).toMatchObject({ allowed: true });
		getCreditPoolSnapshot.mockResolvedValue(snapshot);
		getCreditBudgetsForWorkItem.mockResolvedValue([]);
	});
	it("counts an external agent's run against the Work its session's one active Attempt names", async () => {
		getCreditPoolSnapshot.mockResolvedValue({
			...snapshot,
			availableCredits: 100,
		});
		findSessionWorkItem.mockResolvedValue("work-1");
		getCreditBudgetsForWorkItem.mockImplementation(async (_db, input) =>
			(input as { workItemId: string }).workItemId === "work-1"
				? [
						{
							id: "budget-work",
							scopeType: "work_item",
							scopeId: "work-1",
							limitMicros: 1_000_000,
							mode: "stop",
							alertedPercent: 0,
						},
					]
				: [],
		);
		wallet = new BillingWallet(fakeStorage(), { DB: {} as D1Database });
		const run = (eventId: string) =>
			wallet.charge({ ...member(eventId), agentSessionId: "session-1" });
		expect(await run("run-1")).toMatchObject({ allowed: true });
		expect(await run("run-2")).toMatchObject({ code: "work_budget_exhausted" });
		expect(findSessionWorkItem).toHaveBeenCalledWith(expect.anything(), {
			orgId: "org-1",
			sessionId: "session-1",
		});
		getCreditPoolSnapshot.mockResolvedValue(snapshot);
		getCreditBudgetsForWorkItem.mockReset();
		getCreditBudgetsForWorkItem.mockResolvedValue([]);
		findSessionWorkItem.mockResolvedValue(null);
	});
	it("adopts the migration chain in wallets made before it, keeping their charges", async () => {
		// A wallet from 23 Nov before the model-call columns, with one
		// unsettled run, and its budget spend as the old constructor made them.
		const db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE wallet_events (
			event_id TEXT PRIMARY KEY, tedi_id TEXT, user_id TEXT,
			credits INTEGER NOT NULL, micro_usd_per_eur INTEGER NOT NULL,
			anonymous_loads INTEGER NOT NULL DEFAULT 0, named_loads INTEGER NOT NULL DEFAULT 0,
			settled INTEGER NOT NULL DEFAULT 0, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
			at INTEGER NOT NULL, flush_id TEXT, flushed_at INTEGER);
			CREATE TABLE wallet_budget_spend (budget_id TEXT PRIMARY KEY, micro_credits INTEGER NOT NULL);
			INSERT INTO wallet_events (event_id, user_id, credits, micro_usd_per_eur, period_start, period_end, at)
			VALUES ('old-run', 'member-1', 1, 1100000, '2026-11-01', '2026-12-01', ${Date.now()});
			INSERT INTO wallet_budget_spend VALUES ('budget-1', 2000000);`);
		const adopted = new BillingWallet(fakeStorage(db), {
			DB: {} as D1Database,
		});
		expect(
			adopted.settle({ eventId: "old-run", anonymousLoads: 1, namedLoads: 0 }),
		).toEqual({ ok: true });
		expect(adopted.budgetSpend({ budgetIds: ["budget-1"] })).toEqual({
			"budget-1": 2000000,
		});
		expect(
			db
				.prepare(
					"SELECT kind, settled FROM wallet_events WHERE event_id = 'old-run'",
				)
				.get(),
		).toEqual({ kind: "code_run", settled: 1 });
		// Waking again runs no migration twice.
		new BillingWallet(fakeStorage(db), { DB: {} as D1Database });
		expect(
			db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
		).toEqual({ n: 1 });
	});
});
