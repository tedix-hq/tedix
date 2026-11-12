import { describe, expect, it, vi } from "vite-plus/test";
import { requestPhaseTimings } from "./phase-timings";

describe("request phase timings", () => {
	it("keeps request state separate and records failed phases without changing their error", async () => {
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const context = {};
			const timings = requestPhaseTimings(context);
			expect(requestPhaseTimings(context)).toBe(timings);
			const failure = new Error("handler failed");
			await expect(
				timings.measure("handler", async () => {
					now = 12;
					throw failure;
				}),
			).rejects.toBe(failure);
			await timings.measure("persistence", async () => {
				now = 17;
			});
			expect(timings.snapshot()).toEqual({
				unit: "ms",
				auth: null,
				policy: null,
				catalogResolution: null,
				handler: 12,
				persistence: 5,
				total: 17,
			});
			expect(requestPhaseTimings({}).snapshot().handler).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});
});
