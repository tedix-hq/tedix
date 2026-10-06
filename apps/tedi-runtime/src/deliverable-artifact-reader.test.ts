import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
	RecordArtifactInput,
	TediArtifact,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HttpPlatformClient } from "./brain/platform-client";
import { recordDeliverableArtifact } from "./artifact-recorder";
import { TEDIX_ARTIFACTS_R2_BUCKET_NAME } from "./artifacts-contract";
import {
	readDeliverableArtifact,
	readRecordedArtifact,
	type DeliverableArtifactReaderDependencies,
} from "./deliverable-artifact-reader";

const tediId = "5eed0043-0000-4000-8000-000000000043";
const artifactId = "run-a:artifact:v2:deliverable:acme-commercial-briefing.md";
const content = "# Acme commercial briefing\n\nRecovered in run B.";
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const objectBody = (value: string) => ({
	arrayBuffer: async () =>
		new TextEncoder().encode(value).buffer as ArrayBuffer,
});
const artifact: TediArtifact = {
	id: artifactId,
	tediId,
	runId: "run-a",
	kind: "document",
	name: "deliverable/acme-commercial-briefing.md",
	mimeType: "text/markdown; charset=utf-8",
	uri: `r2://tedix-tedi-production/${tediId}/artifacts/deliverable/acme-commercial-briefing.md`,
	sizeBytes: new TextEncoder().encode(content).byteLength,
	createdAt: "2026-08-08T00:00:00.000Z",
};

function dependencies(
	overrides: {
		artifact?: TediArtifact;
		object?: { arrayBuffer(): Promise<ArrayBuffer> } | null;
		tedi?: string | null;
	} = {},
): DeliverableArtifactReaderDependencies {
	const resolvedArtifact = overrides.artifact ?? artifact;
	assert.ok(resolvedArtifact.uri);
	const expectedKey = resolvedArtifact.uri.replace(
		`r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/`,
		"",
	);
	return {
		bucket: {
			get: async (key: string) => {
				assert.equal(key, expectedKey);
				return overrides.object === undefined
					? (objectBody(content) as R2ObjectBody)
					: (overrides.object as R2ObjectBody | null);
			},
		} as unknown as R2Bucket,
		ensureIdentity: async () => undefined,
		getTediId: () => (overrides.tedi === undefined ? tediId : overrides.tedi),
		getPlatformClient: async () => ({
			listArtifacts: async () => ({ artifacts: [] }),
			getArtifact: async ({ artifactId: requestedId }) => {
				assert.equal(requestedId, artifactId);
				return { artifact: resolvedArtifact };
			},
		}),
	};
}

let storedKey = "";
let storedContent = "";
let recordedArtifact: TediArtifact | null = null;
const sharedBucket = {
	put: async (key: string, value: string) => {
		storedKey = key;
		storedContent = value;
	},
	get: async (key: string) => {
		assert.equal(key, storedKey);
		return key === storedKey
			? (objectBody(storedContent) as R2ObjectBody)
			: null;
	},
} as unknown as R2Bucket;
const sharedPlatform = {
	recordArtifact: async (input: RecordArtifactInput) => {
		assert.ok(input.id);
		assert.equal(typeof input.content, "string");
		const canonicalKey = `${tediId}/artifacts/deliverable/content-digest/acme-commercial-briefing.md`;
		await sharedBucket.put(canonicalKey, input.content as string);
		recordedArtifact = {
			id: input.id,
			tediId: input.tediId,
			runId: input.runId,
			kind: input.kind,
			name: input.name,
			mimeType: input.mimeType,
			uri: `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/${canonicalKey}`,
			sizeBytes: input.sizeBytes,
			accessClassification: "runtime_private",
			createdAt: "2026-08-08T00:00:00.000Z",
		};
		return { artifact: recordedArtifact };
	},
	getArtifact: async ({ artifactId: requestedId }: { artifactId: string }) => {
		assert.equal(requestedId, artifactId);
		assert.ok(recordedArtifact);
		return { artifact: recordedArtifact };
	},
} as unknown as HttpPlatformClient;

const writtenInRunA = await recordDeliverableArtifact({
	platform: sharedPlatform,
	bucket: sharedBucket,
	tediId,
	runId: "run-a",
	name: "acme-commercial-briefing.md",
	content,
});
assert.equal(writtenInRunA.artifactId, artifactId);

const recovered = await readDeliverableArtifact(
	{
		bucket: sharedBucket,
		ensureIdentity: async () => undefined,
		getTediId: () => tediId,
		getPlatformClient: async () => sharedPlatform,
	},
	{ artifactId },
);
assert.deepEqual(recovered, {
	ok: true,
	artifactId,
	name: "acme-commercial-briefing.md",
	mimeType: artifact.mimeType,
	content,
	chars: content.length,
	truncated: false,
	sha256: digest(content),
	byteLength: new TextEncoder().encode(content).byteLength,
});

const crossTedi = await readDeliverableArtifact(
	dependencies({
		artifact: {
			...artifact,
			tediId: "other-tedi",
			uri: `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/other-tedi/artifacts/deliverable/acme-commercial-briefing.md`,
		},
	}),
	{ artifactId },
);
assert.equal(crossTedi.ok, true);

const multibyteContent = "é🙂終";
const multibyteRead = await readDeliverableArtifact(
	dependencies({ object: objectBody(multibyteContent) }),
	{ artifactId, maxChars: 3 },
);
assert.equal(multibyteRead.content, "é🙂");
assert.equal(multibyteRead.chars, 4);
assert.equal(multibyteRead.truncated, true);
assert.equal(multibyteRead.byteLength, 9);
assert.equal(multibyteRead.sha256, digest(multibyteContent));
assert.notEqual(multibyteRead.sha256, digest("é🙂"));

const invalidUtf8 = Uint8Array.from([0x61, 0xff]);
const rawRead = await readDeliverableArtifact(
	dependencies({ object: { arrayBuffer: async () => invalidUtf8.buffer } }),
	{ artifactId },
);
assert.equal(rawRead.content, "a\uFFFD");
assert.equal(rawRead.byteLength, 2);
assert.equal(
	rawRead.sha256,
	createHash("sha256").update(invalidUtf8).digest("hex"),
	"the digest covers stored bytes, not replacement characters after UTF-8 decoding",
);

const workstationKey = `orgs/org-a/tedis/${tediId}/workstations/coding/processes/install-deps/terminal/stdout.log`;
const workstationArtifact = await readDeliverableArtifact(
	dependencies({
		artifact: {
			...artifact,
			uri: `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/${workstationKey}`,
		},
		object: objectBody("96 tests passed"),
	}),
	{ artifactId },
);
assert.deepEqual(workstationArtifact, {
	ok: true,
	artifactId,
	name: artifact.name,
	mimeType: artifact.mimeType,
	content: "96 tests passed",
	chars: 15,
	truncated: false,
	sha256: digest("96 tests passed"),
	byteLength: 15,
});

const wrongTree = await readDeliverableArtifact(
	dependencies({
		artifact: {
			...artifact,
			uri: `r2://tedix-tedi-production/${tediId}/objects/deliverable/acme-commercial-briefing.md`,
		},
	}),
	{ artifactId },
);
assert.equal(wrongTree.ok, false);
assert.equal(wrongTree.error, "artifact_content_unavailable");

// --- readRecordedArtifact: a workstation stdout.log recorded by the adapter ---
// (an artifact.created row) resolves by recorded NAME and
// reads from R2; a plain repo path resolves nothing so the caller falls back
// to the git Artifacts repo.

const processId = "3702bca9-0bd8-4a41-9c1c-2d8a7ecf4f7d";
const stdoutName = `workstation_process/${processId}/stdout.log`;
const stdoutKey = `${tediId}/artifacts/workstation_process/${processId}/stdout.log`;
const stdoutArtifact: TediArtifact = {
	id: `run-3e93f8de:artifact:workstation_process:${processId}:stdout`,
	tediId,
	runId: "run-3e93f8de",
	kind: "log",
	name: stdoutName,
	mimeType: "text/plain; charset=utf-8",
	uri: `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/${stdoutKey}`,
	metadata: { subKind: "workstation_process", exitCode: 0 },
	createdAt: "2026-09-16T10:00:00.000Z",
};
const listCalls: Array<Record<string, unknown>> = [];
const getCalls: string[] = [];
const bucketReads: string[] = [];
const recordedDeps: DeliverableArtifactReaderDependencies = {
	bucket: {
		get: async (key: string) => {
			bucketReads.push(key);
			return key === stdoutKey
				? (objectBody("96 tests passed\n") as R2ObjectBody)
				: null;
		},
	} as unknown as R2Bucket,
	ensureIdentity: async () => undefined,
	getTediId: () => tediId,
	getPlatformClient: async () => ({
		listArtifacts: async (params: Record<string, unknown>) => {
			listCalls.push(params);
			return {
				artifacts: params.name === stdoutName ? [stdoutArtifact] : [],
			};
		},
		getArtifact: async ({
			artifactId: requestedId,
		}: {
			artifactId: string;
		}) => {
			getCalls.push(requestedId);
			if (requestedId === stdoutArtifact.id)
				return { artifact: stdoutArtifact };
			throw new Error("not found");
		},
	}),
};

const byName = await readRecordedArtifact(recordedDeps, {
	ref: stdoutName,
	maxChars: 5,
});
assert.deepEqual(byName, {
	source: "artifact_ledger",
	ok: true,
	artifactId: stdoutArtifact.id,
	name: stdoutName,
	mimeType: stdoutArtifact.mimeType,
	content: "96 te",
	chars: 16,
	truncated: true,
	sha256: digest("96 tests passed\n"),
	byteLength: 16,
});
assert.deepEqual(listCalls, [{ name: stdoutName, limit: 20 }]);
assert.deepEqual(getCalls, [], "an exact-name hit needs no id lookup");
assert.deepEqual(bucketReads, [stdoutKey]);

const byId = await readRecordedArtifact(recordedDeps, {
	ref: stdoutArtifact.id,
});
assert.equal(byId?.ok, true);
assert.equal(byId?.name, stdoutName);
assert.deepEqual(
	getCalls,
	[stdoutArtifact.id],
	"an id falls through to getArtifact",
);

const repoPath = await readRecordedArtifact(recordedDeps, { ref: "SOUL.md" });
assert.equal(
	repoPath,
	null,
	"an unrecorded repo path resolves nothing so the git repo read runs",
);
assert.deepEqual(
	getCalls,
	[stdoutArtifact.id],
	"a repo path never costs an id round-trip",
);

// A failed name lookup still permits the real recorded-id fallback.
const fallbackCalls: string[] = [];
const rejectedListDeps: DeliverableArtifactReaderDependencies = {
	...recordedDeps,
	getPlatformClient: async () => ({
		listArtifacts: async () => {
			fallbackCalls.push("list");
			throw new Error("artifact list unavailable");
		},
		getArtifact: async ({ artifactId: requestedId }) => {
			fallbackCalls.push(requestedId);
			assert.equal(requestedId, stdoutArtifact.id);
			return { artifact: stdoutArtifact };
		},
	}),
};
const afterListFailure = await readRecordedArtifact(rejectedListDeps, {
	ref: stdoutArtifact.id,
});
assert.deepEqual(afterListFailure, {
	source: "artifact_ledger",
	ok: true,
	artifactId: stdoutArtifact.id,
	name: stdoutName,
	mimeType: stdoutArtifact.mimeType,
	content: "96 tests passed\n",
	chars: 16,
	truncated: false,
	sha256: digest("96 tests passed\n"),
	byteLength: 16,
});
assert.deepEqual(fallbackCalls, ["list", stdoutArtifact.id]);
assert.equal(
	await readRecordedArtifact(rejectedListDeps, { ref: "SOUL.md" }),
	null,
);
assert.deepEqual(fallbackCalls, ["list", stdoutArtifact.id, "list"]);

console.log("All deliverable artifact reader tests passed.");
