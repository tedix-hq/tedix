/**
 * Unit coverage for the pure ChatTurnWorkflow step orchestration — in
 * particular the TERMINAL NOTIFY CONTRACT: the Agents SDK only auto-reports
 * ERRORS back to the Agent, so a settled turn MUST durably call
 * `step.reportComplete(result)` or `onWorkflowComplete` never fires on the DO.
 *
 * Without it, cognitive-cron fires stamped `running` in `tedi_cron_executions`
 * stay `lastSuccess: null` forever — the seal lives in `onWorkflowComplete`,
 * which the SDK never invokes unless the workflow reports completion. The fake
 * ledger below models exactly that DO-side seal.
 *
 * Run: `bun run src/chat-turn-steps.test.ts`.
 */
import assert from "node:assert/strict";
import {
	type ChatTurnStepRunner,
	driveChatTurnSteps,
	IDEMPOTENT_STEP_RETRY,
} from "./chat-turn-steps";
import { buildCronExecutionStart, summarizeCronTurnTransitions } from "./cron";

// A fake cron-execution ledger row + the DO-side hooks, modeling production:
// onCronFire opens `running`; onWorkflowComplete (invoked ONLY via the
// workflow's completion report) seals `success`.
interface FakeLedgerRow {
	status: "running" | "success" | "failure";
	transitions: Record<string, unknown> | null;
}

function makeHarness() {
	const ledger = new Map<string, FakeLedgerRow>();
	const stepNames: string[] = [];
	const completionReports: unknown[] = [];

	// onCronFire equivalent: the start stamp (this part worked in production).
	const fireKey = "cron:sched-1:1900000000";
	const stamp = buildCronExecutionStart(
		{ name: "objective-review" },
		fireKey,
		"tedi-1:cron:cron_sched-1_1900000000",
		1_900_000_000_000,
	);
	assert.ok(stamp, "named cron fire opens a start stamp");
	ledger.set(fireKey, { status: "running", transitions: null });

	// onWorkflowComplete equivalent: seals the SAME row — reachable only
	// through the workflow's completion report (the SDK contract).
	const onWorkflowComplete = (result: unknown) => {
		completionReports.push(result);
		const row = ledger.get(fireKey);
		assert.ok(row, "seal targets the running row opened at dispatch");
		row.status = "success";
		row.transitions = summarizeCronTurnTransitions(result);
	};

	const step: ChatTurnStepRunner = {
		sleep: async () => {
			throw new Error("Ordinary settled turns do not sleep");
		},
		do: async (name, config, callback) => {
			stepNames.push(name);
			assert.deepEqual(
				config,
				IDEMPOTENT_STEP_RETRY,
				`step ${name} keeps the explicit idempotent retry budget`,
			);
			return callback();
		},
		reportComplete: async (result) => {
			onWorkflowComplete(result);
		},
	};

	return { ledger, fireKey, step, stepNames, completionReports };
}

// ── A SETTLED turn must seal the running row ─────────────────────────────────
{
	const h = makeHarness();
	const result = await driveChatTurnSteps(h.step, {
		markStarted: async () => {},
		runFacetTurn: async () =>
			JSON.stringify({ text: "cycle done", stopReason: "end_turn" }),
	});

	assert.deepEqual(
		h.stepNames,
		["mark-workflow-started", "facet-turn"],
		"durable step names are part of the resume contract and must not change",
	);
	assert.deepEqual(result, {
		text: "cycle done",
		stopReason: "end_turn",
		toolCalls: [],
	});

	// The gap: without a durable completion report the DO's onWorkflowComplete
	// never runs and the ledger row stays `running` forever (production showed
	// lastSuccess: null 90+ minutes after the fire).
	assert.equal(
		h.completionReports.length,
		1,
		"a settled turn reports completion to the Agent exactly once (SDK only auto-reports errors)",
	);
	assert.deepEqual(
		h.completionReports[0],
		result,
		"the completion report carries the settled result (the seal's transitions source)",
	);
	assert.equal(
		h.ledger.get(h.fireKey)?.status,
		"success",
		"the running cron-execution row is sealed success after settlement",
	);
	assert.deepEqual(
		h.ledger.get(h.fireKey)?.transitions,
		{ stopReason: "end_turn", responseChars: 10, toolCalls: [] },
		"the seal records the mechanical transitions summary",
	);
	console.log("PASS: settled turn seals the running cron execution");
}

// ── Facet tool outcomes are part of the durable completion report ------------
{
	const h = makeHarness();
	const result = await driveChatTurnSteps(h.step, {
		markStarted: async () => {},
		runFacetTurn: async () =>
			JSON.stringify({
				text: "grounded cycle",
				stopReason: "stop",
				toolCalls: [
					{ name: "tedix_mcp_code", ok: true },
					{ name: "browser_execute", ok: false },
					{ ignored: true },
				],
			}),
	});
	assert.deepEqual(result.toolCalls, [
		{ name: "tedix_mcp_code", ok: true },
		{ name: "browser_execute", ok: false },
	]);
	assert.deepEqual(h.ledger.get(h.fireKey)?.transitions, {
		stopReason: "stop",
		responseChars: 14,
		toolCalls: [
			{ name: "tedix_mcp_code", ok: true },
			{ name: "browser_execute", ok: false },
		],
	});
}

// ── Error path: NO completion report — the SDK auto-reports the error and the
// failure seal belongs to onWorkflowError → mirrorWorkflowFailure ────────────
{
	const h = makeHarness();
	await assert.rejects(
		driveChatTurnSteps(h.step, {
			markStarted: async () => {},
			runFacetTurn: async () => {
				throw new Error("facet turn exhausted retries");
			},
		}),
		/facet turn exhausted retries/,
		"a failed turn propagates so the SDK error auto-report fires",
	);
	assert.equal(
		h.completionReports.length,
		0,
		"a failed turn must NOT report completion (failure seal is onWorkflowError's)",
	);
	assert.equal(
		h.ledger.get(h.fireKey)?.status,
		"running",
		"row untouched here — mirrorWorkflowFailure seals failure on the DO",
	);
	console.log("PASS: failed turn does not report completion");
}

// ── Cancel-before-admission: durable tombstone wins before facet execution ──
{
	const h = makeHarness();
	let facetRan = false;
	const result = await driveChatTurnSteps(h.step, {
		markStarted: async () => false,
		runFacetTurn: async () => {
			facetRan = true;
			return JSON.stringify({ text: "must not run", stopReason: "stop" });
		},
	});
	assert.equal(
		facetRan,
		false,
		"a canceled workflow never enters the facet turn",
	);
	assert.deepEqual(h.stepNames, ["mark-workflow-started"]);
	assert.deepEqual(result, {
		text: "",
		stopReason: "canceled",
		toolCalls: [],
	});
	assert.deepEqual(
		h.completionReports,
		[result],
		"cancellation settles the native workflow without retries or a false failure",
	);
	console.log("PASS: cancellation tombstone fences workflow admission");
}

// ── Budget stop: terminal report, but typed for Agent-side failure settlement ─
{
	const h = makeHarness();
	const error =
		"Inference daily budget exhausted for 2026-07-22 (900000/1000000 tokens)";
	const result = await driveChatTurnSteps(h.step, {
		markStarted: async () => {},
		runFacetTurn: async () =>
			JSON.stringify({ text: "", stopReason: "budget_exhausted", error }),
	});
	assert.deepEqual(result, {
		text: "",
		stopReason: "budget_exhausted",
		error,
		toolCalls: [],
	});
	assert.equal(
		h.completionReports.length,
		1,
		"a deterministic budget stop completes the native Workflow without transient retries",
	);
	console.log("PASS: budget stop reports typed terminal result");
}

// ── Billing policy stop: preserve the denial code for Agent-side settlement ──
{
	const h = makeHarness();
	const error = "Inference blocked by billing policy: payment_required";
	const result = await driveChatTurnSteps(h.step, {
		markStarted: async () => {},
		runFacetTurn: async () =>
			JSON.stringify({
				text: "Billing policy blocked this turn.",
				stopReason: "billing_policy_denied",
				error,
				billingCode: "payment_required",
			}),
	});
	assert.deepEqual(result, {
		text: "Billing policy blocked this turn.",
		stopReason: "billing_policy_denied",
		error,
		billingCode: "payment_required",
		toolCalls: [],
	});
	assert.deepEqual(
		h.completionReports,
		[result],
		"a deterministic billing denial reaches onWorkflowComplete once with its typed code intact",
	);
	console.log("PASS: billing policy stop reports typed terminal result");
}

// Native command pending: survive a workflow restart without rerunning the
// model/command, and never seal completion before the terminal observation.
{
	const completedSteps = new Map<string, unknown>();
	const modelSegments: number[] = [];
	const reports: unknown[] = [];
	const reads: Array<[number, string[]]> = [];
	let restart = true;
	let commandIsTerminal = false;
	const step: ChatTurnStepRunner = {
		async do(name, config, callback) {
			assert.deepEqual(config, IDEMPOTENT_STEP_RETRY);
			if (completedSteps.has(name)) return completedSteps.get(name) as never;
			const result = await callback();
			completedSteps.set(name, result);
			return result;
		},
		async sleep(name, duration) {
			assert.equal(name, "computer-wait-0-0");
			assert.equal(duration, "30 seconds");
			assert.equal(reports.length, 0, "pending work has no terminal report");
			if (restart) {
				restart = false;
				throw new Error("Workflow invocation restarted during durable wait");
			}
			commandIsTerminal = true;
		},
		async reportComplete(result) {
			assert.ok(commandIsTerminal);
			reports.push(result);
		},
	};
	const ops = {
		markStarted: async () => true,
		runFacetTurn: async (segment = 0) => {
			modelSegments.push(segment);
			if (segment === 0) {
				return JSON.stringify({
					text: "Waiting for the command",
					stopReason: "computer_pending",
					pendingComputerExecutions: ["exec-original"],
				});
			}
			assert.ok(commandIsTerminal, "model resumes only with terminal evidence");
			return JSON.stringify({
				text: "Command failed: exit 1",
				stopReason: "stop",
			});
		},
		readComputerExecutions: async (segment: number, ids: string[]) => {
			reads.push([segment, ids]);
			return { ready: commandIsTerminal, retryAfterSeconds: 30 };
		},
	};
	await assert.rejects(driveChatTurnSteps(step, ops), /invocation restarted/);
	assert.deepEqual(modelSegments, [0]);
	assert.equal(reports.length, 0);
	const result = await driveChatTurnSteps(step, ops);
	assert.deepEqual(
		modelSegments,
		[0, 1],
		"initial model segment was not replayed",
	);
	assert.deepEqual(reads, [
		[0, ["exec-original"]],
		[0, ["exec-original"]],
	]);
	assert.deepEqual(reports, [result]);
	assert.equal(result.text, "Command failed: exit 1");
	assert.ok(completedSteps.has("facet-turn"));
	assert.ok(completedSteps.has("facet-turn-continuation-1"));
}

// A later segment can launch another command; each wait observes only its own
// execution set. A lost/expired fence must propagate and cannot resume tools.
{
	const h = makeHarness();
	const modelSegments: number[] = [];
	const observations: Array<[number, string[]]> = [];
	await assert.rejects(
		driveChatTurnSteps(h.step, {
			markStarted: async () => true,
			runFacetTurn: async (segment = 0) => {
				modelSegments.push(segment);
				return JSON.stringify({
					text: "pending",
					stopReason: "computer_pending",
					pendingComputerExecutions: [`exec-${segment}`],
				});
			},
			readComputerExecutions: async (segment, ids) => {
				observations.push([segment, ids]);
				if (segment === 1) throw new Error("Original Work Attempt expired");
				return { ready: true, retryAfterSeconds: 15 };
			},
		}),
		/Original Work Attempt expired/,
	);
	assert.deepEqual(modelSegments, [0, 1]);
	assert.deepEqual(observations, [
		[0, ["exec-0"]],
		[1, ["exec-1"]],
	]);
	assert.equal(
		h.completionReports.length,
		0,
		"failure follows the SDK error path",
	);
}

// Malformed pending state must fail closed, never masquerade as a settled turn.
for (const pending of [
	undefined,
	[],
	[""],
	["duplicate", "duplicate"],
	"exec-id",
]) {
	const h = makeHarness();
	await assert.rejects(
		driveChatTurnSteps(h.step, {
			markStarted: async () => true,
			runFacetTurn: async () =>
				JSON.stringify({
					text: "pending",
					stopReason: "computer_pending",
					pendingComputerExecutions: pending,
				}),
		}),
		/Invalid pending computer execution segment/,
	);
	assert.equal(h.completionReports.length, 0);
}

console.log("chat-turn-steps.test.ts: all assertions passed");
