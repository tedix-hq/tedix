import assert from "node:assert/strict";
import {
	DurableCodePassCoordinator,
	bindDurableCodeRecovery,
	createDurableCodeRecovery,
	scopeDurableCodeAction,
} from "./durable-codemode-recovery";
import type { CodemodeRuntimeHandle } from "@cloudflare/codemode";
const coordinator = new DurableCodePassCoordinator();
let release!: () => void;
const held = coordinator.pass(
	"same",
	() =>
		new Promise<void>((resolve) => {
			release = resolve;
		}),
);
let mutated = false;
assert.deepEqual(
	await coordinator.recover("same", { executionId: "e" }, async () => {
		mutated = true;
		return { recovered: false, execution_id: "e", reason: "too_recent" };
	}),
	{ recovered: false, execution_id: "e", reason: "active_pass" },
);
assert.equal(mutated, false);
assert.equal(await coordinator.pass("another", async () => true), true);
release();
await held;
const recovering = coordinator.recover(
	"same",
	{ executionId: "e" },
	async () => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { recovered: false, execution_id: "e", reason: "too_recent" };
	},
);
await assert.rejects(
	coordinator.pass("same", async () => true),
	/recovery is in progress/,
);
release();
await recovering;
await assert.rejects(
	coordinator.pass("same", async () => {
		throw new Error("failed pass");
	}),
	/failed pass/,
);
assert.equal(await coordinator.pass("same", async () => true), true);
const runtime = {
	execute: async () =>
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	approve: async () =>
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	executions: async () => [],
} as unknown as CodemodeRuntimeHandle;
const wrapper = bindDurableCodeRecovery({
	runtime,
	key: "bound",
	coordinator,
	recover: async () => ({
		recovered: false,
		execution_id: "e",
		reason: "too_recent",
	}),
});
for (const verb of ["execute", "approve"] as const) {
	const pass =
		verb === "execute"
			? wrapper.execute({ code: "1" })
			: wrapper.approve({ executionId: "e" });
	assert.equal((await wrapper.recover({ executionId: "e" })).recovered, false);
	release();
	await pass;
}
let lookup = 0;
const recover = createDurableCodeRecovery({
	scope: { kind: "conversation", key: "owner" },
	resolve: async () => ({ kind: "conversation", key: "other" }),
	runtime: async () => {
		lookup++;
		return wrapper;
	},
});
await assert.rejects(
	recover({ execution_id: "e" }),
	/another Computer workspace/,
);
assert.equal(lookup, 0);
for (const action of ["approve", "reject", "rollback"]) {
	for (const foreign of [
		{ kind: "conversation", key: "other" },
		{ kind: "delegated-run", key: "owner" },
	]) {
		let mutations = 0;
		let resolved = { kind: "conversation", key: "owner" };
		const execute = scopeDurableCodeAction({
			scope: { kind: "conversation", key: "owner" },
			resolve: async (id) => {
				assert.equal(id, "e");
				return resolved;
			},
			action: async (args: { execution_id: string; seq?: number }) => {
				mutations++;
				return { action, ...args };
			},
		});
		resolved = foreign;
		await assert.rejects(
			execute({ execution_id: "e", seq: 2 }),
			/another Computer workspace/,
		);
		assert.equal(mutations, 0, action);
		resolved = { kind: "conversation", key: "owner" };
		assert.deepEqual(await execute({ execution_id: "e", seq: 2 }), {
			action,
			execution_id: "e",
			seq: 2,
		});
		assert.equal(mutations, 1, action);
	}
}
console.log("durable-codemode-recovery OK");
