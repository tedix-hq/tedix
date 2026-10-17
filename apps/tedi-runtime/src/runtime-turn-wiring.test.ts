import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

// A resumed facet owns its history; a first turn excludes the current user row.
{
	const reads: unknown[] = [];
	const agent = tediDo({
		sessionHarness: {
			async buildContext(...args: unknown[]) {
				reads.push(args);
				return [{ role: "assistant", content: "earlier answer" }];
			},
		},
	});
	const input = {
		sessionKey: "chat:example",
		runId: "run",
		userTs: 42,
		text: "question",
		priorTurnCount: 1,
	};
	assert.equal(await agent.hydrateFirstFacetTurnText(input), "question");
	assert.deepEqual(reads, []);
	assert.match(
		await agent.hydrateFirstFacetTurnText({ ...input, priorTurnCount: 0 }),
		/assistant: earlier answer/,
	);
	assert.deepEqual(reads, [
		[input.sessionKey, { excludeUserTs: 42, requireContent: true }],
	]);
}

// Missing approval transport retains the original request and schedules bounded retries.
{
	const scheduled: unknown[][] = [];
	const agent = tediDo({
		env: {},
		schedule: async (...args: unknown[]) => scheduled.push(args),
	});
	const request = {
		approvalRequestId: "approval",
		executionId: "execution",
		sessionKey: "chat:example",
		codeHash: "hash",
		conversationId: "conversation",
	};
	assert.equal(await agent.proposeCodemodeExecuteApproval(request), null);
	await agent.scheduleCodemodeApprovalRepair({ ...request, repairAttempt: 4 });
	await agent.scheduleCodemodeApprovalRepair({ ...request, repairAttempt: 5 });
	assert.deepEqual(scheduled, [
		[
			30,
			"repairCodemodeExecuteApproval",
			{ ...request, repairAttempt: 1 },
			{ idempotent: true, retry: { maxAttempts: 3 } },
		],
		[
			480,
			"repairCodemodeExecuteApproval",
			{ ...request, repairAttempt: 5 },
			{ idempotent: true, retry: { maxAttempts: 3 } },
		],
	]);
}

// A failed repair cannot rewrite the durable correlation.
{
	let reads = 0;
	const agent = tediDo({
		proposeCodemodeExecuteApproval: async () => null,
		ctx: {
			storage: {
				get: async () => {
					reads++;
					assert.fail("must not read correlation");
				},
			},
		},
	});
	await agent.repairCodemodeExecuteApproval({ executionId: "execution" });
	assert.equal(reads, 0);
}
console.log("runtime turn wiring characterization passed");
