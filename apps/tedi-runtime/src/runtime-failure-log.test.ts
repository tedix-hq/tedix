import assert from "node:assert/strict";
import type {
	ReportInfo,
	TaskId,
	ConversationId,
} from "@earendil-works/pi-durable";
import {
	logTediFacetBudgetStop,
	logTediPiReport,
	logTediRuntimeDiagnostic,
	logTediRuntimeFailure,
	logTediRuntimeState,
	runtimeFailureType,
} from "./runtime-failure-log";

const privateText = "prompt memory skill credential and user content";
const failure = Object.assign(
	new Error(privateText, { cause: new TypeError(privateText) }),
	{ retryable: true },
);
failure.name = `Private ${privateText}`;

const warnings: unknown[][] = [];
const errors: unknown[][] = [];
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args: unknown[]) => warnings.push(args);
console.error = (...args: unknown[]) => errors.push(args);
try {
	logTediRuntimeFailure("tedi.runtime.websocket_error", failure);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.runtime.websocket_error",
			retryable: true,
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);

	logTediRuntimeFailure(
		"tedi.facet.conversation_turn_failed",
		new Error(`${privateText}: Legacy assistant has no model content`, {
			cause: new Error(`no such column: ${privateText}`),
		}),
		"error",
	);
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.facet.conversation_turn_failed",
			exception: { type: "Error", cause: { type: "Error" } },
			messageClass: ["Legacy assistant has no model content", "no such column"],
		},
	]);

	const untrustedFlag = Object.assign(new Error(privateText), {
		retryable: privateText,
	});
	logTediRuntimeFailure("tedi.runtime.websocket_error", untrustedFlag);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.runtime.websocket_error",
			exception: { type: "Error" },
		},
	]);
	const hostileFlag = new Error(privateText);
	Object.defineProperty(hostileFlag, "retryable", {
		get: () => {
			throw new Error(privateText);
		},
	});
	logTediRuntimeFailure("tedi.runtime.websocket_error", hostileFlag);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.runtime.websocket_error",
			exception: { type: "Error" },
		},
	]);

	logTediRuntimeFailure(
		"tedi.runtime.accounting_completion_denied",
		failure,
		"error",
	);
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.runtime.accounting_completion_denied",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	logTediRuntimeFailure("tedi.facet.judge_turn_failed", failure, "error");
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.facet.judge_turn_failed",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	assert.equal(runtimeFailureType(failure), "UnknownThrown");
	logTediRuntimeFailure("tedi.workstation.repo_clone_failed", failure);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.workstation.repo_clone_failed",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	logTediRuntimeFailure(
		"tedi.codemode.event_projection_failed",
		failure,
		"error",
	);
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.codemode.event_projection_failed",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	logTediRuntimeState("tedi.computer.wake_context_unavailable", "error");
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.computer.wake_context_unavailable",
		},
	]);
	logTediFacetBudgetStop("sse", "step_ceiling");
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.facet.budget_stopped",
			surface: "sse",
			reason: "step_ceiling",
		},
	]);
	logTediRuntimeDiagnostic("tedi.runtime.turn_mirror_unavailable");
	assert.deepEqual(JSON.parse(warnings.pop()?.[0] as string), {
		_tr: "mirror_skipped",
		component: "tedi-runtime",
		event: "tedi.runtime.turn_mirror_unavailable",
		reason: "no_platform_client",
	});
	logTediRuntimeDiagnostic(
		"tedi.runtime.failed_turn_mirror_unavailable",
		"error",
	);
	assert.deepEqual(JSON.parse(errors.pop()?.[0] as string), {
		_tr: "mirror_skipped",
		component: "tedi-runtime",
		event: "tedi.runtime.failed_turn_mirror_unavailable",
		reason: "no_platform_client",
	});
	const task = {
		id: 41 as TaskId,
		conversationId: 7 as ConversationId,
		kind: privateText,
	};
	const reports: ReportInfo[] = [
		{ type: "session_failed" },
		{ type: "task_faulted", task, reason: "threw", extension: privateText },
		{ type: "task_parked", task, extension: privateText },
		{ type: "migration_failed", task, extension: privateText },
		{ type: "task_outdated", task, reason: "missing_task" },
		{ type: "task_error", task },
		{
			type: "extension_error",
			extension: privateText,
			conversationId: task.conversationId,
		},
		{ type: "host_error", callback: "settings", task },
		{ type: "listener_error" },
	];
	for (const report of reports) {
		logTediPiReport(failure, report);
		const fields = errors.pop()?.[0] as Record<string, unknown>;
		assert.equal(fields.event, "tedi.pi.report");
		assert.equal(fields.reportType, report.type);
		assert.deepEqual(fields.exception, {
			type: "UnknownThrown",
			cause: { type: "TypeError" },
		});
		assert.ok(!JSON.stringify(fields).includes(privateText));
		if ("task" in report && report.task) {
			assert.equal(fields.taskId, task.id);
			assert.equal(fields.conversationId, task.conversationId);
		}
		if ("reason" in report) assert.equal(fields.reason, report.reason);
		if (report.type === "host_error") assert.equal(fields.callback, "settings");
	}
	console.error = () => {
		throw new Error(privateText);
	};
	assert.doesNotThrow(() =>
		logTediPiReport(failure, { type: "session_failed" }),
	);
	const unavailable = warnings.pop();
	assert.ok(JSON.stringify(unavailable).includes("telemetry.write_failed"));
	assert.ok(!JSON.stringify(unavailable).includes(privateText));
	console.error = () => Promise.reject(new Error(privateText));
	logTediPiReport(failure, { type: "listener_error" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(warnings.length, 0);
	assert.equal(errors.length, 0);
} finally {
	console.warn = originalWarn;
	console.error = originalError;
}

console.log(
	"PASS: runtime failure events retain shape without private content",
);
