/** Execute MCP response shapes; Computer filesystem coverage lives in workerd. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runtimePackage = JSON.parse(
	await readFile(join(import.meta.dirname, "../package.json"), "utf8"),
);
assert.equal(
	runtimePackage.dependencies["@cloudflare/shell"],
	undefined,
	"runtime must not depend on the deprecated package",
);

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
