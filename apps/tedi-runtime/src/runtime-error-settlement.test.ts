import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { memoryStorage, tediDo } from "../test/tedi-do";
import { driveChatTurnSteps, type ChatTurnStepRunner } from "./chat-turn-steps";
import { providerErrorWorkflowResult } from "./provider-error-settlement";
import {
	runtimeErrorWorkflowResult,
	isTerminalFailureWorkflowResult,
} from "./runtime-error-settlement";

for (const message of [
	"delegated_work_authority_lost: run=run-1 attempt=attempt-1 work=work-1",
	"cron_tool_failure",
	"Durable provider-call ceiling reached",
	"Interrupted tool effects require reconciliation before recovery",
	"Chat inference denied for stopped run: persisted-run",
	"Chat inference denied for canceled or stopped run: persisted-run",
]) {
	const result = runtimeErrorWorkflowResult(new Error(message));
	assert.ok(result);
	assert.equal(result.error, message);
	let calls = 0;
	let retries = 0;
	let failed = false;
	const step: ChatTurnStepRunner = {
		async sleep() {
			throw new Error("A terminal runtime failure does not sleep");
		},
		async do(_name, _config, callback) {
			try {
				return await callback();
			} catch (error) {
				retries++;
				throw error;
			}
		},
		async reportComplete(value) {
			failed = isTerminalFailureWorkflowResult(value);
		},
	};
	const settled = await driveChatTurnSteps(step, {
		markStarted: async () => true,
		runFacetTurn: async () => {
			calls++;
			return JSON.stringify(result);
		},
	});
	assert.equal(calls, 1);
	assert.equal(retries, 0);
	assert.equal(failed, true);
	assert.equal(settled.error, message);
}
for (const message of [
	"STALE_ATTEMPT: Attempt attempt-1 is no longer authoritative",
	"RPC workItems/heartbeatAttempt failed (409)",
	"wrapped delegated_work_authority_lost: run=run-1",
	"delegated_work_authority_lost:",
	"empty_assistant_message",
	"Durable Object storage reset",
	"Durable Object reset because its code was updated",
	"429 no_capacity",
	"fetch failed",
]) {
	assert.equal(
		runtimeErrorWorkflowResult(new Error(message)),
		null,
		`${message} retains bounded transient recovery`,
	);
}
assert.equal(
	isTerminalFailureWorkflowResult(
		providerErrorWorkflowResult(new Error("Incorrect API key provided")),
	),
	true,
);
assert.equal(
	isTerminalFailureWorkflowResult({
		text: "partial",
		stopReason: "step_ceiling",
	}),
	false,
);
assert.equal(
	isTerminalFailureWorkflowResult({ text: "done", stopReason: "stop" }),
	false,
);
assert.equal(
	isTerminalFailureWorkflowResult({ stopReason: "runtime_error", error: "x" }),
	false,
);
assert.equal(isTerminalFailureWorkflowResult(null), false);
// The Agent settles a typed terminal failure as a failed logical run, keeping
// the visible fallback notice when the result carries no text.
for (const text of ["", "I could not finish: the provider refused."]) {
	const settled: unknown[][] = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		async settleWorkflowFailure(...args: unknown[]) {
			settled.push(args);
		},
		async settleWorkflowSuccess() {
			throw new Error("a terminal failure is not success");
		},
	});
	await agent.onWorkflowComplete("CHAT_TURN_WORKFLOW", "wf-1", {
		text,
		stopReason: "runtime_error",
		error: "Durable provider-call ceiling reached",
	});
	assert.deepEqual(settled, [
		[
			"wf-1",
			"Durable provider-call ceiling reached",
			{ assistantText: text || undefined },
		],
	]);
}

// Native reconciliation of a completed instance uses the same settlement.
{
	const completed: unknown[][] = [];
	const agent = tediDo({
		ctx: {
			storage: memoryStorage({ "wfctx:wf-1": { runId: "run-1" } }),
		},
		async getWorkflowStatus() {
			return {
				status: "complete",
				output: { text: "", stopReason: "runtime_error", error: "x" },
			};
		},
		async onWorkflowComplete(...args: unknown[]) {
			completed.push(args);
		},
	});
	assert.equal(
		await agent.reconcileChatWorkflowTerminalInner({
			workflowInstanceId: "wf-1",
			attempt: 0,
		}),
		true,
	);
	assert.deepEqual(completed, [
		[
			"CHAT_TURN_WORKFLOW",
			"wf-1",
			{ text: "", stopReason: "runtime_error", error: "x" },
		],
	]);
}
console.log(
	"runtime-error-settlement tests passed: deterministic failure, transient recovery and truthful completion",
);

// Exercise the actual Workflow callbacks, including its exception boundary.
// Only the unavailable native SDK base/stub/NonRetryableError are replaced.
// This verifies callback behavior and retry decisions, not Cloudflare timing.
// The executable suite runs in Bun; keep its globals out of Worker source types.
const { mock } = createRequire(import.meta.url)("bun:test") as {
	mock: { module(name: string, factory: () => Record<string, unknown>): void };
};
class HarnessNonRetryableError extends Error {}
mock.module("cloudflare:workflows", () => ({
	NonRetryableError: HarnessNonRetryableError,
}));
mock.module("agents", () => ({
	getAgentByName: () => {
		throw new Error("unexpected named stub acquisition");
	},
}));
mock.module("agents/workflows", () => ({ AgentWorkflow: class {} }));
const { ChatTurnWorkflow } = await import("./chat-turn-workflow");

for (const boundary of ["facet", "observation"] as const) {
	for (const terminal of [true, false]) {
		let facetCalls = 0;
		let observations = 0;
		let retries = 0;
		let sleeps = 0;
		const completed: unknown[] = [];
		const error = new Error(
			terminal
				? "delegated_work_authority_lost: run=run-1 attempt=attempt-1 work=work-1"
				: "fetch failed",
		);
		const instance = Object.create(ChatTurnWorkflow.prototype) as InstanceType<
			typeof ChatTurnWorkflow
		>;
		Object.defineProperty(instance, "agent", {
			value: {
				markChatWorkflowStarted: async () => true,
				runFacetWorkflowTurn: async () => {
					facetCalls++;
					if (boundary === "facet" && facetCalls === 1) throw error;
					return boundary === "observation" && facetCalls === 1
						? {
								text: "",
								stopReason: "computer_pending",
								pendingComputerExecutions: ["execution-1"],
							}
						: { text: "done", stopReason: "stop", toolCalls: [] };
				},
				readFacetComputerExecutions: async () => {
					observations++;
					if (observations === 1) throw error;
					return { ready: true, retryAfterSeconds: 30 };
				},
			},
		});
		const step: ChatTurnStepRunner = {
			async do(_name, config, callback) {
				for (let attempt = 0; ; attempt++) {
					try {
						return await callback();
					} catch (failure) {
						if (
							failure instanceof HarnessNonRetryableError ||
							attempt >= (config.retries?.limit ?? 0)
						)
							throw failure;
						retries++;
					}
				}
			},
			async sleep() {
				sleeps++;
			},
			async reportComplete(result) {
				completed.push(result);
			},
		};
		const run = instance.run(
			{
				instanceId: "native-1",
				payload: {
					runId: "run-1",
					sessionKey: "session-1",
					conversationId: "conversation-1",
					userText: "task",
					userTs: 0,
					clientRequestId: "request-1",
					workItemId: "work-1",
					homeRunId: "home-1",
				},
			} as Parameters<typeof instance.run>[0],
			step as unknown as Parameters<typeof instance.run>[1],
		);
		if (terminal && boundary === "observation") {
			await assert.rejects(
				run,
				(failure) =>
					failure instanceof HarnessNonRetryableError &&
					failure.message === error.message,
			);
			assert.equal(facetCalls, 1);
			assert.equal(observations, 1);
			assert.equal(
				completed.length,
				0,
				"native error handling, not a success-shaped status, owns failure",
			);
		} else {
			const result = await run;
			assert.equal(completed.length, 1);
			assert.equal(isTerminalFailureWorkflowResult(result), terminal);
			if (terminal) {
				assert.equal(result.error, error.message);
				assert.equal(facetCalls, 1);
			} else {
				assert.equal(result.text, "done");
				assert.equal(facetCalls, 2);
			}
		}
		assert.equal(retries, terminal ? 0 : 1);
		assert.equal(sleeps, 0);
	}
}
console.log(
	"actual Workflow callbacks: confirmed loss is terminal, transient facet/observation failures retry",
);
