import type { DbClient } from "@tedix/db/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	reapIdleWorkstationLeases,
	workstationIdleCutoff,
} from "./workstation-lease-reaper";

const expireIdleWorkstationLeases = vi.hoisted(() => vi.fn());
const closeTerminalLeaseBundles = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/workstations", () => ({
	WORKSTATION_LEASE_IDLE_EXPIRY_HOURS: 6,
	closeTerminalLeaseBundles,
	expireIdleWorkstationLeases,
}));

const db = {} as DbClient;
const options = {
	idleBefore: "2026-08-03T18:00:00.000Z",
	now: "2026-08-04T00:00:00.000Z",
};

afterEach(() => expireIdleWorkstationLeases.mockReset());

describe("workstation lease reaper", () => {
	it("summarises what it reclaimed by the state it was stuck in", async () => {
		// The production backlog shape: leaks accumulate across several
		// non-terminal states, not just `active`.
		expireIdleWorkstationLeases.mockResolvedValue([
			{ lastAliveAt: "x", leaseId: "1", orgId: "o", previousStatus: "active" },
			{ lastAliveAt: "x", leaseId: "2", orgId: "o", previousStatus: "blocked" },
			{ lastAliveAt: "x", leaseId: "3", orgId: "o", previousStatus: "blocked" },
		]);

		const result = await reapIdleWorkstationLeases(db, options);

		expect(result.expired).toBe(3);
		expect(result.byPreviousStatus).toEqual({ active: 1, blocked: 2 });
	});

	it("passes the idle cutoff through rather than expiring by age", async () => {
		expireIdleWorkstationLeases.mockResolvedValue([]);

		await reapIdleWorkstationLeases(db, options);

		const call = expireIdleWorkstationLeases.mock.calls[0]?.[1] as {
			idleBefore: string;
			limit: number;
		};
		expect(call.idleBefore).toBe("2026-08-03T18:00:00.000Z");
		expect(call.limit).toBeGreaterThan(0);
	});

	it("reports nothing when there is nothing stale", async () => {
		expireIdleWorkstationLeases.mockResolvedValue([]);

		const result = await reapIdleWorkstationLeases(db, options);

		expect(result.expired).toBe(0);
		expect(result.byPreviousStatus).toEqual({});
	});

	it("derives the cutoff from idle hours, not from lease age", () => {
		// A lease created a week ago but touched a minute ago is NOT stale; the
		// cutoff is always measured backwards from now.
		expect(workstationIdleCutoff(new Date("2026-08-04T00:00:00.000Z"), 6)).toBe(
			"2026-08-03T18:00:00.000Z",
		);
	});
});
