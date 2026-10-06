import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { tool } from "ai";
import { redactValue } from "@tedix/context-core/trace-safety";
import { computerExecutionModelOutput } from "./computer-execution-model-output";
import { z } from "zod";
import {
	ComputerEnvironmentController,
	createComputerEnvironmentTools,
} from "./computer-environment";
import {
	NativeToolHookCalls,
	NativeToolLedger,
	isMcpRuntimeLedgeredTool,
	nativeToolOutcome,
	nativeExecutionResultPreview,
} from "./native-tool-ledger";

// --- A real Computer `exec` tool over a mocked workstation client ---------

const values = new Map<string, unknown>();
const store = {
	delete: async (key: string) => values.delete(key),
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async <T>(key: string, value: T) => {
		values.set(key, value);
	},
};
const startedCommands: string[] = [];
let workstationReceipt: Record<string, unknown> = {
	ok: true,
	terminal: true,
	exitCode: 2,
	stdoutTail: "",
	stderrTail: "3 tests failed",
};
const workstation = {
	close: async () => ({ ok: true }),
	open: async () => ({ ok: true, leaseId: "lease-1" }),
	status: async () => ({
		ok: true,
		readiness: { toolsReady: true, repoReady: true },
		repoSync: { workdir: "/home/tedi/workstation/repo" },
	}),
	files: async () => ({ ok: true }),
	start: async (_environment: unknown, input: { command: string }) => {
		startedCommands.push(input.command);
		return { ok: true };
	},
	read: async () => ({
		ok: true,
		terminal: true,
		exitCode: 2,
		stdoutTail: "",
		stderrTail: "3 tests failed",
	}),
	wait: async () => workstationReceipt,
	cancel: async () => ({ ok: true, terminal: true, canceled: true }),
};
const controller = new ComputerEnvironmentController(
	store,
	"scope-a",
	workstation as never,
);
await controller.open("shell");

const native = {
	exec: tool({
		inputSchema: z.object({ command: z.string() }),
		execute: async () => ({ stdout: "scratch" }),
	}),
};
const published: TediRuntimeEvent[] = [];
const ledger = new NativeToolLedger(async (event) => {
	published.push(event);
});
const context = {
	tediId: "tedi-1",
	runId: "run-1",
	conversationId: "cto:agent:main:main",
};
const tools = createComputerEnvironmentTools(native, controller);

const execInput = {
	command: "bun run test:run",
	env: { API_TOKEN: "sk_live_abcdef123456" },
};
const result = (await ledger.observe(
	context,
	{ name: "exec", callId: "call-1", args: execInput },
	() =>
		tools.exec!.execute!(execInput, {
			toolCallId: "call-1",
			messages: [],
			context: undefined,
		}),
)) as Record<string, unknown>;
assert.equal(result.exitCode, 2);
assert.equal(
	startedCommands.length,
	1,
	"the workstation ran exactly one command",
);
assert.ok(
	startedCommands[0]!.includes("bun run test:run"),
	"the dispatched command reached the workstation client",
);

assert.equal(published.length, 2, "one exec call brackets to two rows");
const [started, completed] = published;
assert.equal(started!.kind, "tool.started");
assert.equal(started!.id, "run-1:native-tool.call-1.started");
assert.equal(started!.runId, "run-1");
assert.equal(started!.conversationId, context.conversationId);
assert.equal(started!.runtime?.backend, "cloudflare-agents");
assert.equal(started!.payload!.name, "exec");
assert.equal(started!.payload!.surface, "native_tool");
const args = started!.payload!.arguments as Record<string, unknown>;
assert.equal(args.command, "bun run test:run", "the command is visible");
assert.equal(
	(args.env as Record<string, string>).API_TOKEN,
	"__TEDIX_REDACTED__",
	"secret-shaped argument values are redacted",
);

assert.equal(completed!.kind, "tool.completed");
assert.equal(completed!.id, "run-1:native-tool.call-1.completed");
assert.ok(completed!.sequence! > started!.sequence!);
assert.equal(completed!.payload!.name, "exec");
assert.equal(completed!.payload!.ok, true);
assert.equal(
	completed!.payload!.exitCode,
	2,
	"exit code sits beside the preview",
);
assert.equal(typeof completed!.payload!.executionId, "string");
assert.equal(typeof completed!.payload!.latencyMs, "number");
assert.ok(
	!("result" in completed!.payload!),
	"native rows carry resultPreview, never `result` (kernel answer fallback)",
);
const preview = completed!.payload!.resultPreview as Record<string, unknown>;
assert.deepEqual(preview.stderr, { text: "3 tests failed", omittedChars: 0 });

// --- read_execution is bracketed too, with a fresh call index ---------------

const readInput = { executionId: String(result.executionId) };
await ledger.observe(
	context,
	{ name: "read_execution", callId: "call-2", args: readInput },
	() =>
		tools.read_execution!.execute!(readInput, {
			toolCallId: "call-2",
			messages: [],
			context: undefined,
		}),
);
assert.equal(published.length, 4);
assert.equal(published[2]!.id, "run-1:native-tool.call-2.started");
assert.equal(published[2]!.payload!.name, "read_execution");
assert.equal(published[3]!.kind, "tool.completed");

// --- A thrown tool becomes tool.failed and still throws ---------------------

await assert.rejects(
	ledger.observe(
		context,
		{ name: "write", callId: "call-3", args: { path: "/workspace/a.txt" } },
		async () => {
			throw new Error("disk full");
		},
	),
	/disk full/,
);
assert.equal(published.at(-1)!.kind, "tool.failed");
assert.equal(published.at(-1)!.payload!.error, "disk full");

// --- Structured failures are `ok: false`, not thrown -----------------------

await ledger.observe(
	context,
	{ name: "exec", callId: "call-4", args: { command: "ls" } },
	async () => ({ ok: false, error: "Execution does not belong" }),
);
assert.equal(published.at(-1)!.kind, "tool.completed");
assert.equal(published.at(-1)!.payload!.ok, false);
assert.equal(published.at(-1)!.payload!.error, "Execution does not belong");

// --- MCP tools and missing turn identity are left alone --------------------

assert.equal(isMcpRuntimeLedgeredTool("tedix_mcp_code"), true);
assert.equal(isMcpRuntimeLedgeredTool("exec"), false);
const before = published.length;
await ledger.observe(
	context,
	{
		name: "tedix_mcp_code",
		callId: "call-5",
		args: { code: "async () => 1" },
	},
	async () => "core ledgers this itself",
);
await ledger.observe(
	null,
	{ name: "exec", callId: "call-6", args: { command: "true" } },
	async () => ({ ok: true }),
);
assert.equal(
	published.length,
	before,
	"no rows for MCP tools or unbound turns",
);

// --- Native tool dispatch can bracket calls without wrapping execute -------

const hookCall = { name: "write", callId: "hook-call", args: { path: "/a" } };
assert.equal(await ledger.started(context, hookCall), true);
await ledger.completed(context, hookCall, { ok: true }, 17);
assert.equal(published.at(-2)!.kind, "tool.started");
assert.equal(published.at(-1)!.kind, "tool.completed");
assert.equal(published.at(-1)!.payload!.latencyMs, 17);
assert.equal(
	await ledger.started(context, {
		name: "tedix_mcp_code",
		callId: "hook-mcp",
		args: {},
	}),
	false,
);

const hookCalls = new NativeToolHookCalls();
hookCalls.begin(context, { ...hookCall, args: { secret: "do-not-retain" } });
hookCalls.begin(
	{ ...context, runId: "run-parallel" },
	{ ...hookCall, args: {}, name: "read", callId: "hook-call" },
);
const parallelCall = hookCalls.take("run-parallel", "hook-call");
assert.equal(parallelCall?.call.name, "read");
assert.ok(
	!("args" in parallelCall!.call),
	"pending state retains no raw input",
);
hookCalls.clearRun(context.runId);
assert.equal(
	hookCalls.take(context.runId, "hook-call"),
	null,
	"terminal cleanup prevents a later turn from consuming a stale call id",
);

// --- The call id keys the row, so a restarted ledger cannot reuse an id ----

await ledger.observe(
	{ ...context, runId: "run-2" },
	{ name: "ls", callId: "call-7", args: { path: "/" } },
	async () => ({ ok: true }),
);
assert.equal(published.at(-2)!.id, "run-2:native-tool.call-7.started");

// A restarted Durable Object builds a new ledger for the SAME run. The old
// per-run counter restarted at 0 here, and every row it wrote from then on was
// dropped by `insertTediRuntimeEvent`'s onConflictDoNothing.
const afterRestart = new NativeToolLedger(async (event) => {
	published.push(event);
});
await afterRestart.observe(
	context,
	{ name: "exec", callId: "call-8", args: { command: "git commit" } },
	async () => ({ ok: true }),
);
assert.equal(
	published.at(-2)!.id,
	"run-1:native-tool.call-8.started",
	"a new ledger instance keys rows by call id, never by a restarted counter",
);
assert.ok(
	published.at(-2)!.sequence! > published[0]!.sequence!,
	"and its sequence resumes above the pre-restart cursor",
);

assert.deepEqual(nativeToolOutcome("plain string"), { ok: true });
assert.deepEqual(nativeToolOutcome({ isError: true, error: "x" }), {
	ok: false,
	error: "x",
});

console.log("Native tool ledger: exec/read_execution/failure/skip cases pass");

// --- Production receipts: domain association and independent serialized space ---

function receiptPreview(value: unknown): Record<string, unknown> {
	const result = nativeExecutionResultPreview(value) as Record<string, unknown>;
	assert.ok(JSON.stringify(result).length <= 1_024);
	return result;
}
function assertStream(
	result: Record<string, unknown>,
	key: string,
	raw: string,
) {
	const text = redactValue(raw) as string;
	const stream = result[key] as Record<string, unknown>;
	assert.ok(stream, `${key} remains independently observable`);
	if (typeof stream.text === "string") {
		assert.equal(stream.text, text);
		assert.equal(stream.omittedChars, 0);
	} else {
		assert.equal(typeof stream.head, "string");
		assert.equal(typeof stream.tail, "string");
		const head = stream.head as string;
		const tail = stream.tail as string;
		assert.ok(head.length > 0 && tail.length > 0);
		assert.ok(text.startsWith(head) && text.endsWith(tail));
		assert.equal(stream.omittedChars, text.length - head.length - tail.length);
		if (stream.omittedChars === 0) assert.equal(head + tail, text);
	}
}
const persistence = {
	artifactWriteStatus: { status: "failed", error: "write-rejected" },
	artifactRowPersistence: { status: "failed", error: "row-rejected" },
	workstationEvidencePersistence: { status: "failed", error: "lease-rejected" },
};
const facts = {
	executionId: "f5eb2105-3b55-4921-94c2-f16a6aa7cc12",
	ok: false,
	found: true,
	status: "failed",
	outcome: "failed",
	observation: "available",
	running: false,
	terminal: true,
	timedOut: false,
	canceled: null,
	exitCode: 1,
};
const retainedRef = "r2://retained/receipt.json";
const ordinary = receiptPreview({
	...persistence,
	executionId: facts.executionId,
	stdout: "O",
	stderr: "E",
	artifactRefs: [retainedRef],
});
for (const key of Object.keys(persistence))
	assert.deepEqual(ordinary[key], persistence[key as keyof typeof persistence]);
assert.deepEqual(ordinary.artifactRefs, [retainedRef]);

for (const length of [0, 1, 72, 73, 100, 144, 145, 239, 240, 241, 2_000]) {
	const stdout = "H".repeat(length);
	const stderr = "T".repeat(length);
	const p = receiptPreview({ ...facts, stdout, stderr });
	assertStream(p, "stdout", stdout);
	assertStream(p, "stderr", stderr);
}
for (const character of ['"', "\\n", "\u0000", "😀"]) {
	const stdout = `OUT_HEAD${character.repeat(200)}OUT_TAIL`;
	const stderr = `ERR_HEAD${character.repeat(400)}ERR_TAIL`;
	const p = receiptPreview({
		...facts,
		...persistence,
		error: "error ".repeat(20),
		artifactRefs: ["r2://a/" + "r".repeat(80), "r2://b/" + "r".repeat(80)],
		stdout,
		stderr,
	});
	assertStream(p, "stdout", stdout);
	assertStream(p, "stderr", stderr);
	for (const key of Object.keys(persistence))
		assert.equal((p[key] as Record<string, unknown>).status, "failed");
	assert.equal(p.running, false);
	assert.equal(p.canceled, null);
	assert.equal(p.exitCode, 1);
	for (const key of ["stdout", "stderr"]) {
		const stream = p[key] as Record<string, string>;
		assert.ok(
			(stream.head as string).includes(
				key === "stdout" ? "OUT_HEAD" : "ERR_HEAD",
			),
		);
		assert.ok(
			(stream.tail as string).includes(
				key === "stdout" ? "OUT_TAIL" : "ERR_TAIL",
			),
		);
	}
}
for (const large of ["stdout", "stderr"]) {
	const small = large === "stdout" ? "stderr" : "stdout";
	const p = receiptPreview({
		...facts,
		[large]: "x".repeat(160_000),
		[small]: "short stream stays whole",
	});
	assertStream(p, large, "x".repeat(160_000));
	assertStream(p, small, "short stream stays whole");
}
const missing = receiptPreview({ stdout: "" });
assert.deepEqual(missing.stdout, { text: "", omittedChars: 0 });
assert.ok(!("stderr" in missing));
const tooManyRefs = receiptPreview({
	stdout: "O",
	stderr: "E",
	artifactRefs: Array.from(
		{ length: 100 },
		() => "r2://retained/" + "r".repeat(3_000),
	),
});
assert.ok((tooManyRefs.omittedFields as string[]).includes("artifactRefs"));
assert.equal(tooManyRefs.incomplete, true);
assert.ok(
	!("artifactRefs" in tooManyRefs),
	"no partial handle masquerades as an actual reference",
);

// Actual controller keeps producer fields while renaming stream tails.
workstationReceipt = {
	...facts,
	...persistence,
	stdoutTail: "OUT_HEAD" + "o".repeat(8_000) + "OUT_TAIL",
	stderrTail: "ERR_HEAD" + "e".repeat(8_000) + "ERR_TAIL",
	artifactRefs: [retainedRef],
	context: { audit: "audit-only".repeat(12_000) },
};
const commandCount = startedCommands.length;
const largeInput = { command: "printf receipt" };
const largeResult = (await ledger.observe(
	context,
	{ name: "exec", callId: "large-receipt", args: largeInput },
	() =>
		tools.exec!.execute!(largeInput, {
			toolCallId: "large-receipt",
			messages: [],
			context: undefined,
		}),
)) as Record<string, unknown>;
assert.equal(startedCommands.length, commandCount + 1);
const largePreview = published.at(-1)!.payload!.resultPreview as Record<
	string,
	unknown
>;
assert.ok(JSON.stringify(largePreview).length <= 1_024);
assertStream(largePreview, "stdout", workstationReceipt.stdoutTail as string);
assertStream(largePreview, "stderr", workstationReceipt.stderrTail as string);
for (const key of Object.keys(persistence))
	assert.equal((largePreview[key] as Record<string, unknown>).status, "failed");
assert.ok(!JSON.stringify(largePreview).includes("audit-only"));
assert.equal(largeResult.context, workstationReceipt.context);
const modelBefore = computerExecutionModelOutput({ output: largeResult });
assert.strictEqual(
	await ledger.observe(
		context,
		{ name: "read_execution", callId: "identity", args: {} },
		async () => largeResult,
	),
	largeResult,
);
assert.deepEqual(
	computerExecutionModelOutput({ output: largeResult }),
	modelBefore,
);

// Shared recognizable secret shapes are redacted before all cuts, not after.
for (const offset of [0, 61, 139, 277, 509]) {
	const secret = "a".repeat(384);
	const stdout = "h".repeat(offset) + " Bearer " + secret + " tail";
	const stderr = "q".repeat(offset) + " sk_" + secret + " tail";
	const p = receiptPreview({
		...facts,
		stdout,
		stderr,
		artifactRefs: ["https://example.invalid/log?token=" + secret],
		artifactWriteStatus: {
			status: "failed",
			credentials: { password: secret },
		},
	});
	assertStream(p, "stdout", stdout);
	assertStream(p, "stderr", stderr);
	assert.ok(!JSON.stringify(p).includes(secret.slice(0, 16)));
}

// Observer property access must not replace the command result with its error.
for (const key of ["stdout", "exitCode", "artifactWriteStatus"]) {
	const raw: Record<string, unknown> = { ...facts, stdout: "O", stderr: "E" };
	Object.defineProperty(raw, key, {
		enumerable: true,
		get() {
			throw new Error("getter failed");
		},
	});
	let calls = 0;
	assert.strictEqual(
		await ledger.observe(
			context,
			{ name: "exec", callId: `getter-${key}`, args: {} },
			async () => {
				calls++;
				return raw;
			},
		),
		raw,
	);
	assert.equal(calls, 1);
	assert.equal(published.at(-1)!.kind, "tool.completed");
	assert.ok(
		!("result" in published.at(-1)!.payload!) &&
			!("data" in published.at(-1)!.payload!),
	);
	assert.ok(
		JSON.stringify(published.at(-1)!.payload!.resultPreview).includes(
			"redactionFailed",
		),
	);
}
const cyclic: Record<string, unknown> = { status: "failed" };
cyclic.self = cyclic;
const cyclePreview = receiptPreview({
	stdout: "O",
	stderr: "E",
	artifactRowPersistence: cyclic,
});
assert.equal(
	(cyclePreview.artifactRowPersistence as Record<string, unknown>).self,
	"__TEDIX_REDACTED__",
);
assert.strictEqual(cyclic.self, cyclic);
const thrown = new Error("original native error");
await assert.rejects(
	ledger.observe(
		context,
		{ name: "exec", callId: "original-throw", args: {} },
		async () => {
			throw thrown;
		},
	),
	(error) => error === thrown,
);
await ledger.observe(
	context,
	{ name: "record_artifact", callId: "artifact-produced", args: {} },
	async () => ({ ok: true, artifactId: "artifact-1" }),
);
assert.deepEqual(published.at(-1)?.payload?.producedArtifactIds, [
	"artifact-1",
]);
await ledger.observe(
	context,
	{ name: "some_provider_tool", callId: "artifact-forged", args: {} },
	async () => ({ ok: true, artifactId: "artifact-2" }),
);
assert.equal(published.at(-1)?.payload?.producedArtifactIds, undefined);
console.log("Native execution receipt production regressions pass");
