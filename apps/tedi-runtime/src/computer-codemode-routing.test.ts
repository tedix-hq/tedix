import assert from "node:assert/strict";
import type { ExecutionState } from "@cloudflare/codemode";
import { ComputerCodeRouting } from "./computer-codemode-routing";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";

function fixture() {
	const persisted = new Map<string, unknown>();
	const storage = {
		async get(key: string) {
			return structuredClone(persisted.get(key));
		},
		async put(key: string, value: unknown) {
			persisted.set(key, structuredClone(value));
		},
		async list({ prefix }: { prefix: string }) {
			return new Map([...persisted].filter(([key]) => key.startsWith(prefix)));
		},
	} as unknown as ConstructorParameters<typeof ComputerCodeRouting>[0];
	const histories = new Map<string, ExecutionState[]>();
	const reads: Array<{
		scope: ComputerWorkspaceScope;
		limit: number | undefined;
	}> = [];
	const runtime = async (scope: ComputerWorkspaceScope) => ({
		async executions(limit?: number) {
			reads.push({ scope, limit });
			const all = histories.get(JSON.stringify(scope)) ?? [];
			return limit === undefined ? all : all.slice(0, limit);
		},
	});
	return {
		persisted,
		histories,
		reads,
		router: () => new ComputerCodeRouting(storage, runtime),
	};
}
const a: ComputerWorkspaceScope = { kind: "conversation", key: "session:a" };
const b: ComputerWorkspaceScope = {
	kind: "delegated-run",
	key: '["work-b","run-b"]',
};
const operator: ComputerWorkspaceScope = {
	kind: "operator",
	key: "direct-control",
};
const paused = (id: string): ExecutionState => ({
	id,
	code: "async () => workspace.writeFile({path: 'notes', content: 'approved'})",
	status: "paused",
	log: [],
	createdAt: 1,
	updatedAt: 1,
});

// The SDK persisted a paused execution, then the parent restarted before it
// could record the generated execution ID. Only the pre-execution registry survives.
{
	const f = fixture();
	const before = f.router();
	await Promise.all([
		before.register("workspace-a", a),
		before.register("workspace-b", b),
	]);
	f.histories.set(
		JSON.stringify(a),
		Array.from({ length: 150 }, (_, i) => paused(`a-${i}`)),
	);
	f.histories.set(JSON.stringify(b), [paused("b-paused")]);
	const restarted = f.router();
	assert.deepEqual(
		await restarted.resolve("a-149"),
		a,
		"old queued approval recovers its original workspace after restart",
	);
	assert.deepEqual(await restarted.resolve("b-paused"), b);
	assert.ok(
		f.reads.every(({ limit }) => limit === undefined),
		"pending approval discovery must not truncate history",
	);
	const reads = f.reads.length;
	assert.deepEqual(await f.router().resolve("a-149"), a);
	assert.equal(
		f.reads.length,
		reads,
		"recovered ownership is persisted for the next restart",
	);
	await assert.rejects(restarted.resolve("unknown"), /unavailable/);
}

// Independent concurrent completions must not borrow an ambient active scope.
{
	const f = fixture();
	const router = f.router();
	await Promise.all([
		router.register("workspace-a", a),
		router.register("workspace-b", b),
		router.record("execution-b", b),
		router.record("execution-a", a),
	]);
	assert.deepEqual(
		await Promise.all([
			f.router().resolve("execution-a"),
			f.router().resolve("execution-b"),
		]),
		[a, b],
	);
	assert.equal(f.reads.length, 0);
	await router.record("operator-execution", operator);
	assert.deepEqual(await f.router().resolve("operator-execution"), operator);
	await assert.rejects(router.record("operator-execution", a), /cannot change/);
	await assert.rejects(router.register("workspace-a", b), /cannot change/);
	assert.deepEqual(
		await router.resolve("operator-execution"),
		operator,
		"conversation scope cannot replace operator ownership",
	);
	const conflicting = await Promise.allSettled([
		router.record("conflicting", a),
		router.record("conflicting", b),
	]);
	assert.equal(
		conflicting.filter(({ status }) => status === "fulfilled").length,
		1,
	);
	assert.equal(
		conflicting.filter(({ status }) => status === "rejected").length,
		1,
	);
	await router.record("after-rejection", b);
	assert.deepEqual(
		await router.resolve("after-rejection"),
		b,
		"a rejected reassignment does not poison future writes",
	);
}

// Corrupt or ambiguous durable ownership must never select a default workspace.
{
	const f = fixture();
	const router = f.router();
	await router.register("workspace-a", a);
	await router.register("workspace-b", b);
	f.histories.set(JSON.stringify(a), [paused("duplicate")]);
	f.histories.set(JSON.stringify(b), [paused("duplicate")]);
	await assert.rejects(router.resolve("duplicate"), /ambiguous/);
	assert.equal(f.persisted.has("durable-code:workspace:duplicate"), false);
	for (const corrupt of [
		null,
		"session",
		{ kind: "unknown", key: "x" },
		{ kind: "conversation", key: "" },
		{ ...a, extra: true },
	]) {
		f.persisted.set("durable-code:workspace:corrupt", corrupt);
		await assert.rejects(router.resolve("corrupt"), /Invalid/);
	}
	f.persisted.set("durable-code:registered-workspace:workspace-a", {
		kind: "conversation",
	});
	await assert.rejects(router.resolve("unmapped"), /Invalid/);
}

{
	const inaccessibleStorage = {
		async get() {
			throw new Error("storage unavailable");
		},
	} as unknown as ConstructorParameters<typeof ComputerCodeRouting>[0];
	const router = new ComputerCodeRouting(inaccessibleStorage, async () => {
		throw new Error("must not choose a fallback runtime after a storage error");
	});
	await assert.rejects(router.resolve("pending"), /storage unavailable/);
}

console.log("Computer Code Mode routing recovery tests passed.");

{
	const f = fixture();
	const before = {
		...a,
		environment: {
			leaseId: "old",
			cwd: "/home/tedi/workstation",
			preparation: "shell" as const,
			ready: true,
		},
	};
	const after = {
		...before,
		environment: { ...before.environment, leaseId: "new" },
	};
	await f.router().register("a:old", before);
	await f.router().register("a:new", after);
	f.histories.set(JSON.stringify(before), [paused("old-pending")]);
	assert.deepEqual(await f.router().resolve("old-pending"), before);
	await assert.rejects(
		f.router().record("old-pending", after),
		/cannot change/,
	);
}
