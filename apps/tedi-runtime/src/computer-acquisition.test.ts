import assert from "node:assert/strict";
import type { PlatformClient } from "./brain/platform-client";
import {
	acquisitionWorkAuthority,
	REPOSITORY_STARTING_INSTRUCTION,
	beginComputerAcquisition,
	computerAcquisitionKey,
	confirmComputerAcquisition,
	originalAcquisitionAuthority,
	reconcileComputerAcquisition,
	replaceComputerAcquisition,
	withAcquisitionLock,
	type AcquisitionStore,
	type ComputerAcquisition,
} from "./computer-acquisition";
import type { ComputerEnvironment } from "./computer-environment";
import { delegatedWorkLeaseKey } from "./delegated-work-lease";

function fixture() {
	const rows = new Map<string, unknown>();
	const store: AcquisitionStore = {
		get: async <T>(key: string) =>
			structuredClone(rows.get(key)) as T | undefined,
		put: async (key, value) => {
			rows.set(key, structuredClone(value));
		},
	};
	const intent: ComputerAcquisition = {
		callId: "fixture-run:fixture-call",
		scopeKey: "computer-environment:fixture-workspace",
		ownerRunId: "fixture-run",
		generation: "computer-fixture-generation",
		preparation: "repository",
		work: {
			workItemId: "fixture-work",
			attemptId: "fixture-attempt",
			tediId: "fixture-tedi",
		},
	};
	const environment: ComputerEnvironment = {
		leaseId: "fixture-lease",
		workstationId: "fixture-workstation",
		preparation: "repository",
		cwd: "/fixture/repository",
		ready: false,
	};
	return { rows, store, intent, environment };
}
async function confirmedFixture() {
	const f = fixture();
	await beginComputerAcquisition(f.store, f.intent);
	await confirmComputerAcquisition(f.store, f.intent, f.environment);
	await f.store.put(f.intent.scopeKey, f.environment);
	await f.store.put(`${f.intent.scopeKey}:owner`, f.intent.ownerRunId);
	await f.store.put(`${f.intent.scopeKey}:generation`, f.intent.generation);
	return f;
}

// Intent is durable before provisioning; an unknown outcome must never authorize
// a second provision call merely because the same tool call was redelivered.
{
	const { store, rows, intent, environment } = fixture();
	assert.deepEqual(await beginComputerAcquisition(store, intent), intent);
	assert.deepEqual(rows.get(computerAcquisitionKey(intent.callId)), intent);
	await assert.rejects(beginComputerAcquisition(store, intent), /unknown/);
	await confirmComputerAcquisition(store, intent, environment);
	assert.deepEqual(await beginComputerAcquisition(store, intent), {
		...intent,
		confirmed: environment,
	});
	await assert.rejects(
		confirmComputerAcquisition(store, intent, {
			...environment,
			leaseId: "replacement",
		}),
		/confirmation/,
	);
	assert.equal(
		(rows.get(computerAcquisitionKey(intent.callId)) as ComputerAcquisition)
			.confirmed?.leaseId,
		environment.leaseId,
	);
}
for (const patch of [
	{ scopeKey: "other-scope" },
	{ ownerRunId: "other-run" },
	{ generation: "other-generation" },
	{ preparation: "shell" as const },
	{ work: null },
	{
		work: {
			workItemId: "fixture-work",
			attemptId: "successor",
			tediId: "fixture-tedi",
		},
	},
]) {
	const { store, intent, environment } = fixture();
	await beginComputerAcquisition(store, intent);
	await assert.rejects(
		beginComputerAcquisition(store, { ...intent, ...patch }),
		/identity/,
	);
	await assert.rejects(
		confirmComputerAcquisition(store, { ...intent, ...patch }, environment),
		/confirmation/,
	);
}
{
	const { store, intent, environment } = fixture();
	await assert.rejects(
		confirmComputerAcquisition(store, intent, environment),
		/confirmation/,
	);
	await beginComputerAcquisition(store, intent);
	await assert.rejects(
		confirmComputerAcquisition(store, intent, {
			...environment,
			preparation: "shell",
		}),
		/confirmation/,
	);
}
{
	const { store, intent } = fixture();
	let assertions = 0;
	const authority = async () => {
		assertions++;
	};
	assert.equal(
		await reconcileComputerAcquisition(
			store,
			intent.ownerRunId!,
			intent.callId,
			authority,
		),
		null,
	);
	await beginComputerAcquisition(store, intent);
	assert.equal(
		await reconcileComputerAcquisition(
			store,
			intent.ownerRunId!,
			intent.callId,
			authority,
		),
		null,
	);
	assert.equal(
		assertions,
		0,
		"missing confirmation is not authority to recover",
	);
}
{
	const { rows, store, intent, environment } = await confirmedFixture();
	const selected = { ...environment, ready: true, cwd: "/fixture/current-cwd" };
	await store.put(intent.scopeKey, selected);
	const before = structuredClone(rows);
	const authorities: ComputerAcquisition[] = [];
	assert.deepEqual(
		await reconcileComputerAcquisition(
			store,
			intent.ownerRunId!,
			intent.callId,
			async (receipt) => {
				authorities.push(receipt);
			},
		),
		{
			kind: "computer_acquisition",
			terminal: true,
			leaseId: environment.leaseId,
			preparation: "repository",
			ready: false,
			instruction: REPOSITORY_STARTING_INSTRUCTION,
		},
	);
	assert.deepEqual(authorities, [{ ...intent, confirmed: environment }]);
	assert.deepEqual(
		rows,
		before,
		"reconciliation neither changes selection nor provisions a replacement",
	);
	await assert.rejects(
		reconcileComputerAcquisition(
			store,
			"other-run",
			intent.callId,
			async () => {},
		),
		/owner/,
	);
	await assert.rejects(
		reconcileComputerAcquisition(
			store,
			intent.ownerRunId!,
			intent.callId,
			async () => {
				throw new Error("Attempt expired");
			},
		),
		/Attempt expired/,
	);
}
for (const mutation of [
	"owner",
	"generation",
	"lease",
	"preparation",
	"missing-selection",
	"receipt-call",
	"receipt-scope",
	"receipt-preparation",
]) {
	const { rows, store, intent, environment } = await confirmedFixture();
	if (mutation === "owner")
		await store.put(`${intent.scopeKey}:owner`, "successor-run");
	if (mutation === "generation")
		await store.put(`${intent.scopeKey}:generation`, "successor-generation");
	if (mutation === "lease")
		await store.put(intent.scopeKey, {
			...environment,
			leaseId: "successor-lease",
		});
	if (mutation === "preparation")
		await store.put(intent.scopeKey, { ...environment, preparation: "shell" });
	if (mutation === "missing-selection") rows.delete(intent.scopeKey);
	if (mutation.startsWith("receipt-")) {
		const receipt = rows.get(
			computerAcquisitionKey(intent.callId),
		) as ComputerAcquisition;
		if (mutation === "receipt-call") receipt.callId = "other-call";
		if (mutation === "receipt-scope") receipt.scopeKey = "other-scope";
		if (mutation === "receipt-preparation")
			receipt.confirmed!.preparation = "shell";
	}
	const before = structuredClone(rows);
	await assert.rejects(
		reconcileComputerAcquisition(
			store,
			intent.ownerRunId!,
			intent.callId,
			async () => {},
		),
		/owner|scope, generation or lease changed/,
		mutation,
	);
	assert.deepEqual(
		rows,
		before,
		`failed ${mutation} reconciliation must be read-only`,
	);
}

// The current authority must still be the original admitted tedi Attempt. A new
// Attempt, even for the same Work and run, is not permission to recover this one.
type AttemptPage = Awaited<ReturnType<PlatformClient["listWorkAttempts"]>>;
const liveAttempt = {
	id: "fixture-attempt",
	runId: "fixture-run",
	executorType: "tedi",
	executorId: "fixture-tedi",
	runtimeState: "running",
	finishedAt: null,
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const authorityInput = {
	workItemId: "fixture-work",
	runId: "fixture-run",
	tediId: "fixture-tedi",
	attemptId: "fixture-attempt",
};
function platform(rows: unknown[]) {
	return {
		listWorkAttempts: async (input: { workItemId: string }) => {
			assert.deepEqual(input, { workItemId: "fixture-work" });
			return { data: structuredClone(rows) } as AttemptPage;
		},
	};
}
assert.deepEqual(
	await acquisitionWorkAuthority(platform([liveAttempt]), authorityInput),
	{
		workItemId: "fixture-work",
		attemptId: "fixture-attempt",
		tediId: "fixture-tedi",
	},
);
for (const patch of [
	{ expiresAt: new Date(0).toISOString() },
	{ expiresAt: null },
	{ expiresAt: "invalid-date" },
	{ finishedAt: new Date().toISOString() },
	{ runtimeState: "succeeded" },
	{ runtimeState: "failed" },
	{ executorType: "external_agent" },
	{ executorId: "other-tedi" },
	{ runId: "other-run" },
	{ id: "successor-attempt" },
])
	await assert.rejects(
		acquisitionWorkAuthority(
			platform([{ ...liveAttempt, ...patch }]),
			authorityInput,
		),
		/not active/,
	);
await assert.rejects(
	acquisitionWorkAuthority(platform([]), authorityInput),
	/not active/,
);
await assert.rejects(
	acquisitionWorkAuthority(
		platform([
			{
				...liveAttempt,
				runtimeState: "failed",
				finishedAt: new Date().toISOString(),
			},
			{ ...liveAttempt, id: "successor-attempt" },
		]),
		authorityInput,
	),
	/not active/,
);
await assert.rejects(
	acquisitionWorkAuthority(
		{
			listWorkAttempts: async () => {
				throw new Error("authority unavailable");
			},
		},
		authorityInput,
	),
	/authority unavailable/,
);

// Capturing authority comes from the retained delegation binding, never whichever
// successor happens to be the newest Work Attempt returned by the platform.
{
	const { store } = fixture();
	let reads = 0;
	const client = async () => {
		reads++;
		return platform([liveAttempt]);
	};
	assert.equal(await originalAcquisitionAuthority(store, client, {}), null);
	assert.equal(reads, 0);
	await assert.rejects(
		originalAcquisitionAuthority(store, client, authorityInput),
		/binding/,
	);
	await store.put(delegatedWorkLeaseKey(authorityInput.runId), {
		workItemId: authorityInput.workItemId,
		attemptId: authorityInput.attemptId,
	});
	assert.deepEqual(
		await originalAcquisitionAuthority(store, client, authorityInput),
		{
			workItemId: authorityInput.workItemId,
			attemptId: authorityInput.attemptId,
			tediId: authorityInput.tediId,
		},
	);
	assert.equal(reads, 1);
	for (const input of [
		{ runId: authorityInput.runId },
		{ ...authorityInput, workItemId: "different-work" },
		{ ...authorityInput, attemptId: "successor-attempt" },
		{ ...authorityInput, tediId: undefined },
		{ ...authorityInput, runId: undefined },
	])
		await assert.rejects(
			originalAcquisitionAuthority(store, client, input),
			/authority|binding/,
		);
	assert.equal(reads, 1, "binding mismatches fail before platform lookup");
	await assert.rejects(
		originalAcquisitionAuthority(store, async () => null, authorityInput),
		/unavailable/,
	);
	await assert.rejects(
		originalAcquisitionAuthority(
			store,
			async () => platform([{ ...liveAttempt, id: "successor-attempt" }]),
			authorityInput,
		),
		/not active/,
	);
}
for (const attemptId of [undefined, "", "   "]) {
	const { store } = fixture();
	await store.put(delegatedWorkLeaseKey(authorityInput.runId), {
		workItemId: authorityInput.workItemId,
		attemptId,
	});
	await assert.rejects(
		originalAcquisitionAuthority(store, async () => platform([liveAttempt]), {
			...authorityInput,
			attemptId: undefined,
		}),
		/binding/,
		"incomplete retained binding cannot adopt an available live Attempt",
	);
}
await assert.rejects(
	acquisitionWorkAuthority(
		platform([liveAttempt, { ...liveAttempt, id: "ambiguous-attempt" }]),
		{ ...authorityInput, attemptId: undefined },
	),
	/not active/,
);

// Concurrent claims and confirmations must serialize their read/check/write,
// rather than both observing absence and both permitting provisioning.
{
	const { store, rows, intent } = fixture();
	const outcomes = await Promise.allSettled([
		beginComputerAcquisition(store, intent),
		beginComputerAcquisition(store, intent),
	]);
	assert.equal(
		outcomes.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		outcomes.filter((result) => result.status === "rejected").length,
		1,
	);
	assert.deepEqual(rows.get(computerAcquisitionKey(intent.callId)), intent);
}
{
	const { store, rows, intent, environment } = fixture();
	await beginComputerAcquisition(store, intent);
	const outcomes = await Promise.allSettled([
		confirmComputerAcquisition(store, intent, environment),
		confirmComputerAcquisition(store, intent, {
			...environment,
			leaseId: "other-lease",
		}),
	]);
	assert.equal(
		outcomes.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		outcomes.filter((result) => result.status === "rejected").length,
		1,
	);
	assert.equal(
		(rows.get(computerAcquisitionKey(intent.callId)) as ComputerAcquisition)
			.confirmed?.leaseId,
		environment.leaseId,
	);
}
{
	const { store } = fixture();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const order: string[] = [];
	const first = withAcquisitionLock(store, "scope", async () => {
		order.push("first");
		await blocked;
		throw new Error("first failed");
	});
	const firstRejected = assert.rejects(first, /first failed/);
	const second = withAcquisitionLock(store, "scope", async () => {
		order.push("second");
	});
	await withAcquisitionLock(store, "other-scope", async () => {
		order.push("independent");
	});
	assert.deepEqual(order, ["first", "independent"]);
	release();
	await firstRejected;
	await second;
	assert.deepEqual(
		order,
		["first", "independent", "second"],
		"failed holder releases only its own scope lock",
	);
}
console.log(
	"Computer acquisition: exact intent, durable confirmation, authority, ownership and concurrent claims pass",
);

// Revoking the old confirmation precedes any replacement effect. Recovery may
// never use a pre-authority snapshot after that proof changes.
{
	const { store, intent, environment } = await confirmedFixture();
	const replacement = await replaceComputerAcquisition(
		store,
		intent,
		"replacement-generation",
	);
	assert.equal(replacement.confirmed, undefined);
	assert.equal(
		await reconcileComputerAcquisition(
			store,
			"fixture-run",
			intent.callId,
			async () => {},
		),
		null,
	);
	await assert.rejects(beginComputerAcquisition(store, replacement), /unknown/);
	await assert.rejects(
		replaceComputerAcquisition(store, replacement, "another-generation"),
		/exact confirmed/,
	);
	await confirmComputerAcquisition(store, replacement, {
		...environment,
		leaseId: "replacement-lease",
	});
	await assert.rejects(
		confirmComputerAcquisition(store, intent, environment),
		/confirmation/,
	);
}
{
	const { store, intent } = await confirmedFixture();
	await assert.rejects(
		reconcileComputerAcquisition(
			store,
			"fixture-run",
			intent.callId,
			async () => {
				await replaceComputerAcquisition(
					store,
					intent,
					"replacement-generation",
				);
			},
		),
		/confirmation changed/,
	);
}

// A shell-only acquisition still exposes its real OS working directory.
{
	const { rows, store, intent, environment } = fixture();
	intent.preparation = "shell";
	environment.preparation = "shell";
	await beginComputerAcquisition(store, intent);
	await confirmComputerAcquisition(store, intent, environment);
	await store.put(intent.scopeKey, environment);
	await store.put(`${intent.scopeKey}:owner`, intent.ownerRunId);
	await store.put(`${intent.scopeKey}:generation`, intent.generation);
	const before = structuredClone(rows);
	const receipt = await reconcileComputerAcquisition(
		store,
		intent.ownerRunId!,
		intent.callId,
		async () => {},
	);
	assert.equal(receipt?.cwd, environment.cwd);
	assert.equal(receipt?.instruction, undefined);
	assert.deepEqual(rows, before);
}
