import { describe, expect, it } from "vite-plus/test";
import { createLeaseRenewer, leaseRenewalDelayMs } from "./lease-renewer";

describe("leaseRenewalDelayMs", () => {
	it("waits a third of the remaining lease", () => {
		expect(leaseRenewalDelayMs(90_000)).toBe(30_000);
		expect(leaseRenewalDelayMs(0)).toBe(0);
		expect(leaseRenewalDelayMs(-5)).toBe(0);
		expect(leaseRenewalDelayMs(Number.NaN)).toBe(0);
	});
});

describe("createLeaseRenewer", () => {
	const harness = (waits: number[]) => {
		let now = 1_000_000;
		const wait = async (ms: number) => {
			waits.push(ms);
			now += ms;
		};
		return { now: () => now, wait };
	};

	it("renews at a third of the remaining lease and reports a loss once", async () => {
		const waits: number[] = [];
		const clock = harness(waits);
		const lost: string[] = [];
		let calls = 0;
		const renewer = createLeaseRenewer({
			expiresAt: clock.now() + 90_000,
			now: clock.now,
			wait: clock.wait,
			onLost: (reason) => {
				lost.push(reason);
			},
			step: async () => {
				calls += 1;
				if (calls === 1)
					return { kind: "renewed", expiresAt: clock.now() + 90_000 };
				return { kind: "lost", reason: "server refused" };
			},
		});
		await renewer.done;
		expect(waits[0]).toBe(30_000);
		expect(calls).toBe(2);
		expect(lost).toEqual(["server refused"]);
	});

	it("keeps probing when onLost returns a delay", async () => {
		const waits: number[] = [];
		const clock = harness(waits);
		let calls = 0;
		const renewer = createLeaseRenewer({
			expiresAt: clock.now() + 90_000,
			now: clock.now,
			wait: clock.wait,
			onLost: () => 5_000,
			step: async () => {
				calls += 1;
				if (calls === 1) return { kind: "lost", reason: "not yet" };
				if (calls === 2)
					return { kind: "renewed", expiresAt: clock.now() + 90_000 };
				return { kind: "stop" };
			},
		});
		await renewer.done;
		expect(calls).toBe(3);
		expect(waits).toContain(5_000);
	});

	it("lets onExpired defer expiry to the step", async () => {
		const waits: number[] = [];
		const clock = harness(waits);
		let expired = 0;
		let calls = 0;
		const renewer = createLeaseRenewer({
			expiresAt: clock.now() + 1_000,
			now: clock.now,
			wait: clock.wait,
			onExpired: () => {
				expired += 1;
				return "step";
			},
			step: async () => {
				calls += 1;
				// A retry hint that outlives the lease reaches the expiry check.
				return calls === 1
					? { kind: "retry", delayMs: 5_000 }
					: { kind: "stop" };
			},
		});
		await renewer.done;
		expect(expired).toBe(1);
		expect(calls).toBe(2);
	});
});
