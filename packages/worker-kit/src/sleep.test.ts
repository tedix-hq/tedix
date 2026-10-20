import { describe, expect, it, vi } from "vite-plus/test";
import { sleep } from "./sleep";

describe("sleep", () => {
	it("resolves after the timer fires", async () => {
		vi.useFakeTimers();
		try {
			let done = false;
			const pending = sleep(50).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(49);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(done).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
	it("rejects an already aborted signal without scheduling a timer", async () => {
		vi.useFakeTimers();
		try {
			await expect(sleep(1000, AbortSignal.abort())).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels its timer on abort and removes its listener on completion", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const pending = sleep(1000, controller.signal);
			const rejected = expect(pending).rejects.toMatchObject({
				name: "AbortError",
			});
			controller.abort();
			await rejected;
			expect(vi.getTimerCount()).toBe(0);
			const completed = new AbortController();
			const remove = vi.spyOn(completed.signal, "removeEventListener");
			const timer = sleep(50, completed.signal);
			await vi.advanceTimersByTimeAsync(50);
			await timer;
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		} finally {
			vi.useRealTimers();
		}
	});
});
