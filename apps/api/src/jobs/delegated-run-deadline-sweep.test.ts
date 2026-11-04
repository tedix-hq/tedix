import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listQuietDelegatedRuns = vi.fn();
const readChildRunStatusesForRunRows = vi.fn();
const reconcileHomeRunRowsFromChildStatus = vi.fn();

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({ kind: "db" }) }));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	listQuietDelegatedRuns: (...args: unknown[]) =>
		listQuietDelegatedRuns(...args),
}));
vi.mock("../rpc/routers/kernel/delegation-work-item", () => ({
	KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS: 90_000,
}));
vi.mock("../rpc/routers/kernel/home-plan", () => ({
	readChildRunStatusesForRunRows: (...args: unknown[]) =>
		readChildRunStatusesForRunRows(...args),
}));
vi.mock("../rpc/routers/kernel/run-store-reconciliation", () => ({
	reconcileHomeRunRowsFromChildStatus: (...args: unknown[]) =>
		reconcileHomeRunRowsFromChildStatus(...args),
}));

import { sweepDelegatedRunDeadlines } from "./delegated-run-deadline-sweep";

const env = { DB: {} } as unknown as CloudflareEnv;
const scheduledTime = Date.parse("2026-11-04T12:00:00.000Z");

beforeEach(() => {
	listQuietDelegatedRuns.mockReset();
	readChildRunStatusesForRunRows.mockReset();
	reconcileHomeRunRowsFromChildStatus.mockReset();
});

describe("sweepDelegatedRunDeadlines", () => {
	it("re-reads quiet delegated rows per organization and counts the ones that settled", async () => {
		listQuietDelegatedRuns.mockResolvedValue([
			{ id: "a-1", organizationId: "org-a", status: "queued" },
			{ id: "b-1", organizationId: "org-b", status: "running" },
			{ id: "a-2", organizationId: "org-a", status: "running" },
		]);
		readChildRunStatusesForRunRows.mockResolvedValue({
			childRunStatuses: new Map(),
			unavailableChildRunKeys: new Set(),
		});
		reconcileHomeRunRowsFromChildStatus.mockImplementation(
			async (_context: unknown, input: { rows: Array<{ id: string }> }) =>
				input.rows.map((row) =>
					row.id === "a-1" ? { ...row, status: "failed" } : row,
				),
		);
		const counts = await sweepDelegatedRunDeadlines(env, scheduledTime);
		expect(listQuietDelegatedRuns).toHaveBeenCalledWith(
			{ kind: "db" },
			{ before: "2026-11-04T11:58:30.000Z", limit: 50 },
		);
		expect(reconcileHomeRunRowsFromChildStatus).toHaveBeenCalledTimes(2);
		expect(
			reconcileHomeRunRowsFromChildStatus.mock.calls.map((call) =>
				(call[1] as { rows: Array<{ id: string }> }).rows.map((row) => row.id),
			),
		).toEqual([["a-1", "a-2"], ["b-1"]]);
		expect(counts).toEqual({
			delegatedRunsChecked: 3,
			delegatedRunsSettled: 1,
			delegatedRunOrganizations: 2,
			delegatedRunSweepErrors: 0,
		});
	});

	it("keeps sweeping other organizations when one reconcile fails", async () => {
		listQuietDelegatedRuns.mockResolvedValue([
			{ id: "a-1", organizationId: "org-a", status: "queued" },
			{ id: "b-1", organizationId: "org-b", status: "queued" },
		]);
		readChildRunStatusesForRunRows.mockImplementation(
			async (_context: unknown, rows: Array<{ organizationId: string }>) => {
				if (rows[0]?.organizationId === "org-a")
					throw new Error("D1_ERROR: Network connection lost.");
				return {
					childRunStatuses: new Map(),
					unavailableChildRunKeys: new Set(),
				};
			},
		);
		reconcileHomeRunRowsFromChildStatus.mockImplementation(
			async (_context: unknown, input: { rows: unknown[] }) => input.rows,
		);
		const counts = await sweepDelegatedRunDeadlines(env, scheduledTime);
		expect(reconcileHomeRunRowsFromChildStatus).toHaveBeenCalledTimes(1);
		expect(counts).toMatchObject({
			delegatedRunsChecked: 2,
			delegatedRunsSettled: 0,
			delegatedRunSweepErrors: 1,
		});
	});

	it("is a no-op when nothing is quiet", async () => {
		listQuietDelegatedRuns.mockResolvedValue([]);
		const counts = await sweepDelegatedRunDeadlines(env, scheduledTime);
		expect(readChildRunStatusesForRunRows).not.toHaveBeenCalled();
		expect(counts.delegatedRunsChecked).toBe(0);
	});
});
