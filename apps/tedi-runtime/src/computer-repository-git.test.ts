import assert from "node:assert/strict";
import {
	computerRepositoryGitReader,
	type ComputerEnvironmentController,
} from "./computer-environment";

let scratchReads = 0;
const scratch = async () => {
	scratchReads++;
	return { stdout: "scratch", exitCode: 0 };
};
const calls: { command: string; cwd?: string }[] = [];
let receipt: unknown = { terminal: true, exitCode: 0, stdout: "native" };
let selected = { preparation: "repository", cwd: "/fictional/repo" } as Awaited<
	ReturnType<ComputerEnvironmentController["selected"]>
>;
const read = computerRepositoryGitReader(scratch, {
	selected: async () => selected,
	exec: async (input) => {
		calls.push(input);
		return receipt;
	},
});
assert.deepEqual(await read(["config", "--get", "remote.origin.url"]), {
	stdout: "native",
	exitCode: 0,
});
assert.equal(calls[0]?.cwd, "/fictional/repo");
assert.ok(calls[0]?.command.includes("remote.origin.url"));
assert.equal(scratchReads, 0, "native checkout never reads scratch git");
for (const argv of [
	["fetch"],
	["rev-parse", "HEAD; echo bad"],
	["config", "--get", "credential.helper"],
	["rev-parse", "--help"],
])
	await assert.rejects(read(argv));
receipt = { status: "running", executionId: "fictional" };
await assert.rejects(read(["rev-parse", "HEAD"]), /unavailable/);
assert.equal(
	scratchReads,
	0,
	"pending native read never falls back to scratch",
);
selected = { ...selected!, preparation: "shell" };
await assert.rejects(read(["rev-parse", "HEAD"]), /no repository/);
selected = undefined;
assert.deepEqual(await read(["rev-parse", "HEAD"]), {
	stdout: "scratch",
	exitCode: 0,
});
assert.equal(scratchReads, 1);
console.log(
	"PASS selected checkout git reads, fixed argv, pending refusal and scratch isolation",
);
