import { describe, expect, it, vi } from "vite-plus/test";
import { workRefreshOptions } from "./work-refresh";
describe("Work reconciliation", () => {
	it("pauses hidden polling and refreshes on focus with a bounded visible fallback", () => {
		const hidden = vi.spyOn(document, "hidden", "get");
		hidden.mockReturnValue(true);
		expect(workRefreshOptions.refetchInterval()).toBe(false);
		hidden.mockReturnValue(false);
		expect(workRefreshOptions.refetchInterval()).toBeGreaterThanOrEqual(60_000);
		expect(workRefreshOptions.refetchOnWindowFocus).toBe("always");
		expect(workRefreshOptions.refetchIntervalInBackground).toBe(false);
		hidden.mockRestore();
	});
});
