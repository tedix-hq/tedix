import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { dispatcherHealthReports } from "../schema/dispatcher-health";
import { machineToolCalls, machineToolPolls } from "../schema/machines";
import { upsertDispatcherHealthReport } from "./work-items/dispatcher-health";
import {
	claimMachineToolCalls,
	createMachineToolCall,
	isMachineReporter,
	listMachines,
	MACHINE_TOOL_CALL_MAX_WAITING,
	readMachineToolCall,
} from "./machines";

const T0 = "2026-11-19T10:00:00.000Z";
const after = (seconds: number) =>
	new Date(Date.parse(T0) + seconds * 1_000).toISOString();
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(dispatcherHealthReports, machineToolCalls, machineToolPolls),
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

let next = 0;
function queue(
	db: ReturnType<typeof fixture>,
	overrides: Partial<Parameters<typeof createMachineToolCall>[1]> = {},
) {
	next += 1;
	return createMachineToolCall(db, {
		id: `call-${String(next).padStart(3, "0")}`,
		orgId: "org",
		machineName: "studio",
		tool: "read_runner_state",
		input: "{}",
		requestedBy: { type: "tedi", id: "tedi-1" },
		at: T0,
		...overrides,
	});
}

function report(
	db: ReturnType<typeof fixture>,
	overrides: Partial<Parameters<typeof upsertDispatcherHealthReport>[1]> = {},
) {
	return upsertDispatcherHealthReport(db, {
		orgId: "org",
		reporterId: "reporter-1",
		executor: "codex",
		lane: "codex",
		running: true,
		observedAt: T0,
		reportedAt: T0,
		machineName: "studio",
		machineTools: ["read_file", "read_runner_state", "run_anything"],
		reportedBy: "user:owner",
		...overrides,
	});
}

describe("machines", () => {
	it("groups health reports by machine name within one organization", async () => {
		const db = fixture();
		await report(db);
		await report(db, { executor: "claude", lane: "claude" });
		await report(db, { executor: "supervisor", lane: "supervisor" });
		await report(db, {
			reporterId: "reporter-2",
			machineName: "laptop",
			machineTools: [],
			reportedAt: after(-600),
		});
		await report(db, { reporterId: "old-cli", machineName: null });
		await report(db, { orgId: "other", machineName: "elsewhere" });

		expect(await listMachines(db, { orgId: "org", at: after(60) })).toEqual([
			{
				machineName: "laptop",
				executors: ["codex"],
				lastSeenAt: after(-600),
				cliVersion: null,
				machineTools: [],
				online: false,
			},
			{
				machineName: "studio",
				executors: ["claude", "codex"],
				lastSeenAt: T0,
				cliVersion: null,
				// A tool name this server does not know is dropped.
				machineTools: ["read_file", "read_runner_state"],
				online: true,
			},
		]);
		expect(
			(await listMachines(db, { orgId: "org", at: after(601) })).map(
				(machine) => machine.online,
			),
		).toEqual([false, false]);
	});

	it("recognises a reporter only by the account that sent its health report", async () => {
		const db = fixture();
		await report(db);
		const who = {
			orgId: "org",
			reporterId: "reporter-1",
			machineName: "studio",
			reportedBy: "user:owner",
		};
		expect(await isMachineReporter(db, who)).toBe(true);
		expect(
			await isMachineReporter(db, { ...who, reportedBy: "user:other" }),
		).toBe(false);
		expect(await isMachineReporter(db, { ...who, machineName: "laptop" })).toBe(
			false,
		);
		expect(await isMachineReporter(db, { ...who, orgId: "other" })).toBe(false);
	});
});

describe("machine tool calls", () => {
	it("keeps a machine online after an empty poll and throttles refreshes across runners", async () => {
		const db = fixture();
		await report(db);
		await report(db, { reporterId: "reporter-2", machineName: "Studio" });
		const claim = {
			orgId: "org",
			machineName: "studio",
			reporterId: "reporter-1",
			limit: 1,
		};

		expect(
			(await claimMachineToolCalls(db, { ...claim, at: after(601) })).calls,
		).toEqual([]);
		await claimMachineToolCalls(db, {
			...claim,
			machineName: "Studio",
			reporterId: "reporter-2",
			at: after(660),
		});
		expect(
			await listMachines(db, { orgId: "org", at: after(1201) }),
		).toMatchObject([{ lastSeenAt: after(601), online: true }]);
		await claimMachineToolCalls(db, { ...claim, at: after(661) });
		expect(
			await listMachines(db, { orgId: "org", at: after(1262) }),
		).toMatchObject([{ lastSeenAt: after(661), online: false }]);
	});

	it("hands a machine its own waiting calls, oldest first, once", async () => {
		const db = fixture();
		const first = await queue(db);
		const second = await queue(db, { at: after(1) });
		const third = await queue(db, { at: after(2) });
		await queue(db, { machineName: "laptop" });
		await queue(db, { orgId: "other" });

		const claim = {
			orgId: "org",
			machineName: "studio",
			reporterId: "reporter-1",
		};
		const one = await claimMachineToolCalls(db, {
			...claim,
			limit: 2,
			at: after(5),
		});
		expect(one.calls.map((call) => call.id)).toEqual([first!.id, second!.id]);
		expect(one.calls[0]).toMatchObject({
			status: "claimed",
			claimedByReporterId: "reporter-1",
			claimedAt: after(5),
		});
		const two = await claimMachineToolCalls(db, {
			...claim,
			reporterId: "reporter-2",
			limit: 10,
			at: after(6),
		});
		expect(two.calls.map((call) => call.id)).toEqual([third!.id]);
		expect(
			(await claimMachineToolCalls(db, { ...claim, limit: 10, at: after(7) }))
				.calls,
		).toEqual([]);
	});

	it("stores a result only for a call this reporter claimed", async () => {
		const db = fixture();
		const mine = await queue(db);
		const theirs = await queue(db, { at: after(1) });
		const waiting = await queue(db, { at: after(2) });
		const claim = { orgId: "org", machineName: "studio" };
		await claimMachineToolCalls(db, {
			...claim,
			reporterId: "reporter-1",
			limit: 1,
			at: after(3),
		});
		await claimMachineToolCalls(db, {
			...claim,
			reporterId: "reporter-2",
			limit: 1,
			at: after(3),
		});

		const stored = await claimMachineToolCalls(db, {
			...claim,
			reporterId: "reporter-1",
			limit: 1,
			at: after(10),
			results: [
				{ callId: mine!.id, ok: true, result: "x".repeat(20_500) },
				{ callId: theirs!.id, ok: true, result: "stolen" },
				{ callId: "unknown", ok: false, error: "nope" },
			],
		});
		expect(stored.stored).toBe(1);
		// The same round trip claims the next waiting call.
		expect(stored.calls.map((call) => call.id)).toEqual([waiting!.id]);
		const done = await readMachineToolCall(db, {
			orgId: "org",
			id: mine!.id,
			at: after(11),
		});
		expect(done).toMatchObject({ status: "done", finishedAt: after(10) });
		expect(done!.result).toHaveLength(20_000);
		expect(
			await readMachineToolCall(db, {
				orgId: "org",
				id: theirs!.id,
				at: after(11),
			}),
		).toMatchObject({ status: "claimed", result: null });

		// A second answer for a finished call changes nothing.
		const again = await claimMachineToolCalls(db, {
			...claim,
			reporterId: "reporter-1",
			limit: 1,
			at: after(12),
			results: [{ callId: mine!.id, ok: false, error: "late" }],
		});
		expect(again.stored).toBe(0);
		// Another organization's runner with the same names stores nothing.
		const foreign = await claimMachineToolCalls(db, {
			orgId: "other",
			machineName: "studio",
			reporterId: "reporter-2",
			limit: 1,
			at: after(12),
			results: [{ callId: theirs!.id, ok: true, result: "cross" }],
		});
		expect(foreign.stored).toBe(0);
	});

	it("records a failure with a bounded reason", async () => {
		const db = fixture();
		const call = await queue(db);
		const claim = {
			orgId: "org",
			machineName: "studio",
			reporterId: "reporter-1",
			limit: 1,
		};
		await claimMachineToolCalls(db, { ...claim, at: after(1) });
		await claimMachineToolCalls(db, {
			...claim,
			at: after(2),
			results: [{ callId: call!.id, ok: false, error: "e".repeat(1_500) }],
		});
		const row = await readMachineToolCall(db, {
			orgId: "org",
			id: call!.id,
			at: after(3),
		});
		expect(row!.status).toBe("failed");
		expect(row!.error).toHaveLength(1_000);
	});

	it("expires a call nobody claimed and fails one nobody answered", async () => {
		const db = fixture();
		const unclaimed = await queue(db);
		const read = (id: string, seconds: number) =>
			readMachineToolCall(db, { orgId: "org", id, at: after(seconds) });
		expect((await read(unclaimed!.id, 59))!.status).toBe("pending");
		// An expired call is never handed to a runner.
		expect(
			(
				await claimMachineToolCalls(db, {
					orgId: "org",
					machineName: "studio",
					reporterId: "reporter-1",
					limit: 10,
					at: after(60),
				})
			).calls,
		).toEqual([]);
		expect(await read(unclaimed!.id, 61)).toMatchObject({
			status: "expired",
			error: null,
			finishedAt: after(60),
		});

		const unanswered = await queue(db, { at: after(100) });
		await claimMachineToolCalls(db, {
			orgId: "org",
			machineName: "studio",
			reporterId: "reporter-1",
			limit: 1,
			at: after(110),
		});
		expect((await read(unanswered!.id, 229))!.status).toBe("claimed");
		expect(await read(unanswered!.id, 230)).toMatchObject({
			status: "failed",
			error: "The machine did not answer in time",
		});
	});

	it("accepts a claimed file read when the folder permission prompt outlasts the normal answer window", async () => {
		const db = fixture();
		const call = await queue(db, { tool: "read_file" });
		const runner = {
			orgId: "org",
			machineName: "studio",
			reporterId: "reporter-1",
			limit: 1,
		};
		await claimMachineToolCalls(db, { ...runner, at: after(1) });
		expect(
			(
				await readMachineToolCall(db, {
					orgId: "org",
					id: call!.id,
					at: after(300),
				})
			)?.status,
		).toBe("claimed");
		expect(
			(
				await claimMachineToolCalls(db, {
					...runner,
					at: after(301),
					results: [{ callId: call!.id, ok: true, result: "README" }],
				})
			).stored,
		).toBe(1);
	});

	it("does not read another organization's call", async () => {
		const db = fixture();
		const call = await queue(db);
		expect(
			await readMachineToolCall(db, { orgId: "other", id: call!.id, at: T0 }),
		).toBeNull();
	});

	it("refuses a new call while too many wait for the machine", async () => {
		const db = fixture();
		for (let i = 0; i < MACHINE_TOOL_CALL_MAX_WAITING; i++)
			expect(await queue(db)).not.toBeNull();
		expect(await queue(db)).toBeNull();
		// Another machine, and the same machine once the waiting calls expired,
		// still take calls.
		expect(await queue(db, { machineName: "laptop" })).not.toBeNull();
		expect(await queue(db, { at: after(61) })).not.toBeNull();
	});
});
