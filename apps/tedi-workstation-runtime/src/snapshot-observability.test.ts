import { describe, expect, it, vi } from "vite-plus/test";
import {
	emitSnapshotMetric,
	snapshotDataPoint,
} from "./snapshot-observability";

describe("snapshot observability", () => {
	it("uses a stable content-free Analytics Engine layout", () => {
		expect(
			snapshotDataPoint({
				operation: "restore",
				outcome: "success",
				reason: "none",
				durationMs: 42,
				ageMs: 900,
				retainedReference: 0,
			}),
		).toEqual({
			blobs: ["workstation_snapshot", "restore", "success", "none"],
			doubles: [42, 900, 0],
		});
	});

	it("keeps telemetry fail-soft", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		expect(() =>
			emitSnapshotMetric(
				{
					writeDataPoint() {
						throw new Error("unavailable");
					},
				},
				{
					operation: "create",
					outcome: "failure",
					reason: "provider_rejected",
					retainedReference: 0,
				},
			),
		).not.toThrow();
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				component: "tedi.workstation.snapshot",
				event: "create.failure",
			}),
		);
		info.mockRestore();
	});
});
