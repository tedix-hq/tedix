import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { RegistryRestoreFixture } from "./registry-restore-fixture";

// Separate invocation: global-abort suites must not replace this test's targeted eviction.

it("cold ordinary native task restores its admitted tool without replacing task or effect identity", async () => {
	const namespace = (
		env as unknown as {
			REGISTRY_RESTORE: DurableObjectNamespace<RegistryRestoreFixture>;
		}
	).REGISTRY_RESTORE;
	const name = crypto.randomUUID();
	let agent = await getAgentByName(namespace, name);
	const id = await agent.begin();
	try {
		await expect
			.poll(() => agent.snapshot())
			.toMatchObject({
				id,
				status: "sleeping",
				registry: true,
				effects: 0,
				preparations: 0,
				liveTasks: 1,
				callId: `task-${id}`,
				dispatchStatus: null,
			});
		const before = await agent.snapshot();
		await evictDurableObject(agent);
		agent = await getAgentByName(namespace, name);
		expect(await agent.snapshot()).toMatchObject({
			id,
			status: "sleeping",
			registry: false,
			effects: 0,
			preparations: 0,
			accepted: before.accepted,
		});
		await runDurableObjectAlarm(agent);
		await expect
			.poll(async () => (await agent.snapshot()).status, { timeout: 8_000 })
			.toBe("terminal");
		expect(await agent.snapshot()).toMatchObject({
			id,
			status: "terminal",
			outcome: "completed",
			registry: true,
			effects: 1,
			preparations: 1,
			accepted: before.accepted,
			liveTasks: 0,
			callId: before.callId,
			dispatchStatus: "returned",
		});
	} finally {
		await agent.abortProbe();
	}
});

it("restricted turn restores an empty parent registry after eviction despite configured tools", async () => {
	const namespace = (
		env as unknown as {
			REGISTRY_RESTORE: DurableObjectNamespace<RegistryRestoreFixture>;
		}
	).REGISTRY_RESTORE;
	const name = crypto.randomUUID();
	let agent = await getAgentByName(namespace, name);
	await agent.begin(true);
	try {
		await evictDurableObject(agent);
		agent = await getAgentByName(namespace, name);
		expect(await agent.attemptTool()).toMatchObject({
			code: "facet_tool_unavailable",
		});
		expect(await agent.snapshot()).toMatchObject({
			effects: 0,
			preparations: 1,
			registry: true,
			toolCount: 0,
		});
	} finally {
		await agent.abortProbe();
	}
});
