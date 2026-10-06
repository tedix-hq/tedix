import { describe, expect, it, vi } from "vite-plus/test";
import {
	canonicalProjectionInterval,
	createCanonicalProjectionWatcher,
	stableProjectionRevision,
} from "./canonical-projection";

it("derives a stable revision independent of object key order", () => {
	expect(stableProjectionRevision({ b: 2, a: { d: 4, c: 3 } })).toBe(
		stableProjectionRevision({ a: { c: 3, d: 4 }, b: 2 }),
	);
});

describe("canonicalProjectionInterval", () => {
	it("uses active, idle, and disabled cadences", () => {
		expect(canonicalProjectionInterval({ active: true })).toBe(15_000);
		expect(canonicalProjectionInterval({ active: false })).toBe(false);
		expect(canonicalProjectionInterval({ active: false, idleMs: 60_000 })).toBe(
			60_000,
		);
	});
});

describe("createCanonicalProjectionWatcher", () => {
	it("subscribes before the initial canonical read", async () => {
		const order: string[] = [];
		const watcher = createCanonicalProjectionWatcher({
			subscribe: () => {
				order.push("subscribe");
			},
			read: async () => {
				order.push("read");
				return { revision: "1", active: false };
			},
			revision: (value) => value.revision,
			isActive: (value) => value.active,
			deliver: () => {
				order.push("deliver");
			},
		});
		await watcher.start();
		expect(order).toEqual(["subscribe", "read", "deliver"]);
	});

	it("commits a revision only after successful delivery", async () => {
		let attempts = 0;
		const watcher = createCanonicalProjectionWatcher({
			read: async () => ({ revision: "1", active: false }),
			revision: (value) => value.revision,
			isActive: (value) => value.active,
			deliver: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("consumer failed");
			},
			setTimeoutFn: () => 1,
			clearTimeoutFn: () => {},
		});
		await watcher.start();
		expect(watcher.getRevision()).toBeNull();
		await watcher.refresh();
		expect(attempts).toBe(2);
		expect(watcher.getRevision()).toBe("1");
	});

	it("coalesces hints that arrive during a read", async () => {
		let release!: () => void;
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const deliver = vi.fn();
		const watcher = createCanonicalProjectionWatcher({
			read: async () => {
				reads += 1;
				if (reads === 1) await first;
				return { revision: String(reads), active: false };
			},
			revision: (value) => value.revision,
			isActive: (value) => value.active,
			deliver,
		});
		const starting = watcher.start();
		watcher.wake();
		watcher.wake();
		release();
		await starting;
		await vi.waitFor(() => expect(reads).toBe(2));
		expect(deliver).toHaveBeenCalledTimes(2);
	});
});
