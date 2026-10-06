import { describe, expect, it, vi } from "vite-plus/test";
import { createProgressPersistenceTracker } from "./progress-persistence";

describe("createProgressPersistenceTracker", () => {
	it("waits for tracked progress writes before drain resolves", async () => {
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tracker = createProgressPersistenceTracker();
		tracker.track(work);

		const settled = vi.fn();
		const draining = tracker.drain().then(settled);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();

		release?.();
		await draining;
		expect(settled).toHaveBeenCalledOnce();
	});

	it("keeps progress persistence fail-soft when a tracked write rejects", async () => {
		const tracker = createProgressPersistenceTracker();
		tracker.track(Promise.reject(new Error("D1 unavailable")));
		await expect(tracker.drain()).resolves.toBeUndefined();
	});

	it("drain is a no-op once all tracked writes already settled", async () => {
		const tracker = createProgressPersistenceTracker();
		tracker.track(Promise.resolve());
		await Promise.resolve();
		await expect(tracker.drain()).resolves.toBeUndefined();
	});
});
