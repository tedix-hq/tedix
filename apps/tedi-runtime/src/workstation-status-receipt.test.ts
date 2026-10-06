import { strict as assert } from "node:assert";
import { compactWorkstationStatusReceipt } from "./workstation-status-receipt";
import {
	readWorkstationStatus,
	readWorkstationStatusAdapter,
} from "./workstation";

const bootstrap = {
	environmentReady: false,
	repoReady: false,
	depsReady: false,
	nextAction: "wait_for_repo_sync",
	lastBootstrapError: null,
	installProcessId: "install-1",
	lastInstallExitCode: null,
	nextCommand: "bun install --frozen-lockfile --ignore-scripts",
};
const input = {
	ok: true,
	ready: false,
	status: "provisioning",
	bootstrap,
	repoSync: {
		status: "syncing",
		workdir: "/workspace/repo",
		executionId: "clone-1",
	},
	workstation: {
		id: "ws-1",
		status: "provisioning",
		metadata: { duplicated: "x".repeat(20_000) },
	},
	workstationLease: {
		id: "lease-1",
		workstationId: "ws-1",
		status: "active",
		expiresAt: "2026-09-05T23:00:00Z",
		workItemId: "work-1",
		attemptId: "attempt-1",
		capabilities: ["process"],
		metadata: { duplicated: "x".repeat(20_000) },
		participants: [{ metadata: { large: "x".repeat(10_000) } }],
	},
};
const before = JSON.stringify(input);
const compact = compactWorkstationStatusReceipt(input);
assert.equal(compact.ready, false);
assert.equal(compact.status, "provisioning");
assert.deepEqual(compact.bootstrap, bootstrap);
assert.deepEqual(compact.repoSync, input.repoSync);
assert.deepEqual(compact.workstation, { id: "ws-1", status: "provisioning" });
assert.deepEqual(compact.workstationLease, {
	id: "lease-1",
	workstationId: "ws-1",
	workItemId: "work-1",
	attemptId: "attempt-1",
	status: "active",
	expiresAt: "2026-09-05T23:00:00Z",
	capabilities: ["process"],
});
assert.equal(
	JSON.stringify(input),
	before,
	"canonical state must not be mutated",
);
assert.ok(JSON.stringify(compact).length < before.length / 10);
for (const state of [
	{ ok: false, error: "FORBIDDEN", retryable: false },
	{ ok: true, ready: true, status: "ready" },
	{
		ok: true,
		ready: false,
		status: "blocked",
		setupError: "install failed",
		bootstrap: {
			...bootstrap,
			nextAction: "settle",
			lastBootstrapError: "exit 1",
			lastInstallExitCode: 1,
		},
	},
])
	assert.deepEqual(compactWorkstationStatusReceipt(state), state);
const env = {
	TEDI_SERVICE: {
		fetch: async () => Response.json(input),
	} as unknown as Fetcher,
};
const identity = { orgId: "org-1", slug: "cto", tediId: "tedi-1" };
const request = { leaseId: "lease-1", workstationId: "ws-1" };
assert.deepEqual(
	await readWorkstationStatusAdapter(env, identity, request),
	input,
);
const model = await readWorkstationStatus(env, identity, request);
assert.deepEqual(model, {
	...compact,
	leaseId: "lease-1",
	workstationId: "ws-1",
});
console.log("workstation-status-receipt OK");
