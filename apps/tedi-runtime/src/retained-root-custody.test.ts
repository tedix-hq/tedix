import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { HistoricalExposureInputSchema } from "@tedix/api-contract/schemas/billing";
import { validateRetainedRootRow } from "./retained-root-custody";
const tediId = "11111111-1111-4111-8111-111111111111",
	orgId = "22222222-2222-4222-8222-222222222222",
	objectId = "a".repeat(64),
	operationId = "original-record";
const input = HistoricalExposureInputSchema.parse({
	tediId,
	operationId,
	rootObjectId: objectId,
	objectId,
	targetPath: [],
	expectedGeneration: 1,
	snapshotId: "b".repeat(64),
	sourceHash: "c".repeat(64),
});
const actor = "owner",
	user = "33333333-3333-4333-8333-333333333333";
const hash = createHash("sha256")
	.update(JSON.stringify([orgId, actor, user, input]))
	.digest("hex");
const value = {
	id: "44444444-4444-4444-8444-444444444444",
	organizationId: orgId,
	tediId,
	rootObjectId: objectId,
	objectId,
	rootObjectName: "original",
	objectName: "original",
	targetPath: [],
	className: "AgentTediDO",
	generation: 1,
	snapshotId: input.snapshotId,
	sourceHash: input.sourceHash,
	manifestHash: null,
	originalRunId: null,
	originalWorkId: null,
	originalPeriod: null,
	usage: null,
	costMicros: null,
	effects: "UNKNOWN",
	exposure: "UNKNOWN",
	workflowCount: 0,
	fiberCount: 0,
	identityCount: 0,
	observedBy: actor,
	observedUserId: user,
	observedAt: "2026-10-05T00:00:00.000Z",
	requestHash: hash,
};
const row = {
	...value,
	operationId,
	payload: JSON.stringify(value),
	currentOrganizationId: orgId,
	currentObjectName: "fresh",
};
assert.deepEqual(
	validateRetainedRootRow(row, {
		tediId,
		orgId,
		objectId,
		objectName: "original",
		generation: 1,
	}),
	value,
);
for (const patch of [
	{ currentOrganizationId: "other" },
	{ currentObjectName: "original" },
	{ requestHash: "f".repeat(64) },
	{ generation: 2 },
	{ objectName: "fake" },
	{ payload: JSON.stringify({ ...value, className: "LegacyChild" }) },
	{ payload: JSON.stringify({ ...value, sourceHash: "d".repeat(64) }) },
])
	assert.throws(() =>
		validateRetainedRootRow({ ...row, ...patch }, { tediId, orgId, objectId }),
	);
console.log(
	"retained root strict scalar/JSON/original-request custody assertions passed",
);
