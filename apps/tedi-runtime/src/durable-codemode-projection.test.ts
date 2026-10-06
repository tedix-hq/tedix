import assert from "node:assert/strict";
import type { ProxyToolOutput, ToolLogEntry } from "@cloudflare/codemode";
import type { TruncatedCodeModeResult } from "@tedix/tedi-codemode-core/bounded-result";
import { TEDIX_REDACTED } from "@tedix/context-core/trace-safety";
import {
	projectDurableCodemodeCalls,
	projectDurableCodemodeOutput,
} from "./durable-codemode-projection";

function call(
	seq: number,
	overrides: Partial<ToolLogEntry> = {},
): ToolLogEntry {
	return {
		seq,
		connector: "mcp",
		method: "call_tool",
		args: { query: "safe" },
		requiresApproval: false,
		state: "applied",
		...overrides,
	};
}

const completed = projectDurableCodemodeOutput({
	status: "completed",
	executionId: "exec-1",
	result: { ok: true, token: "output-secret" },
	logs: ["Authorization: Bearer visible-token"],
	calls: [
		call(0, {
			args: { password: "super-secret", note: "Bearer visible-token" },
			result: { apiKey: "sk_live_FAKE_EXAMPLE" },
		}),
	],
});
assert.equal(completed.status, "completed");
if (completed.status !== "completed")
	throw new Error("expected completed output");
const completedCall = completed.calls?.[0];
if (!completedCall) throw new Error("expected a projected completed call");
assert.equal(completedCall.args instanceof Object, true);
assert.equal(
	(completedCall.args as { password: string }).password,
	TEDIX_REDACTED,
);
assert.equal(
	(completedCall.result as { apiKey: string }).apiKey,
	TEDIX_REDACTED,
);
assert.ok(completed.logs?.[0]?.includes(TEDIX_REDACTED));
assert.equal((completed.result as { token: string }).token, TEDIX_REDACTED);
assert.ok(!JSON.stringify(completed).includes("visible-token"));
assert.ok(!JSON.stringify(completed).includes("output-secret"));

const canonicalTruncation: TruncatedCodeModeResult = {
	__tedix_truncated: true,
	marker: "--- TRUNCATED ---",
	originalType: "object",
	approxTokens: 50_000,
	maxTokens: 6_000,
	guidance: "Narrow the projection or paginate.",
	preview: 'password="super-secret-value" ' + "x".repeat(24_000),
};
const projectedTruncation = projectDurableCodemodeOutput({
	status: "completed",
	executionId: "exec-truncated",
	result: canonicalTruncation,
});
if (projectedTruncation.status !== "completed")
	throw new Error("expected completed truncated output");
const truncatedResult = projectedTruncation.result as TruncatedCodeModeResult;
assert.equal(truncatedResult.__tedix_truncated, true);
assert.equal(truncatedResult.marker, canonicalTruncation.marker);
assert.equal(truncatedResult.originalType, canonicalTruncation.originalType);
assert.equal(truncatedResult.approxTokens, canonicalTruncation.approxTokens);
assert.equal(truncatedResult.maxTokens, canonicalTruncation.maxTokens);
assert.equal(truncatedResult.guidance, canonicalTruncation.guidance);
assert.ok(truncatedResult.preview.length <= 16_000);
assert.ok(!truncatedResult.preview.includes("super-secret-value"));
assert.ok(truncatedResult.preview.includes(TEDIX_REDACTED));
assert.ok(canonicalTruncation.preview.length > 24_000);

const paused = projectDurableCodemodeOutput({
	status: "paused",
	executionId: "exec-2",
	pending: [
		{
			executionId: "exec-2",
			seq: 1,
			connector: "workspace",
			method: "write_file",
			args: { token: "must-not-leak" },
		},
	],
	calls: [call(1, { args: { authorization: "Bearer must-not-leak" } })],
});
assert.equal(paused.status, "paused");
if (paused.status !== "paused") throw new Error("expected paused output");
const pendingApproval = paused.pending[0];
if (!pendingApproval) throw new Error("expected a projected pending approval");
assert.equal((pendingApproval.args as { token: string }).token, TEDIX_REDACTED);
assert.ok(!JSON.stringify(paused).includes("must-not-leak"));

const oversized = projectDurableCodemodeCalls(
	Array.from({ length: 30 }, (_, seq) =>
		call(seq, { result: { value: "x".repeat(10_000) } }),
	),
);
assert.equal(oversized.calls.length, 20);
assert.equal(oversized.omitted, 10);
assert.deepEqual(
	oversized.calls.map((entry) => entry.seq),
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
);
const firstOversizedCall = oversized.calls[0];
if (!firstOversizedCall) throw new Error("expected bounded projected calls");
assert.equal(
	(firstOversizedCall.result as { truncated: boolean }).truncated,
	true,
);

const poison = Object.defineProperty({}, "secret", {
	enumerable: true,
	get() {
		throw new Error("raw-poison-value");
	},
});
const failedClosed = projectDurableCodemodeCalls([call(0, { args: poison })]);
assert.deepEqual(failedClosed.calls[0]?.args, {
	redactionFailed: true,
	value: TEDIX_REDACTED,
});
assert.ok(!JSON.stringify(failedClosed).includes("raw-poison-value"));

const error = projectDurableCodemodeOutput({
	status: "error",
	executionId: "exec-3",
	error: "request failed with Bearer error-token",
} satisfies ProxyToolOutput);
assert.ok(error.status === "error" && error.error.includes(TEDIX_REDACTED));

console.log("durable-codemode-projection.test.ts: all assertions passed");
