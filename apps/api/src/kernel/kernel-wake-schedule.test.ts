import { describe, expect, it, vi } from "vite-plus/test";
import {
	ensureKernelWakeSchedule,
	KERNEL_TIMER_WAKE_CALLBACK,
} from "./kernel-wake-schedule";

function scheduler(
	pending: Array<{ id: string; callback: string; time: number }> = [],
) {
	return {
		listSchedules: vi.fn(async () => pending),
		schedule: vi.fn(async () => undefined),
		cancelSchedule: vi.fn(async () => true),
	};
}

describe("kernel wake schedules", () => {
	it("rounds deadlines up and deduplicates each deadline through the SDK", async () => {
		const sdk = scheduler();
		await ensureKernelWakeSchedule(sdk, 10_250);
		expect(sdk.schedule).toHaveBeenCalledWith(
			new Date(11_000),
			KERNEL_TIMER_WAKE_CALLBACK,
			{ targetMs: 11_000 },
			{ idempotent: true },
		);
	});
	it("preserves an earlier kernel wake but does not confuse maintenance with a wake", async () => {
		const sdk = scheduler([
			{ id: "early", callback: KERNEL_TIMER_WAKE_CALLBACK, time: 10 },
		]);
		await ensureKernelWakeSchedule(sdk, 20_000);
		expect(sdk.schedule).not.toHaveBeenCalled();
		sdk.listSchedules.mockResolvedValue([
			{ id: "maintenance", callback: "reconcileRuns", time: 5 },
		]);
		await ensureKernelWakeSchedule(sdk, 20_000);
		expect(sdk.schedule).toHaveBeenCalledOnce();
		expect(sdk.cancelSchedule).not.toHaveBeenCalled();
	});
	it("installs an earlier wake before cancelling the later one", async () => {
		const sdk = scheduler([
			{ id: "later", callback: KERNEL_TIMER_WAKE_CALLBACK, time: 30 },
		]);
		await ensureKernelWakeSchedule(sdk, 20_000);
		expect(sdk.schedule.mock.invocationCallOrder[0]).toBeLessThan(
			sdk.cancelSchedule.mock.invocationCallOrder[0]!,
		);
		expect(sdk.cancelSchedule).toHaveBeenCalledWith("later");
	});
	it("retains the old wake when installing its replacement fails", async () => {
		const sdk = scheduler([
			{ id: "later", callback: KERNEL_TIMER_WAKE_CALLBACK, time: 30 },
		]);
		sdk.schedule.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(ensureKernelWakeSchedule(sdk, 20_000)).rejects.toThrow(
			"storage unavailable",
		);
		expect(sdk.cancelSchedule).not.toHaveBeenCalled();
	});
});
