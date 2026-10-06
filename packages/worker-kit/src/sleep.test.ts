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
});
