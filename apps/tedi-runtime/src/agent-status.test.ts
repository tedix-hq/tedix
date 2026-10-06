import assert from "node:assert/strict";
import {
	type AgentHealthProbe,
	type AgentStatusTedi,
	agentStatusPayload,
	agentWakePayload,
	buildAgentHealthRequest,
	cronSyncEdgeDecision,
	parseAgentHealthBody,
} from "./agent-status";

const tedi: AgentStatusTedi = {
	id: "tedi-cto",
	isolateAgentId: "agent-cto",
	orgId: "org-tedix",
	slug: "cto",
};

const healthyProbe: AgentHealthProbe = {
	body: { recentTurnCount: 7, service: "tedi-runtime-do", status: "ok" },
	ms: 12,
	ok: true,
	status: 200,
};

{
	const request = buildAgentHealthRequest(
		new Request("https://cto.tedi.tedix.dev/api/status?readiness=1", {
			headers: { "X-Existing": "value" },
		}),
		tedi,
	);
	const url = new URL(request.url);
	assert.equal(request.method, "GET");
	assert.equal(url.pathname, "/health");
	assert.equal(url.search, "");
	assert.equal(request.headers.get("X-Existing"), "value");
	assert.equal(request.headers.get("X-Tedi-Id"), "tedi-cto");
	assert.equal(request.headers.get("X-Tedi-Org-Id"), "org-tedix");
	assert.equal(request.headers.get("X-Tedi-Slug"), "cto");
}

assert.deepEqual(parseAgentHealthBody('{"status":"ok"}'), { status: "ok" });
assert.deepEqual(parseAgentHealthBody("[1,2]"), [1, 2]);
assert.equal(parseAgentHealthBody("not-json"), "not-json");
assert.equal(parseAgentHealthBody("{bad"), "{bad");

{
	const body = agentStatusPayload(tedi, healthyProbe);
	assert.equal(body.ok, true);
	assert.equal(body.status, "running");
	assert.equal(body.processId, "agent-cto");
	assert.equal(body.readiness.ready, true);
	assert.equal(body.readiness.httpStatus, 200);
	assert.equal(body.processSummary.historyCount, 7);
	assert.equal(body.processSummary.runningCount, 1);
	assert.equal(body.processes[0]?.id, "agent-cto");
}

{
	const failedProbe: AgentHealthProbe = {
		body: null,
		error: "connect failed",
		ms: 20,
		ok: false,
		status: 503,
	};
	const status = agentStatusPayload(tedi, failedProbe);
	assert.equal(status.ok, false);
	assert.equal(status.status, "starting");
	assert.deepEqual(status.readiness.failing, ["agent_do_health"]);
	assert.equal(status.processSummary.runningCount, 0);

	const wake = agentWakePayload(tedi, failedProbe, 20);
	assert.equal(wake.success, false);
	assert.equal(wake.ready, false);
	assert.equal(wake.woke, false);
	assert.equal(wake.message, "connect failed");
}

{
	assert.equal(
		cronSyncEdgeDecision(
			new Request("https://cmo.tedi.tedix.dev/__internal/cron/sync", {
				method: "POST",
			}),
		),
		"deny_internal_path",
	);
	assert.equal(
		cronSyncEdgeDecision(
			new Request("https://cmo.tedi.tedix.dev/api/cron/sync", {
				headers: { "X-Service-Binding": "true" },
				method: "GET",
			}),
		),
		"method_not_allowed",
	);
	assert.equal(
		cronSyncEdgeDecision(
			new Request("https://cmo.tedi.tedix.dev/api/cron/sync", {
				method: "POST",
			}),
		),
		"forbidden",
	);
	assert.equal(
		cronSyncEdgeDecision(
			new Request("https://cmo.tedi.tedix.dev/api/cron/sync", {
				headers: { "X-Service-Binding": "true" },
				method: "POST",
			}),
		),
		"forward",
	);
}

console.log("agent-status tests passed");
