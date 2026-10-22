import assert from "node:assert/strict";
import { runtimeParentTurns } from "./runtime-parent-turns";
import type { ParentServiceOperation } from "./pi-parent-services";
const operation: ParentServiceOperation = {
	operationId: "maintenance:fixture:1",
	kind: "maintenance",
	requestHash: "fixture",
	input: { taskId: "isolate-brain-digest" },
};
const rows = new Map<string, unknown>();
const effectKey = `tedix:pi:maintenance:effect:${operation.operationId}`;
rows.set(effectKey, { operation, stage: "uncertain" });
rows.set(`memory:maintenance:result:${operation.operationId}`, {
	task: "isolate-brain-digest",
	compiledAt: "2026-01-01T00:00:00Z",
});
let writes = 0;
const host: any = {
	ctx: {
		storage: {
			get: async (k: string) => structuredClone(rows.get(k)),
			put: async (k: string, v: unknown) => {
				rows.set(k, structuredClone(v));
			},
			kv: { get: (k: string) => rows.get(k) },
		},
	},
	parentServiceRunId: (op: ParentServiceOperation) => op.operationId,
	runtimeAdmission: () => ({
		assertOriginalClaim: async () => {},
		assertAcceptedTurn: async () => {},
	}),
	runtimeReceiptHash: async () => "a".repeat(64),
	onCompileBrainDigest: async () => {
		writes++;
	},
};
const receipt = await runtimeParentTurns.runMaintenanceEffects.call(
	host,
	"isolate-brain-digest",
	operation,
);
assert.equal(receipt.status, "acknowledged");
assert.equal(
	writes,
	0,
	"persisted digest completes the original uncertain operation without another inference",
);
rows.set(effectKey, { operation, stage: "uncertain" });
rows.delete(`memory:maintenance:result:${operation.operationId}`);
await runtimeParentTurns.runMaintenanceEffects.call(
	host,
	"isolate-brain-digest",
	operation,
);
assert.equal(
	writes,
	1,
	"missing local effect retries under original admitted run",
);
await runtimeParentTurns.runMaintenanceEffects.call(
	host,
	"isolate-brain-digest",
	operation,
);
assert.equal(
	writes,
	1,
	"effect journal acknowledgment prevents another replay",
);
await assert.rejects(
	runtimeParentTurns.runMaintenanceEffects.call(host, "isolate-brain-digest", {
		...operation,
		requestHash: "changed",
	}),
	/original effect changed/,
);
console.log(
	"PASS uncertain maintenance reconciles actual durable result and preserves original identity",
);
