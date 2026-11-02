import assert from "node:assert/strict";
import { memoryStorage, tediDo } from "../test/tedi-do";

// Cancellation/storage failures must stop recovery before budget authority runs.
{
	let budgetChecks = 0;
	const agent = tediDo({
		ctx: { storage: { get: async () => true } },
		getInferenceBudgetStore: () => {
			budgetChecks++;
			assert.fail("canceled recovery checked budget");
		},
	});
	assert.equal(await agent.canRecoverChatTurn("canceled-run"), false);
	assert.equal(budgetChecks, 0);
	agent.ctx.storage.get = async () => {
		throw new Error("storage unavailable");
	};
	await assert.rejects(agent.canRecoverChatTurn("run"), /storage unavailable/);
	assert.equal(budgetChecks, 0);
}

// Mid-turn accounting normalizes malformed totals and settles cumulatively.
{
	const checks: unknown[][] = [];
	const limits = { dailyTokenLimit: 100 };
	const agent = tediDo({
		state: {},
		inferenceBudgetLimits: () => limits,
		getInferenceBudgetStore: () => ({
			checkMidTurn: (...args: unknown[]) => {
				checks.push(args);
				return { exhausted: false };
			},
		}),
	});
	assert.deepEqual(
		await agent.checkFacetTurnBudget({
			runId: "run",
			cumulativeTokens: NaN,
			stepCount: 1,
		}),
		{ abort: false, reason: null },
	);
	agent.settleCumulativeInferenceTokens("run", 12);
	agent.settleCumulativeInferenceTokens("run", 12);
	agent.settleCumulativeInferenceTokens("run", NaN);
	assert.deepEqual(checks, [
		["run", limits, 0],
		["run", limits, 12],
		["run", limits, 12],
	]);
}

// A recorded dispatch is acknowledged without repeating the workflow effect.
{
	const params = { runId: "run", sessionKey: "chat:example" };
	const agent = tediDo({
		runtimeAdmission: () => ({ assertAcceptedTurn: async () => {} }),
		ctx: {
			storage: memoryStorage({
				"runtime-admission-workflow:run": {
					params,
					id: "workflow",
					stage: "dispatched",
				},
			}),
		},
		runWorkflow: async () => assert.fail("repeated a dispatched workflow"),
	});
	await agent.dispatchAdmittedChatWorkflow("CHAT_TURN_WORKFLOW", params, {
		id: "workflow",
		agentBinding: "TEDI_AGENT",
	});
	await assert.rejects(
		agent.dispatchAdmittedChatWorkflow(
			"CHAT_TURN_WORKFLOW",
			{ ...params, sessionKey: "changed" },
			{ id: "workflow", agentBinding: "TEDI_AGENT" },
		),
		/Original admitted workflow dispatch changed/,
	);
}

// Failed admission or journal persistence cannot reach native dispatch.
for (const failure of [
	"admission-before",
	"admission-after",
	"storage",
	"dispatch",
] as const) {
	let checks = 0;
	let dispatches = 0;
	const storage = memoryStorage();
	const params = { runId: "run", sessionKey: "chat:fixture" };
	if (failure === "storage")
		storage.put = async () => {
			throw new Error("storage");
		};
	const agent = tediDo({
		ctx: { storage },
		runtimeAdmission: () =>
			failure === "storage" || failure === "dispatch"
				? null
				: {
						assertAcceptedTurn: async () => {
							checks++;
							if (checks === (failure === "admission-before" ? 1 : 2))
								throw new Error(failure);
						},
					},
		runWorkflow: async () => {
			dispatches++;
			throw new Error("dispatch");
		},
	});
	await assert.rejects(
		agent.dispatchAdmittedChatWorkflow("CHAT_TURN_WORKFLOW", params, {
			id: "workflow",
			agentBinding: "TEDI_AGENT",
		}),
	);
	assert.equal(dispatches, failure === "dispatch" ? 1 : 0);
	const prior = await storage.get<{ stage: string }>(
		"runtime-admission-workflow:run",
	);
	assert.equal(
		prior?.stage,
		failure === "dispatch"
			? "uncertain"
			: failure === "admission-after"
				? "dispatching"
				: undefined,
	);
	if (failure === "dispatch") {
		await assert.rejects(
			agent.dispatchAdmittedChatWorkflow("CHAT_TURN_WORKFLOW", params, {
				id: "workflow",
				agentBinding: "TEDI_AGENT",
			}),
			/uncertain/,
		);
		assert.equal(dispatches, 1);
	}
}
console.log("runtime parent turn wiring characterization passed");
