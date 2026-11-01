import assert from "node:assert/strict";
import { memoryStorage, tediDo } from "../test/tedi-do";
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";

const runId = buildRunId("tedi-1", "request-1", "mcp");
const workflowId = buildWorkflowInstanceId("request-1");
const cutoff = Date.parse("2026-10-31T12:00:00Z");

async function probe(options: {
	context?: { runId: string; admittedAt: number };
	status?: string;
	runId?: string;
	cutoff?: string;
}) {
	const storage = memoryStorage();
	if (options.context)
		await storage.put(`wfctx:${workflowId}`, options.context);
	let terminated = 0;
	const abort = new AbortController();
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage },
		activeTurnAborts: new Map([[runId, abort]]),
		async cascadeCancelFanout() {
			return { terminated: [] };
		},
		async clearWorkflowDispatch() {},
		env: {
			CHAT_TURN_WORKFLOW: {
				async get(id: string) {
					assert.equal(id, workflowId);
					return {
						async status() {
							return { status: options.status ?? "running" };
						},
						async terminate() {
							assert.equal(storage.data.has(`wfcancel:${runId}`), true);
							terminated++;
						},
					};
				},
			},
		},
	});
	const response = await agent.onRequest(
		new Request("https://do.internal/__internal/cleanup-orphan", {
			method: "POST",
			headers: { "X-Service-Binding": "true" },
			body: JSON.stringify({
				client_request_id: "request-1",
				run_id: options.runId ?? runId,
				orphaned_before: options.cutoff ?? new Date(cutoff).toISOString(),
			}),
		}),
	);
	return { response, terminated, abort, storage };
}

for (const context of [
	undefined,
	{ runId: "another-run", admittedAt: cutoff - 1 },
	{ runId, admittedAt: cutoff + 1 },
	{ runId, admittedAt: cutoff },
	{ runId, admittedAt: NaN },
]) {
	const result = await probe({ context });
	assert.equal(result.response.status, 409);
	assert.equal(result.terminated, 0);
	assert.equal(result.abort.signal.aborted, false);
	assert.equal(result.storage.data.has(`wfcancel:${runId}`), false);
}
for (const input of [
	{ runId: "other-tedi:mcp:request-1" },
	{ cutoff: "invalid" },
]) {
	const result = await probe(input);
	assert.equal(result.response.status, 400);
	assert.equal(result.terminated, 0);
}
for (const status of ["complete", "errored", "terminated"]) {
	const result = await probe({ status });
	assert.equal(result.response.status, 200);
	assert.equal((await result.response.json()).detail, "already_settled");
	assert.equal(result.terminated, 0);
	assert.equal(result.storage.data.has(`wfcancel:${runId}`), false);
}
const result = await probe({ context: { runId, admittedAt: cutoff - 1000 } });
assert.equal(result.response.status, 200);
assert.equal(result.terminated, 1);
assert.equal(result.abort.signal.aborted, true);
console.log(
	"PASS: orphan cleanup preserves newer/unknown dispatches and fences exact old work before terminating",
);

await assert.rejects(
	probe({ status: "unknown" }),
	/unverified_workflow_status/,
);
await assert.rejects(
	probe({ status: "rollingBack" }),
	/unverified_workflow_status/,
);
