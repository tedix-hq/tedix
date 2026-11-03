import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import { repoSnapshotManifest } from "./repo-commit-snapshot";
import type { WorkstationTurnContext } from "./workstation-turn-context";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";

const input = {
	owner: "fictional",
	repo: "repository",
	baseSha: "a".repeat(40),
	changes: [{ path: "file.txt", content: "new" }],
};
const manifest = await repoSnapshotManifest(input);
const receipt = {
	version: "v1",
	baseSha: input.baseSha,
	resultTreeSha: "b".repeat(40),
	orderedChangesDigest: manifest.orderedChangesDigest,
	gateRecipeDigest: "c".repeat(64),
};
async function run(
	overrides: Record<string, unknown> = {},
	native = true,
	admitted = true,
	context: WorkstationTurnContext | null = null,
	sourceScope?: ComputerWorkspaceScope,
) {
	let starts = 0;
	const agent = tediDo({
		activeTurnBinding: {
			runId: "unrelated-run",
			conversationId: "unrelated-conversation",
			workItemId: "unrelated-work",
		},
		computerEnvironment: (scope: unknown, capturedContext: unknown) => {
			assert.equal(capturedContext, context);
			assert.deepEqual(
				scope,
				sourceScope ??
					(context?.workItemId
						? { kind: "delegated-run", key: context.workItemId }
						: context
							? {
									kind: "conversation",
									key: context.sessionKey ?? context.conversationId,
								}
							: { kind: "operator", key: "direct-control" }),
			);
			return {
				selected: async () =>
					native
						? {
								preparation: "repository",
								cwd: "/repos/fictional",
								leaseId: "lease-one",
								workstationId: "workstation-one",
							}
						: null,
			};
		},
		startWorkstationProcessTool: async (
			request: {
				processId: string;
				command: string;
				leaseId: string;
				workstationId: string;
			},
			captured: unknown,
		) => {
			starts++;
			assert.equal(captured, context);
			assert.equal(request.leaseId, "lease-one");
			assert.equal(request.workstationId, "workstation-one");
			assert.match(request.command, /tedix-exact-tree/);
			return { ok: admitted, processId: request.processId };
		},
		waitWorkstationJobTool: async (
			request: { leaseId: string; workstationId: string },
			captured: unknown,
		) => {
			assert.equal(captured, context);
			assert.equal(request.leaseId, "lease-one");
			assert.equal(request.workstationId, "workstation-one");
			return {
				ok: true,
				job: {
					terminal: true,
					exitCode: 0,
					stdoutTail: "TEDIX_EXACT_TREE " + JSON.stringify(receipt),
					artifactRefs: [
						"r2://fictional/processes/check/terminal/evidence.json",
					],
					artifactWriteStatus: { status: "persisted" },
					...overrides,
				},
			};
		},
	});
	return {
		result: await agent.runRepoCommitGate({ ...input, sourceScope }, context),
		starts,
	};
}

const success = await run();
const task = {
	sessionKey: "task-session",
	runId: "task-run",
	conversationId: "task-conversation",
	workItemId: "work-one",
};
assert.equal(
	(await run({}, true, true, task)).result.ok,
	true,
	"captured Work scope and selected lease survive unrelated ambient turn",
);
assert.equal(
	(
		await run({}, true, true, {
			runId: "task-run",
			conversationId: "mcp-run:task-run",
			workItemId: "work-one",
		})
	).result.ok,
	true,
	"authenticated MCP Work need not invent a session key",
);
assert.equal(
	(
		await run({}, true, true, {
			runId: "task-run",
			conversationId: "mcp-run:task-run",
		})
	).result.ok,
	true,
	"MCP conversation scope follows owning context contract",
);
assert.equal(
	(
		await run({}, true, true, null, {
			kind: "conversation",
			key: "captured-source",
		})
	).result.ok,
	true,
	"null binding retains actual source scope instead of operator fallback",
);
assert.equal(
	(await run({}, true, true, task, { kind: "operator", key: "direct-control" }))
		.starts,
	0,
	"task cannot redirect checks to operator scope",
);
assert.equal(
	(await run({}, true, true, { sessionKey: "incomplete" })).starts,
	0,
	"incomplete task identity cannot borrow an ambient operator/turn",
);
assert.equal(success.result.ok, true);
assert.equal(success.result.validation.resultTreeSha, receipt.resultTreeSha);
for (const invalid of [
	{ artifactRefs: [] },
	{ artifactWriteStatus: { status: "failed" } },
	{ terminal: false, ok: false },
	{ timedOut: true },
	{ canceled: true },
	{ exitCode: 1 },
	{ stdoutTail: "" },
	{
		stdoutTail:
			"TEDIX_EXACT_TREE " +
			JSON.stringify({ ...receipt, orderedChangesDigest: "d".repeat(64) }),
	},
]) {
	assert.equal((await run(invalid)).result.ok, false, JSON.stringify(invalid));
}
assert.equal(
	(await run({}, false)).starts,
	0,
	"scratch-only check cannot dispatch an unrelated native checkout",
);
assert.equal(
	(await run({}, true, false)).result.ok,
	false,
	"failed process admission cannot authorize publication",
);
console.log(
	"repository exact-tree gate: scope, admission, terminal evidence and immutable manifest fences passed",
);
