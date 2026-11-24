import { expect, it, vi } from "vite-plus/test";
import type { DbQueryClient } from "@tedix/db/query-client";
import { listOsWorkApps } from "@tedix/db/queries/os-workspaces/gadgets";
import { readWorkApps } from "./work-apps";

vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	listOsWorkApps: vi.fn(),
}));

it("coalesces a burst, isolates viewers and tenants, expires after a minute and retries failed reads", async () => {
	vi.useFakeTimers();
	try {
		const db = {} as DbQueryClient;
		const query = vi.mocked(listOsWorkApps).mockResolvedValue([]);
		await Promise.all(
			Array.from({ length: 204 }, () =>
				readWorkApps(db, "pine", { userIds: ["ada", "bea"] }, 101),
			),
		);
		expect(query).toHaveBeenCalledTimes(1);
		await readWorkApps(db, "pine", { userIds: ["bea", "ada", "ada"] }, 201);
		expect(query).toHaveBeenCalledTimes(1);
		await readWorkApps(db, "cedar", { userIds: ["ada", "bea"] }, 101);
		await readWorkApps(db, "pine", { userIds: ["ada"] }, 101);
		await readWorkApps(
			db,
			"pine",
			{ userIds: ["ada"], workspaceIds: ["inspection"] },
			101,
		);
		expect(query).toHaveBeenCalledTimes(4);
		vi.advanceTimersByTime(60_000);
		query.mockRejectedValueOnce(new Error("D1 busy"));
		await expect(
			readWorkApps(db, "pine", { userIds: ["ada"] }, 101),
		).rejects.toThrow("D1 busy");
		await readWorkApps(db, "pine", { userIds: ["ada"] }, 101);
		expect(query).toHaveBeenCalledTimes(6);
		expect(query).toHaveBeenLastCalledWith(
			db,
			"pine",
			{ userIds: ["ada"] },
			201,
		);
	} finally {
		vi.useRealTimers();
	}
});
