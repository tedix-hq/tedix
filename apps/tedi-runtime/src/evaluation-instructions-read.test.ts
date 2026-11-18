import assert from "node:assert/strict";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
const reads: string[] = [];
let content: string | null = "Keep customer information private.";
let failed = false;
// AGENTS.md is read from the tedi's Artifacts repo; stand in for the Git read.
const realArtifactsGit = await import("./artifacts-git");
mock.module("./artifacts-git", () => ({
	...realArtifactsGit,
	readFilesFromExistingRepoWithStatus: async (
		_artifacts: unknown,
		_accountId: string,
		_namespace: string,
		tediId: string,
		paths: string[],
	) => {
		reads.push(...paths.map((path) => `${tediId}/${path}`));
		if (failed) throw new Error("repository unavailable");
		return {
			repoFound: true,
			cloneOk: true,
			files: paths.map((path) => ({
				path,
				content,
				fileFound: content !== null,
			})),
		};
	},
}));
const { tediDo } = await import("../test/tedi-do");
const agent = tediDo({
	env: {
		GIT_SHA: "source-fixture",
		ARTIFACTS: {},
		CF_ACCOUNT_ID: "account-fixture",
	},
	state: { tediId: "tedi-1", orgId: "org-1" },
	async ensureIdentity() {},
	async getPlatformClient() {
		throw new Error("Unexpected generic artifact lookup");
	},
});
const read = async (path: string, maxChars?: number) =>
	await agent.readArtifactFileTool({
		path,
		maxChars,
		evaluationInstructions: true,
	});
const result = await read("AGENTS.md");
assert.equal(result.source, "effective_evaluation_instructions");
assert.equal(result.tediId, "tedi-1");
assert.equal(result.path, "AGENTS.md");
assert.equal(result.content, content);
assert.equal(result.sha256, await sha256Hex(content!));
assert.equal(result.runtimeSource, "source-fixture");
assert.deepEqual(result.provenance, { backend: "artifacts", key: "AGENTS.md" });
assert.deepEqual(reads, ["tedi-1/AGENTS.md"]);
for (const path of [
	"SOUL.md",
	"../other/AGENTS.md",
	"other/AGENTS.md",
	"memory/MEMORY.md",
	"AGENTS.md/extra",
]) {
	await assert.rejects(read(path), /restricted to AGENTS.md/);
	assert.equal(reads.length, 1);
}
const truncated = await read("AGENTS.md", 5);
assert.equal(truncated.content, content!.slice(0, 5));
assert.equal(truncated.truncated, true);
assert.equal(truncated.chars, content!.length);
assert.equal(truncated.sha256, result.sha256);
// A file missing from a readable repo is a proven absence, not an error.
content = null;
const absent = await read("AGENTS.md");
assert.equal(absent.presence, "absent");
assert.equal(absent.content, "");
// Present but blank content is neither instructions nor a proven absence.
for (const value of ["", "   "]) {
	content = value;
	await assert.rejects(read("AGENTS.md"), /unavailable/);
}
failed = true;
await assert.rejects(read("AGENTS.md"), /unavailable/);
// Without the flag, the plain Artifacts file read remains selected.
failed = false;
content = "Plain repo file";
const plain = (await agent.readArtifactFileTool({ path: "AGENTS.md" })) as {
	source?: string;
	content?: string;
};
assert.notEqual(plain.source, "effective_evaluation_instructions");
assert.equal(plain.content, "Plain repo file");
console.log("evaluation instructions owned effective read OK");
