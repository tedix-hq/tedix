import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

function probe() {
	return tediDo({
		state: {},
		setState(state: unknown) {
			this.state = state;
		},
	});
}

{
	const agent = probe();
	agent.recordPendingTraceIds(
		"run-0",
		["rationale-a", "", "rationale-a"],
		["artifact-a"],
	);
	agent.recordPendingTraceIds(
		"run-0",
		["rationale-b", "rationale-a"],
		["artifact-a", "artifact-b"],
	);
	assert.deepEqual(agent.getPendingTraceIds("run-0"), {
		rationaleRecordIds: ["rationale-a", "rationale-b"],
		artifactIds: ["artifact-a", "artifact-b"],
	});
	for (let index = 1; index <= 50; index++) {
		agent.recordPendingTraceIds(`run-${index}`, [], []);
	}
	assert.equal(agent.state.pendingTraceIds.length, 50);
	assert.equal(agent.state.pendingTraceIds[0].runId, "run-1");
	assert.deepEqual(agent.getPendingTraceIds("run-0"), {
		rationaleRecordIds: [],
		artifactIds: [],
	});
}

{
	const agent = probe();
	const stepNumber = agent.bufferFacetToolCall("run-a", "read");
	assert.equal(stepNumber, 0);
	assert.equal(agent.bufferFacetToolCall("run-a", "write"), 1);
	agent.bufferFacetToolCall("run-b", "ls");
	assert.equal(agent.peekToolResultCount("run-a"), 0);
	assert.equal(agent.peekTotalTokens("missing"), null);
	assert.deepEqual(agent.toolCallRefsForRun("run-a"), [
		"run-a:step:0:0:read",
		"run-a:step:1:0:write",
	]);
	await agent.completeFacetToolCall({
		runId: "run-a",
		stepNumber,
		toolName: "read",
		finishReason: "facet-tool-error",
		resultDigest: "sha256:example",
	});
	assert.equal(agent.peekToolResultCount("run-a"), 1);
	assert.equal(agent.runHadFacetToolError("run-a"), true);
	assert.equal(agent.runHadFacetToolError("run-b"), false);
	const steps = agent.takePendingToolSteps("run-a");
	assert.equal(steps.length, 2);
	assert.equal(steps[0].resultDigest, "sha256:example");
	assert.deepEqual(agent.takePendingToolSteps("run-a"), []);
	assert.equal(agent.peekPendingToolSteps("run-b").length, 1);
	await agent.completeFacetToolCall({
		runId: "missing",
		stepNumber: 0,
		toolName: "read",
		finishReason: "facet-tool-proxy",
	});
	assert.equal(agent.state.pendingToolSteps.length, 1);
}

console.log("runtime trace buffer characterization passed");
