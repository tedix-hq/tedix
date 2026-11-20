import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import type { CronFirePayload } from "./cron";
import { CRON_OPEN_RUN_MAX_AGE_MS, openCronRun } from "./runtime-cron";

const existing = {
	id: "old-job",
	callback: "onCronFire",
	type: "interval",
	intervalSeconds: 3600,
	time: 1_900_000_000,
	payload: { name: "review", message: "Review the queue" },
};
const job = {
	name: "review",
	message: " Review the queue ",
	schedule: { kind: "every", everyMs: 3_600_000 },
};

{
	const calls: unknown[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-example", budgets: { maxCronJobs: 1 } },
		async listSchedules() {
			return [existing];
		},
		async cronProtectionError(name: string, action: string) {
			calls.push([name, action]);
			return null;
		},
		async scheduleEvery(
			seconds: number,
			callback: string,
			payload: CronFirePayload,
			options: unknown,
		) {
			assert.equal(seconds, 3600);
			assert.equal(callback, "onCronFire");
			assert.equal(payload.message, "Review the queue");
			assert.equal(payload.sessionKey, "chat:example");
			assert.equal(payload.source, "tool");
			assert.ok(payload.expiresAtMs! > Date.now());
			assert.deepEqual(options, { _idempotent: false });
			calls.push("created");
			return { id: "new-job" };
		},
		async cancelSchedule(id: string) {
			calls.push(["cancel", id]);
			return true;
		},
		async getScheduleById(id: string) {
			return { ...existing, id };
		},
	});
	const receipt = await agent.cronTool({ action: "add", job }, "chat:example");
	assert.equal(receipt.ok, true);
	assert.equal(receipt.job.id, "new-job");
	assert.deepEqual(calls, [
		["review", "replace"],
		"created",
		["cancel", "old-job"],
	]);
	calls.length = 0;
	agent.scheduleEvery = async () => {
		throw new Error("scheduler unavailable");
	};
	const failed = await agent.cronTool({ action: "add", job });
	assert.equal(failed.ok, false);
	assert.match(failed.error, /scheduler unavailable/);
	assert.deepEqual(
		calls,
		[["review", "replace"]],
		"failed replacement preserves old schedule",
	);
}

{
	const agent = tediDo({
		state: { tediId: "tedi-example" },
		async listSchedules() {
			return [
				existing,
				{ ...existing, id: "maintenance", callback: "onDailyLogFlush" },
			];
		},
		async getScheduleById() {
			return existing;
		},
		async cronProtectionError() {
			return "protected by policy";
		},
		async cancelSchedule() {
			assert.fail("protected schedule must not be removed");
		},
		async scheduleEvery() {
			assert.fail("protected schedule must not be replaced");
		},
	});
	const status = await agent.cronTool({ action: "status" });
	assert.equal(status.count, 1);
	assert.equal(status.jobs[0].id, "old-job");
	assert.deepEqual(await agent.cronTool({ action: "add", job }), {
		ok: false,
		error: "protected by policy",
	});
	assert.deepEqual(
		await agent.cronTool({ action: "remove", jobId: "old-job" }),
		{ ok: false, error: "protected by policy", protected: true },
	);
}

{
	const agent = tediDo({
		async getScheduleById() {
			return existing;
		},
		async onCronFire(payload: unknown, row: { id: string; time: number }) {
			assert.equal(payload, existing.payload);
			assert.equal(row.id, existing.id);
			assert.ok(row.time >= startedAt && row.time <= Date.now());
			assert.notEqual(row.time, existing.time);
			return { status: "dispatched", runId: "run-example" };
		},
	});
	const startedAt = Date.now();
	assert.deepEqual(await agent.cronTool({ action: "run", id: "old-job" }), {
		ok: true,
		fired: "old-job",
		outcome: { status: "dispatched", runId: "run-example" },
	});
	agent.getScheduleById = async () => ({
		...existing,
		callback: "onDailyLogFlush",
	});
	assert.deepEqual(await agent.cronTool({ action: "run", id: "old-job" }), {
		ok: false,
		error: "no cron job with id old-job",
	});
}
console.log("Runtime cron tool characterization tests passed");

// A recurring fire is held back only by an open run of the same schedule.
{
	const now = 1_900_000_000_000;
	const records = new Map<string, { admittedAt: number }>([
		["wfctx:cron_job-a_1900000000", { admittedAt: now - 200_000 }],
		["wfctx:cron_job-a_other_1900000000", { admittedAt: now }],
		["wfctx:cron_job-b_1900000000", { admittedAt: now }],
		[
			"wfctx:cron_job-c_1900000000",
			{ admittedAt: now - CRON_OPEN_RUN_MAX_AGE_MS - 1 },
		],
	]);
	const storage = {
		async list({ prefix }: { prefix: string }) {
			return new Map([...records].filter(([key]) => key.startsWith(prefix)));
		},
	} as unknown as Pick<DurableObjectStorage, "list">;
	assert.deepEqual(
		await openCronRun(storage, "job-a", "cron_job-a_1900000180", now),
		{ workflowInstanceId: "cron_job-a_1900000000", openForMs: 200_000 },
	);
	assert.equal(
		await openCronRun(storage, "job-a", "cron_job-a_1900000000", now),
		null,
		"a re-fired alarm does not block its own run",
	);
	assert.equal(
		await openCronRun(storage, "job-c", "cron_job-c_1900003700", now),
		null,
		"a record that outlived the bound no longer holds back the task",
	);
	assert.equal(
		await openCronRun(storage, "job-d", "cron_job-d_1900000000", now),
		null,
	);
	console.log("PASS: recurring fire is skipped while the previous run is open");
}
