import assert from "node:assert/strict";
import type { ToolExecuteFunction } from "ai";
import type { z } from "zod";
import { createDeliverableArtifactTools } from "./deliverable-artifact-reader";
import type { RuntimeRepositoryHost } from "./runtime-repository";

const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
mock.module("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	RpcTarget: class {},
	tracing: {},
	exports: {},
	env: {},
}));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
let repoReads = 0;
const files = [
	"reports/a.md",
	"reports/日本語.md",
	"reports-old.md",
	"private.md",
];
mock.module("./artifacts-git", () => ({
	listFilesFromExistingRepoWithStatus: async () => {
		repoReads++;
		return { repoFound: true, cloneOk: true, files };
	},
}));
const { runtimeRepository } = await import("./runtime-repository");

const calls: R2ListOptions[] = [];
const tools = createDeliverableArtifactTools({
	ensureIdentity: async () => {},
	getTediId: () => "tedi-example",
	getPlatformClient: async () => null,
	bucket: {
		list: async (input: R2ListOptions) => {
			calls.push(input);
			return { objects: [] };
		},
	} as unknown as R2Bucket,
});
type ListInput = { prefix?: string; limit?: number };
const list = tools.deliverable_list!;
const execute = list.execute as ToolExecuteFunction<
	ListInput,
	unknown,
	unknown
>;
const schema = list.inputSchema as z.ZodType<ListInput>;
const host = {
	ensureIdentity: async () => {},
	state: { tediId: "tedi-example" },
	env: { ARTIFACTS: {}, CF_ACCOUNT_ID: "example-account" },
} as unknown as RuntimeRepositoryHost;
const options = { toolCallId: "prefix-test", messages: [], context: undefined };

for (const prefix of [
	"../private",
	"reports/../private",
	"reports/./a",
	"reports//a",
	"reports//",
	"a\0b",
	"/",
	"a".repeat(1025),
]) {
	const expected = { ok: false, error: "prefix must be a safe object path" };
	assert.deepEqual(await execute(schema.parse({ prefix }), options), expected);
	assert.deepEqual(
		await runtimeRepository.listArtifactFilesTool.call(host, { prefix }),
		expected,
	);
}
assert.equal(calls.length, 0, "invalid prefixes must not access R2");
assert.equal(repoReads, 0, "invalid prefixes must not access Artifacts/Git");

for (const [prefix, normalized] of [
	[undefined, ""],
	["", ""],
	["   ", ""],
	[" ///reports ", "reports"],
	[" ///reports/ ", "reports/"],
	["reports/日本語", "reports/日本語"],
] as const) {
	await execute(schema.parse({ prefix, limit: 3 }), options);
	assert.deepEqual(calls.at(-1), {
		prefix: `tedi-example/artifacts/${normalized}`,
		limit: 3,
	});
	const result = (await runtimeRepository.listArtifactFilesTool.call(host, {
		prefix,
		limit: 3,
	})) as { prefix: string; files: string[] };
	assert.equal(result.prefix, normalized);
	assert.deepEqual(
		result.files,
		files.filter((path) => path.startsWith(normalized)).slice(0, 3),
	);
}
assert.equal(repoReads, 6);
console.log(
	"PASS: artifact listing prefixes stay bounded before storage access",
);
