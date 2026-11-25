import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { workDue, WORK_DUE_KINDS } from "@tedix/db/schema/work-due";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { dispatchWorkDue } from "./work-due";

const maintenance = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("./work-maintenance-due", () => ({
	dispatchMaintenanceDue: maintenance,
}));

const handlers = vi.hoisted(() => ({
	approval: vi.fn().mockResolvedValue({}),
	redrive: vi.fn().mockResolvedValue({}),
	review: vi.fn().mockResolvedValue({}),
	delegation: vi.fn().mockResolvedValue({}),
	supervision: vi.fn().mockResolvedValue({}),
	orphan: vi.fn().mockResolvedValue({}),
	attempt: vi.fn().mockResolvedValue({}),
}));
vi.mock("./approval-expiry", () => ({
	expireOverdueApprovals: handlers.approval,
}));
vi.mock("./work-approval-redrive", () => ({
	dispatchWorkApprovalRedrives: handlers.redrive,
}));
vi.mock("./interaction-follow-through", () => ({
	dispatchInteractionReviews: handlers.review,
}));
vi.mock("./delegated-run-deadline-sweep", () => ({
	sweepDelegatedRunDeadlines: handlers.delegation,
}));
vi.mock("./agent-run-supervision", () => ({
	dispatchAgentRunSupervision: handlers.supervision,
}));
vi.mock("./platform-tick", () => ({ sweepOrphanRunsTick: handlers.orphan }));
vi.mock("./work-attempt-lease-sweeper", () => ({
	runWorkAttemptLeaseSweeperTick: handlers.attempt,
}));

it("dispatches each kind at its due time from a single claim, with no early object reads", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(workDue));
		const DB = createD1Facade(sqlite);
		const db = createDbQueryClient(DB);
		const now = Date.now();
		await db.insert(workDue).values(
			WORK_DUE_KINDS.map((kind) => ({
				orgId: "org",
				kind,
				objectId: kind,
				dueAt: new Date(now).toISOString(),
			})),
		);
		const prepare = vi.spyOn(DB, "prepare");
		const env = { DB, TEDI_SERVICE: {} } as unknown as CloudflareEnv;
		const track = async (_kind: string, run: () => Promise<unknown>) => {
			await run();
		};
		await dispatchWorkDue(env, now - 1, track);
		expect(prepare).toHaveBeenCalledTimes(1);
		for (const handler of Object.values(handlers))
			expect(handler).not.toHaveBeenCalled();
		prepare.mockClear();
		await dispatchWorkDue(env, now, track);
		const entries = Object.values(handlers);
		for (const [index, handler] of entries.entries()) {
			expect(handler).toHaveBeenCalledTimes(1);
			const kind = WORK_DUE_KINDS[index]!;
			expect(handler).toHaveBeenCalledWith(
				...(kind === "approval-expiry" || kind === "orphan-run-sweep"
					? [env, [kind]]
					: kind === "agent-run-supervision"
						? [env, now, [kind], expect.any(Function)]
						: [env, now, [kind]]),
			);
		}
		expect(maintenance).toHaveBeenCalledTimes(5);
		for (const kind of WORK_DUE_KINDS.slice(7)) {
			expect(maintenance).toHaveBeenCalledWith(env, kind, now, [
				expect.objectContaining({ orgId: "org", objectId: kind }),
			]);
		}
		// One claim, then only bounded claim-release statements; no source scans.
		expect(
			prepare.mock.calls.filter(([query]) => query.includes("SELECT org_id")),
		).toHaveLength(1);
		for (const [query] of prepare.mock.calls) expect(query).toMatch(/work_due/);
		await dispatchWorkDue(env, now + 1, track);
		for (const handler of entries) expect(handler).toHaveBeenCalledTimes(1);
		handlers.redrive.mockResolvedValueOnce({ observed: 0 });
		await dispatchWorkDue(env, now + 120_000, track);
		expect(
			(await db.select().from(workDue)).some(
				(row) => row.kind === "work-approval-redrive",
			),
		).toBe(false);
	} finally {
		sqlite.close();
	}
});

it("keeps unprocessed supervision timers due ahead of already serviced supervisors", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(workDue));
		const DB = createD1Facade(sqlite);
		const db = createDbQueryClient(DB);
		const now = Date.now();
		const ids = Array.from(
			{ length: 45 },
			(_, index) => `run-${String(index).padStart(2, "0")}`,
		);
		for (const objectId of ids)
			await db.insert(workDue).values({
				orgId: "orchard",
				objectId,
				kind: "agent-run-supervision",
				dueAt: new Date(now).toISOString(),
			});
		handlers.supervision.mockClear();
		handlers.supervision.mockImplementationOnce(
			async (_env, _time, dueIds, unprocessed) => {
				unprocessed(dueIds.slice(40));
				return { budgetExhausted: 1 };
			},
		);
		const env = { DB, TEDI_SERVICE: {} } as unknown as CloudflareEnv;
		const track = async (_kind: string, run: () => Promise<unknown>) => {
			await run();
		};
		await dispatchWorkDue(env, now, track);
		const second = vi.fn();
		handlers.supervision.mockImplementationOnce(
			async (_env, _time, pending) => {
				second(pending);
				return {};
			},
		);
		await dispatchWorkDue(env, now + 1, track);
		expect(second).toHaveBeenCalledWith(ids.slice(40));
	} finally {
		sqlite.close();
	}
});
