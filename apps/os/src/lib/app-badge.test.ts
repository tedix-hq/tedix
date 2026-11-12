import { describe, expect, it, vi } from "vite-plus/test";
import { syncAppBadge } from "@/lib/app-badge";

describe("syncAppBadge", () => {
	it("shows a positive count and clears at zero", () => {
		const setAppBadge = vi.fn(() => Promise.resolve());
		const clearAppBadge = vi.fn(() => Promise.resolve());
		syncAppBadge(3.9, { setAppBadge, clearAppBadge });
		expect(setAppBadge).toHaveBeenCalledWith(3);
		syncAppBadge(0, { setAppBadge, clearAppBadge });
		syncAppBadge(Number.NaN, { setAppBadge, clearAppBadge });
		expect(clearAppBadge).toHaveBeenCalledTimes(2);
		expect(setAppBadge).toHaveBeenCalledTimes(1);
	});

	it("does nothing in a browser without icon badges, and survives a refusal", () => {
		expect(() => syncAppBadge(2, {})).not.toThrow();
		expect(() =>
			syncAppBadge(2, { setAppBadge: () => Promise.reject(new Error("no")) }),
		).not.toThrow();
	});
});
