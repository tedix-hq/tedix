import { describe, expect, it, vi } from "vite-plus/test";
import { requestPhaseTimings } from "./phase-timings";

describe("request phase timings", () => {
	it("retains only known numeric API phases and snapshots without sharing mutable state", () => {
		const timings = requestPhaseTimings({});
		timings.recordApi(
			'db;desc="queries=20 rows=20", output-storage;dur=125.5, output-editor;dur=4000, private-name;dur=4, output-editor;dur=-1, output-workspace;dur=Infinity',
		);
		const snapshot = timings.snapshot();
		expect(snapshot.api).toEqual({
			"output-storage": 125.5,
			"output-editor": 4000,
		});
		timings.recordApi("output-storage;dur=10");
		expect(snapshot.api?.["output-storage"]).toBe(125.5);
		expect(timings.snapshot().api?.["output-storage"]).toBe(135.5);
		expect(requestPhaseTimings({}).snapshot()).not.toHaveProperty("api");
	});
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
