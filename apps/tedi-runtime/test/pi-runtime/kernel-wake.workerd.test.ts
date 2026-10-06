import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { KernelWakeFixture } from "./kernel-wake-fixture";

it("keeps the kernel wake through SDK queue mutations and restart", async () => {
	const bindings = env as unknown as {
		KERNEL_WAKE: DurableObjectNamespace<KernelWakeFixture>;
	};
	const name = crypto.randomUUID();
	const agent = await getAgentByName(bindings.KERNEL_WAKE, name);
	const result = await agent.probe();
	// Reproduce the broken raw-alarm path against Agents 0.23, then verify the
	// production helper persists that deadline in the lifecycle-owned queue.
	expect(result.overwrittenRawAlarm).toBeGreaterThan(result.early);
	expect(result.queuedAlarm).toBe(result.early);
	expect(result.afterCancellation).toBe(result.early);
	expect(result.afterMaintenance).toBe(result.early);
	expect(result.snapshot.wakes).toHaveLength(1);
	await abortAllDurableObjects();
	const restarted = await getAgentByName(bindings.KERNEL_WAKE, name);
	const snapshot = await restarted.inspect();
	expect(snapshot.alarm).toBe(result.early);
	expect(snapshot.wakes).toHaveLength(1);
});
