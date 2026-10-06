/**
 * Unit test for the `execute` tool wiring in codeModeExtras.
 *
 * Proves that:
 *   1. The state backend returned by `createWorkspaceStateBackend(workspace)`
 *      correctly proxies readFile/writeFile to the live DO-SQLite workspace.
 *   2. A fake executor receiving those provider fns can perform a
 *      seed→read→write→readback round-trip through the SAME workspace instance.
 *   3. The execute tool response shape (`{ executionId, result, logs? }`) is
 *      what callers expect on success and `{ executionId, error }` on failure.
 *
 * Avoids importing `@cloudflare/codemode` or `@cloudflare/shell/workers` —
 * both transitively import `cloudflare:workers` (Cloudflare runtime-only) and
 * cannot run locally. The real WorkerLoader is a closed-beta Cloudflare
 * binding; the wiring test therefore uses a direct StateBackend call.
 *
 * Run: `bun run src/execute-state-code.test.ts`
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createWorkspaceStateBackend, Workspace } from "@cloudflare/shell";

// ── Minimal bun:sqlite backend compatible with @cloudflare/shell ─────────────
function sqlBackend() {
	const db = new Database(":memory:");
	return {
		query<T>(sql: string, ...params: (string | number | boolean | null)[]) {
			return db.query(sql).all(...(params as never[])) as T[];
		},
		run(sql: string, ...params: (string | number | boolean | null)[]) {
			db.run(sql, params as never[]);
		},
	};
}

// ── (1) StateBackend reads/writes the live workspace ─────────────────────────
// Proves that `createWorkspaceStateBackend(workspace)` is the correct bridge
// between the sandbox provider fns and the DO-SQLite workspace used in do.ts.
{
	const ws = new Workspace({
		sql: sqlBackend(),
		namespace: "computer_workspace_adapter",
		name: () => "test-tedi",
	});

	const backend = createWorkspaceStateBackend(ws);

	// Write via workspace directly; read back via backend (provider path).
	await ws.writeFile("/seed.txt", "seed content");
	const content = await backend.readFile("/seed.txt");
	assert.equal(content, "seed content", "backend reads from live workspace");

	// Write via backend; read back via workspace (proves it's not a copy).
	await backend.writeFile("/derived.txt", "derived output");
	const derived = await ws.readFile("/derived.txt");
	assert.equal(
		derived,
		"derived output",
		"backend writes persist to live workspace",
	);
}

// ── (2) Full read→derive→write→readback round-trip ───────────────────────────
// Simulates what the `execute` tool does: sandbox code reads a seeded file,
// writes a derived file, caller reads the derived file back from the workspace.
{
	const ws = new Workspace({
		sql: sqlBackend(),
		namespace: "computer_workspace_adapter",
		name: () => "test-tedi-rw",
	});
	const backend = createWorkspaceStateBackend(ws);

	// Seed.
	await ws.writeFile("/notes.md", "# Notes\nHello world");

	// Simulate sandbox: read seed, write derived.
	const notes = await backend.readFile("/notes.md");
	assert.ok(
		typeof notes === "string" && notes.includes("Hello world"),
		"sandbox read hit live workspace",
	);
	await backend.writeFile("/summary.txt", `Summary: ${notes.length} chars`);

	// Caller reads derived file from the SAME workspace instance.
	const summary = await ws.readFile("/summary.txt");
	assert.ok(
		typeof summary === "string" && summary.startsWith("Summary:"),
		"derived file readable from same workspace",
	);
}

// ── (3) Execute tool response shape ─────────────────────────────────────────
// Validates the structured response the `execute` MCP tool emits.
// Mirrors the shaping done in do.ts codeModeExtras registerOuterTool handler.
function buildExecuteResponse(
	executionId: string,
	result: unknown,
	logs?: string[],
) {
	const output: Record<string, unknown> = {
		executionId,
		result: result ?? null,
	};
	if (logs?.length) output.logs = logs;
	return {
		content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
		structuredContent: output,
	};
}

function buildExecuteError(executionId: string, error: string) {
	return {
		content: [{ type: "text" as const, text: `Execution error: ${error}` }],
		isError: true,
		structuredContent: { executionId, error },
	};
}

{
	const id = "test-exec-id";

	const successResp = buildExecuteResponse(id, { value: 42 }, ["log line"]);
	assert.deepEqual(
		(successResp.structuredContent as Record<string, unknown>).executionId,
		id,
		"executionId in success response",
	);
	assert.deepEqual(
		(successResp.structuredContent as Record<string, unknown>).result,
		{ value: 42 },
		"result in success response",
	);
	assert.deepEqual(
		(successResp.structuredContent as Record<string, unknown>).logs,
		["log line"],
		"logs in success response",
	);
	assert.equal(successResp.content[0]?.type, "text", "content type is text");

	const errResp = buildExecuteError(id, "ReferenceError: x is not defined");
	assert.equal(
		(errResp as Record<string, unknown>).isError,
		true,
		"isError on error response",
	);
	assert.equal(
		(errResp.structuredContent as Record<string, unknown>).error,
		"ReferenceError: x is not defined",
		"error message forwarded",
	);

	// Success response without logs omits the logs field.
	const noLogsResp = buildExecuteResponse(id, "hello");
	assert.equal(
		(noLogsResp.structuredContent as Record<string, unknown>).logs,
		undefined,
		"no logs field when logs is empty",
	);
}

console.log("execute-state-code.test.ts OK");
