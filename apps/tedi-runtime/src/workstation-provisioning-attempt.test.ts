import { workstationPreparationObservation } from "./workstation-provisioning-attempt";
import assert from "node:assert/strict";
import type { FiberInspection } from "agents";
import {
	admitWorkstationProvisioning,
	observeWorkstationRefresh,
	workstationRefreshKey,
	isActiveWorkstationProvisioningFiber,
	latestWorkstationProvisioningFiber,
	shouldStartWorkstationProvisioningSuccessor,
	WORKSTATION_PROVISION_MAX_ATTEMPTS,
	workstationProvisioningAttemptNumber,
	workstationProvisioningAttemptKey,
	workstationProvisioningBaseKey,
	workstationProvisioningFiberMetadata,
	workstationProvisioningFiberName,
} from "./workstation-provisioning-attempt";

function fiber(
	fiberId: string,
	status: FiberInspection["status"],
	createdAt: number,
	settledAt?: number,
	provisioningAttempt?: number,
): FiberInspection {
	return {
		createdAt,
		fiberId,
		name: workstationProvisioningFiberName("lease-1"),
		settledAt,
		status,
		metadata:
			provisioningAttempt === undefined ? undefined : { provisioningAttempt },
	};
}

const baseKey = workstationProvisioningBaseKey("lease-1");
assert.equal(baseKey, "workstation-provision:lease-1");
assert.equal(workstationProvisioningAttemptKey("lease-1", null), baseKey);
assert.deepEqual(
	workstationProvisioningFiberMetadata(
		{ leaseId: "lease-1", workstationId: "workstation-1" },
		null,
	),
	{
		leaseId: "lease-1",
		provisioningAttempt: 1,
		workstationId: "workstation-1",
	},
);

const completed = fiber("completed-fiber", "completed", 10);
assert.equal(
	workstationProvisioningAttemptKey("lease-1", completed),
	`${baseKey}:after:completed-fiber`,
	"all concurrent retries after one terminal attempt must converge on one successor key",
);

assert.equal(
	isActiveWorkstationProvisioningFiber(fiber("pending", "pending", 1)),
	true,
);
assert.equal(
	isActiveWorkstationProvisioningFiber(fiber("running", "running", 1)),
	true,
);
assert.equal(
	isActiveWorkstationProvisioningFiber(fiber("interrupted", "interrupted", 1)),
	true,
	"an unsettled interrupted fiber remains recovery-owned and must not be duplicated",
);
assert.equal(
	isActiveWorkstationProvisioningFiber(
		fiber("settled-interrupted", "interrupted", 1, 2),
	),
	false,
	"a settled interrupted fiber cannot recover itself and must allow a successor attempt",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"provisioning",
		false,
	),
	true,
	"a persisted provisioning lease must re-drive work after a settled interruption",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("errored-provision", "error", 1, 2),
		"provisioning",
		false,
	),
	true,
	"a failed provisioning fiber must receive a deterministic successor while its lease remains provisioning",
);
assert.equal(
	workstationProvisioningAttemptNumber(
		fiber("third-error", "error", 1, 2, WORKSTATION_PROVISION_MAX_ATTEMPTS),
	),
	WORKSTATION_PROVISION_MAX_ATTEMPTS,
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("third-error", "error", 1, 2, WORKSTATION_PROVISION_MAX_ATTEMPTS),
		"provisioning",
		false,
	),
	false,
	"provisioning recovery must stop after the bounded attempt ceiling",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"blocked",
		false,
		"wait_for_repo_sync",
	),
	true,
	"a retained Computer clone must re-drive reconciliation after the fiber turn is interrupted",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"blocked",
		false,
		"configure_github_credentials",
	),
	false,
	"an actionable blocked lease must not create a retry loop",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"blocked",
		false,
		null,
		"CloudflareContainerBackend(container) [stage=ws]: /ws upgrade did not arrive within 180000ms",
	),
	true,
	"a bounded Computer reconnect failure must be retried from persisted state",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("errored-rpc-stream", "error", 1, 2),
		"blocked",
		false,
		null,
		"WritableStream RPC stub was disposed without calling close()",
	),
	true,
	"a disposed Computer RPC stream must receive a bounded successor attempt",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"blocked",
		false,
		null,
		"GitHub credentials are required before the repo can be prepared",
	),
	false,
	"a configuration failure must remain operator-actionable rather than loop",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("running", "running", 1),
		"provisioning",
		false,
	),
	false,
	"polling must not duplicate an active provisioning fiber",
);
assert.equal(
	shouldStartWorkstationProvisioningSuccessor(
		fiber("settled-interrupted", "interrupted", 1, 2),
		"ready",
		true,
	),
	false,
	"a ready lease must never be re-provisioned",
);
assert.equal(isActiveWorkstationProvisioningFiber(completed), false);
assert.equal(
	isActiveWorkstationProvisioningFiber(fiber("error", "error", 1)),
	false,
);
assert.equal(
	isActiveWorkstationProvisioningFiber(fiber("aborted", "aborted", 1)),
	false,
);

const newer = fiber("newer", "running", 20);
assert.equal(
	latestWorkstationProvisioningFiber(completed, newer)?.fiberId,
	"newer",
);
assert.equal(latestWorkstationProvisioningFiber(null, undefined), null);

console.log("workstation-provisioning-attempt OK");

const refreshInput = { leaseId: "lease-1", refreshId: "generation:refresh-1" };
let exact: FiberInspection | null = null;
let starts = 0;
let prior: FiberInspection | null = fiber("old-ready", "completed", 1);
const refreshDeps = {
	inspect: async (key: string) => {
		assert.equal(key, workstationRefreshKey("lease-1", refreshInput.refreshId));
		return exact;
	},
	latest: async () => prior,
	start: async () => {
		starts++;
		exact = fiber("refresh", "running", 2);
		return exact;
	},
};
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ready,
	false,
);
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ready,
	false,
);
assert.equal(
	starts,
	1,
	"foreground expiry/reopen must observe one durable wake",
);
exact = {
	...fiber("refresh", "completed", 2),
	snapshot: {
		...refreshInput,
		refreshReceipt: {
			ok: true,
			ready: true,
			readiness: { toolsReady: true, repoReady: true },
		},
	},
};
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ready,
	true,
);
exact.snapshot = {
	...refreshInput,
	refreshId: "wrong-generation",
	refreshReceipt: { ready: true },
};
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ok,
	false,
);
exact.snapshot = {
	...refreshInput,
	refreshReceipt: {
		ready: false,
		repoSync: { status: "failed", executionState: "terminal" },
	},
};
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ok,
	false,
	"completed does not mean ready",
);
exact = null;
prior = fiber("active-original", "running", 1);
assert.equal(
	(await observeWorkstationRefresh(refreshInput, refreshDeps)).ready,
	false,
);
assert.equal(
	starts,
	1,
	"existing provisioning must settle before native refresh starts",
);
console.log("Durable native refresh identity and observation pass");

const owner = {};
let admitted: FiberInspection | null = null;
let concurrentStarts = 0;
const requests = ["refresh-a", "refresh-b", "ordinary-successor"].map((id) =>
	admitWorkstationProvisioning(owner, "shared-lease", {
		active: async () => {
			await Promise.resolve();
			return admitted;
		},
		start: async () => {
			await Promise.resolve();
			concurrentStarts++;
			admitted = fiber(id, "running", 10);
			return { ...admitted, accepted: true };
		},
	}),
);
const admissions = await Promise.all(requests);
assert.equal(concurrentStarts, 1);
assert.equal(admissions.filter((r) => r.accepted).length, 1);
assert.equal(new Set(admissions.map((r) => r.fiberId)).size, 1);

// Pending observations carry only matched diagnostics, never a ready/ownership
// claim, and never launch another fiber merely to obtain richer evidence.
{
	const receipt = {
		ready: true,
		observedAt: "2026-09-21T20:23:40.000Z",
		repoSync: {
			status: "syncing",
			executionId: "repo-clone-retained",
			executionState: "admitting",
			error: "PRIVATE",
			stdout: "PRIVATE",
		},
		bootstrap: {
			nextAction: "wait_for_repo_sync",
			lastBootstrapError: "PRIVATE",
		},
	};
	const pending = {
		...fiber("pending-refresh", "running", 2),
		snapshot: { ...refreshInput, refreshReceipt: receipt },
	};
	let starts = 0;
	const deps = {
		inspect: async () => pending,
		latest: async () => null,
		start: async () => {
			starts++;
			throw Error("must not start");
		},
	};
	const result = await observeWorkstationRefresh(refreshInput, deps);
	assert.equal(result.ready, false);
	assert.deepEqual(result.lastObservation, {
		...refreshInput,
		source: "native_refresh",
		observedAt: receipt.observedAt,
		repoSync: {
			status: "syncing",
			executionId: "repo-clone-retained",
			executionState: "admitting",
		},
		bootstrap: { nextAction: "wait_for_repo_sync" },
		provisioningFiber: { fiberId: "pending-refresh", status: "running" },
	});
	assert.ok(!JSON.stringify(result).includes("PRIVATE"));
	for (const mismatch of [
		{ leaseId: "another-lease" },
		{ refreshId: "old-refresh" },
	]) {
		pending.snapshot = {
			...refreshInput,
			...mismatch,
			refreshReceipt: receipt,
		};
		assert.equal(
			(await observeWorkstationRefresh(refreshInput, deps)).lastObservation,
			undefined,
		);
	}
	pending.snapshot = {
		...refreshInput,
		refreshReceipt: {
			...receipt,
			repoSync: { ...receipt.repoSync, executionId: "x".repeat(257) },
		},
	};
	const bounded = await observeWorkstationRefresh(refreshInput, deps);
	assert.ok(!JSON.stringify(bounded).includes("x".repeat(257)));
	assert.equal(starts, 0);
}

// Short malformed values are rejected too: diagnostics cannot carry arbitrary
// errors, control characters, or impossible timestamps disguised as identifiers.
for (const observedAt of [
	"not-a-date",
	"2026-02-30T00:00:00.000Z",
	"2026-09-21T00:00:00.000Z\n",
]) {
	const result = workstationPreparationObservation({
		leaseId: "lease\nsecret",
		refreshId: "refresh token",
		source: "native_refresh",
		receipt: {
			observedAt,
			repoSync: {
				status: "custom secret",
				executionId: "id\u0000secret",
				executionState: "unexpected",
			},
			bootstrap: { nextAction: "run arbitrary text" },
		},
		fiber: { fiberId: "fiber\rsecret", status: "stalled secret" },
	});
	assert.deepEqual(result, {
		source: "native_refresh",
		repoSync: {},
		bootstrap: {},
		provisioningFiber: {},
	});
}
