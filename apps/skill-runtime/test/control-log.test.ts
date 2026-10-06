import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	describeEvidenceFailure,
	logControlFailure,
	logEvidenceFailure,
	logEvidenceJudgeSummary,
	logFactoryEvidenceRetry,
	logFactoryFailure,
	logRuntimeFailure,
	logSkillRuntimeWarning,
} from "../src/control-log";

test("runtime warnings retain only fixed events, bounded counts and cause types", () => {
	const original = console.warn;
	const logs: unknown[] = [];
	console.warn = (...values: unknown[]) => logs.push(...values);
	try {
		logSkillRuntimeWarning("reason.exchange_seal_failed", {
			runId: "run-123",
			caught: new TypeError("Bearer private-token /secret/path", {
				cause: new RangeError("private provider response"),
			}),
		});
		logSkillRuntimeWarning("evidence.judge_span_rejected", {
			runId: "run-123",
			spanRejected: 2,
			resolved: 3,
		});
	} finally {
		console.warn = original;
	}
	assert.deepEqual(logs, [
		{
			component: "skill-runtime.warning",
			service: "skill-runtime",
			event: "reason.exchange_seal_failed",
			runId: "run-123",
			failure: { name: "TypeError", cause: { name: "RangeError" } },
			message: "Skill runtime diagnostic",
		},
		{
			component: "skill-runtime.warning",
			service: "skill-runtime",
			event: "evidence.judge_span_rejected",
			runId: "run-123",
			spanRejected: 2,
			resolved: 3,
			message: "Skill runtime diagnostic",
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(logs),
		/private|token|\/secret\/path|stack/i,
	);
});

test("evidence diagnostics preserve cause topology and judge counts without source content", () => {
	const originalWarn = console.warn;
	const originalError = console.error;
	const originalInfo = console.info;
	const warnings: unknown[] = [];
	const errors: unknown[] = [];
	const infos: unknown[] = [];
	console.warn = (...values: unknown[]) => warnings.push(...values);
	console.error = (...values: unknown[]) => errors.push(...values);
	console.info = (...values: unknown[]) => infos.push(...values);
	try {
		const failure = new TypeError(
			"provider-token-secret https://private.example",
			{
				cause: new RangeError("claim-secret evidence/judge/private-path"),
			},
		);
		logEvidenceFailure("evidence.scrape_failed", failure, "run-123");
		logEvidenceFailure(
			"evidence.judge_exchange_seal_failed",
			failure,
			"run-123",
		);
		const stats = {
			requested: 2,
			resolved: 0,
			recoveredByRetry: 0,
			recoveredByItemFallback: 0,
			unavailable: 2,
			spanRejected: 0,
			spanRepaired: 0,
		};
		const context = {
			runId: "run-123",
			judge: "cto.run_tedi_turn",
			promptVersion: "v2-span",
			stats,
			failures: [describeEvidenceFailure(failure)],
		};
		logEvidenceJudgeSummary("evidence.entailment_judge_dead", context);
		logEvidenceJudgeSummary("evidence.calibrated", context);
	} finally {
		console.warn = originalWarn;
		console.error = originalError;
		console.info = originalInfo;
	}
	assert.equal(warnings.length, 2);
	assert.equal(errors.length, 1);
	assert.equal(infos.length, 1);
	for (const entry of [...warnings, ...errors, ...infos]) {
		assert.equal(
			(entry as { component: string }).component,
			"skill-runtime.evidence",
		);
		assert.equal((entry as { service: string }).service, "skill-runtime");
		assert.equal((entry as { runId: string }).runId, "run-123");
	}
	assert.deepEqual((warnings[0] as { failure: unknown }).failure, {
		name: "TypeError",
		cause: { name: "RangeError" },
	});
	assert.deepEqual((errors[0] as { failures: unknown }).failures, [
		{ name: "TypeError", cause: { name: "RangeError" } },
	]);
	assert.equal((errors[0] as { requested: number }).requested, 2);
	assert.equal((errors[0] as { unavailable: number }).unavailable, 2);
	assert.equal(
		(errors[0] as { event: string }).event,
		"evidence.entailment_judge_dead",
	);
	assert.equal((infos[0] as { event: string }).event, "evidence.calibrated");
	assert.doesNotMatch(
		JSON.stringify({ warnings, errors, infos }),
		/secret|private|stack|url|path/i,
	);
});

test("control diagnostics retain cause types without message or payload content", () => {
	const original = console.error;
	const logs: unknown[] = [];
	console.error = (...values: unknown[]) => logs.push(...values);
	try {
		logControlFailure(
			"event",
			new TypeError("payload-secret", {
				cause: new RangeError("credential-secret"),
			}),
			"run-123",
		);
	} finally {
		console.error = original;
	}
	assert.deepEqual(logs, [
		{
			component: "skill-runtime.control",
			event: "workflow.event.failed",
			runId: "run-123",
			failure: { name: "TypeError", cause: { name: "RangeError" } },
			message: "Workflow event failed",
		},
	]);
	assert.doesNotMatch(JSON.stringify(logs), /secret|stack/i);
});

test("control diagnostics reject an untrusted exception name", () => {
	const original = console.error;
	const logs: unknown[] = [];
	console.error = (...values: unknown[]) => logs.push(...values);
	try {
		const error = new Error("credential-secret");
		error.name = "credential-secret";
		logControlFailure("approve", error);
	} finally {
		console.error = original;
	}
	assert.deepEqual(logs, [
		{
			component: "skill-runtime.control",
			event: "workflow.approve.failed",
			failure: { name: "Error" },
			message: "Workflow approve failed",
		},
	]);
	assert.doesNotMatch(JSON.stringify(logs), /secret|stack/i);
});

test("runtime failure diagnostics retain topology without provider content", () => {
	const original = console.error;
	const logs: unknown[] = [];
	console.error = (...values: unknown[]) => logs.push(...values);
	try {
		logRuntimeFailure(
			"workflow.reconciliation_row.failed",
			new AggregateError(
				[new TypeError("provider-token-secret")],
				"request-payload-secret",
			),
			"run-123",
		);
	} finally {
		console.error = original;
	}
	assert.deepEqual(logs, [
		{
			component: "skill-runtime.control",
			event: "workflow.reconciliation_row.failed",
			runId: "run-123",
			failure: {
				name: "AggregateError",
				errors: [{ name: "TypeError" }],
			},
			message: "Workflow runtime operation failed",
		},
	]);
	assert.doesNotMatch(JSON.stringify(logs), /secret|stack/i);
});

test("factory retries and terminal failures retain context without exception content", () => {
	const originalWarn = console.warn;
	const originalError = console.error;
	const warnings: unknown[] = [];
	const errors: unknown[] = [];
	console.warn = (...values: unknown[]) => warnings.push(...values);
	console.error = (...values: unknown[]) => errors.push(...values);
	try {
		const failure = new TypeError("skill-source-secret", {
			cause: new RangeError("provider-token-secret"),
		});
		for (const kind of ["started", "failed"] as const) {
			logFactoryEvidenceRetry(kind, failure, {
				runId: "run-123",
				executionEpoch: 2,
				attempt: 3,
			});
		}
		logFactoryFailure(failure, "run-123");
	} finally {
		console.warn = originalWarn;
		console.error = originalError;
	}
	for (const [index, kind] of (["started", "failed"] as const).entries()) {
		assert.deepEqual(warnings[index], {
			component: "skill-runtime.factory",
			service: "skill-runtime",
			event: "factory.evidence_retry",
			kind,
			runId: "run-123",
			executionEpoch: 2,
			attempt: 3,
			failure: { name: "TypeError", cause: { name: "RangeError" } },
			message: "Workflow evidence retry",
		});
	}
	assert.deepEqual(errors, [
		{
			component: "skill-runtime.factory",
			service: "skill-runtime",
			event: "factory.failed",
			runId: "run-123",
			failure: { name: "TypeError", cause: { name: "RangeError" } },
			message: "Workflow factory failed",
		},
	]);
	assert.doesNotMatch(JSON.stringify({ warnings, errors }), /secret|stack/i);
});
