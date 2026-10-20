import { QueryClient, QueryObserver } from "@tanstack/react-query";
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
	it("bounds retries and adds exponential jitter", () => {
		expect(retryWorkRead(2, new Error("offline"))).toBe(true);
		expect(retryWorkRead(3, new Error("offline"))).toBe(false);
		expect(retryWorkRead(0, { code: "FORBIDDEN" })).toBe(false);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		expect([0, 1, 2, 9].map(workRetryDelay)).toEqual([1500, 3000, 6000, 22500]);
		random.mockRestore();
	});
});

it.each(["focus", "reconnect", "remount"] as const)(
	"recovers a failed shared Work read on %s without a manual retry",
	async (event) => {
		const client = new QueryClient();
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("Temporary 503"))
			.mockResolvedValue(["fictional-app"]);
		const options = {
			queryKey: ["fictional-work-recovery"],
			queryFn: read,
			...workRefreshOptions,
			retry: false,
		};
		let observer = new QueryObserver(client, options);
		let stop = observer.subscribe(() => {});
		try {
			await vi.waitFor(() =>
				expect(observer.getCurrentResult().isError).toBe(true),
			);
			expect(observer.getCurrentResult().failureCount).toBeGreaterThan(0);
			if (event === "focus") client.getQueryCache().onFocus();
			else if (event === "reconnect") client.getQueryCache().onOnline();
			else {
				stop();
				observer = new QueryObserver(client, options);
				stop = observer.subscribe(() => {});
			}
			await vi.waitFor(() =>
				expect(observer.getCurrentResult().data).toEqual(["fictional-app"]),
			);
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			stop();
			client.clear();
			hidden.mockRestore();
		}
	},
);
