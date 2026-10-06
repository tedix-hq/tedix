import { describe, expect, it } from "vite-plus/test";
import { createSessionHub } from "./session-hub";

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
