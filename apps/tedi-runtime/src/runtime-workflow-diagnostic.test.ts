import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import { tedis } from "@tedix/db/schema/tedis";
import {
	readOwnedRuntimeWorkflow,
	runtimeWorkflowDiagnosticRunId,
} from "./runtime-workflow-diagnostic";
import { handleMcp } from "./mcp-mount";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

const sqlite = new DatabaseSync(":memory:");
for (const table of [tedis])
	for (const ddl of tableDdl(table, { foreignKeys: false })) sqlite.exec(ddl);
const DB = createD1Facade(sqlite),
	db = createDbClient(DB);
await db.insert(tedis).values({
	id: "tedi-1",
	name: "Fixture",
	slug: "fixture",
	organizationId: "org-1",
});
const runId = "tedi-1:mcp:client-1",
	conversationId = "fixture:session-1";
const original = {
	id: "client-1",
	stage: "dispatched",
	params: {
		runId,
		agentName: "agent-1",
		clientRequestId: "client-1",
		sessionKey: "session-1",
		conversationId,
		userText: "private prompt",
	},
};
let record: unknown = original;
let dispatchContext: Record<string, unknown> | undefined;
let nativeStatus: unknown = {
	status: "queued",
	output: "private prompt",
	error: { message: "private secret" },
};
let failure: unknown;
const gets: string[] = [],
	keys: string[] = [];
const env = {
	DB,
	GIT_SHA: "source-fixture",
	CHAT_TURN_WORKFLOW: {
		get: async (id: string) => {
			gets.push(id);
			if (failure) throw failure;
			return { status: async () => nativeStatus };
		},
	},
} as unknown as Cloudflare.Env;
const storage = {
	get: async (key: string) => {
		keys.push(key);
		return key.startsWith("wfctx:") ? dispatchContext : record;
	},
} as unknown as Pick<DurableObjectStorage, "get">;
const scope = {
	runId,
	tediId: "tedi-1",
	orgId: "org-1",
	agentName: "agent-1",
	env,
	storage,
};
for (const [status, expected] of [
	["queued", "queued"],
	["running", "running"],
	["waiting", "waiting"],
	["paused", "paused"],
	["complete", "completed"],
	["errored", "failed"],
	["terminated", "canceled"],
	["unknown", "not_available"],
]) {
	nativeStatus = {
		status,
		output: "private prompt",
		error: { message: "private secret" },
	};
	const result = await readOwnedRuntimeWorkflow(scope);
	assert.equal(result.status, expected);
	assert.equal(result.association, "verified");
	assert.equal(result.nativeWorkflowId, "client-1");
	assert.equal(JSON.stringify(result).includes("private"), false);
}
assert.ok(
	keys.every(
		(key) =>
			key === `runtime-admission-workflow:${runId}` || key === "wfctx:client-1",
	),
);
assert.ok(gets.every((id) => id === "client-1"));
for (const changed of [
	{ runId: "tedi-other:mcp:client-1" },
	{ orgId: "other-org" },
	{ tediId: "other-tedi" },
]) {
	const n: number = gets.length;
	await assert.rejects(
		readOwnedRuntimeWorkflow({ ...scope, ...changed }),
		/OWNER_MISMATCH/,
	);
	assert.equal(gets.length, n);
}
for (const changed of [
	undefined,
	{ id: "caller-selected-id", params: original.params },
	{
		...original,
		id: "client-other",
		params: { ...original.params, clientRequestId: "client-other" },
	},
	{
		...original,
		params: { ...original.params, clientRequestId: "<<<>>>" },
	},
	{
		...original,
		params: { ...original.params, runId: "other" },
	},
	{
		...original,
		params: { ...original.params, agentName: "other" },
	},
	{
		...original,
		params: { ...original.params, conversationId: "other" },
	},
]) {
	record = changed;
	const n: number = gets.length;
	const result = await readOwnedRuntimeWorkflow(scope);
	assert.equal(result.status, "not_available");
	assert.equal(gets.length, n);
}
record = original;
// A verified association reports how long the native instance waited for its
// first checkpoint, so a queued delay is attributable.
const admittedAt = Date.now() - 90_000;
const dispatchBase = {
	runId,
	sessionKey: "session-1",
	userText: "private prompt",
	userTs: admittedAt,
	admittedAt,
	restartCount: 1,
};
dispatchContext = dispatchBase;
nativeStatus = { status: "queued" };
{
	const result = await readOwnedRuntimeWorkflow(scope);
	assert.equal(result.status, "queued");
	const timing = "dispatchTiming" in result ? result.dispatchTiming : undefined;
	assert.ok(timing);
	assert.equal(timing.admittedAt, admittedAt);
	assert.equal(timing.startedAt, null);
	assert.equal(timing.startDelayMs, null);
	assert.equal(timing.restartCount, 1);
	assert.ok(timing.ageMs >= 80_000);
	assert.equal(JSON.stringify(result).includes("private"), false);
}
dispatchContext = { ...dispatchBase, startedAt: admittedAt + 2_500 };
nativeStatus = { status: "running" };
{
	const result = await readOwnedRuntimeWorkflow(scope);
	assert.equal(result.status, "running");
	const timing = "dispatchTiming" in result ? result.dispatchTiming : undefined;
	assert.equal(timing?.startDelayMs, 2_500);
}
for (const changed of [
	{ ...dispatchBase, runId: "other" },
	{ runId, admittedAt: "soon" },
	"not a record" as unknown as Record<string, unknown>,
]) {
	dispatchContext = changed;
	const result = await readOwnedRuntimeWorkflow(scope);
	assert.equal(result.status, "running");
	assert.equal("dispatchTiming" in result, false);
}
dispatchContext = undefined;
failure = { status: 404, message: "private secret" };
assert.equal((await readOwnedRuntimeWorkflow(scope)).status, "missing");
failure = new Error("private secret");
assert.equal((await readOwnedRuntimeWorkflow(scope)).status, "not_available");
failure = undefined;
assert.equal(
	(
		await readOwnedRuntimeWorkflow({
			...scope,
			env: {
				...env,
				CHAT_TURN_WORKFLOW: undefined,
			} as unknown as Cloudflare.Env,
		})
	).status,
	"not_available",
);
assert.equal(
	runtimeWorkflowDiagnosticRunId(`runtime-workflows/${runId}/status.json`),
	runId,
);
assert.equal(runtimeWorkflowDiagnosticRunId("AGENTS.md"), null);
assert.throws(
	() => runtimeWorkflowDiagnosticRunId("runtime-workflows/../status.json"),
	/PATH_INVALID/,
);
assert.throws(
	() =>
		runtimeWorkflowDiagnosticRunId(
			"runtime-workflows/other/status.json?token=x",
		),
	/PATH_INVALID/,
);

const request = (scopes: string[]) =>
	new Request("https://fixture.tedi.example/mcp", {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "artifact_read_file",
			"Mcp-Protocol-Version": "2026-07-28",
			[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
				method: "jwt",
				principalId: "owner-1",
				principalType: "user",
				scopes,
			}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "artifact_read_file",
				arguments: { path: `runtime-workflows/${runId}/status.json` },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": {
						name: "diagnostic-test",
						version: "1",
					},
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
let callbacks = 0;
const tools = {
	conversationGet: async () => ({}),
	conversationsList: async () => ({}),
	messagesRead: async () => ({}),
	messagesSend: async () => ({}),
	readArtifactFile: async (args: { path: string }) => {
		callbacks++;
		return readOwnedRuntimeWorkflow({
			...scope,
			runId: runtimeWorkflowDiagnosticRunId(args.path)!,
		});
	},
};
assert.equal(
	(await handleMcp(request(["tedi:channel.read"]), "fixture", tools)).status,
	403,
);
assert.equal(callbacks, 0);
nativeStatus = { status: "queued" };
const response = await handleMcp(
	request(["tedi:config.read"]),
	"fixture",
	tools,
);
assert.equal(response.status, 200);
assert.equal(callbacks, 1);
assert.match(JSON.stringify(await response.json()), /owned-runtime-workflow/);
sqlite.close();
