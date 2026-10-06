import assert from "node:assert/strict";
import { ArtifactContributionReceipts } from "./artifact-contribution-receipts";

const rows = new Map<string, unknown>();
const storage = {
	get: async (key: string) => rows.get(key),
	put: async (key: string, value: unknown) => void rows.set(key, value),
} as unknown as DurableObjectStorage;
const ledger = new ArtifactContributionReceipts(storage);
const base = {
	id: "e",
	tediId: "t",
	conversationId: "c",
	runId: "r",
	sequence: 1,
	runtime: { backend: "cloudflare-agents" as const },
	createdAt: new Date().toISOString(),
};
const receipt = {
	innerCallId: "exec:0",
	receipt: {
		version: 1 as const,
		kind: "docs_file_observation" as const,
		receiptId: "00000000-0000-4000-8000-000000000001",
		provider: { appSlug: "docs" as const, toolName: "get_docs_file" as const },
		resource: {
			organizationSlug: "org",
			siteId: "00000000-0000-4000-8000-000000000002",
			path: "a.md",
		},
		evidence: {
			contentSha256: "a".repeat(64),
			byteLength: 1,
			observedGitRevision: "b".repeat(40),
		},
		observedAt: new Date().toISOString(),
	},
};

await ledger.decorate({
	...base,
	id: "start",
	kind: "tool.started",
	payload: {},
});
await ledger.decorate({
	...base,
	kind: "tool.failed",
	payload: { readObservations: [receipt] },
});
const produced = await ledger.decorate({
	...base,
	id: "p",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact"] },
});
assert.deepEqual(
	(
		produced.payload?.artifactContributionReceipt as {
			completeness: string;
			observations: unknown[];
		}
	).completeness,
	"observed_prefix",
);
assert.equal(
	(produced.payload?.artifactContributionReceipt as { observations: unknown[] })
		.observations.length,
	1,
);

const second = structuredClone(receipt);
second.receipt.receiptId = "00000000-0000-4000-8000-000000000003";
await Promise.all([
	ledger.decorate({
		...base,
		id: "c1",
		kind: "tool.completed",
		payload: { readObservations: [receipt] },
	}),
	ledger.decorate({
		...base,
		id: "c2",
		kind: "tool.failed",
		payload: { readObservations: [second] },
	}),
]);
const concurrent = await ledger.decorate({
	...base,
	id: "c3",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-2"] },
});
assert.equal(
	(
		concurrent.payload?.artifactContributionReceipt as {
			observations: unknown[];
		}
	).observations.length,
	2,
);

await ledger.decorate({
	...base,
	id: "bad",
	kind: "tool.failed",
	payload: { readObservations: "forged" },
});
const unavailable = await ledger.decorate({
	...base,
	id: "after-bad",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-3"] },
});
assert.equal(
	(unavailable.payload?.artifactContributionReceipt as { completeness: string })
		.completeness,
	"unavailable",
);

let failPut = true;
const flakyRows = new Map<string, unknown>();
const flaky = new ArtifactContributionReceipts({
	get: async (key: string) => flakyRows.get(key),
	put: async (key: string, value: unknown) => {
		if (failPut) throw new Error("storage unavailable");
		flakyRows.set(key, value);
	},
} as unknown as DurableObjectStorage);
await flaky.decorate({
	...base,
	id: "lost-read",
	kind: "tool.failed",
	payload: { readObservations: [receipt] },
});
failPut = false;
const afterLostRead = await flaky.decorate({
	...base,
	id: "production",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-lost"] },
});
assert.equal(
	(
		afterLostRead.payload?.artifactContributionReceipt as {
			completeness: string;
		}
	).completeness,
	"unavailable",
);

const restartRows = new Map<string, unknown>();
const restartStorage = {
	get: async (key: string) => restartRows.get(key),
	put: async (key: string, value: unknown) => void restartRows.set(key, value),
} as unknown as DurableObjectStorage;
const beforeRestart = new ArtifactContributionReceipts(restartStorage);
await beforeRestart.decorate({
	...base,
	id: "started",
	kind: "tool.started",
	payload: {},
});
assert.ok(restartRows.has("artifact-contributions:r"));
await beforeRestart.decorate({
	...base,
	id: "read-before-restart",
	kind: "tool.completed",
	payload: { readObservations: [receipt] },
});
const afterRestart = new ArtifactContributionReceipts(restartStorage);
const inherited = await afterRestart.decorate({
	...base,
	id: "produced-after-restart",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-after-restart"] },
});
assert.equal(
	(inherited.payload?.artifactContributionReceipt as { completeness: string })
		.completeness,
	"unavailable",
);
assert.equal(
	(
		inherited.payload?.artifactContributionReceipt as {
			observations: unknown[];
		}
	).observations.length,
	1,
);

let failRestartWrite = false;
const lostAcrossRestartRows = new Map<string, unknown>();
const lostAcrossRestartStorage = {
	get: async (key: string) => lostAcrossRestartRows.get(key),
	put: async (key: string, value: unknown) => {
		if (failRestartWrite) throw new Error("lost observation write");
		lostAcrossRestartRows.set(key, value);
	},
} as unknown as DurableObjectStorage;
const lostBeforeRestart = new ArtifactContributionReceipts(
	lostAcrossRestartStorage,
);
await lostBeforeRestart.decorate({
	...base,
	id: "initialized-before-loss",
	kind: "tool.started",
	payload: {},
});
failRestartWrite = true;
await lostBeforeRestart.decorate({
	...base,
	id: "lost-read-before-restart",
	kind: "tool.completed",
	payload: { readObservations: [receipt] },
});
failRestartWrite = false;
const lostAfterRestart = new ArtifactContributionReceipts(
	lostAcrossRestartStorage,
);
const unknownAfterRestart = await lostAfterRestart.decorate({
	...base,
	id: "production-after-lost-read",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-after-lost-read"] },
});
assert.equal(
	(
		unknownAfterRestart.payload?.artifactContributionReceipt as {
			completeness: string;
		}
	).completeness,
	"unavailable",
);

const missingState = new ArtifactContributionReceipts({
	get: async () => undefined,
	put: async () => undefined,
} as unknown as DurableObjectStorage);
const completionWithoutStart = await missingState.decorate({
	...base,
	id: "completion-without-start",
	kind: "tool.completed",
	payload: { producedArtifactIds: ["artifact-without-start"] },
});
assert.equal(
	(
		completionWithoutStart.payload?.artifactContributionReceipt as {
			completeness: string;
		}
	).completeness,
	"unavailable",
);
console.log("artifact-contribution-receipts: ok");
