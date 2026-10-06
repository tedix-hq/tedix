import assert from "node:assert/strict";
import { computerMcpContext as resolveContext } from "./computer-mcp-context";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
const computerMcpContext = (request: Request) =>
	resolveContext(request, { kind: "operator", key: "direct-control" });
const request = (meta: unknown) =>
	new Request("https://tedi/mcp", {
		method: "POST",
		body: JSON.stringify({ params: { _meta: meta } }),
	});
const a = await computerMcpContext(
	request({ "io.tedix/kernelRunId": "run-a", "io.tedix/workItemId": "work-a" }),
);
assert.deepEqual(a.scope, { kind: "delegated-run", key: "work-a" });
assert.equal(a.turnContext?.workItemId, "work-a");
assert.deepEqual(
	a.scope,
	(
		await computerMcpContext(
			request({
				"io.tedix/kernelRunId": "run-b",
				"io.tedix/workItemId": "work-a",
			}),
		)
	).scope,
);
await assert.rejects(
	computerMcpContext(request({ "io.tedix/workItemId": "work-a" })),
	/run ID/,
);
assert.equal((await computerMcpContext(request({}))).scope.kind, "operator");

// The skill-runtime bridge carries a Work Item without a kernel run. Its
// authenticated workflow header must keep artifact and other MCP calls alive.
const skillRequest = request({ "io.tedix/workItemId": "work-skill" });
skillRequest.headers.set("X-Tedix-Skill-Run-Id", "skill-run-a");
await assert.rejects(computerMcpContext(skillRequest), /run ID/);
skillRequest.headers.set(
	TEDI_MCP_AUTH_CONTEXT_HEADER,
	encodeTediMcpCaller({
		method: "jwt",
		principalId: "user-a",
		principalType: "user",
		scopes: [],
	}),
);
await assert.rejects(computerMcpContext(skillRequest), /run ID/);
skillRequest.headers.set(
	TEDI_MCP_AUTH_CONTEXT_HEADER,
	encodeTediMcpCaller({
		method: "service",
		principalId: "gateway",
		principalType: "service",
		scopes: [],
	}),
);
const skill = await computerMcpContext(skillRequest);
assert.deepEqual(skill.scope, { kind: "delegated-run", key: "work-skill" });
assert.equal(skill.turnContext?.runId, "skill-run-a");
assert.equal(skill.turnContext?.workItemId, "work-skill");
skillRequest.headers.set("X-Tedix-Skill-Run-Id", "   ");
await assert.rejects(computerMcpContext(skillRequest), /run ID/);
