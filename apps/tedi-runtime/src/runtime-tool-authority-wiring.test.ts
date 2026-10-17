import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

{
	const agent = tediDo({});
	await assert.rejects(
		agent.requestBrowserTakeover(
			{ reason: "login", note: "sign in", limit: 1 },
			null,
		),
		/browser_takeover_owner_missing/,
	);
	await agent.enforceBrowserTakeoverGate("browser_budget_status");
}

// A successful approval repair updates only its own pending correlation.
{
	let correlation = { approvalPendingSeq: 3, runId: "original-run" };
	const writes: unknown[] = [];
	const agent = tediDo({
		proposeCodemodeExecuteApproval: async () => "approved-card",
		ctx: {
			storage: {
				get: async () => correlation,
				put: async (...args: unknown[]) => writes.push(args),
			},
		},
	});
	const input = { executionId: "execution", pendingSeq: 2 };
	await agent.repairCodemodeExecuteApproval(input);
	assert.equal(writes.length, 0);
	correlation = { ...correlation, approvalPendingSeq: 2 };
	await agent.repairCodemodeExecuteApproval(input);
	assert.equal(writes.length, 1);
	assert.deepEqual((writes[0] as unknown[])[1], {
		...correlation,
		approvalRequestId: "approved-card",
	});
}
console.log("runtime tool authority wiring characterization passed");
