import assert from "node:assert/strict";
import { asSchema } from "ai";
import {
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	nativeToolMarkers,
	tediDo,
} from "../test/tedi-do";
import type { PlatformClient } from "./brain/platform-client";
import { OPERATOR_COMPUTER_SCOPE } from "./computer-workspace-scope";
import { supervisedDelegationToolSet } from "./delegation-authority";
import { createWorkApprovalAiTools } from "./work-approval-tools";

const calls: Array<{ method: string; input: unknown }> = [];
const platform = {
	async listWorkApprovalInbox(input: unknown) {
		calls.push({ method: "list", input });
		return { data: [], hasMore: false };
	},
	async decideWorkApproval(input: unknown) {
		calls.push({ method: "decide", input });
		return { proposal: {}, decision: {} };
	},
} as unknown as PlatformClient;

const tools = createWorkApprovalAiTools(async () => platform);
assert.deepEqual(Object.keys(tools).sort(), [
	"decide_work_approval",
	"list_work_approval_inbox",
]);

const inbox = tools.list_work_approval_inbox as {
	execute: (input: unknown, options: unknown) => Promise<unknown>;
};
const decide = tools.decide_work_approval as {
	execute: (input: unknown, options: unknown) => Promise<unknown>;
};
const inboxSchema = asSchema(tools.list_work_approval_inbox!.inputSchema);
assert.ok(inboxSchema.validate);
async function invokeInbox(input: unknown) {
	const result = await inboxSchema.validate!(input);
	if (!result.success) throw result.error;
	return inbox.execute(result.value, {});
}
await invokeInbox({
	limit: 1,
	proposalId: "5eed0010-0000-4000-8000-000000000010",
});
await decide.execute(
	{
		proposalId: "5eed0010-0000-4000-8000-000000000010",
		expectedProposalVersion: 1,
		decision: "approved",
		rationale: "Independent review passed",
	},
	{},
);
assert.deepEqual(calls, [
	{
		method: "list",
		input: { limit: 1, proposalId: "5eed0010-0000-4000-8000-000000000010" },
	},
	{
		method: "decide",
		input: {
			proposalId: "5eed0010-0000-4000-8000-000000000010",
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Independent review passed",
		},
	},
]);

await invokeInbox({});
assert.deepEqual(calls.at(-1), { method: "list", input: {} });
const cursor = {
	at: "2026-09-20T01:42:33.000Z",
	id: "5eed0010-0000-4000-8000-000000000010",
};
await invokeInbox({ cursor, limit: 1 });
assert.deepEqual(calls.at(-1), {
	method: "list",
	input: { cursor, limit: 1 },
});
const callsBeforeInvalidCursors = calls.length;
for (const invalidCursor of [
	{ ...cursor, at: "" },
	{ ...cursor, at: "not-a-datetime" },
	{ ...cursor, at: "2026-02-30T01:42:33.000Z" },
	{ ...cursor, id: "not-a-uuid" },
]) {
	await assert.rejects(invokeInbox({ cursor: invalidCursor }));
	assert.equal(calls.length, callsBeforeInvalidCursors);
}

const unavailable = createWorkApprovalAiTools(async () => null);
await assert.rejects(
	(unavailable.list_work_approval_inbox as typeof inbox).execute({}, {}),
	/Tedi platform identity is unavailable/,
);

await assert.rejects(
	(unavailable.decide_work_approval as typeof decide).execute(
		{
			proposalId: "5eed0010-0000-4000-8000-000000000010",
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Synthetic identity must refuse",
		},
		{},
	),
	/Tedi platform identity is unavailable/,
);

// The approval preflight reports the actual native registry after identity,
// without depending on credential-bound MCP review discovery.
for (const discovery of ["throw", "pending"] as const) {
	let identityCalls = 0;
	let mcpCalls = 0;
	let discoveryCalls = 0;
	let platformCalls = 0;
	const agent = tediDo({
		env: {},
		state: { tediId: "fictional-reviewer" },
		async ensureIdentity() {
			identityCalls++;
		},
		async getMcpRuntime() {
			mcpCalls++;
			if (discovery === "throw")
				throw new Error("Unused MCP runtime unavailable");
			return {
				discoverCredentialBoundReviewCallables() {
					discoveryCalls++;
					return new Promise<string[]>(() => {});
				},
			};
		},
		async getPlatformClient() {
			platformCalls++;
			return null;
		},
		...nativeToolMarkers(),
	});
	const actualGetTools = agent.getTools;
	agent.getTools = function (scope: unknown) {
		assert.equal(identityCalls, 1);
		return actualGetTools.call(this, scope);
	};
	const response = await agent.onRequest(
		new Request("https://do.internal/__internal/review-capabilities"),
	);
	const body = (await response.json()) as {
		ok: boolean;
		nativeTools: string[];
	};
	assert.equal(response.status, 200);
	assert.equal(body.ok, true);
	assert.deepEqual(
		body.nativeTools,
		Object.keys(agent.getTools(OPERATOR_COMPUTER_SCOPE)),
	);
	assert.ok(body.nativeTools.includes("list_work_approval_inbox"));
	assert.ok(body.nativeTools.includes("decide_work_approval"));
	assert.equal(mcpCalls, 0);
	assert.equal(discoveryCalls, 0);
	assert.equal(platformCalls, 0);
	assert.equal(Object.hasOwn(body, "credentialBoundCallables"), false);
}

// Method and identity failures cannot publish a registry or execute tools.
{
	let identityCalls = 0,
		registryCalls = 0,
		mcpCalls = 0;
	const identityFailure = new Error("Synthetic identity refusal");
	const agent = tediDo({
		env: {},
		state: { tediId: "fictional-reviewer" },
		async ensureIdentity() {
			identityCalls++;
			throw identityFailure;
		},
		getTools() {
			registryCalls++;
			throw new Error("Registry must not be reached");
		},
		async getMcpRuntime() {
			mcpCalls++;
			throw new Error("MCP must not be reached");
		},
	});
	const post = await agent.onRequest(
		new Request("https://do.internal/__internal/review-capabilities", {
			method: "POST",
		}),
	);
	assert.equal(post.status, 405);
	assert.deepEqual([identityCalls, registryCalls, mcpCalls], [0, 0, 0]);
	await assert.rejects(
		agent.onRequest(
			new Request("https://do.internal/__internal/review-capabilities"),
		),
		(error) => error === identityFailure,
	);
	assert.deepEqual([identityCalls, registryCalls, mcpCalls], [1, 0, 0]);
}

// Home owns a delegated run's Work lifecycle below the model: a supervised
// facet turn keeps the approval tools but never exposes the assigned-work
// lifecycle tools.
{
	const delegated = await mcpFacetTurnProbe().prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		workItemId: "3f1c2a1e-0000-4000-8000-000000000001",
		homeRunId: "home-1",
	});
	assert.ok("list_work_approval_inbox" in delegated.tools);
	assert.equal("start_assigned_work" in delegated.tools, false);
}

// The Work tool set a facet turn builds is the same whether or not the turn is
// Home-supervised: every tool in it survives the supervised filter, so the
// filter is never what keeps a lifecycle tool away from the model. Building
// tools only to drop them again would make this assertion fail.
{
	const built = createWorkApprovalAiTools(async () => platform);
	assert.deepEqual(
		Object.keys(supervisedDelegationToolSet(built, true)).sort(),
		Object.keys(built).sort(),
	);
	for (const name of Object.keys(built)) {
		assert.doesNotMatch(name, /assigned_work/);
	}
}

// These prototype/collaborator assertions are unit evidence, not native
// persistence or Cloud execution proof.

console.log("work-approval-tools.test.ts: native AITL tool wiring passed");
