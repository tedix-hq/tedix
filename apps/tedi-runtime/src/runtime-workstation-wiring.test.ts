import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

// Detached reads must never borrow a later turn's authority.
{
	const platform = {};
	const active = { runId: "run-a", conversationId: "conversation-a", platform };
	const agent = tediDo({
		activeTurnBinding: active,
		getPlatformClient: async () => platform,
	});
	assert.equal(await agent.resolveWorkstationTurnBinding(null), null);
	assert.equal(await agent.resolveWorkstationTurnBinding(undefined), active);
	const replacement = { runId: "run-b", conversationId: "conversation-b" };
	assert.deepEqual(await agent.resolveWorkstationTurnBinding(replacement), {
		...replacement,
		platform,
	});
	agent.activeTurnBinding = { ...replacement, platform };
	assert.equal(
		await agent.resolveWorkstationTurnBinding(undefined),
		agent.activeTurnBinding,
	);
}

// Missing identity fails before acquisition or confirmation can produce effects.
{
	let confirmed = false;
	const agent = tediDo({ state: {}, ensureIdentity: async () => {} });
	assert.deepEqual(
		await agent.requestWorkstationTool({}, null, async () => {
			confirmed = true;
		}),
		{ ok: false, error: "Tedi identity is not resolved" },
	);
	assert.equal(confirmed, false);
}

// A collected wake is inert; no process read or dispatch is owed.
{
	const agent = tediDo({
		ctx: { storage: { get: async () => undefined } },
		readWorkstationJobTool: async () =>
			assert.fail("collected wake read a process"),
	});
	await agent.onComputerExecutionWake({ executionId: "collected" });
}
// Concurrent calls share the parent's provisioning lock even across fresh adapters.
{
	let active: unknown = null;
	let starts = 0;
	const agent = tediDo({
		inspectFiberByKey: async () => active,
		listFibers: async () => [],
		startFiber: async () => {
			starts++;
			await Promise.resolve();
			active = { fiberId: "fiber-one", status: "running", accepted: true };
			return active;
		},
	});
	const results = await Promise.all([
		agent.startWorkstationProvisioningFiber({ leaseId: "lease-one" }, null),
		agent.startWorkstationProvisioningFiber({ leaseId: "lease-one" }, null),
	]);
	assert.equal(starts, 1);
	assert.deepEqual(
		results.map((result) => result.accepted),
		[true, false],
	);
}
console.log("runtime workstation wiring characterization passed");
