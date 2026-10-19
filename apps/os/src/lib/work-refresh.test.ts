import { describe, expect, it, vi } from "vite-plus/test";
import {
	retryWorkRead,
	workRefreshOptions,
	workRetryDelay,
} from "./work-refresh";
describe("Work reconciliation", () => {
	it("pauses hidden polling and refreshes on focus with a bounded visible fallback", () => {
		const hidden = vi.spyOn(document, "hidden", "get");
		hidden.mockReturnValue(true);
		expect(workRefreshOptions.refetchInterval()).toBe(false);
		hidden.mockReturnValue(false);
		expect(workRefreshOptions.refetchInterval()).toBeGreaterThanOrEqual(60_000);
		expect(workRefreshOptions.refetchOnWindowFocus()).toBe(true);
		expect(workRefreshOptions.refetchIntervalInBackground).toBe(false);
		hidden.mockRestore();
	});
	it("bounds retries, adds exponential jitter, and stops automatic refresh after failures", () => {
		expect(retryWorkRead(2, new Error("offline"))).toBe(true);
		expect(retryWorkRead(3, new Error("offline"))).toBe(false);
		expect(retryWorkRead(0, { code: "FORBIDDEN" })).toBe(false);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		expect([0, 1, 2, 9].map(workRetryDelay)).toEqual([1500, 3000, 6000, 22500]);
		const failed = { state: { fetchFailureCount: 4 } };
		expect(workRefreshOptions.refetchInterval(failed)).toBe(false);
		expect(workRefreshOptions.refetchOnWindowFocus(failed)).toBe(false);
		expect(workRefreshOptions.refetchOnReconnect(failed)).toBe(false);
		random.mockRestore();
	});
});
