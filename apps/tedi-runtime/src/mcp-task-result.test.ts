import { strict as assert } from "node:assert";
import {
	MESSAGES_SEND_TASK_ADAPTER,
	nativeDirectTediTaskResult,
	nativeTediTaskResult,
} from "./mcp-task-result";

const META_TASKS = {
	"io.modelcontextprotocol/clientCapabilities": {
		extensions: { "io.modelcontextprotocol/tasks": {} },
	},
};

// Pending durable turn + tasks-capable caller → protocol-native task envelope.
const task = nativeDirectTediTaskResult(
	{ pending: true, run_id: "run-direct-1" },
	META_TASKS,
);
assert.ok(task);
assert.equal(task?.resultType, "task");
assert.equal(task?.taskId, "run-direct-1");
assert.equal(task?.status, "working");
assert.equal(task?.pollIntervalMs, 2_500);
assert.equal(task?.ttlMs, null);

// Caller that did not declare the tasks extension → no task escalation.
assert.equal(
	nativeDirectTediTaskResult({ pending: true, run_id: "run-direct-1" }, {}),
	null,
);

// Synchronous reply (not pending) → no task, even for a tasks-capable caller.
assert.equal(
	nativeDirectTediTaskResult({ pending: false, reply: "hi" }, META_TASKS),
	null,
);

// Generalized builder: the run_tedi_turn adapter matches the wrapper exactly.
const viaAdapter = nativeTediTaskResult(
	{ pending: true, run_id: "run-direct-2" },
	META_TASKS,
	MESSAGES_SEND_TASK_ADAPTER,
);
assert.ok(viaAdapter);
assert.equal(viaAdapter?.taskId, "run-direct-2");
assert.equal(viaAdapter?.pollIntervalMs, 2_500);

// Generalized builder: a custom per-tool adapter maps its own pending flag +
// id field, and may override the poll cadence.
const CUSTOM_ADAPTER = {
	pendingFlagField: "in_flight",
	idField: "job_run_id",
	pollIntervalMs: 5_000,
};
const customTask = nativeTediTaskResult(
	{ in_flight: true, job_run_id: "run-custom-1" },
	META_TASKS,
	CUSTOM_ADAPTER,
);
assert.ok(customTask);
assert.equal(customTask?.resultType, "task");
assert.equal(customTask?.taskId, "run-custom-1");
assert.equal(customTask?.status, "working");
assert.equal(customTask?.pollIntervalMs, 5_000);
assert.equal(customTask?.ttlMs, null);

// Custom adapter, pending flag absent/false → null.
assert.equal(
	nativeTediTaskResult(
		{ in_flight: false, job_run_id: "run-custom-1" },
		META_TASKS,
		CUSTOM_ADAPTER,
	),
	null,
);

// Custom adapter, pending but id missing or non-string → null (an envelope
// without a pollable id must never be emitted).
assert.equal(
	nativeTediTaskResult({ in_flight: true }, META_TASKS, CUSTOM_ADAPTER),
	null,
);
assert.equal(
	nativeTediTaskResult(
		{ in_flight: true, job_run_id: "" },
		META_TASKS,
		CUSTOM_ADAPTER,
	),
	null,
);
assert.equal(
	nativeTediTaskResult(
		{ in_flight: true, job_run_id: 42 },
		META_TASKS,
		CUSTOM_ADAPTER,
	),
	null,
);

// Custom adapter, non-declaring caller → null.
assert.equal(
	nativeTediTaskResult(
		{ in_flight: true, job_run_id: "run-custom-1" },
		{},
		CUSTOM_ADAPTER,
	),
	null,
);

// Non-record results never escalate.
assert.equal(nativeTediTaskResult(null, META_TASKS, CUSTOM_ADAPTER), null);
assert.equal(nativeTediTaskResult("pending", META_TASKS, CUSTOM_ADAPTER), null);
assert.equal(nativeTediTaskResult([], META_TASKS, CUSTOM_ADAPTER), null);

console.log("Direct tedi MCP native task result tests passed.");

assert.equal(
	nativeDirectTediTaskResult(
		{ pending: true, run_id: "ephemeral", session_key: "__test:temporary" },
		META_TASKS,
	),
	null,
	"ephemeral runs have no ledger-backed task",
);
