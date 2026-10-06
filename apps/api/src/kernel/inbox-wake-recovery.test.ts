import { describe, expect, it, vi } from "vite-plus/test";
import {
	DEFAULT_INBOX_WAKE_DELAY_MS,
	recoverPendingInboxWake,
	resolveInboxWakeDelayMs,
} from "./inbox-wake-recovery";

describe("resolveInboxWakeDelayMs", () => {
	it("defaults to a sub-second coordination debounce", () => {
		expect(resolveInboxWakeDelayMs(undefined)).toBe(
			DEFAULT_INBOX_WAKE_DELAY_MS,
		);
	});

	it("accepts an explicit bounded integer", () => {
		expect(resolveInboxWakeDelayMs("400")).toBe(400);
	});

	it("clamps unsafe values and rejects malformed input", () => {
		expect(resolveInboxWakeDelayMs("0")).toBe(100);
		expect(resolveInboxWakeDelayMs("99999")).toBe(5_000);
		expect(resolveInboxWakeDelayMs("250ms")).toBe(DEFAULT_INBOX_WAKE_DELAY_MS);
	});
});

describe("recoverPendingInboxWake", () => {
	it("does not arm an alarm when the canonical queue is empty", async () => {
		const ensureAlarm = vi.fn(async () => undefined);
		const recovered = await recoverPendingInboxWake({
			delayMs: DEFAULT_INBOX_WAKE_DELAY_MS,
			ensureAlarm,
			hasPendingWake: async () => false,
			now: () => 10_000,
		});

		expect(recovered).toBe(false);
		expect(ensureAlarm).not.toHaveBeenCalled();
	});

	it("re-arms persisted work from the current activation", async () => {
		const ensureAlarm = vi.fn(async () => undefined);
		const recovered = await recoverPendingInboxWake({
			delayMs: DEFAULT_INBOX_WAKE_DELAY_MS,
			ensureAlarm,
			hasPendingWake: async () => true,
			now: () => 10_000,
		});

		expect(recovered).toBe(true);
		expect(ensureAlarm).toHaveBeenCalledWith(
			10_000 + DEFAULT_INBOX_WAKE_DELAY_MS,
		);
	});

	it("surfaces alarm failures to the DO boundary", async () => {
		await expect(
			recoverPendingInboxWake({
				delayMs: DEFAULT_INBOX_WAKE_DELAY_MS,
				ensureAlarm: async () => {
					throw new Error("alarm unavailable");
				},
				hasPendingWake: async () => true,
			}),
		).rejects.toThrow("alarm unavailable");
	});
});
