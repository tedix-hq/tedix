import { describe, expect, it } from "vite-plus/test";

import {
	runMcpScanBatchConcurrently,
	summarizeMcpScanThroughput,
} from "./mcp-scan-concurrency";

describe("runMcpScanBatchConcurrently", () => {
	it("starts every item in the bounded batch before waiting for completion", async () => {
		let active = 0;
		let maximumActive = 0;
		const releases: Array<() => void> = [];

		const run = runMcpScanBatchConcurrently([1, 2, 3, 4, 5], async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active--;
		});

		await Promise.resolve();
		expect(maximumActive).toBe(5);
		for (const release of releases) release();
		await run;
		expect(active).toBe(0);
	});

	it("waits for every item even when they complete out of order", async () => {
		const completed: number[] = [];
		const releases = new Map<number, () => void>();
		let settled = false;
		const run = runMcpScanBatchConcurrently([3, 1, 2], async (value) => {
			await new Promise<void>((resolve) => releases.set(value, resolve));
			completed.push(value);
		}).then(() => {
			settled = true;
		});

		for (const value of [1, 2]) {
			releases.get(value)!();
			await Promise.resolve();
		}
		expect(completed).toEqual([1, 2]);
		expect(settled).toBe(false);
		releases.get(3)!();
		await run;

		expect(completed).toEqual([1, 2, 3]);
		expect(settled).toBe(true);
	});
});

describe("summarizeMcpScanThroughput", () => {
	it("reports measured throughput and backlog-clear time", () => {
		expect(
			summarizeMcpScanThroughput({
				batchConcurrency: 5,
				batchDurationsMs: [30_000, 30_000],
				checked: 10,
				dueNow: 120,
			}),
		).toEqual({
			batchConcurrency: 5,
			scanDurationMs: 60_000,
			scansPerMinute: 10,
			estimatedMinutesToClear: 12,
		});
	});

	it("does not invent a clear time when no scan completed", () => {
		expect(
			summarizeMcpScanThroughput({
				batchConcurrency: 5,
				batchDurationsMs: [],
				checked: 0,
				dueNow: 120,
			}).estimatedMinutesToClear,
		).toBeNull();
	});
});
