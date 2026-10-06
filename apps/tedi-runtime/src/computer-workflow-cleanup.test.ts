import assert from "node:assert/strict";
import { cleanupComputerWorkflow } from "./computer-workflow-cleanup";
import { ComputerEnvironmentController } from "./computer-environment";
const values = new Map<string, unknown>([
	["wfctx:wf", { runId: "run", workItemId: "work", sessionKey: "session" }],
]);
const storage = {
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async (key: string, value: unknown) => {
		values.set(key, value);
	},
	delete: async (key: string) => values.delete(key),
};
let releases = 0;
let canRelease = false;
let activeCode = true;
let defers = 0;
const controller = new ComputerEnvironmentController(
	storage,
	"computer",
	{
		open: async () => ({ ok: true, leaseId: "lease" }),
		status: async () => ({
			ok: true,
			readiness: { toolsReady: true, repoReady: true },
		}),
		close: async () => {
			releases++;
			return { ok: canRelease };
		},
		files: async () => ({}),
		start: async () => ({}),
		read: async () => ({}),
		wait: async () => ({}),
		cancel: async () => ({}),
	},
	undefined,
	"run",
);
await controller.open("repository");
const deps = {
	scope: () => ({ kind: "delegated-run" as const, key: "work" }),
	computer: () => controller,
	hasActiveCode: async () => activeCode,
	defer: async () => {
		defers++;
	},
};
await cleanupComputerWorkflow(
	storage as unknown as DurableObjectStorage,
	"wf",
	deps,
);
assert.equal(releases, 0, "paused code keeps its exact computer");
await cleanupComputerWorkflow(
	storage as unknown as DurableObjectStorage,
	"wf",
	deps,
);
assert.equal(defers, 2, "reconciliation can defer more than once");
assert.ok(values.has("wfctx:wf"));
activeCode = false;
await cleanupComputerWorkflow(
	storage as unknown as DurableObjectStorage,
	"wf",
	deps,
);
assert.equal(releases, 1);
assert.ok(values.has("wfctx:wf"), "failed cleanup keeps durable retry context");
canRelease = true;
await cleanupComputerWorkflow(
	storage as unknown as DurableObjectStorage,
	"wf",
	deps,
);
assert.equal(releases, 2);
assert.equal(values.has("wfctx:wf"), false);
assert.equal(defers, 3);
await cleanupComputerWorkflow(
	storage as unknown as DurableObjectStorage,
	"wf",
	deps,
);
assert.equal(releases, 2);
console.log(
	"Computer workflow cleanup preserves paused work and retries failures",
);

// A release that can never succeed must not retry forever: every retry destroys
// the container. Ten stuck contexts on a 60s timer between them destroy a
// workstation every couple of seconds, and no command lives long enough to
// write an exit code.
canRelease = false;
values.set("wfctx:wf", {
	runId: "run",
	sessionKey: "session",
	workItemId: "work",
});
await controller.open("repository");
const releasesBeforeBudget = releases;
const defersBeforeBudget = defers;
for (let attempt = 0; attempt < 8; attempt += 1)
	await cleanupComputerWorkflow(
		storage as unknown as DurableObjectStorage,
		"wf",
		deps,
	);
assert.equal(
	releases - releasesBeforeBudget,
	5,
	"a release that always fails stops after its bounded budget",
);
assert.equal(
	defers - defersBeforeBudget,
	4,
	"the attempt that spends the budget retires the context instead of re-arming",
);
assert.equal(values.has("wfctx:wf"), false);
console.log("Computer workflow cleanup bounds a release that cannot succeed");

const workflowInstanceId = "client-secret-workflow";
const runId = "client-secret-run";
const providerError = "provider-secret: private response and stack";
values.set(`wfctx:${workflowInstanceId}`, {
	runId,
	sessionKey: "client-secret-session",
	workItemId: "work",
});
const failedController = {
	selected: async () => null,
	finish: async () => ({ ok: false, error: providerError }),
} as unknown as ComputerEnvironmentController;
const errorCalls: unknown[][] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
	errorCalls.push(args);
};
try {
	for (let attempt = 0; attempt < 5; attempt += 1)
		await cleanupComputerWorkflow(
			storage as unknown as DurableObjectStorage,
			workflowInstanceId,
			{ ...deps, computer: () => failedController },
		);
} finally {
	console.error = originalError;
}
assert.equal(errorCalls.length, 6);
for (let attempt = 1; attempt <= 5; attempt += 1) {
	assert.deepEqual(errorCalls[attempt - 1], [
		{
			component: "tedi-runtime-computer",
			event: "tedi.computer.cleanup_incomplete",
			attempt,
			limit: 5,
		},
	]);
}
assert.deepEqual(errorCalls[5], [
	{
		component: "tedi-runtime-computer",
		event: "tedi.computer.cleanup_abandoned",
		attempt: 5,
		limit: 5,
	},
]);
for (const secret of [
	workflowInstanceId,
	runId,
	providerError,
	"client-secret-session",
])
	assert.equal(JSON.stringify(errorCalls).includes(secret), false);
assert.equal(values.has(`wfctx:${workflowInstanceId}`), false);
console.log(
	"Computer workflow cleanup logs bounded events without provider data",
);
