import assert from "node:assert/strict";
import {
	PiTurnAccounting,
	PiAccountingError,
	isReplaySafeRecoveryTool,
	type PiAccountingAuthority,
	type PiProviderAttempt,
	type ReconciledEffect,
} from "./pi-turn-accounting";
import { REPOSITORY_STARTING_INSTRUCTION } from "./computer-acquisition";

async function test(name: string, run: () => Promise<void>) {
	await run();
	console.log(`PASS ${name}`);
}

function fixture() {
	const rows = new Map<string, unknown>();
	const receipts = new Map<string, number | null>();
	const reservations = new Map<string, number>();
	const effects = new Map<string, ReconciledEffect>();
	let failReceipt = false;
	let canceled = false;
	const storage = {
		get: async (key: string) => structuredClone(rows.get(key)),
		put: async (key: string, value: unknown) => {
			rows.set(key, structuredClone(value));
		},
	} as unknown as Pick<DurableObjectStorage, "get" | "put">;
	const authority: PiAccountingAuthority = {
		assertActive: async () => {
			if (canceled) throw new Error("run canceled");
		},
		reserveStep: async ({ stepId, estimatedTokens }) => {
			reservations.set(stepId, estimatedTokens);
		},
		recordStep: async ({ stepId, actualTokens }) => {
			receipts.set(stepId, actualTokens);
			if (failReceipt) throw new Error("lost acknowledgement");
		},
		reconcileEffect: async (_run, callId) => effects.get(callId) ?? null,
	};
	return {
		rows,
		receipts,
		reservations,
		effects,
		cancel() {
			canceled = true;
		},
		fail(value: boolean) {
			failReceipt = value;
		},
		create() {
			return new PiTurnAccounting(storage, authority);
		},
	};
}
const usage = { inputTokens: 60, outputTokens: 40, totalTokens: 100 };
let capturedA: PiProviderAttempt, capturedB: PiProviderAttempt;
const context = { messages: [{ role: "user" as const, content: "hello" }] };

await test("native receipts deduplicate and durable ceilings survive client resets", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("a");
	assert.equal(await a.prepareStep(context, { maxSteps: 2 }), 0);
	capturedA = await a.captureProviderAttempt();
	await a.recordProviderUsage(usage, [], capturedA);
	await a.recordProviderUsage(usage, [], capturedA);
	await a.assertComplete();
	assert.equal(f.receipts.size, 1);
	assert.equal((await a.usage()).totalTokens, 100);
	assert.ok(
		f.rows.has("pi-accounting:a"),
		"write only the native accounting namespace",
	);
	const b = f.create();
	await b.begin("a");
	assert.equal(await b.prepareStep(context, { maxSteps: 2 }), 1);
	capturedB = await b.captureProviderAttempt();
	await b.recordProviderUsage(usage, [], capturedB);
	assert.equal((await b.usage()).totalTokens, 200);
	await assert.rejects(b.prepareStep(context, { maxSteps: 2 }), /ceiling/);
	assert.equal(b.hasFault(), true);
	await b.begin("other");
	assert.equal(b.hasFault(), false);
	assert.equal((await b.usage()).totalTokens, null);
});

await test("a lost acknowledgement remains a durable fault without a legacy recovery hook", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("receipt");
	await a.prepareStep(context, {});
	capturedA = await a.captureProviderAttempt();
	f.fail(true);
	await assert.rejects(
		a.recordProviderUsage(usage, [], capturedA),
		PiAccountingError,
	);
	await assert.rejects(a.assertComplete(), /acknowledgement/);
	f.fail(false);
	const b = f.create();
	await assert.rejects(b.begin("receipt"), /acknowledgement/);
	assert.equal(f.receipts.size, 1);
	assert.equal((await b.inspect("receipt")).receiptFault, true);
});

await test("interrupted inference retains its reservation and unknown usage separately", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("reset");
	await a.prepareStep(context, { maxSteps: 2 });
	capturedA = await a.captureProviderAttempt();
	await a.beforeToolCall("read-skill", "read_skill");
	const b = f.create();
	await b.begin("reset");
	assert.equal(await b.prepareStep(context, { maxSteps: 2 }), 1);
	capturedB = await b.captureProviderAttempt();
	await b.recordProviderUsage(usage, [], capturedB);
	await b.assertComplete();
	assert.deepEqual([...f.receipts.values()], [null, 100]);
	assert.equal((await b.usage()).totalTokens, null);
	assert.equal(f.reservations.size, 2);
	const interrupted = (await b.inspect("reset")).attempts[0]!;
	assert.equal(interrupted.phase, "unknown");
	assert.ok(f.reservations.get(interrupted.id)! > 0);
});

await test("safe discovery cannot clear a concurrently dispatched mutation fence", async () => {
	for (const name of [
		"repo_load",
		"read",
		"read_skill",
		"artifact_list_files",
		"artifact_read_file",
		"ls",
		"find",
		"grep",
		"read_execution",
		"deliverable_read_artifact",
	])
		assert.equal(isReplaySafeRecoveryTool(name), true);
	for (const name of [
		"clone_repo",
		"exec",
		"write",
		"edit",
		"delete",
		"artifact_write_file",
		"repo_commit",
		"cancel_execution",
		"open_computer",
		"close_computer",
		"unknown_tool",
		"tedix_mcp_code",
		"decide_work_approval",
	])
		assert.equal(isReplaySafeRecoveryTool(name), false);
	const f = fixture(),
		a = f.create();
	await a.begin("mixed");
	await a.prepareStep(context, {});
	capturedA = await a.captureProviderAttempt();
	await Promise.all([
		a.beforeToolCall("lookup", "read_skill"),
		a.beforeToolCall("approval", "decide_work_approval"),
		a.beforeToolCall("write", "write"),
	]);
	await a.recordProviderUsage(usage, [], capturedA);
	assert.deepEqual((await a.inspect("mixed")).attempts[0]?.effectIds?.sort(), [
		"approval",
		"write",
	]);
	assert.deepEqual(await f.create().reconcileEffects("mixed"), []);
	assert.notEqual((await a.inspect("mixed")).attempts[0]?.effectsSealed, true);
});

await test("cancellation before a tool still records already billed inference", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("cancel");
	await a.prepareStep(context, {});
	capturedA = await a.captureProviderAttempt();
	f.cancel();
	await assert.rejects(a.beforeToolCall("tool"), /run canceled/);
	assert.equal((await a.inspect("cancel")).attempts[0]?.effectsStarted, false);
	await assert.rejects(
		a.recordProviderUsage(usage, [], capturedA),
		/run canceled/,
	);
	assert.deepEqual([...f.receipts.values()], [100]);
	assert.equal((await a.usage()).totalTokens, 100);
	await assert.rejects(a.assertComplete(), /run canceled/);
});

await test("cumulative billed input does not impose a per-call context-window ceiling", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("long");
	for (let index = 0; index < 30; index++) {
		assert.equal(await a.prepareStep(context, { maxSteps: 40 }), index);
		capturedA = await a.captureProviderAttempt();
		await a.recordProviderUsage(
			{ ...usage, inputTokens: 71_000, totalTokens: 71_040 },
			[],
			capturedA,
		);
	}
	assert.equal((await a.inspect("long")).attempts.length, 30);
});

await test("exact running execution receipts seal dispatch without inventing provider usage", async () => {
	const f = fixture(),
		a = f.create();
	const running = {
		executionId: "process",
		terminal: false,
		running: true,
		exitCode: null,
	};
	await a.begin("running");
	await a.prepareStep(context, { maxSteps: 3 });
	capturedA = await a.captureProviderAttempt();
	await a.beforeToolCall("exec", "exec");
	assert.deepEqual(await f.create().reconcileEffects("running"), []);
	f.effects.set("exec", running);
	const b = f.create();
	assert.deepEqual(await b.reconcileEffects("running"), [
		{ ...running, toolCallId: "exec" },
	]);
	await b.begin("running");
	await b.prepareStep(context, { maxSteps: 3 });
	capturedB = await b.captureProviderAttempt();
	assert.equal((await b.inspect("running")).attempts[0]?.phase, "unknown");
	assert.equal((await b.usage()).totalTokens, null);
});

await test("acquisition cannot seal an unrelated effect; exact reconciled receipts survive reset", async () => {
	const f = fixture(),
		a = f.create();
	const acquired = {
		kind: "computer_acquisition" as const,
		terminal: true as const,
		leaseId: "lease",
		preparation: "repository" as const,
		ready: false as const,
		instruction: REPOSITORY_STARTING_INSTRUCTION,
	};
	await a.begin("acquisition");
	await a.prepareStep(context, { maxSteps: 3 });
	capturedA = await a.captureProviderAttempt();
	await a.beforeToolCall("open", "open_computer");
	await a.beforeToolCall("write", "write");
	f.effects.set("open", acquired);
	assert.deepEqual(await f.create().reconcileEffects("acquisition"), []);
	assert.notEqual(
		(await a.inspect("acquisition")).attempts[0]?.effectsSealed,
		true,
	);
	const returned = {
		kind: "facet_tool_returned" as const,
		terminal: true as const,
		tool: "write",
		finishReason: "completed",
		resultLost: true as const,
	};
	f.effects.set("write", returned);
	const expected = [
		{ ...acquired, toolCallId: "open" },
		{ ...returned, toolCallId: "write" },
	];
	assert.deepEqual(await f.create().reconcileEffects("acquisition"), expected);
	const b = f.create();
	assert.deepEqual(await b.reconcileEffects("acquisition"), expected);
	await b.begin("acquisition");
	await b.prepareStep(context, { maxSteps: 3 });
	capturedB = await b.captureProviderAttempt();
	assert.equal((await b.usage()).totalTokens, null);
});

await test("captured provider receipts remain with original reservation after rebind", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("original");
	await a.prepareStep(context, {});
	const original = await a.captureProviderAttempt();
	assert.equal(Object.isFrozen(original), true);
	await a.begin("newer");
	await a.prepareStep(context, {});
	const newer = await a.captureProviderAttempt();
	const newerBefore = await a.inspect("newer");
	await a.recordProviderUsage(usage, ["original-tool"], original);
	assert.deepEqual(await a.inspect("newer"), newerBefore);
	assert.equal(f.receipts.get(original.attemptId), 100);
	assert.equal(f.receipts.has(newer.attemptId), false);
	const oldAfter = await a.inspect("original");
	await a.recordProviderUsage(usage, ["original-tool"], original);
	assert.deepEqual(await a.inspect("original"), oldAfter);
	await assert.rejects(
		a.recordProviderUsage(
			{ ...usage, totalTokens: 101 },
			["original-tool"],
			original,
		),
		/Conflicting/,
	);
	assert.equal(
		a.hasFault(),
		false,
		"old receipt faults cannot fence a different bound run",
	);
	assert.deepEqual(await a.inspect("newer"), newerBefore);
	await a.recordProviderUsage(usage, [], newer);
	await a.assertComplete();
});
await test("late original receipts acknowledge cancellation but never reopen dispatch", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("late-canceled");
	await a.prepareStep(context, {});
	const original = await a.captureProviderAttempt();
	f.cancel();
	await assert.rejects(a.beforeToolCall("mutation", "write"), /canceled/);
	await assert.rejects(a.recordProviderUsage(usage, [], original), /canceled/);
	assert.equal(
		(await a.inspect(original.runId)).attempts[0]?.acknowledged,
		true,
	);
	assert.equal(f.reservations.size, 1);
	assert.equal(f.receipts.get(original.attemptId), 100);
	await assert.rejects(a.prepareStep(context, {}), /canceled/);
	assert.equal(f.reservations.size, 1);
});
await test("receipt binding rejects absent reservations and conflicting tool identities", async () => {
	const f = fixture(),
		a = f.create();
	await assert.rejects(a.captureProviderAttempt(), /no prepared attempt/);
	await a.begin("reserved");
	await a.prepareStep(context, {});
	const original = await a.captureProviderAttempt();
	await a.recordProviderUsage(usage, ["b", "a"], original);
	const before = await a.inspect(original.runId);
	await a.recordProviderUsage(usage, ["a", "b", "a"], original);
	assert.deepEqual(await a.inspect(original.runId), before);
	await assert.rejects(
		a.recordProviderUsage(usage, ["c"], original),
		/Conflicting/,
	);
	assert.deepEqual(
		(await a.inspect(original.runId)).attempts[0]?.generatedToolCallIds,
		["a", "b"],
	);
	await a.begin("healthy-new-run");
	await a.prepareStep(context, {});
	const newBefore = await a.inspect("healthy-new-run");
	await assert.rejects(
		a.recordProviderUsage(usage, [], {
			runId: "reserved",
			attemptId: "nonexistent",
		}),
		/no started reserved/,
	);
	assert.deepEqual(await a.inspect("healthy-new-run"), newBefore);
	assert.equal(a.hasFault(), false);
});

await test("overlapping original receipts serialize conflict checks without replacing usage", async () => {
	const f = fixture(),
		a = f.create();
	await a.begin("overlap");
	await a.prepareStep(context, {});
	const original = await a.captureProviderAttempt();
	const outcomes = await Promise.allSettled([
		a.recordProviderUsage(usage, [], original),
		a.recordProviderUsage({ ...usage, totalTokens: 200 }, [], original),
	]);
	assert.equal(outcomes[0]?.status, "fulfilled");
	assert.equal(outcomes[1]?.status, "rejected");
	assert.equal(
		(await a.inspect("overlap")).attempts[0]?.usage?.totalTokens,
		100,
	);
	assert.equal(f.receipts.get(original.attemptId), 100);
});

await test("old accounting requires explicit transfer and cannot dispatch anew", async () => {
	const f = fixture();
	const a = f.create();
	await a.begin("migration-source");
	await a.prepareStep(context, {});
	const checkpoint = f.rows.get("pi-accounting:migration-source")!;
	f.rows.delete("pi-accounting:migration-source");
	f.rows.set("think-accounting:migration-source", checkpoint);
	await assert.rejects(
		f.create().begin("migration-source"),
		/explicit state cutover/,
	);
	assert.equal(f.rows.has("pi-accounting:migration-source"), false);
	assert.equal(f.receipts.size, 0);
});
