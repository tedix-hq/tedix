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
// Live View credentials belong in the human approval, never in tool output.
{
	let approvalBody = "";
	const agent = tediDo({
		state: { tediId: "test-tedi", orgId: "test-org" },
		ensureIdentity: async () => {},
		env: {
			API_SERVICE: {
				fetch: async (request: Request) => {
					approvalBody = await request.text();
					return Response.json({
						json: {
							id: "approval",
							expiresAt: "2099-01-01T00:00:00.000Z",
							status: "pending",
						},
					});
				},
			},
		},
		getBrowserSession: () => ({
			liveView: async () => ({
				sessionId: "private-provider-session",
				expiresInMs: 300_000,
				targets: [
					{
						targetId: "tab",
						url: "https://live.example.com/secret-token",
						pageUrl: "https://example.com/private",
					},
				],
			}),
		}),
		getBrowserBudgetStore: () => ({ status: () => ({ remaining: 1 }) }),
	});
	const output = await agent.requestBrowserTakeover(
		{ reason: "login", note: "Sign in", limit: 1 },
		{
			sessionKey: "chat",
			runId: "test-run",
			platform: { recordRuntimeEvent: async () => {} },
		},
	);
	assert.match(approvalBody, /private-provider-session/);
	assert.match(approvalBody, /secret-token/);
	assert.doesNotMatch(
		JSON.stringify(output),
		/private-provider-session|secret-token|live.example.com/,
	);
	assert.deepEqual(output.targets, [
		{ targetId: "tab", pageUrl: "https://example.com", title: null },
	]);
}

console.log("runtime tool authority wiring characterization passed");
