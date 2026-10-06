import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { ComputerTurnFixture } from "./pi-runtime/computer-turn-fixture";

const bindings = env as unknown as {
	COMPUTER_TURN: DurableObjectNamespace<ComputerTurnFixture>;
};

it("renews the exact Attempt repeatedly through real SDK intervals, reentry and restart", async () => {
	const name = crypto.randomUUID();
	let agent = await getAgentByName(bindings.COMPUTER_TURN, name);
	await agent.beginLeaseRenewal();
	await agent.reenterLeaseRenewal();
	const initial = await agent.inspectLeaseRenewal();
	expect(initial.schedules).toHaveLength(1);
	const scheduleId = initial.schedules[0]!.id;
	for (let tick = 1; tick <= 3; tick++) {
		if (tick === 2) {
			await abortAllDurableObjects();
			agent = await getAgentByName(bindings.COMPUTER_TURN, name);
			await agent.reenterLeaseRenewal();
		}
		await agent.makeLeaseRenewalDue();
		expect(await runDurableObjectAlarm(agent)).toBe(true);
		await expect
			.poll(async () => (await agent.inspectLeaseRenewal()).heartbeats.length)
			.toBe(tick);
		const state = await agent.inspectLeaseRenewal();
		expect(state.schedules).toHaveLength(1);
		expect(state.schedules[0]).toMatchObject({
			id: scheduleId,
			type: "interval",
			intervalSeconds: 60,
		});
		expect(state.record?.armedAt).toBe(initial.record?.armedAt);
		expect(state.heartbeats).toEqual(
			Array.from({ length: tick }, () => ({
				workItemId: "work-1",
				attemptId: "attempt-1",
			})),
		);
	}
	await agent.cancelLeaseRenewal();
	await agent.makeLeaseRenewalDue();
	expect(await runDurableObjectAlarm(agent)).toBe(true);
	await expect
		.poll(async () => (await agent.inspectLeaseRenewal()).schedules.length)
		.toBe(0);
	const final = await agent.inspectLeaseRenewal();
	expect(final.record).toBeUndefined();
	expect(final.heartbeats).toHaveLength(3);
});
