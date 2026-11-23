import { DatabaseSync } from "node:sqlite";
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

const { BillingWallet } = await import("./billing-wallet");

/** DO SQLite and KV over a real in-memory SQLite database. */
function fakeStorage() {
	const db = new DatabaseSync(":memory:");
	const kv = new Map<string, unknown>();
	let alarm: number | null = null;
	return {
		sql: {
			exec: (query: string, ...args: unknown[]) => {
				const statement = db.prepare(query);
				const select = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
				const rows = select ? statement.all(...(args as never[])) : [];
				const rowsWritten = select
					? 0
					: Number(statement.run(...(args as never[])).changes);
				return { toArray: () => rows, one: () => rows[0], rowsWritten };
			},
		},
		kv: {
			get: (key: string) => kv.get(key),
			put: (key: string, value: unknown) => kv.set(key, value),
		},
		getAlarm: async () => alarm,
		setAlarm: async (at: number) => {
			alarm = at;
		},
	} as unknown as DurableObjectStorage;
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
});
