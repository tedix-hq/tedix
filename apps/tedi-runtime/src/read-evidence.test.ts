import assert from "node:assert/strict";
import { tool } from "ai";
import { z } from "zod";
import {
	ComputerEnvironmentController,
	createComputerEnvironmentTools,
} from "./computer-environment";
import { invalidateReadEvidence, readEvidenceKey } from "./read-evidence";

const values = new Map<string, unknown>();
const store = {
	delete: async (key: string) => values.delete(key),
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async <T>(key: string, value: T) => {
		values.set(key, value);
	},
};
const unusedActions = {
	open: async () => ({ ok: true }),
	close: async () => ({ ok: true }),
	status: async () => ({ ok: true }),
	files: async () => ({ ok: true }),
	start: async () => ({ ok: true }),
	read: async () => ({ ok: true }),
	wait: async () => ({ ok: true }),
	cancel: async () => ({ ok: true }),
};

const reads: string[] = [];
const writes: string[] = [];
const native = {
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async ({ path }: { path: string }) => {
			reads.push(path);
			return { content: "the exact bytes the model believes it knows" };
		},
	}),
	write: tool({
		inputSchema: z.object({ path: z.string(), content: z.string() }),
		execute: async ({ path }: { path: string }) => {
			writes.push(path);
			return { ok: true };
		},
	}),
	edit: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async ({ path }: { path: string }) => {
			writes.push(path);
			return { ok: true };
		},
	}),
};

const controller = new ComputerEnvironmentController(
	store,
	"read-evidence-scope",
	unusedActions,
	async () => {},
);
const tools = createComputerEnvironmentTools(native, controller);

const options = (toolCallId: string) =>
	({ toolCallId, messages: [], context: undefined }) as never;
const call = async (name: "read" | "write" | "edit", path: string) =>
	(await tools[name]!.execute!(
		{ path, content: "next" } as never,
		options(name),
	)) as Record<string, unknown>;

// ── The hole: a write after compaction to a file whose read evidence was
// summarized away must be refused until the model reads the file again.

await call("read", "/workspace/repo/a.ts");
assert.deepEqual(reads, ["/workspace/repo/a.ts"]);

// Read evidence is live: the write goes through untouched.
assert.equal((await call("write", "/workspace/repo/a.ts")).ok, true);
assert.deepEqual(writes, ["/workspace/repo/a.ts"]);

// A compaction summarized that read away.
invalidateReadEvidence();

const refused = await call("write", "/workspace/repo/a.ts");
assert.equal(
	refused.ok,
	false,
	"a write after compaction must not run on read evidence that was summarized away",
);
assert.match(
	String(refused.error),
	/read/i,
	"the refusal must tell the model to read the file again",
);
assert.deepEqual(
	writes,
	["/workspace/repo/a.ts"],
	"the refused write must never reach the filesystem",
);

const refusedEdit = await call("edit", "/workspace/repo/a.ts");
assert.equal(refusedEdit.ok, false, "edit is gated exactly like write");

// A file the model never read is not gated: this fix invalidates evidence, it
// does not introduce a blanket read-before-write regime.
assert.equal((await call("write", "/workspace/repo/new.ts")).ok, true);

// A fresh read restores the evidence and the write proceeds.
await call("read", "/workspace/repo/a.ts");
assert.equal((await call("write", "/workspace/repo/a.ts")).ok, true);
assert.deepEqual(writes, [
	"/workspace/repo/a.ts",
	"/workspace/repo/new.ts",
	"/workspace/repo/a.ts",
]);

// Evidence is scope-keyed: another conversation's read licenses nothing here.
const other = createComputerEnvironmentTools(
	native,
	new ComputerEnvironmentController(
		store,
		"other-scope",
		unusedActions,
		async () => {},
	),
);
invalidateReadEvidence();
await other.read!.execute!(
	{ path: "/workspace/repo/a.ts" } as never,
	options("x"),
);
assert.equal(
	(await call("write", "/workspace/repo/a.ts")).ok,
	false,
	"read evidence never crosses a computer scope",
);

// ── Path resolution: a relative tool path resolves against the computer cwd,
// so "a.ts" read in /w and "/w/a.ts" written are the same evidence.
assert.equal(readEvidenceKey("/w", "a.ts"), "/w/a.ts");
assert.equal(readEvidenceKey("/w", "./sub/../a.ts"), "/w/a.ts");
assert.equal(readEvidenceKey("/w", "/other/a.ts"), "/other/a.ts");
assert.equal(readEvidenceKey(undefined, "a.ts"), "a.ts");

console.log(
	"read-evidence OK (compaction invalidates evidence; stale writes are refused)",
);
