import assert from "node:assert/strict";
import { asSchema } from "ai";
import {
	COMPUTER_ISOLATE_BACKEND_ID,
	createTediComputerTools,
} from "./workspace-fs";

const execCalls: Array<{
	command: string;
	options: {
		backend?: string;
		cwd?: string;
		encoding: "utf8";
		env?: Record<string, string>;
		input?: unknown;
	};
}> = [];
let disposedExecutions = 0;
const workspace = {
	fs: {
		async mkdir() {},
		async find() {
			return [];
		},
		async grep() {
			return [];
		},
		async readFile() {
			return new ReadableStream<Uint8Array>();
		},
		async readdir() {
			return [];
		},
		async rm() {},
		async stat() {
			return {
				isDirectory: false,
				isFile: true,
				mode: 0o100644,
				mtime: 0,
				size: 0,
			};
		},
		async writeFile() {},
	},
	runtime: {
		async exec(
			command: string,
			options: {
				backend?: string;
				cwd?: string;
				encoding: "utf8";
				env?: Record<string, string>;
				input?: unknown;
			},
		) {
			execCalls.push({ command, options });
			return {
				[Symbol.dispose]() {
					disposedExecutions++;
				},
				async result() {
					return { exitCode: 0, stderr: "", stdout: "computer-ok\n" };
				},
			};
		},
	},
};

const tools = createTediComputerTools(workspace as never);
assert.deepEqual(
	Object.keys(tools).sort(),
	["delete", "edit", "exec", "find", "grep", "ls", "read", "write"],
	"Computer exposes the governed workspace tool vocabulary",
);

const exec = tools.exec as unknown as {
	execute: (
		input: { command: string; cwd?: string },
		options: unknown,
	) => Promise<Record<string, unknown>>;
};
const result = await exec.execute(
	{ command: "find /workspace -type f", cwd: "/workspace" },
	{},
);
assert.deepEqual(execCalls, [
	{
		command: "find /workspace -type f",
		options: {
			backend: COMPUTER_ISOLATE_BACKEND_ID,
			cwd: "/workspace",
			encoding: "utf8",
			env: undefined,
			input: undefined,
		},
	},
]);
assert.equal(result?.backend, COMPUTER_ISOLATE_BACKEND_ID);
assert.equal(result?.stdout, "computer-ok\n");
assert.deepEqual(structuredClone(result), result);
assert.equal(
	typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator],
	"undefined",
	"exec must return a structured-cloneable terminal result across facets",
);

assert.match(
	String((tools.exec as { description?: string }).description),
	/no network access/,
	"the Computer exec contract must not advertise an unbundled network shell",
);

const quotedCommand = "printf '%s\\n' 'example; curl is a command name'";
await exec.execute({ command: quotedCommand, cwd: "/workspace" }, {});
assert.equal(
	execCalls.at(-1)?.command,
	quotedCommand,
	"the native shell parses quoted text; tool adapters must not scan it as command syntax",
);
assert.doesNotMatch(
	String(tools.exec?.description),
	/multiple backends|npm test|retry.*backend/i,
);

console.log("computer-workspace-tools OK (native tools + isolate routing)");

assert.equal(
	disposedExecutions,
	execCalls.length,
	"every native exec handle must be released after its terminal result",
);

// Concurrent calls own different handles; releasing one must never dispose another.
const firstGate = Promise.withResolvers<void>();
const secondGate = Promise.withResolvers<void>();
const bothStarted = Promise.withResolvers<void>();
const disposedCommands: string[] = [];
let startedExecutions = 0;
const concurrentTools = createTediComputerTools({
	...workspace,
	runtime: {
		async exec(command: string) {
			if (++startedExecutions === 2) bothStarted.resolve();
			return {
				[Symbol.dispose]() {
					assert.ok(
						!disposedCommands.includes(command),
						"dispose once per execution",
					);
					disposedCommands.push(command);
				},
				async result() {
					await (command === "first" ? firstGate.promise : secondGate.promise);
					if (command === "first") throw new Error("script failed");
					return { exitCode: 0, stdout: command, stderr: "" };
				},
			};
		},
	},
} as never);
const concurrentExec = concurrentTools.exec as typeof exec;
const first = concurrentExec.execute({ command: "first" }, {});
const second = concurrentExec.execute({ command: "second" }, {});
await bothStarted.promise;
secondGate.resolve();
assert.equal((await second).stdout, "second");
assert.deepEqual(disposedCommands, ["second"]);
firstGate.resolve();
assert.match(String((await first).error), /script failed/);
assert.deepEqual(disposedCommands, ["second", "first"]);

const execSchema = await asSchema(tools.exec!.inputSchema).jsonSchema;
assert.deepEqual(Object.keys(execSchema.properties ?? {}).sort(), [
	"command",
	"cwd",
	"env",
]);
assert.doesNotMatch(
	JSON.stringify(execSchema),
	/npm test|callable|different backend/i,
);
