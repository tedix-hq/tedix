import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CAPN_CONNECT_TIMEOUT_MS, createSessionHub } from "./session-hub";

describe("shared capability session lifecycle", () => {
	it("shares an authenticated connection and disposes only on the last release", async () => {
		let connects = 0;
		let disposed = 0;
		const hub = createSessionHub({
			connect: async () => {
				connects++;
				return {
					ping: async () => {},
					identity: "embedded-user",
					[Symbol.dispose]: () => {
						disposed++;
					},
				};
			},
		});
		const a = hub.lease();
		const b = hub.lease();
		const [first, second] = await Promise.all([a.session(), b.session()]);
		expect(first.root.identity).toBe("embedded-user");
		expect(first.root).toBe(second.root);
		expect(connects).toBe(1);
		a.release();
		expect(disposed).toBe(0);
		b.release();
		b.release();
		expect(disposed).toBe(1);
		expect(hub.leaseCount()).toBe(0);
	});

	it("reacquires capabilities after failure without allowing a stale socket to kill its successor", async () => {
		const broken: Array<(error: unknown) => void> = [];
		const hub = createSessionHub({
			connect: async () => ({
				ping: async () => {},
				onRpcBroken: (callback: (error: unknown) => void) => {
					broken.push(callback);
				},
			}),
		});
		const lease = hub.lease();
		const first = await lease.session();
		broken[0]!(new Error("disconnected"));
		const second = await lease.session();
		expect(second.generation).toBeGreaterThan(first.generation);
		broken[0]!(new Error("late disconnect"));
		expect((await lease.session()).generation).toBe(second.generation);
		lease.release();
	});
});

afterEach(() => vi.useRealTimers());

describe("bounded shared dial", () => {
	it("releases a timed-out shared dial and disposes its late root", async () => {
		vi.useFakeTimers();
		const lateDispose = vi.fn();
		const late = { ping: async () => {}, [Symbol.dispose]: lateDispose };
		const next = { ping: async () => {}, [Symbol.dispose]: vi.fn() };
		let finish!: (root: typeof late) => void;
		const dial = new Promise<typeof late>((resolve) => {
			finish = resolve;
		});
		const hub = createSessionHub({
			connect: vi.fn().mockReturnValueOnce(dial).mockResolvedValue(next),
		});
		const a = hub.lease();
		const b = hub.lease();
		const outcomes = Promise.allSettled([a.session(), b.session()]);
		await vi.advanceTimersByTimeAsync(CAPN_CONNECT_TIMEOUT_MS);
		expect((await outcomes).every((r) => r.status === "rejected")).toBe(true);
		const recovered = await a.session();
		expect(recovered.root).toBe(next);
		finish(late);
		await vi.advanceTimersByTimeAsync(0);
		expect(lateDispose).toHaveBeenCalledTimes(1);
		expect((await b.session()).root).toBe(next);
		a.release();
		b.release();
		expect(next[Symbol.dispose]).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels the deadline when the final borrower leaves a pending dial", async () => {
		vi.useFakeTimers();
		const hub = createSessionHub({
			connect: () => new Promise<never>(() => {}),
		});
		const lease = hub.lease();
		const outcome = Promise.allSettled([lease.session()]);
		lease.release();
		await vi.advanceTimersByTimeAsync(0);
		expect((await outcome)[0]?.status).toBe("rejected");
		expect(vi.getTimerCount()).toBe(0);
	});
});
