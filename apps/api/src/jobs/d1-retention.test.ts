import { expect, it, vi } from "vite-plus/test";
import { runD1RetentionTick } from "./d1-retention";

const mocks = vi.hoisted(() => ({
	daily: vi.fn().mockResolvedValue({ catalogIntegrityDispatched: 1 }),
}));
vi.mock("@tedix/db/query-client", () => ({ createDbQueryClient: () => ({}) }));
vi.mock("../services/os-gadget-execution-body-store", () => ({
	retainGadgetExecutionBodies: vi
		.fn()
		.mockRejectedValue(new Error("fixture archive failure")),
}));
vi.mock("./retention-maintenance", () => ({
	runRetentionMaintenance: mocks.daily,
}));

it("keeps daily retention independent of archive failures and runs it on only one retention fire", async () => {
	for (const minute of [11, 27, 41]) {
		mocks.daily.mockClear();
		await expect(
			runD1RetentionTick(
				{ DB: {} } as CloudflareEnv,
				{
					scheduledTime: Date.UTC(2026, 10, 25, 3, minute, 11),
				} as ScheduledController,
			),
		).rejects.toMatchObject({
			counts: {
				d1RetentionFailed: 1,
				...(minute === 27 ? { catalogIntegrityDispatched: 1 } : {}),
			},
		});
		expect(mocks.daily).toHaveBeenCalledTimes(minute === 27 ? 1 : 0);
	}
});
