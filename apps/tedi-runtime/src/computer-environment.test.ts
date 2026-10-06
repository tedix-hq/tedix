import {
	ComputerWorkflowContinuation,
	retainComputerForNativeExecutions,
} from "./computer-workflow-continuation";
import { collectComputerExecutionWake } from "./computer-execution-wake";
import assert from "node:assert/strict";
import { reconcileWorkstation } from "./workstation";
import { computerExecutionModelOutput } from "./computer-execution-model-output";
import {
	ComputerEnvironmentController,
	computerEffectKey,
	reconcileComputerEffect,
	createComputerEnvironmentTools,
	computerEnvironmentWorkspace,
	computerRepositoryReader,
	computerScratchState,
	type ExecRoundTrip,
} from "./computer-environment";
import { asSchema, tool } from "ai";
import { z } from "zod";
const values = new Map<string, unknown>();
const store = {
	delete: async (key: string) => values.delete(key),
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async <T>(key: string, value: T) => {
		values.set(key, value);
	},
};
const files = new Map<string, string>();
let opens = 0;
let failStart = false;
const actions = {
	close: async (environment: { leaseId: string }) => ({
		ok: true,
		leaseId: environment.leaseId,
		leaseStatus: "released",
	}),
	open: async () => ({ ok: true, leaseId: `lease-${++opens}` }),
	status: async () => ({
		ok: true,
		readiness: { toolsReady: true, repoReady: true },
		repoSync: { workdir: "/home/tedi/workstation/repo" },
	}),
	files: async (
		environment: { leaseId: string },
		operation: string,
		input: Record<string, unknown>,
	) => {
		const path = `${environment.leaseId}:${input.path}`;
		if (operation === "reversible_write") {
			const previousContent = files.get(path) ?? null;
			files.set(path, String(input.content));
			return { ok: true, previousContent };
		}
		if (operation === "guarded_restore") {
			if ((files.get(path) ?? null) !== input.expectedContent)
				return { ok: false, error: "workspace_rollback_conflict" };
			if (input.previousContent === null) files.delete(path);
			else files.set(path, String(input.previousContent));
		}

		if (operation === "write") files.set(path, String(input.content));
		if (operation === "delete") files.delete(path);
		return { ok: true, operation, content: files.get(path) ?? null };
	},
	start: async () => {
		if (failStart) throw new Error("Transport disconnected after dispatch");
		return { ok: true };
	},
	read: async () => ({
		ok: true,
		terminal: true,
		exitCode: 0,
		stdoutTail: "PASS",
		stderrTail: "",
	}),
	wait: async () => ({
		ok: true,
		terminal: true,
		exitCode: 0,
		stdoutTail: "PASS",
		stderrTail: "",
	}),
	cancel: async () => ({ ok: true, terminal: true, canceled: true }),
};

// Unavailable observation preserves continuation, while the model sees uncertainty.
{
	let dispatches = 0;
	const watched: string[] = [];
	const collected: string[] = [];
	let observed: Record<string, unknown> = {
		ok: false,
		terminal: false,
		observation: "unavailable",
	};
	const controller = new ComputerEnvironmentController(
		store,
		"scope-unavailable-observation",
		{
			...actions,
			open: async () => ({
				ok: true,
				leaseId: "unavailable-observation-lease",
			}),
			start: async () => {
				dispatches++;
				return { ok: true };
			},
			wait: async () => ({
				...observed,
				error: "provider detail",
				hint: "rerun",
				running: false,
			}),
			read: async () => observed,
		},
		async () => {
			throw new Error("An unknown observation must not busy-wait");
		},
		undefined,
		{
			detached: async ({ executionId }) => {
				watched.push(executionId);
			},
			collected: async (executionId) => {
				collected.push(executionId);
			},
		},
	);
	await controller.open();
	const input = { command: "bun run build" };
	const initial = (await controller.exec(input, "unavailable-call")) as Record<
		string,
		unknown
	>;
	assert.equal(initial.running, true, "internal continuation stays armed");
	assert.equal(initial.terminal, false);
	assert.equal(initial.observation, "unavailable");
	assert.equal(
		initial.error,
		undefined,
		"provider errors never become continuation controls",
	);
	assert.deepEqual(watched, [initial.executionId]);
	const preview = JSON.parse(
		computerExecutionModelOutput({ output: initial }).value,
	);
	assert.equal(preview.outcome, "unknown");
	assert.equal(preview.executionId, initial.executionId);
	assert.equal(Object.hasOwn(preview, "running"), false);
	assert.equal(Object.hasOwn(preview, "status"), false);
	assert.match(preview.hint, /Yield/);
	assert.doesNotMatch(preview.hint, /keeps running/);
	const replay = (await controller.exec(input, "unavailable-call")) as Record<
		string,
		unknown
	>;
	assert.equal(replay.executionId, initial.executionId);
	assert.equal(
		JSON.parse(computerExecutionModelOutput({ output: replay }).value).outcome,
		"unknown",
	);
	assert.equal(dispatches, 1);
	assert.deepEqual(watched, [initial.executionId]);
	observed = { ok: true, terminal: true, exitCode: 0, stdoutTail: "DONE" };
	const terminal = (await controller.exec(input, "unavailable-call")) as Record<
		string,
		unknown
	>;
	assert.equal(terminal.executionId, initial.executionId);
	assert.equal(terminal.exitCode, 0);
	assert.equal(terminal.stdout, "DONE");
	assert.deepEqual(collected, [initial.executionId]);
	assert.equal(dispatches, 1);
}
// Closing with no selected environment is a truthful no-op, not a successful close.
{
	const noOp = new ComputerEnvironmentController(
		store,
		"scope-no-open",
		actions,
	);
	assert.deepEqual(await noOp.close(), {
		ok: true,
		closed: false,
		message: "No open computer for this scope",
	});
}

const first = new ComputerEnvironmentController(store, "scope-a", actions);
const repository = (await first.open("repository")) as Record<string, unknown>;
assert.equal(repository.ready, true);
assert.match(String(repository.instruction), /configured checkout/);
assert.match(String(repository.instruction), /initial clones are shallow/);
assert.match(
	String(repository.instruction),
	/governed pushes must descend from that recorded start/,
);
assert.match(
	String(repository.instruction),
	/verify the exact task base and required ancestry/,
);
assert.doesNotMatch(String(repository.instruction), /--depth 1/);
assert.match(String(repository.instruction), /existing task authority/);
assert.equal("preparedStartSha" in repository, false);
const reopened = (await first.open()) as Record<string, unknown>;
assert.equal(reopened.instruction, repository.instruction);
assert.equal(opens, 1, "reopening reuses the selected repository environment");
// Forward only an observed commit SHA, without probing Git or caching a prior
// preparation's identity when the next status does not carry one.
{
	const observedSha = "a".repeat(40);
	let startSha: unknown = observedSha;
	let statusReads = 0;
	const controller = new ComputerEnvironmentController(
		store,
		"prepared-start",
		{
			...actions,
			status: async () => {
				statusReads++;
				return {
					...(await actions.status()),
					repoSync: {
						workdir: "/prepared/repo",
						treePreflight: { startSha },
					},
				};
			},
			start: async () => {
				throw new Error("opening must not probe Git");
			},
		},
	);
	const opened = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.equal(opened.preparedStartSha, observedSha);
	assert.equal(opened.cwd, "/prepared/repo");
	for (const absent of [undefined, "not-a-commit", 42]) {
		startSha = absent;
		const reused = (await controller.open()) as Record<string, unknown>;
		assert.equal("preparedStartSha" in reused, false);
	}
	assert.equal(
		statusReads,
		7,
		"initial passive observation plus passive and native checks on reopen",
	);
	const shell = new ComputerEnvironmentController(
		store,
		"prepared-start-shell",
		{
			...actions,
			status: async () => ({
				...(await actions.status()),
				repoSync: { treePreflight: { startSha: observedSha } },
			}),
		},
	);
	const shellReceipt = (await shell.open("shell")) as Record<string, unknown>;
	assert.equal("preparedStartSha" in shellReceipt, false);
	assert.equal("instruction" in shellReceipt, false);
}
await first.file("write", { path: "test.js", content: "exact tested bytes" });
const restarted = new ComputerEnvironmentController(store, "scope-a", actions);
assert.equal(
	((await restarted.file("read", { path: "test.js" })) as { content: string })
		.content,
	"exact tested bytes",
);
const second = new ComputerEnvironmentController(store, "scope-b", actions);
assert.deepEqual(await second.open("shell"), {
	ok: true,
	ready: true,
	environment: "linux",
	cwd: "/home/tedi/workstation",
});
assert.equal(
	((await second.file("read", { path: "test.js" })) as { content?: string })
		.content,
	null,
	"distinct tasks do not share files",
);
const execution = (await first.exec({ command: "node --test" })) as Record<
	string,
	unknown
>;

// Foreground exec waits exactly once in the workstation; it no longer polls
// `read` from the Durable Object. A wait expiry keeps the existing detach shape.
{
	let waitCalls = 0;
	let readCalls = 0;
	const foreground = new ComputerEnvironmentController(
		store,
		"scope-foreground",
		{
			...actions,
			read: async () => {
				readCalls++;
				throw new Error("foreground exec must not poll status");
			},
			wait: async (_environment, _id, timeoutMs) => {
				waitCalls++;
				assert.equal(timeoutMs, 90_000);
				return {
					ok: true,
					terminal: true,
					exitCode: 0,
					stdoutTail: "waited",
					// What the CONTAINER measured. The Durable Object used to overwrite
					// this with its own clock, so it never reached the model at all.
					waitedMs: 4_200,
				};
			},
		},
	);
	await foreground.open();
	const terminal = (await foreground.exec({
		command: "bun run test",
	})) as Record<string, unknown>;
	assert.equal(terminal.stdout, "waited");
	assert.equal(waitCalls, 1, "one workstation wait replaces the poll loop");
	assert.equal(readCalls, 0);

	const detaching = new ComputerEnvironmentController(store, "scope-detach", {
		...actions,
		wait: async () => ({
			ok: true,
			terminal: false,
			startedAt: "2026-09-17T10:00:00Z",
		}),
	});
	await detaching.open();
	const detached = (await detaching.exec({
		command: "bun run build",
	})) as Record<string, unknown>;
	assert.equal(detached.status, "running");
	assert.equal(detached.running, true);
	assert.equal(detached.terminal, false);
	assert.equal(typeof detached.executionId, "string");

	/*
	 * Where the round trip went. 20 execs at 11-19s each were ~4 minutes of a
	 * 16 minute delegated turn on commands that finished in under a second, and
	 * nothing in the receipt said which part of the trip that was. Both paths
	 * carry the split, and the parts must add up to the whole or the split is
	 * not evidence of anything.
	 */
	const segments = terminal.roundTrip as ExecRoundTrip | undefined;
	assert.ok(segments, "a terminal receipt carries its round trip");
	for (const measured of [
		segments.dispatchMs,
		segments.waitMs,
		segments.readMs,
		segments.totalMs,
	])
		assert.equal(typeof measured, "number", "every segment is measured");
	assert.equal(
		segments.dispatchMs + segments.waitMs + segments.readMs,
		segments.totalMs,
		"segments sum to the reported total",
	);
	// Both clocks survive, distinctly named. The gap between the container's own
	// measurement and the Durable Object's is the transport, and a single
	// DO-side number can never separate the two — which is why an earlier
	// optimization attempt against this layer measured nothing at all.
	assert.equal(
		segments.containerWaitedMs,
		4_200,
		"the container's own measurement reaches the model unchanged",
	);
	assert.notEqual(segments.waitMs, undefined);

	const detachedSegments = detached.roundTrip as ExecRoundTrip | undefined;
	assert.ok(detachedSegments, "a detached receipt carries its round trip");
	assert.equal(
		detachedSegments.dispatchMs +
			detachedSegments.waitMs +
			detachedSegments.readMs,
		detachedSegments.totalMs,
		"the detached split also adds up",
	);
	assert.equal(
		detachedSegments.readMs,
		0,
		"nothing was read back on the detached path",
	);
}

// Long-running commands wait inside the tool instead of burning model rounds
// on unchanged status. Terminal reads, unknown outcomes and cancellation stay immediate.
{
	let reads = 0;
	let waits = 0;
	let running = true;
	const waiting = new ComputerEnvironmentController(
		store,
		"scope-a",
		{
			...actions,
			read: async () => {
				reads++;
				return running
					? { ok: true, running: true, terminal: false }
					: {
							ok: true,
							running: false,
							terminal: true,
							exitCode: 0,
							stdoutTail: "done",
						};
			},
			wait: async (_environment, _id, timeoutMs) => {
				assert.equal(timeoutMs, 90_000);
				waits++;
				running = false;
				return {
					ok: true,
					terminal: true,
					exitCode: 0,
					stdoutTail: "done",
				};
			},
		},
		async (ms) => {
			assert.equal(ms, 15_000);
			waits++;
			running = false;
		},
	);
	assert.equal(
		(
			(await waiting.execution(String(execution.executionId), false)) as {
				stdout: string;
			}
		).stdout,
		"done",
	);
	assert.equal(reads, 2, "refresh once after waiting");
	assert.equal(waits, 1);
	await waiting.execution(String(execution.executionId), false);
	assert.equal(waits, 1, "terminal reads return immediately");
	running = true;
	await waiting.execution(String(execution.executionId), true);
	assert.equal(waits, 1, "cancellation never waits");

	// A still-running read returns the same running receipt the exec detach
	// returns, so the model always sees "status: running" and is told the
	// completion notification is still owed rather than told to poll.
	const stillRunning = (await new ComputerEnvironmentController(
		store,
		"scope-a",
		{
			...actions,
			read: async () => ({
				ok: true,
				found: true,
				running: true,
				terminal: false,
				startedAt: "2026-09-16T10:00:00Z",
			}),
		},
		async () => {},
	).execution(String(execution.executionId), false)) as Record<string, unknown>;
	assert.equal(stillRunning.startedAt, "2026-09-16T10:00:00Z");
	assert.equal(stillRunning.status, "running");
	assert.equal(stillRunning.ok, true);
	assert.equal(stillRunning.executionId, execution.executionId);
	assert.match(String(stillRunning.hint), /you will be woken once/);
	assert.match(String(stillRunning.hint), /do not poll/);
}

// A detached command is handed to the runtime's watcher, and collecting one
// hands it back. The model is promised exactly one completion notification, so
// the arm must happen before the receipt that promises it, and a terminal
// receipt the model already holds must cancel the notification it would
// otherwise receive a second time.
{
	const detachedIds: string[] = [];
	const collectedIds: string[] = [];
	const watch = {
		collected: async (executionId: string) => {
			collectedIds.push(executionId);
		},
		detached: async (execution: { executionId: string; command: string }) => {
			detachedIds.push(`${execution.executionId}:${execution.command}`);
		},
	};

	const watched = new ComputerEnvironmentController(
		store,
		"scope-watch",
		{
			...actions,
			wait: async () => ({ ok: true, terminal: false }),
		},
		undefined,
		undefined,
		watch,
	);
	await watched.open();
	const detached = (await watched.exec({ command: "bun run build" })) as Record<
		string,
		unknown
	>;
	assert.equal(detachedIds.length, 1, "the detached command is watched once");
	assert.equal(detachedIds[0], `${detached.executionId}:bun run build`);
	assert.deepEqual(collectedIds, []);

	// Reading it terminal settles the promise: nothing is owed a wake.
	await new ComputerEnvironmentController(
		store,
		"scope-watch",
		{
			...actions,
			read: async () => ({
				exitCode: 0,
				found: true,
				ok: true,
				stdoutTail: "built",
				terminal: true,
			}),
		},
		undefined,
		undefined,
		watch,
	).execution(String(detached.executionId), false);
	assert.deepEqual(collectedIds, [detached.executionId]);

	// A command that finishes inside the inline wait never detaches, so it is
	// never watched — its result is already in the receipt.
	const inline = new ComputerEnvironmentController(
		store,
		"scope-watch-inline",
		{
			...actions,
			wait: async () => ({
				exitCode: 0,
				ok: true,
				stdoutTail: "fast",
				terminal: true,
			}),
		},
		undefined,
		undefined,
		watch,
	);
	await inline.open();
	await inline.exec({ command: "echo fast" });
	assert.equal(detachedIds.length, 1, "an inline command is never watched");
}

// A request deadline is a WAIT bound, never a kill. The command is dispatched
// under the persisted execution id and keeps running on the computer, so the
// tool detaches with a running receipt instead of an `ok: false` the model
// reads as a killed command with no output.
{
	const requestTimeout = {
		ok: false,
		error: "workstation process/start timed out after 120000ms",
		requestTimedOut: true,
		waitedMs: 120_000,
	};
	const detached = new ComputerEnvironmentController(store, "scope-a", {
		...actions,
		start: async () => requestTimeout,
		read: async () => requestTimeout,
	});
	const receipt = (await detached.exec({
		command: "bunx tsc --noEmit",
	})) as Record<string, unknown>;
	assert.equal(receipt.ok, true, "a wait deadline is not a failure");
	assert.equal(receipt.status, "running");
	assert.equal(receipt.running, true);
	assert.equal(receipt.terminal, false);
	assert.equal(typeof receipt.executionId, "string");
	// The request never reached a container, so there is no container-side
	// measurement to report. The Worker's own budget echoed back is not one, and
	// reporting it as one is how a receipt claims to have measured something it
	// never observed.
	assert.equal(
		(receipt.roundTrip as ExecRoundTrip).containerWaitedMs,
		undefined,
	);
	assert.equal(typeof (receipt.roundTrip as ExecRoundTrip).totalMs, "number");
	assert.equal(
		receipt.waitedMs,
		undefined,
		"no DO-side clock wearing that name",
	);
	assert.equal(
		receipt.hint,
		`the process keeps running on this computer and you will be woken once with its exit code and output when it finishes; do not poll read_execution({ executionId: "${receipt.executionId}" })`,
	);
	assert.equal(receipt.error, undefined, "no error text to misread as a kill");

	// read_execution whose status request timed out: the process is untouched.
	const read = (await detached.execution(
		String(receipt.executionId),
		false,
	)) as Record<string, unknown>;
	assert.equal(read.status, "running");
	assert.equal(read.ok, true);
	assert.equal(read.executionId, receipt.executionId);
	// A collection is measured too, and the same rule holds: no container
	// answered, so no container-side number is reported.
	const readTrip = read.roundTrip as ExecRoundTrip;
	assert.equal(typeof readTrip.dispatchMs, "number");
	assert.equal(readTrip.containerWaitedMs, undefined);
	assert.equal(
		readTrip.dispatchMs + readTrip.waitMs + readTrip.readMs,
		readTrip.totalMs,
	);

	// A cancel whose request timed out is UNCONFIRMED: keep the failure.
	const cancel = (await new ComputerEnvironmentController(store, "scope-a", {
		...actions,
		cancel: async () => requestTimeout,
	}).execution(String(receipt.executionId), true)) as Record<string, unknown>;
	assert.equal(cancel.ok, false);
	assert.equal(cancel.status, undefined);
	assert.equal(cancel.requestTimedOut, true);
	// Even a receipt the model reads as a failure says what the trip cost.
	assert.equal(typeof (cancel.roundTrip as ExecRoundTrip).totalMs, "number");

	// Once the process finishes, read_execution returns the exit code and the
	// output tail exactly as before, with no running receipt fields.
	const finished = (await new ComputerEnvironmentController(store, "scope-a", {
		...actions,
		read: async () => ({
			ok: true,
			found: true,
			running: false,
			terminal: true,
			exitCode: 2,
			stdoutTail: "src/a.ts(1,1): error TS2304",
			stderrTail: "",
			waitedMs: 0,
		}),
	}).execution(String(receipt.executionId), false)) as Record<string, unknown>;
	assert.equal(finished.exitCode, 2);
	assert.equal(finished.terminal, true);
	assert.equal(finished.stdout, "src/a.ts(1,1): error TS2304");
	assert.equal(finished.status, undefined);
	assert.equal(finished.hint, undefined);
	// The collection of a DETACHED command is the case that used to be entirely
	// unmeasurable: `roundTrip` was attached only on the three exec exits, so a
	// command collected minutes later cost a round trip nothing recorded.
	const finishedTrip = finished.roundTrip as ExecRoundTrip;
	assert.equal(typeof finishedTrip.dispatchMs, "number");
	assert.equal(finishedTrip.waitMs, 0, "a terminal first read never idles");
	assert.equal(finishedTrip.containerWaitedMs, 0);
	assert.equal(
		finishedTrip.dispatchMs + finishedTrip.waitMs + finishedTrip.readMs,
		finishedTrip.totalMs,
	);

	// Other start failures still surface as failures with the execution id.
	const failed = (await new ComputerEnvironmentController(store, "scope-a", {
		...actions,
		start: async () => ({
			ok: false,
			error: "workstation dependencies are not ready",
		}),
	}).exec({ command: "bun run test" })) as Record<string, unknown>;
	assert.equal(failed.ok, false);
	assert.equal(failed.status, undefined);
	assert.equal(typeof failed.executionId, "string");
}
assert.equal(execution.stdout, "PASS");
assert.equal(execution.stdoutTail, undefined, "output appears once");
assert.equal(
	(
		(await second.execution(String(execution.executionId), false)) as {
			ok: boolean;
		}
	).ok,
	false,
	"execution ownership is scope-bound",
);
failStart = true;
const unknown = (await first.exec({ command: "publish" })) as Record<
	string,
	unknown
>;
assert.equal(unknown.outcome, "unknown");
assert.equal(typeof unknown.executionId, "string");
assert.equal(
	(
		(await first.execution(String(unknown.executionId), false)) as {
			terminal: boolean;
		}
	).terminal,
	true,
	"unknown dispatch remains inspectable",
);
const native = {
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async () => ({ content: "scratch" }),
	}),
	exec: tool({
		inputSchema: z.object({ command: z.string() }),
		execute: async () => ({ stdout: "scratch" }),
	}),
};
const tools = createComputerEnvironmentTools(native, first);
assert.ok(
	tools.open_computer && tools.read_execution && tools.cancel_execution,
);
assert.ok(!tools.request_workstation && !tools.workstation_run_job);
assert.equal(
	(
		(await tools.read!.execute!({ path: "test.js" } as never, {
			toolCallId: "read",
			messages: [],
			context: undefined,
		})) as { content: string }
	).content,
	"exact tested bytes",
	"file tools use the selected native disk",
);
console.log(
	"Computer environment: selection, persistence, isolation, execution ownership and unknown outcomes pass",
);

const scratch = {
	readFile: async () => "scratch",
	writeFile: async () => {},
	deleteFile: async () => true,
	diffContent: async () => "",
};
const workspace = computerEnvironmentWorkspace(scratch, first);
assert.equal(await workspace.readFile("missing.js"), null);
await workspace.writeFile("new.js", "new\n");
assert.equal(await workspace.readFile("new.js"), "new\n");
assert.equal(
	await computerRepositoryReader(scratch, first)("repo/new.js"),
	"new\n",
);
await assert.rejects(
	computerScratchState(scratch, first).readFile(),
	/scratch storage/,
);
const frozen = computerEnvironmentWorkspace(
	scratch,
	first,
	(await first.selected())!,
);
await first.close();
await first.open("shell");
assert.equal(
	await frozen.readFile("new.js"),
	"new\n",
	"recovery stays on the execution's original filesystem",
);
assert.equal(await workspace.readFile("new.js"), null);
assert.equal(
	(
		(await first.execution(String(execution.executionId), false)) as {
			terminal: boolean;
		}
	).terminal,
	true,
);
let finishOpen!: () => void;
let parallelOpens = 0;
const pendingActions = {
	...actions,
	open: async () => {
		parallelOpens++;
		await new Promise<void>((resolve) => {
			finishOpen = resolve;
		});
		return { ok: true, leaseId: "parallel" };
	},
};
const parallelA = new ComputerEnvironmentController(
	store,
	"parallel",
	pendingActions,
);
const parallelB = new ComputerEnvironmentController(
	store,
	"parallel",
	pendingActions,
);
const openingA = parallelA.open();
const openingB = parallelB.open();
await new Promise((resolve) => setTimeout(resolve, 0));
const selection = parallelB.selected();
finishOpen();
await Promise.all([openingA, openingB]);
assert.equal(parallelOpens, 1);
assert.equal((await selection)?.leaseId, "parallel");

// The provider tool ID survives a restart and close without replaying effects.
{
	let starts = 0;
	const onceActions = {
		...actions,
		start: async () => {
			starts++;
			return { ok: true };
		},
	};
	const controller = new ComputerEnvironmentController(
		store,
		"once",
		onceActions,
	);
	await controller.open("shell");
	const input = { command: "increment-counter" };
	const [a, b] = (await Promise.all([
		controller.exec(input, "durable-call"),
		controller.exec(input, "durable-call"),
	])) as Array<{ executionId: string }>;
	assert.equal(starts, 1);
	assert.equal(a!.executionId, b!.executionId);
	await controller.close();
	const resumed = new ComputerEnvironmentController(store, "once", onceActions);
	await resumed.exec(input, "durable-call");
	assert.equal(starts, 1, "recovery reads the original receipt after close");
	await assert.rejects(
		resumed.exec({ command: "different" }, "durable-call"),
		/identity/,
	);
	await assert.rejects(
		new ComputerEnvironmentController(store, "wrong-scope", onceActions).exec(
			input,
			"durable-call",
		),
		/identity/,
	);
	const wrapped = createComputerEnvironmentTools(native, resumed);
	await wrapped.exec!.execute!(input as never, {
		toolCallId: "durable-call",
		messages: [],
		context: undefined,
	});
	assert.equal(
		starts,
		1,
		"tool routing preserves journal ownership after close",
	);
}

async function assertUnconfirmedOpen(opening: Promise<unknown>) {
	const result = (await opening) as Record<string, unknown>;
	assert.equal(result.ok, false);
	assert.equal(result.ready, false);
	assert.match(String(result.error), /readiness and ownership are unconfirmed/);
	assert.doesNotMatch(String(result.instruction), /git fetch|shallow/);
	for (const field of ["acquired", "leaseId", "cwd", "readinessTimedOut"])
		assert.equal(field in result, false, `uncertainty must not claim ${field}`);
	assert.equal("preparedStartSha" in result, false);
}

// Cold startup never reports a file operation or command as executed.
{
	let dispatched = 0;
	const cold = new ComputerEnvironmentController(
		store,
		"cold",
		{
			...actions,
			status: async () => ({ ok: true, readiness: { toolsReady: false } }),
			files: async () => {
				dispatched++;
				return { ok: true };
			},
			start: async () => {
				dispatched++;
				return { ok: true };
			},
		},
		undefined,
		undefined,
		undefined,
		{ budgetMs: 10 },
	);
	{
		await assertUnconfirmedOpen(cold.open("shell"));
		const write = (await cold.file("write", {
			path: "pending.txt",
			content: "never written",
		})) as Record<string, unknown>;
		assert.equal(write.ok, false);
		assert.equal(write.executed, false);
		assert.equal(write.pending, undefined);
		assert.equal(
			write.operation,
			"write",
			"Linux readiness failures bypass scratch success formatters",
		);
		assert.match(
			String(write.error),
			/readiness and ownership are unconfirmed/,
		);
		const command = (await cold.exec(
			{ command: "never-run" },
			"cold-call",
		)) as Record<string, unknown>;
		assert.equal(command.executed, false);
		assert.equal(await cold.hasEffect("cold-call"), false);
		assert.equal(dispatched, 0);
	}
	let probes = 0;
	const warming = new ComputerEnvironmentController(store, "warming", {
		...actions,
		status: async () => ({ ok: true, readiness: { toolsReady: ++probes > 1 } }),
	});
	const opened = (await warming.open("shell")) as { ready: boolean };
	assert.equal(
		opened.ready,
		true,
		"host completes transient startup without another model round",
	);
}

// Task continuation uses the same disk, but a late terminal callback cannot
// close a successor run's selection. Failed cleanup must retain its target.
{
	let closes = 0;
	let fail = true;
	const lifecycleActions = {
		...actions,
		close: async (environment: { leaseId?: string }) => {
			closes++;
			return fail
				? { ok: false, error: "preservation failed" }
				: { ok: true, leaseId: environment.leaseId, leaseStatus: "released" };
		},
	};
	const previous = new ComputerEnvironmentController(
		store,
		"task-lifecycle",
		lifecycleActions,
		undefined,
		"run-1",
	);
	await previous.open("repository");
	const id = (await previous.selected())?.leaseId;
	const continuation = new ComputerEnvironmentController(
		store,
		"task-lifecycle",
		lifecycleActions,
		undefined,
		"run-2",
	);
	await continuation.open();
	assert.equal((await continuation.selected())?.leaseId, id);
	await previous.finish("run-1");
	assert.equal(closes, 0, "late completion cannot close a successor computer");
	assert.equal(
		((await continuation.finish("run-2")) as { ok: boolean }).ok,
		false,
	);
	assert.equal(
		(await continuation.selected())?.leaseId,
		id,
		"failed cleanup retains exact target",
	);
	fail = false;
	await continuation.finish("run-2");
	assert.equal(await continuation.selected(), undefined);
	await continuation.finish("run-2");
	assert.equal(closes, 2, "completed cleanup is idempotent");
}

// Recovery observes the exact retained process without dispatching another command.
{
	const environment = {
		leaseId: "retained-lease",
		cwd: "/repo",
		preparation: "repository",
	};
	const effects = {
		get: async <T>(key: string) =>
			(key === computerEffectKey("interrupted")
				? { environment, executionId: "retained-process" }
				: undefined) as T | undefined,
	};
	let reads = 0;
	const read = async (selected: unknown, id: string) => {
		reads++;
		assert.deepEqual(selected, environment);
		assert.equal(id, "retained-process");
		return { ok: true, found: true, running: true, terminal: false };
	};
	assert.deepEqual(
		await reconcileComputerEffect(effects, "interrupted", read),
		{
			executionId: "retained-process",
			terminal: false,
			running: true,
			exitCode: null,
			canceled: false,
			timedOut: false,
		},
	);
	assert.equal(await reconcileComputerEffect(effects, "missing", read), null);
	assert.equal(reads, 1);
	for (const receipt of [
		{ ok: false, found: true, running: true, terminal: false },
		{ ok: true, found: false, running: true, terminal: false },
		{ ok: true, found: true, running: false, terminal: false },
		{ ok: true, found: true, running: true },
	])
		assert.equal(
			await reconcileComputerEffect(
				effects,
				"interrupted",
				async () => receipt,
			),
			null,
		);
}

// Recovery retains the failed body and leaves old execution receipts pinned.
{
	let failedLease: string | undefined;
	let everyLeaseFails = false;
	let leaseStatus = "active";
	let statusOk = true;
	let closed = 0;
	const bodySetupError = "the body refused to start";
	const generations: string[] = [];
	const recovery = new ComputerEnvironmentController(store, "recovery", {
		...actions,
		open: async (_, generation) => {
			generations.push(generation);
			return { ok: true, leaseId: `recovery-${generations.length}` };
		},
		close: async () => {
			closed++;
			return { ok: true };
		},
		status: async (env) => {
			const failing = everyLeaseFails || env.leaseId === failedLease;
			return {
				...(await actions.status()),
				// A dead lease reports an unhealthy envelope; a healthy replacement
				// does not.
				ok: failing ? statusOk : true,
				bootstrap: {
					lastBootstrapError: "the body wrote this a long time ago",
				},
				// `setupError` is the body's own refusal to come up, and the only
				// thing that makes a fresh `blocked` lease a failure rather than a
				// container that has not finished booting.
				setupError: failing && everyLeaseFails ? bodySetupError : null,
				workstationLease: { status: failing ? leaseStatus : "active" },
			};
		},
		read: async (env) => ({
			...(await actions.read()),
			stdoutTail: env.leaseId,
		}),
	});
	failStart = false;
	await recovery.open("repository");
	const prior = await recovery.selected();
	assert.ok(prior);
	failedLease = prior.leaseId;
	const oldExecution = (await recovery.exec({ command: "pwd" })) as {
		executionId: string;
	};
	for (const state of ["active", "unknown"]) {
		leaseStatus = state;
		await recovery.open();
		const refreshed = await recovery.selected();
		assert.ok(refreshed);
		assert.ok(
			refreshed.checkedAt !== undefined && prior.checkedAt !== undefined,
		);
		assert.ok(refreshed.checkedAt >= prior.checkedAt);
		assert.deepEqual(
			refreshed,
			{ ...prior, checkedAt: refreshed.checkedAt },
			"a lease that is not failed is never replaced",
		);
		assert.equal(generations.length, 1);
	}
	// A blocked lease reporting `ok: false` is exactly the production shape that
	// was unrecoverable: recovery used to demand a status envelope that a dead
	// lease almost never produces. The body never confirmed readiness, which is
	// how a lease reaches `blocked` in the first place.
	// Stranded across turns: the selection was opened long enough ago that the
	// body cannot still be starting, which is what separates it from a cold
	// container that merely has not reported readiness yet.
	const strandedAt = Date.now() - 30 * 60_000;
	values.set("recovery", { ...prior, openedAt: strandedAt, ready: false });
	leaseStatus = "blocked";
	statusOk = false;
	const recovered = (await recovery.open()) as {
		ok: boolean;
		retainedLeaseId: string;
		retainedLeaseStatus: string;
	};
	assert.equal(recovered.ok, true);
	assert.equal(recovered.retainedLeaseId, prior.leaseId);
	assert.equal(recovered.retainedLeaseStatus, "blocked");
	assert.deepEqual(
		(
			values.get(`recovery:retained:${prior.leaseId}`) as {
				environment: unknown;
			}
		).environment,
		{ ...prior, openedAt: strandedAt, ready: false },
		"the failed body is retained exactly as it was, not reconstructed",
	);
	assert.notEqual((await recovery.selected())?.leaseId, prior.leaseId);
	assert.notEqual(generations[0], generations[1]);
	assert.equal((await recovery.selected())?.preparation, "repository");
	assert.equal(
		(
			(await recovery.execution(oldExecution.executionId, false)) as {
				stdout: string;
			}
		).stdout,
		prior.leaseId,
	);
	assert.equal(closed, 0, "recovery must not destroy the failed environment");

	// Replacement is bounded, and the refusal names the lease instead of blaming
	// whatever the body last wrote. Every lease now fails, so the replacements
	// themselves fail and the ceiling is what stops the loop.
	const generationsBeforeCeiling = generations.length;
	everyLeaseFails = true;
	values.set("recovery", {
		...(await recovery.selected()),
		openedAt: strandedAt,
		ready: false,
	});
	const exhausted = (await recovery.open()) as {
		ok: boolean;
		error: string;
		blockedLeaseId: string;
		blockedLeaseStatus: string;
		bodyError: string | null;
	};
	assert.equal(exhausted.ok, false);
	assert.equal(exhausted.blockedLeaseStatus, "blocked");
	assert.equal(exhausted.bodyError, bodySetupError);
	assert.ok(
		exhausted.error.includes(exhausted.blockedLeaseId),
		"the refusal must name the blocked lease",
	);
	assert.ok(
		exhausted.error.includes("not a missing credential"),
		"the refusal must not present the body's last message as the cause",
	);
	assert.equal(
		generations.length - generationsBeforeCeiling,
		2,
		"replacement stops at the bounded attempt ceiling",
	);
}

// A terminal clone failure is actionable, not a new-container retry loop.
{
	const scope = "terminal-repo-failure";
	let leaseOpens = 0;
	let starts = 0;
	let repoSync: Record<string, unknown> = {
		status: "failed",
		executionState: "terminal",
		executionId: "clone-429",
		error: "GitHub clone failed: HTTP 429 Too Many Requests",
		treePreflight: { startSha: "a".repeat(40) },
	};
	const controller = new ComputerEnvironmentController(store, scope, {
		...actions,
		open: async () => ({ ok: true, leaseId: `terminal-${++leaseOpens}` }),
		status: async (_environment, _timeoutMs, refreshNative) => ({
			ok: true,
			status: repoSync.status === "updated" ? "ready" : "blocked",
			setupError: null,
			credentials: {
				configured: true,
				status: "brokered",
				...(refreshNative
					? {
							probe: {
								status: "valid",
								httpStatus: 200,
								responseHeaders: {
									"x-github-request-id": "SAFE-REQUEST-ID",
									authorization: "must-not-forward",
								},
							},
						}
					: {}),
				secret: "must-not-forward",
			},
			workstationLease: {
				status: repoSync.status === "updated" ? "active" : "blocked",
			},
			bootstrap: { installStatus: "blocked", lastBootstrapError: "old error" },
			readiness: { toolsReady: true, repoReady: repoSync.status === "updated" },
			repoSync,
		}),
		start: async () => {
			starts++;
			return { ok: true };
		},
	});
	const opened = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.equal(opened.ok, false);
	assert.equal(opened.ready, false);
	assert.equal(opened.leaseId, "terminal-1");
	assert.equal("cwd" in opened, false);
	assert.equal("preparedStartSha" in opened, false);
	assert.deepEqual(opened.credentials, {
		configured: true,
		status: "brokered",
	});
	const diagnosed = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.deepEqual(diagnosed.credentials, {
		configured: true,
		status: "brokered",
		probe: {
			status: "valid",
			httpStatus: 200,
			responseHeaders: { "x-github-request-id": "SAFE-REQUEST-ID" },
		},
	});
	assert.match(String(opened.error), /HTTP 429/);
	assert.equal(
		opened.instruction,
		"Repository preparation failed. This computer is retained; resolve the reported failure before retrying repository work.",
	);
	const selected = (await controller.selected())!;
	selected.openedAt = Date.now() - 7 * 60_000;
	await store.put(scope, selected);
	const rejected = (await controller.exec({
		command: "echo must-not-run",
	})) as Record<string, unknown>;
	assert.equal(rejected.ok, false);
	assert.equal(rejected.executed, false);
	assert.equal(rejected.pending, undefined);
	assert.doesNotMatch(String(rejected.instruction), /until ready/);
	assert.equal(starts, 0);
	assert.equal(leaseOpens, 1);
	assert.equal((await controller.selected())?.leaseId, "terminal-1");
	assert.equal(values.get(`${scope}:recoveries`), undefined);
	// A current successful status can recover the same selection despite stale text.
	repoSync = { status: "updated", executionState: "terminal" };
	const repaired = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.equal(repaired.ready, true);
	assert.equal(leaseOpens, 1);
	// Shell access is independent of the failed repository.
	const shell = new ComputerEnvironmentController(store, "repo-failure-shell", {
		...actions,
		status: async () => ({
			ok: true,
			readiness: { toolsReady: true, repoReady: false },
			repoSync: {
				status: "failed",
				executionState: "terminal",
				error: "HTTP 429",
			},
		}),
	});
	assert.equal(((await shell.open("shell")) as { ready: boolean }).ready, true);
	// A terminal lease still takes precedence over its old clone error.
	let deadLeaseOpens = 0;
	const deadLease = new ComputerEnvironmentController(
		store,
		"dead-repo-lease",
		{
			...actions,
			open: async () => ({
				ok: true,
				leaseId: `dead-repo-${++deadLeaseOpens}`,
			}),
			status: async (environment) =>
				environment.leaseId === "dead-repo-1"
					? {
							ok: false,
							workstationLease: { status: "expired" },
							repoSync: {
								status: "failed",
								executionState: "terminal",
								error: "old clone failure",
							},
						}
					: actions.status(),
		},
	);
	assert.equal(
		((await deadLease.open("repository")) as { ready: boolean }).ready,
		true,
	);
	assert.equal(deadLeaseOpens, 2);
}

// A body that is merely starting is waited for, never replaced.
//
// apps/tedi derives the workstation status from readiness dimensions, so a
// container that is still installing tools or cloning the repo reports
// `blocked` on the workstation AND on its lease, with no `setupError`.
// Replacing it on the first status read abandons bodies that would have
// reached active/ready by themselves.
//
// The clock is driven from the status stub: every read pushes the selection's
// `openedAt` a further 100 simulated seconds into the past, and the body only
// reports ready at 200s — long past the 14s at which it used to be replaced.
{
	const leases: string[] = [];
	let waitedMs = 0;
	const slowStart = new ComputerEnvironmentController(store, "slow-start", {
		...actions,
		open: async () => {
			leases.push(`slow-${leases.length + 1}`);
			return { ok: true, leaseId: leases.at(-1) };
		},
		status: async (environment) => {
			waitedMs += 100_000;
			(environment as { openedAt?: number }).openedAt = Date.now() - waitedMs;
			if (waitedMs < 200_000)
				return {
					ok: true,
					ready: false,
					status: "blocked",
					setupError: null,
					bootstrap: {
						lastBootstrapError:
							"GitHub credentials are required before the repo can be prepared",
					},
					readiness: { toolsReady: false, repoReady: false },
					repoSync: {
						status: "failed",
						executionState: "running",
						error: "old clone error",
					},
					workstationLease: { status: "blocked" },
				};
			return {
				...(await actions.status()),
				ready: true,
				status: "ready",
				setupError: null,
				bootstrap: { lastBootstrapError: null },
				workstationLease: { status: "active" },
			};
		},
	});
	const opened = (await slowStart.open("repository")) as {
		ok: boolean;
		ready: boolean;
	};
	assert.equal(opened.ok, true);
	assert.equal(opened.ready, true, "a slow body comes up on its own lease");
	assert.ok(waitedMs >= 200_000, "the body reported ready only after 200s");
	assert.equal(
		leases.length,
		1,
		"a starting body is waited for, not replaced — one lease for the task",
	);
	assert.equal((await slowStart.selected())?.leaseId, "slow-1");
	assert.equal(
		values.get("slow-start:recoveries"),
		undefined,
		"the replacement budget is spent only on bodies that genuinely failed",
	);
	assert.equal(
		values.get("slow-start:retained:slow-1"),
		undefined,
		"nothing was retained because nothing failed",
	);
}

// Foreground readiness includes the entire action, including work after HTTP.
// Late completions cannot rewrite a newer owner's selected filesystem.
{
	const scope = "bounded-acquisition";
	let provisioned = 0;
	let statusCalls = 0;
	let releaseStatus!: (value: unknown) => void;
	const lateStatus = new Promise<unknown>((resolve) => {
		releaseStatus = resolve;
	});
	const boundedActions = {
		...actions,
		open: async (
			_preparation: "shell" | "repository",
			_generation: string,
			_work: unknown,
			confirmed?: (value: unknown) => Promise<void>,
		) => {
			provisioned++;
			const receipt = { ok: true, leaseId: "confirmed-bound" };
			await confirmed?.(receipt);
			return receipt;
		},
		status: async () => (++statusCalls === 1 ? lateStatus : actions.status()),
	};
	const original = new ComputerEnvironmentController(
		store,
		scope,
		boundedActions,
		undefined,
		"owner-original",
		undefined,
		{ budgetMs: 15 },
	);
	await assertUnconfirmedOpen(
		original.open("repository", "owner-original:open"),
	);
	const next = new ComputerEnvironmentController(
		store,
		scope,
		boundedActions,
		undefined,
		"owner-next",
	);
	await next.open("repository", "owner-next:open");
	releaseStatus({
		ok: true,
		readiness: { toolsReady: true, repoReady: true },
		repoSync: { workdir: "/wrong-late-path" },
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal((await next.selected())?.cwd, "/home/tedi/workstation/repo");
	assert.equal(values.get(`${scope}:owner`), "owner-next");
	assert.equal(provisioned, 1);
	await assert.rejects(
		original.open("repository", "owner-original:open"),
		/owner or generation changed/,
	);
	assert.equal(
		values.get(`${scope}:owner`),
		"owner-next",
		"replay mismatch must not steal ownership",
	);
}

// Timeout finalization cannot wait indefinitely for fresh ownership reads.
// Identical callers share the bounded outcome and retain the original journal.
{
	const scope = "blocked-final-ownership";
	let blockOwnership = false;
	let blockedOwnershipReads = 0;
	let releaseOwnership!: () => void;
	const ownershipBlocked = new Promise<void>((resolve) => {
		releaseOwnership = resolve;
	});
	const blockedStore = {
		...store,
		get: async <T>(key: string): Promise<T | undefined> => {
			if (
				blockOwnership &&
				(key === `${scope}:owner` || key === `${scope}:generation`)
			) {
				blockedOwnershipReads++;
				await ownershipBlocked;
			}
			return store.get<T>(key);
		},
	};
	let provisions = 0;
	let releaseStatus!: (value: unknown) => void;
	const lateStatus = new Promise<unknown>((resolve) => {
		releaseStatus = resolve;
	});
	let firstStatus = true;
	const bindings = {
		...actions,
		open: async () => ({ ok: true, leaseId: `bounded-final-${++provisions}` }),
		status: async () => {
			if (firstStatus) {
				firstStatus = false;
				blockOwnership = true;
				return lateStatus;
			}
			return actions.status();
		},
	};
	const controller = new ComputerEnvironmentController(
		blockedStore,
		scope,
		bindings,
		undefined,
		"bounded-owner",
		undefined,
		{ budgetMs: 10 },
	);
	const first = controller.open("repository", `${scope}:open`);
	const duplicate = controller.open("repository", `${scope}:open`);
	const both = Promise.allSettled([first, duplicate]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcomes = await Promise.race([
			both,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								"open exceeded its total deadline while ownership reads were blocked",
							),
						),
					250,
				);
			}),
		]);
		for (const result of outcomes) {
			assert.equal(result.status, "fulfilled");
			if (result.status === "fulfilled")
				await assertUnconfirmedOpen(Promise.resolve(result.value));
		}
	} finally {
		clearTimeout(timer);
		blockOwnership = false;
		releaseOwnership();
	}
	assert.equal(provisions, 1);
	assert.equal(
		blockedOwnershipReads,
		0,
		"the expired deadline cannot begin new ownership reads",
	);
	assert.equal(
		(
			values.get(`computer-acquisition:${scope}:open`) as {
				confirmed: { leaseId: string };
			}
		).confirmed.leaseId,
		"bounded-final-1",
	);
	const next = new ComputerEnvironmentController(
		blockedStore,
		scope,
		bindings,
		undefined,
		"successor-owner",
	);
	await next.open("repository", `${scope}:successor`);
	releaseStatus({
		ok: true,
		readiness: { toolsReady: true, repoReady: true },
		repoSync: { workdir: "/stale-path" },
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(values.get(`${scope}:owner`), "successor-owner");
	assert.equal((await next.selected())?.cwd, "/home/tedi/workstation/repo");
	assert.equal(provisions, 1);
}

// An unready repository has no public checkout path. The next relative exec
// resolves readiness on the same lease; explicitly chosen directories still win.
{
	const scope = "repository-cwd-after-deadline";
	let provisioned = 0;
	let statusCalls = 0;
	const executionCwds: unknown[] = [];
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async (_preparation, _generation, _work, confirmed) => {
				provisioned++;
				const receipt = { ok: true, leaseId: "checkout-once" };
				await confirmed?.(receipt);
				return receipt;
			},
			status: async () => {
				if (++statusCalls === 1) return new Promise(() => {});
				return {
					ok: true,
					readiness: { toolsReady: true, repoReady: true },
					repoSync: { workdir: "/workspace/repos/org/repo" },
				};
			},
			start: async (_environment, input) => {
				executionCwds.push(input.cwd);
				return { ok: true };
			},
		},
		undefined,
		"checkout-owner",
		undefined,
		{ budgetMs: 15 },
	);
	await assertUnconfirmedOpen(
		controller.open("repository", "checkout-owner:open"),
	);
	assert.equal((await controller.selected())?.cwd, "/home/tedi/workstation");
	await controller.exec({ command: "git status" });
	assert.deepEqual(executionCwds, ["/workspace/repos/org/repo"]);
	await controller.exec({ command: "pwd", cwd: "/workspace/explicit" });
	assert.deepEqual(executionCwds, [
		"/workspace/repos/org/repo",
		"/workspace/explicit",
	]);
	const ready = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.equal(ready.ready, true);
	assert.equal(ready.cwd, "/workspace/repos/org/repo");
	assert.equal(ready.instruction, repository.instruction);
	assert.equal(provisioned, 1);
}

// Explicit open observes the same lease again, including a new owner and a
// cache that is still within the operation freshness window. A timed-out
// refresh must not leave stale readiness available to a following command.
for (const cachedAgeMs of [0, 60_000]) {
	const scope = `reopen-freshness-${cachedAgeMs}`;
	let provisions = 0;
	let statusReads = 0;
	let starts = 0;
	let state: "ready" | "syncing" | "hung" = "ready";
	const bindings = {
		...actions,
		open: async () => ({ ok: true, leaseId: `freshness-${++provisions}` }),
		status: async () => {
			statusReads++;
			if (state === "hung") return new Promise(() => {});
			return {
				ok: true,
				readiness: { toolsReady: true, repoReady: state === "ready" },
				repoSync: { workdir: "/workspace/repos/current", status: state },
			};
		},
		start: async () => {
			starts++;
			return { ok: true };
		},
	};
	const initial = new ComputerEnvironmentController(
		store,
		scope,
		bindings,
		undefined,
		"old-owner",
	);
	await initial.open("repository", `${scope}:initial`);
	const selected = (await initial.selected())!;
	const generation = values.get(`${scope}:generation`);
	values.set(scope, { ...selected, checkedAt: Date.now() - cachedAgeMs });
	state = "syncing";
	const current = new ComputerEnvironmentController(
		store,
		scope,
		bindings,
		undefined,
		"new-owner",
		undefined,
		{ budgetMs: 10 },
	);
	await assertUnconfirmedOpen(current.open("repository", `${scope}:refresh`));
	assert.ok(statusReads >= 2);
	assert.equal((await current.selected())?.ready, false);
	assert.equal((await current.selected())?.leaseId, selected.leaseId);
	assert.equal(values.get(`${scope}:generation`), generation);
	assert.equal(values.get(`${scope}:owner`), "new-owner");
	const blocked = (await current.exec({ command: "must-not-run" })) as Record<
		string,
		unknown
	>;
	assert.equal(blocked.executed, false);
	assert.equal(starts, 0);
	state = "ready";
	const ready = (await current.open("repository")) as Record<string, unknown>;
	assert.equal(ready.ready, true);
	assert.equal(ready.cwd, "/workspace/repos/current");
	// Same-owner explicit opens also refresh; a hung backend cannot preserve
	// the just-observed ready bit through the foreground deadline.
	state = "hung";
	await assertUnconfirmedOpen(current.open("repository"));
	assert.equal((await current.selected())?.ready, false);
	state = "ready";
	await current.exec({ command: "now-ready" });
	assert.equal(starts, 1);
	assert.equal(provisions, 1);
}

// D1 can retain ready after the native container lost its checkout. Reopening
// must use the existing wake adapter, including retries after a pending/error
// receipt; a passive status read alone would incorrectly enable file/exec calls.
{
	let provisions = 0;
	let nativeReady = false;
	let pending = false;
	let passiveReads = 0;
	let starts = 0;
	const wakes: Record<string, unknown>[] = [];
	const env = {
		TEDI_SERVICE: {
			fetch: async (request: Request) => {
				assert.equal(
					new URL(request.url).pathname,
					"/api/admin/workstation/wake",
				);
				wakes.push((await request.json()) as Record<string, unknown>);
				return Response.json({
					ok: nativeReady || pending,
					ready: nativeReady,
					...(nativeReady ? {} : { error: "Native checkout is not ready" }),
					readiness: { toolsReady: true, repoReady: nativeReady },
					repoSync: {
						workdir: "/home/tedi/workstation/repos/current",
						status: nativeReady ? "cloned" : "syncing",
					},
				});
			},
		} as unknown as Fetcher,
	};
	const controller = new ComputerEnvironmentController(
		store,
		"native-reopen",
		{
			...actions,
			open: async () => ({ ok: true, leaseId: `native-lease-${++provisions}` }),
			status: async (selected, timeoutMs, refreshNative) => {
				if (refreshNative)
					return reconcileWorkstation(
						env,
						{ tediId: "tedi", slug: "cto" },
						selected,
						{ timeoutMs },
					);
				passiveReads++;
				return actions.status(); // Historical D1 readiness remains true.
			},
			start: async () => {
				starts++;
				return { ok: true };
			},
		},
		async () => {
			if (pending) nativeReady = true;
		},
	);
	assert.equal(
		((await controller.open("repository")) as Record<string, unknown>).ready,
		true,
	);
	const selected = (await controller.selected())!;
	assert.equal(
		((await controller.open("repository")) as Record<string, unknown>).ready,
		false,
	);
	assert.equal((await controller.selected())!.ready, false);
	await controller.exec({ command: "must-not-run" });
	assert.equal(starts, 0);
	assert.equal(passiveReads, 3);
	assert.equal(wakes.length, 2);
	pending = true;
	const ready = (await controller.open("repository")) as Record<
		string,
		unknown
	>;
	assert.equal(ready.ready, true);
	assert.equal(ready.cwd, "/home/tedi/workstation/repos/current");
	assert.equal(wakes.length, 4, "syncing retries actively on the same lease");
	assert.equal(provisions, 1);
	assert.equal((await controller.selected())!.leaseId, selected.leaseId);
	assert.ok(wakes.every((wake) => wake.leaseId === selected.leaseId));
}

// An inactive lease must be classified passively before /wake can refuse it.
{
	let provisions = 0;
	let expired = false;
	const refreshed: string[] = [];
	const controller = new ComputerEnvironmentController(
		store,
		"inactive-refresh",
		{
			...actions,
			open: async () => ({ ok: true, leaseId: `inactive-${++provisions}` }),
			status: async (environment, _timeout, refreshNative) => {
				if (environment.leaseId === "inactive-1" && expired) {
					assert.equal(
						refreshNative,
						false,
						"inactive participant cannot wake",
					);
					return { ok: false, workstationLease: { status: "expired" } };
				}
				if (refreshNative) refreshed.push(environment.leaseId);
				return actions.status();
			},
		},
	);
	await controller.open("repository");
	expired = true;
	assert.equal(
		((await controller.open("repository")) as Record<string, unknown>).ready,
		true,
	);
	assert.equal(provisions, 2);
	assert.ok(!refreshed.includes("inactive-1"));
}

// A fresh revalidation of an aged ready lease gets one persisted grace window.
// Deadline/reopen must retain it, never immediately replace the warming body or
// extend the grace on every stale-ready database receipt.
{
	const scope = "revalidation-grace";
	let provisions = 0;
	let nativeReady = false;
	let passiveReady = true;
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async () => ({ ok: true, leaseId: `grace-${++provisions}` }),
			status: async (_environment, _timeout, refreshNative) => {
				const ready = refreshNative ? nativeReady : passiveReady;
				if (refreshNative) passiveReady = nativeReady;
				return {
					ok: true,
					ready,
					status: ready ? "ready" : "blocked",
					workstationLease: { status: ready ? "active" : "blocked" },
					readiness: { toolsReady: true, repoReady: ready },
					repoSync: {
						status: ready ? "cloned" : "syncing",
						executionState: "admitting",
					},
				};
			},
		},
		undefined,
		undefined,
		undefined,
		{ budgetMs: 20 },
	);
	await controller.open("repository");
	values.set(scope, {
		...(await controller.selected()),
		openedAt: Date.now() - 3_600_000,
	});
	await assertUnconfirmedOpen(controller.open("repository"));
	const started = (await controller.selected())!.revalidationStartedAt;
	const refreshId = (await controller.selected())!.revalidationId;
	assert.equal(typeof refreshId, "string");
	assert.equal(typeof started, "number");
	assert.equal(provisions, 1);
	passiveReady = true; // Even a repeated stale D1-ready receipt cannot renew grace.
	await assertUnconfirmedOpen(controller.open("repository"));
	assert.equal((await controller.selected())!.revalidationStartedAt, started);
	assert.equal((await controller.selected())!.revalidationId, refreshId);
	assert.equal(provisions, 1);
	nativeReady = true;
	assert.equal(
		((await controller.open("repository")) as Record<string, unknown>).ready,
		true,
	);
	assert.equal((await controller.selected())!.revalidationStartedAt, undefined);
	assert.equal((await controller.selected())!.revalidationId, undefined);
	assert.equal(provisions, 1);
}

// Acceptance must be persisted before post-provision bookkeeping can suspend.
{
	const scope = "accept-before-bookkeeping";
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async (_preparation, _generation, _work, confirmed) => {
				await confirmed?.({
					ok: true,
					leaseId: "accepted-before-fiber",
					workstationLease: { id: "accepted-before-fiber" },
				});
				return new Promise(() => {});
			},
		},
		undefined,
		"owner-fiber",
		undefined,
		{ budgetMs: 10 },
	);
	await assertUnconfirmedOpen(controller.open("shell", "owner-fiber:open"));
	assert.equal(
		(
			values.get("computer-acquisition:owner-fiber:open") as {
				confirmed: { leaseId: string };
			}
		).confirmed.leaseId,
		"accepted-before-fiber",
	);
}

// An unacknowledged provision remains unknown even if it answers after expiry.
{
	const scope = "unknown-provision";
	let provide!: (value: unknown) => void;
	let provisions = 0;
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async (_preparation, _generation, _work, confirmed) => {
				provisions++;
				const receipt = await new Promise((resolve) => {
					provide = resolve;
				});
				await confirmed?.(receipt);
				return receipt;
			},
		},
		undefined,
		"owner-unknown",
		undefined,
		{ budgetMs: 10 },
	);
	const opening = controller.open("shell", "owner-unknown:open");
	await new Promise((resolve) => setTimeout(resolve, 0));
	await assert.rejects(
		controller.open("repository", "owner-unknown:other"),
		/different Computer acquisition/,
	);
	await assert.rejects(opening, /outcome is unknown/);
	provide({ ok: true, leaseId: "too-late" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(values.get(scope), undefined);
	await assert.rejects(
		controller.open("shell", "owner-unknown:open"),
		/outcome is unknown/,
	);
	await assert.rejects(
		controller.open("shell", "owner-unknown:new"),
		/outcome is unknown/,
	);
	assert.equal(provisions, 1);
}

// Refusal envelopes and synthesized/malformed lease identities are not proof.
for (const [name, receipt] of Object.entries({
	missingOk: { leaseId: "synthetic" },
	failed: { ok: false, leaseId: "synthetic" },
	empty: { ok: true, leaseId: " " },
	conflict: { ok: true, leaseId: "root", workstationLease: { id: "nested" } },
})) {
	const scope = `invalid-acquisition-${name}`;
	const controller = new ComputerEnvironmentController(store, scope, {
		...actions,
		open: async () => receipt,
	});
	try {
		await controller.open("shell", `${scope}:open`);
	} catch (error) {
		assert.match(String(error), /confirmed lease|conflicting leases/);
	}
	assert.equal(values.get(scope), undefined);
	assert.equal(
		(
			values.get(`computer-acquisition:${scope}:open`) as {
				confirmed?: unknown;
			}
		).confirmed,
		undefined,
	);
}

// A NEW explicit call can replace a dead old lease; its confirmed replay cannot.
{
	const scope = "explicit-replacement";
	const generations: string[] = [];
	let dead = false;
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async (_mode, generation) => {
				generations.push(generation);
				return { ok: true, leaseId: `explicit-${generations.length}` };
			},
			status: async () =>
				dead
					? { ok: false, workstationLease: { status: "expired" } }
					: actions.status(),
		},
		undefined,
		"replacement-owner",
	);
	await controller.open("shell", "replacement-owner:first");
	const selected = await controller.selected();
	values.set(scope, { ...selected, ready: false });
	dead = true;
	const replay = (await controller.open(
		"shell",
		"replacement-owner:first",
	)) as Record<string, unknown>;
	assert.equal(replay.ok, false);
	assert.equal(generations.length, 1);
	const newer = (await controller.open(
		"shell",
		"replacement-owner:second",
	)) as Record<string, unknown>;
	assert.equal(newer.ok, false, "replacement stops at the bounded ceiling");
	assert.equal(generations.length, 3);
	assert.notEqual(generations[0], generations[1]);
	assert.equal(newer.retainedLeaseId, "explicit-1");
}

// A successor Work Attempt gets a new immutable lease while the prior one stays retained.
{
	const scope = "successor-attempt-lease";
	const attempts = new Map<string, string>();
	const actionsWithAttempt = {
		...actions,
		open: async (
			_mode: string,
			_generation: string,
			work: { attemptId: string } | null,
		) => {
			const leaseId = `successor-${attempts.size + 1}`;
			attempts.set(leaseId, work?.attemptId ?? "missing");
			return { ok: true, leaseId };
		},
		status: async (environment: { leaseId: string }) => ({
			ok: true,
			workstationLease: {
				id: environment.leaseId,
				workItemId: scope,
				attemptId: attempts.get(environment.leaseId),
				status: "active",
			},
			readiness: { toolsReady: true, repoReady: true },
			repoSync: { workdir: "/home/tedi/workstation/repo" },
		}),
	};
	const first = new ComputerEnvironmentController(
		store,
		scope,
		actionsWithAttempt,
		undefined,
		"run-first",
		undefined,
		{
			captureAuthority: async () => ({
				workItemId: scope,
				attemptId: "attempt-first",
				tediId: "tedi-test",
			}),
		},
	);
	assert.equal(
		((await first.open("repository", "first-open")) as { ready: boolean })
			.ready,
		true,
	);
	const successor = new ComputerEnvironmentController(
		store,
		scope,
		actionsWithAttempt,
		undefined,
		"run-successor",
		undefined,
		{
			captureAuthority: async () => ({
				workItemId: scope,
				attemptId: "attempt-successor",
				tediId: "tedi-test",
			}),
		},
	);
	const opened = (await successor.open("repository", "successor-open")) as {
		ready: boolean;
	};
	const selected = await successor.selected();
	assert.equal(opened.ready, true);
	assert.equal(selected?.leaseId, "successor-2");
	assert.equal(attempts.get(selected!.leaseId), "attempt-successor");
	assert.equal(
		(values.get(`${scope}:retained:successor-1`) as { status: string }).status,
		"superseded_attempt",
	);
}
console.log(
	"Computer acquisition: whole-action deadlines, late completion fencing and exact-call replay pass",
);

// Existing known selections are confirmed for the new exact call before status.
{
	const scope = "existing-unready-deadline";
	const initial = new ComputerEnvironmentController(
		store,
		scope,
		actions,
		undefined,
		"existing-owner",
	);
	await initial.open("shell", "existing-owner:first");
	const environment = await initial.selected();
	values.set(scope, { ...environment, ready: false });
	const hanging = new ComputerEnvironmentController(
		store,
		scope,
		{ ...actions, status: async () => new Promise(() => {}) },
		undefined,
		"existing-owner",
		undefined,
		{ budgetMs: 10 },
	);
	await assertUnconfirmedOpen(hanging.open("shell", "existing-owner:second"));
	assert.equal(
		(
			values.get("computer-acquisition:existing-owner:second") as {
				confirmed: { leaseId: string };
			}
		).confirmed.leaseId,
		environment?.leaseId,
	);
}

// Waiting behind an in-flight release belongs to the foreground deadline too.
{
	const scope = "closing-deadline";
	let release!: (value: unknown) => void;
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			close: async () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		},
		undefined,
		"closing-owner",
		undefined,
		{ budgetMs: 10 },
	);
	await controller.open("shell", "closing-owner:first");
	const leaseId = (await controller.selected())!.leaseId;
	const closing = controller.close();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await assert.rejects(
		controller.open("shell", "closing-owner:second"),
		/did not start before/,
	);
	assert.equal(
		values.get("computer-acquisition:closing-owner:second"),
		undefined,
	);
	release({ ok: true, leaseId, leaseStatus: "released" });
	await closing;
}

// A deadline exactly while the old journal proof is revoked cannot return it.
{
	const scope = "replacement-revocation-deadline";
	let pauseRevocation = false;
	let resumeRevocation!: () => void;
	const delayedStore = {
		...store,
		put: async <T>(key: string, value: T) => {
			await store.put(key, value);
			if (
				pauseRevocation &&
				key === "computer-acquisition:replace-owner:second" &&
				!(value as { confirmed?: unknown }).confirmed
			) {
				pauseRevocation = false;
				await new Promise<void>((resolve) => {
					resumeRevocation = resolve;
				});
			}
		},
	};
	let dead = false;
	let provisions = 0;
	const controller = new ComputerEnvironmentController(
		delayedStore,
		scope,
		{
			...actions,
			open: async () => ({ ok: true, leaseId: `revocation-${++provisions}` }),
			status: async () => {
				if (dead) {
					pauseRevocation = true;
					return { ok: false, workstationLease: { status: "expired" } };
				}
				return actions.status();
			},
		},
		undefined,
		"replace-owner",
		undefined,
		{ budgetMs: 15 },
	);
	await controller.open("shell", "replace-owner:first");
	values.set(scope, { ...(await controller.selected()), ready: false });
	dead = true;
	await assert.rejects(
		controller.open("shell", "replace-owner:second"),
		/outcome is unknown/,
	);
	assert.equal(
		(
			values.get("computer-acquisition:replace-owner:second") as {
				confirmed?: unknown;
			}
		).confirmed,
		undefined,
	);
	assert.equal(provisions, 1);
	resumeRevocation();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		provisions,
		1,
		"late transition must not issue replacement provision",
	);
}

// Authenticated non-owning readers may refresh an existing selection without
// taking the owning run's lease or inventing a Work Attempt.
{
	const scope = "non-owning-reader";
	const owning = new ComputerEnvironmentController(
		store,
		scope,
		actions,
		undefined,
		"owning-run",
	);
	await owning.open();
	values.set(scope, { ...(await owning.selected()), ready: false });
	const reader = new ComputerEnvironmentController(
		store,
		scope,
		actions,
		undefined,
		undefined,
		undefined,
		{ captureAuthority: async () => null },
	);
	assert.equal(((await reader.open()) as { ready: boolean }).ready, true);
	assert.equal(values.get(`${scope}:owner`), "owning-run");
}

// Wake registration can fail after a process has started. Both detach paths
// must preserve the existing execution handle instead of throwing it away.
for (const path of ["start-timeout", "wait-timeout"] as const) {
	let starts = 0;
	let dispatchedId = "";
	let registrations = 0;
	const failedWake = new ComputerEnvironmentController(
		store,
		`scope-wake-failure-${path}`,
		{
			...actions,
			start: async (_environment, input) => {
				starts++;
				dispatchedId = input.processId;
				return path === "start-timeout"
					? { ok: false, requestTimedOut: true }
					: { ok: true };
			},
			wait: async () => {
				assert.equal(path, "wait-timeout");
				return { ok: true, terminal: false };
			},
		},
		undefined,
		undefined,
		{
			collected: async () => {},
			detached: async () => {
				registrations++;
				throw new Error(
					"computer_continuation_failed: detached Work execution has no owning session",
				);
			},
		},
	);
	await failedWake.open();
	const command = { command: "git push origin scratch" };
	const result = (await failedWake.exec(
		command,
		`wake-failure-${path}`,
	)) as Record<string, unknown>;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, "unknown");
	assert.equal(result.executionId, dispatchedId);
	assert.match(String(result.error), /computer_continuation_failed/);
	assert.match(String(result.instruction), /Do not repeat the command/);
	assert.equal(registrations, 1);
	const reread = (await failedWake.exec(
		command,
		`wake-failure-${path}`,
	)) as Record<string, unknown>;
	assert.equal(reread.executionId, dispatchedId);
	assert.equal(starts, 1, "same tool call never dispatches its command twice");
	assert.equal(registrations, 1);
}

// Model-only naming changes must preserve internal effect identity and scratch inputs.
{
	let inspected = 0;
	let scratchCalls = 0;
	let scratchInput: unknown;
	const controller = new ComputerEnvironmentController(
		store,
		"deadline-model",
		actions,
	);
	const originalSelected = controller.selected.bind(controller);
	const originalHasEffect = controller.hasEffect.bind(controller);
	controller.selected = async () => {
		inspected++;
		return originalSelected();
	};
	controller.hasEffect = async (id) => {
		inspected++;
		return originalHasEffect(id);
	};
	const wrapped = createComputerEnvironmentTools(
		{
			exec: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: async (input) => {
					scratchCalls++;
					scratchInput = input;
					return { stdout: "scratch" };
				},
			}),
		},
		controller,
	);
	// Facet descriptors persist this same AI SDK JSON Schema conversion.
	const schema = JSON.parse(
		JSON.stringify(asSchema(wrapped.exec!.inputSchema as never).jsonSchema),
	);
	assert.ok(schema.properties.killAfterMs);
	assert.equal(schema.properties.timeoutMs, undefined);
	assert.equal(schema.additionalProperties, false);
	const call = (args: unknown, id = crypto.randomUUID()) =>
		wrapped.exec!.execute!(args as never, {
			toolCallId: id,
			messages: [],
			context: undefined,
		});
	for (const args of [
		{ command: "pwd", timeoutMs: 1000 },
		{ command: "pwd", timeoutMs: 1000, killAfterMs: 1000 },
		...[999, 21_600_001, 1000.5, "1000", null].map((killAfterMs) => ({
			command: "pwd",
			killAfterMs,
		})),
	])
		await assert.rejects(call(args));
	assert.equal(
		inspected,
		0,
		"invalid raw facet arguments fail before effect/selection reads",
	);
	assert.equal(scratchCalls, 0);
	await call({ command: "pwd", killAfterMs: 1000 });
	assert.deepEqual(scratchInput, { command: "pwd", timeoutMs: 1000 });
	await call({ command: "pwd" });
	assert.deepEqual(scratchInput, { command: "pwd" });
	let starts = 0;
	let linuxInput: unknown;
	const linux = new ComputerEnvironmentController(store, "deadline-linux", {
		...actions,
		start: async (_environment, input) => {
			starts++;
			linuxInput = input;
			return { ok: true };
		},
	});
	await linux.open("shell");
	const linuxTools = createComputerEnvironmentTools(native, linux);
	const input = {
		command: "pwd",
		cwd: "/workspace",
		env: { B: "2", A: "1" },
		timeoutMs: 1000,
	};
	await linux.exec(input, "retained-deadline");
	assert.equal(starts, 1);
	await linuxTools.exec!.execute!(
		{
			command: "pwd",
			cwd: "/workspace",
			env: { A: "1", B: "2" },
			killAfterMs: 1000,
		} as never,
		{ toolCallId: "retained-deadline", messages: [], context: undefined },
	);
	assert.equal(
		starts,
		1,
		"new model naming reuses the old normalized Computer receipt",
	);
	await linuxTools.exec!.execute!(
		{ command: "pwd", killAfterMs: 21_600_000 } as never,
		{ toolCallId: "new-deadline", messages: [], context: undefined },
	);
	assert.equal(starts, 2);
	assert.equal((linuxInput as Record<string, unknown>).timeoutMs, 21_600_000);
	assert.equal((linuxInput as Record<string, unknown>).killAfterMs, undefined);
}

// A launch/wait transport interruption must retain cleanup protection even when
// no detached receipt ever reaches the model. Exercise the actual continuation store.
for (const failure of [
	"start",
	"wait",
	"registration",
	"rejection",
	"setup-rejection",
	"none",
] as const) {
	const rows = new Map<string, unknown>();
	const storage = {
		get: async <T>(key: string) =>
			structuredClone(rows.get(key)) as T | undefined,
		put: async <T>(key: string, value: T) => {
			rows.set(key, structuredClone(value));
		},
		delete: async (key: string) => rows.delete(key),
		list: async ({ prefix }: { prefix: string }) =>
			new Map([...rows].filter(([key]) => key.startsWith(prefix))),
	} as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
	const owner = { runId: `retain-${failure}`, workItemId: `work-${failure}` };
	let starts = 0,
		notifications = 0;
	let reject = failure === "rejection" || failure === "setup-rejection";
	let detach = false;
	let retainedId = "";
	const scope = `retention-${failure}`;
	const controller = new ComputerEnvironmentController(
		storage,
		scope,
		{
			...actions,
			start: async (_environment, request) => {
				starts++;
				assert.equal(request.processId, retainedId);
				assert.equal(
					await retainComputerForNativeExecutions(
						storage,
						{ ...owner, leaseId: _environment.leaseId },
						{
							canceled: false,
							cancel: async () => {
								throw Error("must not cancel");
							},
						},
					),
					true,
				);
				if (failure === "start") throw Error("dispatch response interrupted");
				return reject
					? failure === "setup-rejection"
						? {
								ok: false,
								setupError: "Workstation credential configuration failed",
								error: "Workstation credential configuration failed",
							}
						: { ok: false, status: 400, error: "invalid command request" }
					: { ok: true };
			},
			wait: async () => {
				if (failure === "wait") throw Error("wait response interrupted");
				if (detach) return { ok: true, terminal: false, running: true };
				return {
					ok: true,
					terminal: true,
					exitCode: 0,
					stdoutTail: "retained result",
				};
			},
		},
		undefined,
		owner.runId,
		{
			retained: async (execution) => {
				retainedId = execution.executionId;
				if (failure === "registration") throw Error("retention unavailable");
				await new ComputerWorkflowContinuation(storage).register({
					...execution,
					workItemId: owner.workItemId,
					launchedByRunId: owner.runId,
					sessionKey: "retention-session",
					homeRunId: "retention-home",
					detachedAt: Date.now(),
					attempt: 0,
				});
			},
			detached: async () => {
				notifications++;
			},
			collected: (id) => collectComputerExecutionWake(storage, id, owner),
		},
	);
	await controller.open("repository");
	const result = (
		failure === "setup-rejection"
			? await controller.codeSearch({ pattern: "merge-conflict-recovery" })
			: await controller.exec({ command: "bounded command" }, `call-${failure}`)
	) as Record<string, unknown>;
	assert.equal(result.executionId, retainedId);
	assert.equal(starts, failure === "registration" ? 0 : 1);
	assert.equal(
		notifications,
		0,
		"retention never schedules an early completion notification",
	);
	const leaseId = (await controller.selected())!.leaseId;
	const retained = () =>
		retainComputerForNativeExecutions(
			storage,
			{ ...owner, leaseId },
			{
				canceled: false,
				cancel: async () => {
					throw Error("must not cancel");
				},
			},
		);
	assert.equal(await retained(), failure === "start" || failure === "wait");
	if (failure === "rejection" || failure === "setup-rejection") {
		if (failure === "rejection") assert.equal(result.status, 400);
		else
			assert.equal(
				result.setupError,
				"Workstation credential configuration failed",
			);
		reject = false;
		detach = true;
		const valid = (await controller.exec(
			{ command: "valid detached command" },
			"valid-after-rejection",
		)) as Record<string, unknown>;
		assert.equal(valid.running, true);
		assert.equal(await retained(), true);
		const pending = [...rows.entries()]
			.filter(([key]) => key.startsWith("computer-exec-wake:"))
			.map(([, value]) => value as Record<string, unknown>)
			.filter((value) => !value.collectedByRunId);
		assert.deepEqual(
			pending.map((value) => value.executionId),
			[valid.executionId],
			"only the valid detached command remains pending",
		);
	}
	if (failure === "start" || failure === "wait") {
		assert.equal(result.outcome, "unknown");
		const recovered = (await controller.exec(
			{ command: "bounded command" },
			`call-${failure}`,
		)) as Record<string, unknown>;
		assert.equal(recovered.executionId, retainedId);
		assert.equal(recovered.terminal, true);
		assert.equal(
			starts,
			1,
			"recovery observes the original command without redispatch",
		);
		assert.equal(
			await retained(),
			false,
			"terminal collection permits ordinary cleanup",
		);
	}
}

// A foreground deadline carries bounded last-observed preparation diagnostics,
// without extending authority, claiming readiness, or replaying the acquisition.
{
	const scope = "pending-preparation-diagnostics";
	let provisions = 0,
		dispatches = 0;
	let refreshReads = 0;
	const initial = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async () => ({
				ok: true,
				leaseId: `diagnostic-lease-${++provisions}`,
			}),
		},
		undefined,
		"diagnostic-owner",
	);
	await initial.open("repository", `${scope}:first`);
	const lease = (await initial.selected())!;
	let refreshId: string | undefined;
	const controller = new ComputerEnvironmentController(
		store,
		scope,
		{
			...actions,
			open: async () => {
				provisions++;
				throw Error("must not provision");
			},
			start: async () => {
				dispatches++;
				return { ok: true };
			},
			status: async (environment, _timeout, refreshNative) => {
				if (!refreshNative)
					return {
						ok: true,
						ready: true,
						workstationLease: { id: lease.leaseId, status: "ready" },
						readiness: { toolsReady: true, repoReady: true },
						repoSync: { status: "updated" },
					};
				refreshReads++;
				refreshId ??= environment.revalidationId;
				assert.equal(environment.revalidationId, refreshId);
				if (refreshReads % 2 === 0) return new Promise(() => {});
				return {
					ok: true,
					ready: false,
					lastObservation: {
						leaseId: environment.leaseId,
						refreshId: environment.revalidationId,
						source: "native_refresh",
						observedAt: "2026-09-21T20:23:40.000Z",
						repoSync: {
							status: "syncing",
							executionId: "retained-clone",
							executionState: "admitting",
							error: "PRIVATE",
						},
						bootstrap: { nextAction: "wait_for_repo_sync" },
						provisioningFiber: { fiberId: "retained-fiber", status: "running" },
						ready: true,
					},
				};
			},
		},
		async () => {},
		"diagnostic-owner",
		undefined,
		{ budgetMs: 25 },
	);
	for (let i = 0; i < 2; i++) {
		const result = (await controller.open(
			"repository",
			`${scope}:retry-${i}`,
		)) as Record<string, unknown>;
		assert.equal(result.ok, false);
		assert.equal(result.ready, false);
		const diagnostic = result.lastObservation as Record<string, unknown>;
		assert.equal(diagnostic.leaseId, lease.leaseId);
		assert.equal(diagnostic.refreshId, refreshId);
		assert.equal(
			(diagnostic.repoSync as Record<string, unknown>).executionId,
			"retained-clone",
		);
		assert.equal(diagnostic.ready, undefined);
		assert.ok(!JSON.stringify(diagnostic).includes("PRIVATE"));
	}
	assert.equal(provisions, 1);
	assert.equal(dispatches, 0);
	assert.equal((await controller.selected())!.leaseId, lease.leaseId);
	assert.equal((await controller.selected())!.ready, false);
}

{
	const undo = computerEnvironmentWorkspace(scratch, first);
	await undo.writeFile("guarded.txt", "before");
	const receipt = await undo.writeReversibleFile!("guarded.txt", "approved");
	assert.equal(receipt.previousContent, "before");
	await undo.writeFile("guarded.txt", "newer");
	await assert.rejects(
		undo.restoreFile!("guarded.txt", "approved", receipt.previousContent),
		/workspace_rollback_conflict/,
	);
	assert.equal(await undo.readFile("guarded.txt"), "newer");
}
