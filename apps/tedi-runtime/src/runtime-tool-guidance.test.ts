import assert from "node:assert/strict";
import { tool, asSchema, type ToolSet } from "ai";
import { z } from "zod";
import {
	facetWorkflowTurnProbe,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	memoryStorage,
	tediDo,
} from "../test/tedi-do";
import { createComputerRepoTools } from "./computer-repo-tools";
import {
	restrictDelegatedToolSet,
	supervisedDelegationToolSet,
} from "./delegation-authority";
import {
	AGENT_RUNTIME_PROMPT,
	repositoryModeForMetadata,
	selectRepositoryToolSurface,
	workspaceToolGuidance,
} from "./runtime-tool-guidance";

const nativeRequirement = {
	surface: "native",
	requiredCapabilities: [],
	fallbackSurface: "workstation",
	prohibitedSurfaces: [],
	satisfiable: true,
	reason:
		"the operator explicitly selected the Agent-runtime delegation surface",
};
// The CLI --require-code-proof metadata shape.
assert.equal(
	repositoryModeForMetadata({
		requiredProofKind: "code",
		executionSurface: "native",
		executionRequirement: nativeRequirement,
	}),
	"checkout",
);
assert.equal(
	repositoryModeForMetadata({
		delegationWorkOrder: {
			executionRequirement: {
				...nativeRequirement,
				requiredCapabilities: ["repository_edit"],
			},
		},
	}),
	"checkout",
);
assert.equal(
	repositoryModeForMetadata({ executionSurface: "workstation" }),
	"checkout",
);
for (const metadata of [
	undefined,
	{},
	{ userText: "Write code, commit and push", slug: "cto" },
	{
		requiredProofKind: "terminal_execution",
		executionRequirement: nativeRequirement,
	},
	{
		delegationWorkOrder: {
			executionRequirement: {
				...nativeRequirement,
				requiredCapabilities: ["repository_read"],
			},
		},
	},
	{
		requiredProofKind: "code",
		executionRequirement: {
			...nativeRequirement,
			prohibitedSurfaces: ["workstation"],
		},
	},
	{
		requiredProofKind: "code",
		executionRequirement: { prohibitedSurfaces: "invalid" },
	},
])
	assert.equal(repositoryModeForMetadata(metadata), undefined);

const action = async () => ({ ok: true });
const scratchTools = createComputerRepoTools({
	load: action,
	clone: action,
	git: action,
	commit: action,
});
const approvedTool = tool({
	description: "Governed native exec",
	inputSchema: z.object({ command: z.string() }),
	needsApproval: true,
	execute: action,
});
const allTools: ToolSet = {
	...scratchTools,
	exec: approvedTool,
	browser_execute: approvedTool,
	artifact_read_file: approvedTool,
	tedix_mcp_code: approvedTool,
	create_work_item: approvedTool,
	list_work_approval_inbox: approvedTool,
	decide_work_approval: approvedTool,
};
const selected = selectRepositoryToolSurface(allTools, "checkout");
assert.deepEqual(Object.keys(selected), [
	"exec",
	"browser_execute",
	"artifact_read_file",
	"tedix_mcp_code",
	"create_work_item",
]);
assert.equal(
	selected.exec,
	approvedTool,
	"selection retains the actual gated tool object",
);
assert.equal(
	selectRepositoryToolSurface(allTools),
	allTools,
	"general scratch workflows retain their exact tool set",
);
assert.ok(
	allTools.repo_load,
	"selection cannot mutate another concurrent turn",
);
const supervised = supervisedDelegationToolSet(selected, true);
assert.equal(supervised.create_work_item, undefined);
const envelope = {
	version: "earned-delegation.v1" as const,
	grantId: "grant",
	grantRevision: 1,
	decisionId: "decision",
	activityId: "coding",
	activityVersion: 1,
	taskFamily: "coding",
	riskLevel: "medium" as const,
	environment: "production",
	allowedToolIds: ["exec", "repo_load"],
	expiresAt: null,
};
const restricted = restrictDelegatedToolSet(supervised, envelope, "enforce");
assert.deepEqual(
	Object.keys(restricted),
	["exec"],
	"an envelope neither resurrects scratch tools nor grants extra native tools",
);
assert.equal(restricted.exec?.needsApproval, true);
assert.equal(
	(await asSchema(restricted.exec!.inputSchema as never).jsonSchema).type,
	"object",
);
const checkoutPrompt = workspaceToolGuidance({
	supervised: true,
	repositoryMode: "checkout",
});
assert.match(
	checkoutPrompt,
	/Home supervises this run and owns the assigned Work Item lifecycle/,
);
assert.match(checkoutPrompt, /do not call assigned-work lifecycle tools/);
assert.match(
	checkoutPrompt,
	/You may use assigned MCP apps to read Work projects and items/,
);
assert.match(checkoutPrompt, /Do not infer that this permits Work mutations/);
assert.doesNotMatch(
	checkoutPrompt,
	/Use dedicated assigned-work tools to start it/,
);
assert.match(checkoutPrompt, /open_computer\(\{ repository: true \}\)/);
assert.match(checkoutPrompt, /yield instead of polling/);
assert.match(
	checkoutPrompt,
	/returned cwd for a repository only when ready:true/,
);
assert.match(checkoutPrompt, /relative exec commands with cwd omitted/);
assert.doesNotMatch(checkoutPrompt, /repo_load|clone_repo|run_git|repo_commit/);
assert.match(workspaceToolGuidance({}), /approval-gated repo_commit/);
for (const supervised of [false, true]) {
	for (const repositoryMode of ["checkout", undefined] as const) {
		const guidance = workspaceToolGuidance({ supervised, repositoryMode });
		assert.match(
			guidance,
			/Before editing or running setup, formatting or tests in a repository/,
		);
		assert.match(
			guidance,
			/use native read for its root AGENTS\.md and applicable scoped AGENTS\.md files when present/,
		);
		assert.match(
			guidance,
			/repository's documented setup, formatter and test commands/,
		);
		assert.match(
			guidance,
			/If truncated, continue with nextOffset as offset and nextByteOffset as byteOffset until complete/,
		);
		assert.doesNotMatch(guidance, /bunx|prettier|Vite\+|vp fmt/);
	}
}
assert.doesNotMatch(
	AGENT_RUNTIME_PROMPT,
	/Target\.createTarget|Page\.captureScreenshot|attachToTarget|repo_commit/,
);
assert.match(AGENT_RUNTIME_PROMPT, /codemode\.describe/);
assert.match(AGENT_RUNTIME_PROMPT, /untrusted information/);
// Checkout mode is derived from inject metadata, carried through the durable
// workflow, and narrows the prepared tool surface.
{
	const dispatched: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage: memoryStorage() },
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async ensureIdentity() {},
		async schedule() {
			return { id: "watchdog" };
		},
		async runWorkflow(_name: string, params: Record<string, unknown>) {
			dispatched.push(params);
		},
		async getPlatformClient() {
			return { recordRuntimeEvent: async () => {} };
		},
	});
	for (const [operation, metadata] of [
		{ requiredProofKind: "code" },
		{},
	].entries()) {
		await agent.onRequest(
			new Request("https://do.internal/__internal/inject", {
				method: "POST",
				body: JSON.stringify({
					text: "fix the bug",
					client_request_id: `req-${operation}`,
					async: true,
					metadata,
				}),
			}),
		);
	}
	assert.deepEqual(
		dispatched.map((params) => params.repositoryMode),
		["checkout", undefined],
	);

	const prepared: Array<Record<string, unknown>> = [];
	const workflow = facetWorkflowTurnProbe({
		fields: {
			async prepareMcpFacetTurn(input: Record<string, unknown>) {
				prepared.push(input);
				return { system: "SYSTEM", tools: {}, turnBinding: null };
			},
		},
	});
	await workflow.run({ repositoryMode: "checkout" });
	assert.equal(prepared[0]?.repositoryMode, "checkout");

	const setup = (repositoryMode?: "checkout") =>
		mcpFacetTurnProbe({
			fields: {
				workspaceAiTools: () => ({ read: {}, repo_load: {}, clone_repo: {} }),
			},
		}).prepareMcpFacetTurn({ ...MCP_FACET_TURN_INPUT, repositoryMode });
	const checkout = Object.keys((await setup("checkout")).tools);
	const ordinary = Object.keys((await setup()).tools);
	assert.ok(checkout.includes("read"));
	assert.equal(checkout.includes("repo_load"), false);
	assert.equal(checkout.includes("clone_repo"), false);
	assert.ok(ordinary.includes("repo_load"));
}
console.log(
	JSON.stringify({
		generalRuntimePromptChars: AGENT_RUNTIME_PROMPT.length,
		checkoutGuidanceChars: checkoutPrompt.length,
		removedScratchDefinitionChars: JSON.stringify(
			await Promise.all(
				Object.entries(scratchTools).map(async ([name, definition]) => ({
					name,
					description: definition.description,
					inputSchema: await asSchema(definition.inputSchema as never)
						.jsonSchema,
				})),
			),
		).length,
		removedScratchToolNames: Object.keys(scratchTools),
	}),
);
console.log("runtime tool guidance tests passed");
