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
const postWalletCodeRunFlush = vi.fn(
	async (_db: unknown, _input: unknown) => {},
);
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/billing/credit-pool", async (importOriginal) => ({
	creditRefusalReason: (
		(await importOriginal()) as typeof import("@tedix/db/queries/billing/credit-pool")
	).creditRefusalReason,
	getCreditPoolSnapshot,
}));
vi.mock("@tedix/db/queries/billing/wallet-flush", () => ({
	postWalletCodeRunFlush,
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
				const rows = /^\s*(SELECT|WITH)/i.test(query)
					? statement.all(...(args as never[]))
					: (statement.run(...(args as never[])), []);
				return { toArray: () => rows, one: () => rows[0] };
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
		postWalletCodeRunFlush.mockRejectedValueOnce(new Error("D1 busy"));
		await wallet.alarm();
		await wallet.alarm();
		const [failed, retried] = postWalletCodeRunFlush.mock.calls.map(
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
		expect(postWalletCodeRunFlush).toHaveBeenCalledTimes(2);
		expect(await wallet.charge(member("run-3"))).toMatchObject({
			allowed: true,
		});
	});
});
