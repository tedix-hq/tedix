import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import type { CronFirePayload } from "./cron";

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
