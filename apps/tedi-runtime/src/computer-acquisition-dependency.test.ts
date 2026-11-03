import assert from "node:assert/strict";
import { ComputerEnvironmentController } from "./computer-environment";

const values = new Map<string, unknown>();
const store = {
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async <T>(key: string, value: T) => {
		values.set(key, value);
	},
	delete: async (key: string) => values.delete(key),
};
const work = {
	workItemId: "fixture-work",
	attemptId: "fixture-attempt",
	tediId: "fixture-tedi",
};
let provisions = 0;
let reads = 0;
let fiberStatus = "completed";
const forbidden = async (): Promise<never> => {
	throw new Error("Unexpected effect");
};
const actions = {
	open: async () => ({ ok: true, leaseId: `fixture-lease-${++provisions}` }),
	status: async () => {
		reads++;
		return {
			ok: true,
			ready: false,
			workstationLease: { id: "fixture-lease-1", status: "active", ...work },
			readiness: { toolsReady: true, repoReady: false },
			repoSync: { configured: false, status: "not_configured" },
			bootstrap: { nextAction: "open_computer" },
			provisioningFiber: { fiberId: "fixture-fiber", status: fiberStatus },
		};
	},
	close: forbidden,
	files: forbidden,
	start: forbidden,
	read: forbidden,
	wait: forbidden,
	cancel: forbidden,
};
const controller = new ComputerEnvironmentController(
	store,
	"fixture-scope",
	actions,
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
	},
	"fixture-run",
	undefined,
	{ budgetMs: 15, now: () => 0, captureAuthority: async () => work },
);
for (const call of ["first", "continuation"]) {
	const result = (await controller.open("repository", call)) as Record<
		string,
		unknown
	>;
	assert.equal(result.ok, false);
	assert.equal(result.ready, false);
	assert.equal(result.dependency, "repository_not_configured");
	assert.match(String(result.instruction), /configur/i);
	assert.doesNotMatch(
		String(result.instruction),
		/still starting|returns ready:true/,
	);
}
assert.equal(provisions, 1);
assert.equal(reads, 2, "a settled dependency must not poll until the deadline");
assert.equal((await controller.selected())?.leaseId, "fixture-lease-1");

const successor = new ComputerEnvironmentController(
	store,
	"fixture-scope",
	actions,
	async () => {},
	"successor-run",
	undefined,
	{
		captureAuthority: async () => ({ ...work, attemptId: "successor-attempt" }),
	},
);
const result = (await successor.open("repository", "successor")) as Record<
	string,
	unknown
>;
assert.equal(result.ok, false);
assert.equal(result.dependency, "computer_attempt_ownership");
assert.equal(
	provisions,
	1,
	"a different Attempt must not allocate a replacement",
);
assert.equal((await successor.selected())?.leaseId, "fixture-lease-1");
assert.equal(values.get("fixture-scope:owner"), "fixture-run");
assert.equal(values.has("computer-acquisition:successor"), false);
const refusedExec = (await successor.exec({
	command: "must not execute",
})) as Record<string, unknown>;
assert.equal(refusedExec.dependency, "computer_attempt_ownership");
assert.equal(values.get("fixture-scope:owner"), "fixture-run");
const changedAttempt = new ComputerEnvironmentController(
	store,
	"fixture-scope",
	actions,
	async () => {},
	"fixture-run",
	undefined,
	{ captureAuthority: async () => ({ ...work, attemptId: "changed-attempt" }) },
);
const denied = (await changedAttempt.open(
	"repository",
	"changed-attempt-call",
)) as Record<string, unknown>;
assert.equal(denied.dependency, "computer_attempt_ownership");
assert.equal(values.has("computer-acquisition:changed-attempt-call"), false);
for (const terminal of ["error", "aborted"]) {
	fiberStatus = terminal;
	const failure = (await controller.open(
		"repository",
		`ended-${terminal}`,
	)) as Record<string, unknown>;
	assert.equal(failure.dependency, "computer_provisioning_ended");
	assert.equal(failure.ready, false);
	assert.equal(provisions, 1);
}
// Passive not_configured is not a terminal diagnosis while native work runs.
let activeReads = 0;
const active = new ComputerEnvironmentController(
	store,
	"active-scope",
	{
		...actions,
		open: async () => ({ ok: true, leaseId: "active-lease" }),
		status: async () => ({
			ok: true,
			ready: ++activeReads >= 2,
			workstationLease: { id: "active-lease", status: "active", ...work },
			readiness: { toolsReady: true, repoReady: activeReads >= 2 },
			repoSync: { configured: false, status: "not_configured" },
			provisioningFiber: { fiberId: "active-fiber", status: "running" },
		}),
	},
	async () => {},
	"active-run",
	undefined,
	{ captureAuthority: async () => work },
);
assert.equal(
	((await active.open("repository", "active-open")) as { ready: boolean })
		.ready,
	true,
);
assert.equal(activeReads, 2);

// Match the reported observations without inventing a native failure or progress.
let uncertainOpens = 0;
const uncertain = new ComputerEnvironmentController(
	store,
	"uncertain-scope",
	{
		...actions,
		open: async () => {
			uncertainOpens++;
			return { ok: true, leaseId: "uncertain-lease" };
		},
		status: async (_environment, _timeout, refreshNative) =>
			refreshNative
				? { ok: true, ready: false }
				: {
						ok: true,
						ready: false,
						workstationLease: {
							id: "uncertain-lease",
							status: "active",
							...work,
						},
						repoSync: { configured: false, status: "not_configured" },
						bootstrap: { nextAction: "open_computer" },
					},
	},
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 2));
	},
	"uncertain-run",
	undefined,
	{ budgetMs: 15, now: () => 0, captureAuthority: async () => work },
);
for (const call of ["uncertain-first", "uncertain-continuation"]) {
	const pending = (await uncertain.open("repository", call)) as Record<
		string,
		unknown
	>;
	assert.equal(pending.dependency, "native_readiness_receipt");
	assert.equal(pending.ready, false);
	assert.doesNotMatch(
		String(pending.instruction),
		/still starting|not a provisioning failure|returns ready:true/,
	);
	assert.equal(pending.leaseId, undefined);
	assert.equal(pending.cwd, undefined);
}
assert.equal(uncertainOpens, 1);
assert.equal((await uncertain.selected())?.leaseId, "uncertain-lease");
console.log(
	"Computer acquisition: settled repository dependency and immutable Attempt continuation pass",
);
