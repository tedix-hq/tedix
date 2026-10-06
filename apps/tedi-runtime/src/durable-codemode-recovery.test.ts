import assert from "node:assert/strict";
import {
	DurableCodePassCoordinator,
	bindDurableCodeRecovery,
	createDurableCodeRecovery,
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
console.log("durable-codemode-recovery OK");
