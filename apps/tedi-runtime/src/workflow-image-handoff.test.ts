import assert from "node:assert/strict";
import type { TurnImagePart } from "@tedix/voice/stt";
import {
	cleanupWorkflowImages as cleanupImages,
	describeWorkflowImages,
	loadWorkflowImages,
	persistWorkflowImages as persistImages,
	workflowImageUri,
	type WorkflowImageBucket,
} from "./workflow-image-handoff";

const persistWorkflowImages = (
	bucket: WorkflowImageBucket,
	tediId: string,
	runId: string,
	images: readonly TurnImagePart[],
) => persistImages(bucket, tediId, runId, images, async () => () => {});
const cleanupWorkflowImages = (
	bucket: WorkflowImageBucket,
	tediId: string,
	runId: string,
) =>
	cleanupImages(bucket, tediId, runId, {
		cursor: null,
		allowedKeys: [...objects.keys()].filter((key) =>
			key.startsWith(
				`__runtime/workflow-images/${encodeURIComponent(tediId)}/${encodeURIComponent(runId)}/`,
			),
		),
		assertReady: async () => () => {},
		issued: async () => {},
		acknowledged: async () => {},
	});

const objects = new Map<string, string>();
let reads = 0;
let writes = 0;
let pages = 0;
let failPayload = false;
const bucket = {
	put: async (key: string, body: string, options?: { onlyIf?: Headers }) => {
		if (failPayload && !key.endsWith("manifest.json")) {
			failPayload = false;
			throw new Error("simulated_reset");
		}
		if (options?.onlyIf?.get("If-None-Match") === "*" && objects.has(key))
			return null;
		writes++;
		objects.set(key, body);
		return { key };
	},
	get: async (key: string) => {
		reads++;
		const body = objects.get(key);
		return body === undefined
			? null
			: { size: new TextEncoder().encode(body).length, text: async () => body };
	},
	list: async ({ prefix }: { prefix: string }) => {
		pages++;
		const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
		return {
			objects: keys.slice(0, 1).map((key) => ({ key })),
			truncated: keys.length > 1,
			cursor: "next",
		};
	},
	delete: async (keys: string | string[]) => {
		for (const key of typeof keys === "string" ? [keys] : keys)
			objects.delete(key);
	},
} as unknown as WorkflowImageBucket;
const inline: TurnImagePart = {
	kind: "base64",
	data: "aGVsbG8=",
	mediaType: "image/png",
	fileName: "image.png",
};
const hosted: TurnImagePart = {
	...inline,
	kind: "url",
	data: "https://example.com/image.png",
};
const described = await describeWorkflowImages("tedi/one", "run/one", [
	inline,
	hosted,
]);
assert.equal(
	writes,
	0,
	"compact obligation descriptors are prepared before any R2 write",
);
assert.equal(reads, 0);
const refs = await persistWorkflowImages(bucket, "tedi/one", "run/one", [
	inline,
	hosted,
]);
assert.deepEqual(refs, described);
assert.ok(
	refs.every((ref) =>
		ref.key.startsWith("__runtime/workflow-images/tedi%2Fone/run%2Fone/"),
	),
);
assert.deepEqual(
	await loadWorkflowImages(bucket, "tedi/one", "run/one", refs),
	[inline, hosted],
);
assert.equal(new URL(workflowImageUri(refs[0]!)).protocol, "tedix-r2:");
await assert.rejects(
	loadWorkflowImages(bucket, "tedi/one", "run/one", [
		{ ...refs[0]!, fileName: "forged" },
	]),
	/workflow_image_invalid/,
);
assert.deepEqual(
	await persistWorkflowImages(bucket, "tedi/one", "run/one", [inline, hosted]),
	refs,
);
const conflictWrites = writes;
await assert.rejects(
	persistWorkflowImages(bucket, "tedi/one", "run/one", [
		{ ...inline, fileName: "changed" },
	]),
	/workflow_image_conflict/,
);
await assert.rejects(
	persistWorkflowImages(bucket, "tedi/one", "run/one", [hosted, inline]),
	/workflow_image_conflict/,
);
assert.equal(writes, conflictWrites, "known conflicts do not leave new blobs");
const raced = await Promise.allSettled([
	persistWorkflowImages(bucket, "tedi", "race", [inline]),
	persistWorkflowImages(bucket, "tedi", "race", [hosted]),
]);
assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(
	raced.filter(
		(result) =>
			result.status === "rejected" &&
			/workflow_image_conflict/.test(String(result.reason)),
	).length,
	1,
);
const winner = raced.find((result) => result.status === "fulfilled");
assert.ok(winner?.status === "fulfilled");
failPayload = true;
await assert.rejects(
	persistWorkflowImages(bucket, "tedi", "reset", [inline]),
	/simulated_reset/,
);
await assert.rejects(
	persistWorkflowImages(bucket, "tedi", "reset", [hosted]),
	/workflow_image_conflict/,
);
const repaired = await persistWorkflowImages(bucket, "tedi", "reset", [inline]);
assert.deepEqual(await loadWorkflowImages(bucket, "tedi", "reset", repaired), [
	inline,
]);
assert.equal(
	[...objects.keys()].filter((key) =>
		key.startsWith("__runtime/workflow-images/tedi/race/"),
	).length,
	2,
	"race loser writes no payload",
);
assert.deepEqual(
	await loadWorkflowImages(bucket, "tedi/one", "run/one", [refs[0]!]),
	[inline],
);
const beforeReads = reads;
await assert.rejects(
	loadWorkflowImages(bucket, "other", "run/one", refs),
	/workflow_image_invalid/,
);
await assert.rejects(
	loadWorkflowImages(bucket, "tedi/one", "other", refs),
	/workflow_image_invalid/,
);
await assert.rejects(
	loadWorkflowImages(bucket, "tedi/one", "run/one", [
		{ ...refs[0]!, key: "secret" },
	]),
	/workflow_image_invalid/,
);
assert.equal(
	reads,
	beforeReads,
	"invalid ownership is rejected before bucket access",
);
objects.set(refs[0]!.key, JSON.stringify(hosted));
await assert.rejects(
	loadWorkflowImages(bucket, "tedi/one", "run/one", [refs[0]!]),
	/workflow_image_integrity_failed/,
);
objects.delete(refs[0]!.key);
await assert.rejects(
	loadWorkflowImages(bucket, "tedi/one", "run/one", [refs[0]!]),
	/workflow_image_missing/,
);
const dataUrl = await persistWorkflowImages(bucket, "tedi", "data", [
	{ ...inline, kind: "url", data: `data:image/png;base64,${inline.data}` },
]);
assert.deepEqual(await loadWorkflowImages(bucket, "tedi", "data", dataUrl), [
	inline,
]);
const large = Buffer.alloc(5 * 1024 * 1024).toString("base64");
const four = Array.from({ length: 4 }, (_, index) => ({
	...inline,
	data: large,
	fileName: `${index}.png`,
}));
const compact = await persistWorkflowImages(bucket, "tedi", "large", four);
assert.ok(
	JSON.stringify(compact).length < 2048,
	"maximum legal images remain a compact Workflow payload",
);
assert.deepEqual(
	await loadWorkflowImages(bucket, "tedi", "large", compact),
	four,
);
const beforeWrites = writes;
for (const images of [
	[...four, inline],
	[{ ...inline, data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }],
	[
		{
			...inline,
			kind: "url" as const,
			data: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`,
		},
	],
	[{ ...inline, kind: "url" as const, data: "file:///etc/passwd" }],
	[
		{
			...inline,
			kind: "url" as const,
			data: "data:image/jpeg;base64,aGVsbG8=",
		},
	],
	[{ ...inline, data: "broken!=" }],
	[{ ...inline, mediaType: "application/pdf" }],
])
	await assert.rejects(
		persistWorkflowImages(bucket, "tedi", "invalid", images),
		/workflow_image_invalid/,
	);
assert.equal(
	writes,
	beforeWrites,
	"whole invalid requests are rejected before writes",
);
const other = await persistWorkflowImages(bucket, "other", "large", [inline]);
await cleanupWorkflowImages(bucket, "tedi", "large");
assert.ok(pages >= 4, "cleanup consumes all pages");
assert.ok(
	objects.has(other[0]!.key),
	"cleanup retains another owner's payload",
);
assert.ok(
	objects.has(dataUrl[0]!.key),
	"cleanup retains another run's payload",
);
assert.ok(compact.every((ref) => !objects.has(ref.key)));
await cleanupWorkflowImages(bucket, "tedi", "large");
console.log(
	"workflow-image-handoff: ownership, integrity, replay, limits, and paginated cleanup passed",
);

// A queued microtask can revoke authority after the async preparation returns.
// The synchronous wire guard runs in the caller immediately before each effect.
{
	let held = false,
		effects = 0;
	await assert.rejects(
		persistImages(
			{
				get: async () => null,
				put: async () => {
					effects++;
					return {} as R2Object;
				},
			} as unknown as WorkflowImageBucket,
			"tedi",
			"await-gap",
			[inline],
			async () => {
				queueMicrotask(() => {
					held = true;
				});
				return () => {
					if (held) throw new Error("wire held");
				};
			},
		),
		/wire held/,
	);
	assert.equal(effects, 0);
}
{
	let held = false,
		lists = 0,
		deletes = 0;
	const owner = "__runtime/workflow-images/tedi/delete-gap/";
	await assert.rejects(
		cleanupImages(
			{
				list: async () => {
					lists++;
					return {
						objects: [{ key: `${owner}manifest.json` }],
						truncated: false,
					};
				},
				delete: async () => {
					deletes++;
				},
			} as unknown as WorkflowImageBucket,
			"tedi",
			"delete-gap",
			{
				cursor: null,
				allowedKeys: [`${owner}manifest.json`],
				assertReady: async () => () => {
					if (held) throw new Error("delete wire held");
				},
				issued: async () => {
					queueMicrotask(() => {
						held = true;
					});
				},
				acknowledged: async () => {
					throw new Error("unissued acknowledgment");
				},
			},
		),
		/delete wire held/,
	);
	assert.equal(lists, 1);
	assert.equal(deletes, 0);
}
