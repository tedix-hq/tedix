import assert from "node:assert/strict";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { tediDo } from "../test/tedi-do";

const reads: string[] = [];
let content: string | null = "Keep customer information private.";
let failed = false;
const agent = tediDo({
	env: {
		GIT_SHA: "source-fixture",
		TEDI_STORAGE: {
			get: async (key: string) => {
				reads.push(key);
				if (failed) throw new Error("storage unavailable");
				return content === null ? null : { text: async () => content! };
			},
		},
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
assert.deepEqual(result.provenance, { backend: "r2", key: "tedi-1/AGENTS.md" });
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
for (const value of [null, "", "   "]) {
	content = value;
	await assert.rejects(read("AGENTS.md"), /unavailable/);
}
failed = true;
await assert.rejects(read("AGENTS.md"), /unavailable/);
// Without the flag, the existing artifact/Git path remains selected.
await assert.rejects(
	agent.readArtifactFileTool({ path: "AGENTS.md" }),
	/Unexpected generic artifact lookup/,
);
console.log("evaluation instructions owned effective read OK");
