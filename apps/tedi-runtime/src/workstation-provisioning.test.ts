import assert from "node:assert/strict";
import type { FiberRecoveryContext } from "agents";
import {
	reconcileWorkstationUntilSettled,
	workstationProvisioningRecoveryInput,
	type WorkstationProvisioningCheckpoint,
} from "./workstation-provisioning";
const input: WorkstationProvisioningCheckpoint = {
	leaseId: "lease-1",
	refreshId: "generation:refresh",
	attempt: 0,
	phase: "provision",
	startedAt: Date.now(),
};
let calls = 0;
const snapshots: WorkstationProvisioningCheckpoint[] = [];
const result = await reconcileWorkstationUntilSettled(
	{
		identity: { tediId: "tedi-1", orgId: "org-1", slug: "cto" },
		env: {
			TEDI_SERVICE: {
				fetch: async () => {
					calls++;
					return Response.json({
						ok: true,
						ready: true,
						credentials: { secret: "never-retained" },
						readiness: { repoReady: true, toolsReady: true },
						repoSync: {
							workdir: "/workspace/repo",
							executionState: "terminal",
							treePreflight: { startSha: "a".repeat(40) },
						},
						bootstrap: { cacheBackupStatus: "pending" },
						workstationPersistence: { status: "persisted" },
						workstationLease: { id: "lease-1", status: "active" },
					});
				},
			} as unknown as Fetcher,
		},
	},
	input,
	{ checkpoint: (value) => snapshots.push(structuredClone(value)) },
);
assert.equal(calls, 1, "refresh must not block readiness behind cache backup");
assert.equal(result.refreshReceipt?.ready, true);
assert.equal(JSON.stringify(result).includes("never-retained"), false);
assert.ok(snapshots.some((s) => s.refreshReceipt?.ready));
const recovered = workstationProvisioningRecoveryInput({
	snapshot: result,
	createdAt: input.startedAt,
} as FiberRecoveryContext);
assert.equal(recovered?.refreshId, input.refreshId);
assert.deepEqual(recovered?.refreshReceipt, result.refreshReceipt);
console.log("Durable native refresh receipt and recovery pass");
