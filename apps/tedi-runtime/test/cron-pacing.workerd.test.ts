import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { it, expect } from "vite-plus/test";
import {
	cronPacingKey,
	finishCronTask,
	reserveCronTask,
} from "../src/cron-pacing";
import type { PiRuntimeFixture } from "./pi-runtime/worker";

it("serializes competing fires and retains completion spacing across reconstruction and replacement", async () => {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	const stub = ns.get(ns.idFromName(crypto.randomUUID()));
	const task = {
		name: "review",
		schedule: { everyMs: 300_000 },
		now: 1_000_000,
	};
	await runInDurableObject(stub, async (_agent, state) => {
		const outcomes = await Promise.all(
			["first", "second"].map((workflowId) =>
				reserveCronTask(state.storage, {
					...task,
					workflowId,
					fireKey: workflowId,
				}),
			),
		);
		expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
	});
	await runInDurableObject(stub, async (_agent, state) => {
		const fire = (now: number, scheduledFor = now) =>
			reserveCronTask(state.storage, {
				...task,
				now,
				scheduledFor,
				workflowId: "replacement",
				fireKey: `new-row:${scheduledFor}`,
			});
		expect((await fire(5_000_000))?.reason).toBe("reconciliation_required");
		// A retry, stalled queued run or restart never releases its reservation.
		await finishCronTask(state.storage, task.name, "unrelated", 5_000_000);
		expect((await fire(5_000_001))?.reason).toBe("reconciliation_required");
		const open = await state.storage.get<{ open: { workflowId: string } }>(
			cronPacingKey(task.name),
		);
		// Terminal spacing must survive a reset before dispatch-context cleanup.
		await state.storage.put(`wfctx:${open!.open.workflowId}`, {
			cron: { name: task.name },
		});
		await finishCronTask(
			state.storage,
			task.name,
			open!.open.workflowId,
			5_000_002,
		);
		await finishCronTask(
			state.storage,
			task.name,
			open!.open.workflowId,
			5_100_000,
		);
		expect((await fire(5_300_001))?.reason).toBe("completion_cooldown");
		// Late delivery of an intervening alarm cannot catch up after cooldown.
		expect((await fire(6_000_000, 5_100_000))?.reason).toBe(
			"completion_cooldown",
		);
		expect(
			await reserveCronTask(state.storage, {
				...task,
				schedule: { everyMs: 1 },
				now: 5_200_000,
				workflowId: "shorter",
				fireKey: "shorter",
			}),
		).toMatchObject({ reason: "completion_cooldown", eligibleAt: 5_300_002 });
		expect(await fire(5_300_002)).toBeUndefined();
		const calendar = {
			name: "calendar",
			schedule: { expr: "*/5 * * * *" },
			now: 60_000,
			workflowId: "calendar",
			fireKey: "calendar",
		};
		expect(await reserveCronTask(state.storage, calendar)).toBeUndefined();
		await finishCronTask(
			state.storage,
			calendar.name,
			calendar.workflowId,
			180_000,
		);
		expect(
			await reserveCronTask(state.storage, {
				...calendar,
				now: 300_000,
				fireKey: "calendar-next",
			}),
		).toMatchObject({ reason: "completion_cooldown", eligibleAt: 480_000 });
	});
});

it("adopts old schedule identities and holds records with unknown liveness", async () => {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	const stub = ns.get(ns.idFromName(crypto.randomUUID()));
	await runInDurableObject(stub, async (_agent, state) => {
		await state.storage.put("wfctx:old-row", { cron: { name: "review" } });
		const hold = await reserveCronTask(state.storage, {
			name: "review",
			schedule: { everyMs: 300_000 },
			now: 10_000_000,
			workflowId: "new-row",
			fireKey: "new-row",
		});
		expect(hold?.reason).toBe("reconciliation_required");
		expect(await state.storage.get(cronPacingKey("review"))).toMatchObject({
			deferred: hold,
		});
	});
});
