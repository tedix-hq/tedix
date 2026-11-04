import assert from "node:assert/strict";
import * as z from "zod";
import { RpcCallError } from "@tedix/api-client/internal";
import type { PlatformClient } from "./brain/platform-client";
import { delegatedWorkTools } from "./delegated-work-tools";
import {
	delegatedCloseoutProjects,
	closeoutRequiresHuman,
} from "@tedix/api-contract/utils/delegated-work-closeout";

const project = "11111111-1111-4111-8111-111111111111";
const request = `Work backlog hygiene in project ${project}: Mark each completed with a closing comment.`;
assert.deepEqual(delegatedCloseoutProjects(request), [project]);
for (const denied of [
	`Read-only: ${request}`,
	request.replace("Mark", "Do not mark"),
	`Explain this quoted task:\n> ${request}`,
	`Explain this code: \x60\x60\x60${request}\x60\x60\x60`,
])
	assert.deepEqual(delegatedCloseoutProjects(denied), []);
assert.deepEqual(
	delegatedCloseoutProjects(`Read Work history. Brief: ${request}`),
	[],
);
assert.deepEqual(
	delegatedCloseoutProjects(
		`Read Work history.\n\nLocal terminal context:\n- cwd: ${request}`,
	),
	[],
);
assert.deepEqual(
	delegatedCloseoutProjects(
		"Work backlog hygiene: Mark each completed with a closing comment.",
	),
	[],
);
for (const correction of [
	"*",
	"native:close_completed_work_item",
	"tool:tedix:tedix__add_comment",
	"work.complete_work_item",
])
	assert.equal(closeoutRequiresHuman([correction]), true);
assert.equal(closeoutRequiresHuman(["native:read"]), false);
let observed: unknown;
const tools = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
	getPlatform: async () =>
		({
			closeoutDelegatedWorkItem: async (
				input: Parameters<PlatformClient["closeoutDelegatedWorkItem"]>[0],
			) => {
				observed = input;
				return { id: input.id };
			},
		}) as unknown as PlatformClient,
});
assert.deepEqual(Object.keys(tools), ["close_completed_work_item"]);
assert.equal(tools.close_completed_work_item!.needsApproval, true);
await tools.close_completed_work_item!.execute!(
	{ id: "target", sha: "a".repeat(40) },
	{ toolCallId: "call", messages: [], context: {} },
);
assert.deepEqual(observed, {
	id: "target",
	sha: "a".repeat(40),
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
});
const unavailable = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
	getPlatform: async () => null,
});
await assert.rejects(
	async () =>
		unavailable.close_completed_work_item!.execute!(
			{ id: "target", sha: "a".repeat(40) },
			{ toolCallId: "call", messages: [], context: {} },
		),
	/platform identity/,
);
console.log("delegated-work-tools tests passed");

const targetId = "22222222-2222-4222-8222-222222222222";
const linkedId = "33333333-3333-4333-8333-333333333333";
const receiptId = `home:steward-closeout:${targetId}:v2`;
const metadata = {
	source: "native-steward-closeout.v1",
	homeRunId: "home",
	childRunId: "run",
	linkedWorkItemId: linkedId,
	targetWorkItemVersion: 2,
};
let writeCalls = 0;
let readCalls = 0;
let receiptMetadata = { ...metadata };
let workVersion = 3;
let readFails = false;
const targets = [
	{
		id: targetId,
		expectedWorkItemVersion: 2,
		repositoryTargetId: "fixture-repo",
	},
];
const native = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: linkedId,
	stewardCloseoutTargets: targets,
	getPlatform: async () =>
		({
			inspectStewardWork: async (
				bound: Parameters<PlatformClient["inspectStewardWork"]>[0],
			) => {
				readCalls++;
				observed = bound;
				if (readFails) throw new Error("read unavailable");
				return {
					workItem: {
						id: targetId,
						disposition: writeCalls === 0 ? "accepted" : "completed",
						version: writeCalls === 0 ? 2 : workVersion,
					},
					comments: [
						{ id: receiptId, workItemId: targetId, metadata: receiptMetadata },
					],
					latestAttempt: null,
				};
			},
			completeStewardWork: async () => {
				writeCalls++;
				throw new Error("response lost after possible commit");
			},
		}) as unknown as PlatformClient,
});
const options = { toolCallId: "native-call", messages: [], context: {} };
assert.ok(native.read_steward_work);
assert.ok(native.complete_steward_work);
assert.equal(native.complete_steward_work.needsApproval, true);
assert.ok(native.complete_steward_work.inputSchema instanceof z.ZodType);
assert.equal(
	native.complete_steward_work.inputSchema.safeParse({
		id: targetId,
		sha: "a".repeat(40),
	}).success,
	false,
);
targets[0]!.expectedWorkItemVersion = 99;
await native.read_steward_work.execute!({ id: targetId }, options);
assert.deepEqual(observed, {
	id: targetId,
	nativeStewardCloseout: {
		homeRunId: "home",
		runId: "run",
		linkedWorkItemId: linkedId,
		expectedWorkItemVersion: 2,
	},
});
await assert.rejects(
	async () => native.read_steward_work!.execute!({ id: project }, options),
	/approved steward target/,
);
assert.equal(readCalls, 1, "unapproved target fails before API access");
for (const bad of [
	{ ...metadata, source: "other" },
	{ ...metadata, homeRunId: "other" },
	{ ...metadata, childRunId: "other" },
	{ ...metadata, linkedWorkItemId: project },
	{ ...metadata, targetWorkItemVersion: 1 },
]) {
	receiptMetadata = bad;
	assert.equal(
		(
			(await native.complete_steward_work.execute!(
				{ id: targetId },
				options,
			)) as { status?: string }
		).status,
		"unknown",
	);
}
assert.equal(
	writeCalls,
	1,
	"unknown results never repeat the completion write",
);
receiptMetadata = metadata;
workVersion = 4;
assert.equal(
	(
		(await native.complete_steward_work.execute!(
			{ id: targetId },
			options,
		)) as { status?: string }
	).status,
	"unknown",
);
workVersion = 3;
readFails = true;
assert.equal(
	(
		(await native.complete_steward_work.execute!(
			{ id: targetId },
			options,
		)) as { status?: string }
	).status,
	"unknown",
);
readFails = false;
assert.equal(
	(
		(await native.complete_steward_work.execute!(
			{ id: targetId },
			options,
		)) as { id?: string }
	).id,
	targetId,
);
assert.equal(
	writeCalls,
	1,
	"matching receipt resolves uncertainty using readback only",
);
const reconstructed = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: linkedId,
	stewardCloseoutTargets: [{ ...targets[0]!, expectedWorkItemVersion: 2 }],
	getPlatform: async () =>
		({
			inspectStewardWork: async () => ({
				workItem: { id: targetId, disposition: "completed", version: 3 },
				comments: [{ id: receiptId, workItemId: targetId, metadata }],
				latestAttempt: null,
			}),
			completeStewardWork: async () => {
				throw new Error("matching existing receipt must prevent a write");
			},
		}) as unknown as PlatformClient,
});
assert.equal(
	(
		(await reconstructed.complete_steward_work!.execute!(
			{ id: targetId },
			options,
		)) as { id: string }
	).id,
	targetId,
);
const independentWrites: string[] = [];
const independent = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: linkedId,
	stewardCloseoutTargets: [targetId, project].map((id) => ({
		id,
		expectedWorkItemVersion: 2,
		repositoryTargetId: "fixture-repo",
	})),
	getPlatform: async () =>
		({
			inspectStewardWork: async ({
				id,
			}: Parameters<PlatformClient["inspectStewardWork"]>[0]) => ({
				workItem: { id, disposition: "accepted", version: 2 },
				comments: [],
				latestAttempt: null,
			}),
			completeStewardWork: async ({
				id,
			}: Parameters<PlatformClient["completeStewardWork"]>[0]) => {
				independentWrites.push(id);
				return { id };
			},
		}) as unknown as PlatformClient,
});
for (const id of [targetId, project])
	await independent.complete_steward_work!.execute!({ id }, options);
assert.deepEqual(
	independentWrites,
	[targetId, project],
	"one target does not lock a different allowed target",
);
console.log(
	"native steward target binding and uncertain completion readback passed",
);

let rejectedWrites = 0;
let rejectInspection = true;
const rejection = new RpcCallError(
	"workItems/complete",
	403,
	JSON.stringify({
		message:
			"A matching registered repository delivery target is unavailable. Authorization: Bearer private-token-value",
		privateDiagnostic: "body-only-secret",
	}),
	"Forbidden",
	new Error("private-cause"),
);
const rejected = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: linkedId,
	stewardCloseoutTargets: [
		{
			id: targetId,
			expectedWorkItemVersion: 2,
			repositoryTargetId: "fixture-repo",
		},
	],
	getPlatform: async () =>
		({
			inspectStewardWork: async () => {
				if (rejectInspection) throw rejection;
				return {
					workItem: { id: targetId, disposition: "accepted", version: 2 },
					comments: [],
					latestAttempt: null,
				};
			},
			completeStewardWork: async () => {
				rejectedWrites++;
				throw rejection;
			},
		}) as unknown as PlatformClient,
});
const beforeWrite = (await rejected.complete_steward_work!.execute!(
	{ id: targetId },
	options,
)) as { status: string; message: string };
assert.equal(beforeWrite.status, "blocked");
assert.match(
	beforeWrite.message,
	/No completion was sent.*registered repository delivery target/,
);
assert.doesNotMatch(
	beforeWrite.message,
	/may have committed|private-token-value|body-only-secret|private-cause|RpcCallError/,
);
assert.equal(rejectedWrites, 0);
rejectInspection = false;
for (let replay = 0; replay < 2; replay++) {
	const afterWrite = (await rejected.complete_steward_work!.execute!(
		{ id: targetId },
		options,
	)) as { status: string; message: string };
	assert.equal(afterWrite.status, "unknown");
	assert.match(
		afterWrite.message,
		/may have committed.*registered repository delivery target/,
	);
	assert.doesNotMatch(
		afterWrite.message,
		/No completion was sent|private-token-value|body-only-secret|private-cause/,
	);
}
assert.equal(
	rejectedWrites,
	1,
	"an explicit rejection after send still never authorizes blind resend",
);
