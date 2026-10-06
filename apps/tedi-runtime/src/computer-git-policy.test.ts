import assert from "node:assert/strict";
import {
	createGitClient,
	type GitClientFactory,
} from "@cloudflare/computer/git";
import {
	boundGitCliOutput,
	createGovernedComputerGitClient,
	GIT_CLI_LOG_MAX_COUNT,
	GIT_CLI_OUTPUT_MAX_BYTES,
} from "./computer-git-policy";

const calls: Array<Parameters<ReturnType<GitClientFactory>["cli"]>[0]> = [];
let clones = 0;
let stdout = "native result";
let stderr = "";
const factory = createGovernedComputerGitClient((options) => ({
	...createGitClient()(options),
	async cli(input) {
		calls.push(input);
		return { stdout, stderr, exitCode: 0 };
	},
	async clone() {
		clones++;
	},
}));
const client = factory({
	ws: {
		provider() {
			throw new Error("test must not access storage");
		},
	},
});

for (const argv of [
	["clone", "https://example.test/repo"],
	["fetch"],
	["push", "origin"],
	["pull"],
	["-C", "/workspace/repo", "push"],
	["--git-dir=/workspace/repo/.git", "fetch"],
	["submodule", "update", "--init"],
]) {
	const result = await client.cli({ argv, cwd: "/workspace/repo" });
	assert.equal(result.exitCode, 126, argv.join(" "));
	assert.match(result.stderr, /subcommand_not_allowed/);
}
assert.equal(
	calls.length,
	0,
	"denied shell Git commands must never reach the native host CLI",
);
const input = {
	argv: ["log"],
	cwd: "/workspace/repo",
	env: { GIT_AUTHOR_NAME: "Tedi" },
};
const result = await client.cli(input);
assert.deepEqual(result, { stdout: "native result", stderr: "", exitCode: 0 });
assert.deepEqual(calls[0], {
	...input,
	argv: ["log", `--max-count=${GIT_CLI_LOG_MAX_COUNT}`],
});
assert.deepEqual(input.argv, ["log"], "validation must not mutate caller argv");
await client.cli({ argv: ["log", "-n", "5"] });
assert.deepEqual(calls[1]?.argv, ["log", "-n", "5"]);
await client.clone({
	url: "https://example.test/trusted",
	dir: "/workspace/repo",
});
assert.equal(
	clones,
	1,
	"trusted bounded clone API remains available independently of shell CLI",
);
stdout = "😀".repeat(GIT_CLI_OUTPUT_MAX_BYTES);
stderr = "é".repeat(GIT_CLI_OUTPUT_MAX_BYTES);
const bounded = await client.cli({ argv: ["diff"] });
for (const channel of [bounded.stdout, bounded.stderr]) {
	assert.ok(
		new TextEncoder().encode(channel).byteLength <
			GIT_CLI_OUTPUT_MAX_BYTES + 100,
	);
	assert.ok(
		!channel.includes("�"),
		"UTF-8 truncation must preserve complete characters",
	);
	assert.match(channel, /truncated/);
}
assert.equal(
	boundGitCliOutput({ stderr }).outputTruncated,
	true,
	"stderr-only truncation is reported",
);
// Computer 0.4 adds command-specific help. Exercise the real native CLI:
// help must work without touching storage or enabling the described command.
const nativeClient = createGovernedComputerGitClient()({
	ws: {
		provider() {
			throw new Error("help must not access storage");
		},
	},
});
for (const verb of ["help", "--help", "-h"]) {
	const help = await nativeClient.cli({ argv: [verb, "cat-file"] });
	assert.equal(help.exitCode, 0);
	assert.match(help.stdout, /git cat-file \(-p\|-t\|-s\)/);
}
const cloneHelp = await nativeClient.cli({ argv: ["help", "clone"] });
assert.equal(cloneHelp.exitCode, 0);
assert.match(cloneHelp.stdout, /--depth/);
assert.equal(
	(await nativeClient.cli({ argv: ["clone", "https://example.test/repo"] }))
		.exitCode,
	126,
	"discovering clone usage must not grant network execution",
);
assert.equal(
	(await nativeClient.cli({ argv: ["help", "unknown-command"] })).exitCode,
	1,
	"unsupported topics preserve the native error",
);
const cwdHelp = await nativeClient.cli({
	argv: ["-C", "/workspace/repo", "help", "log"],
});
assert.equal(cwdHelp.exitCode, 0);
assert.match(cwdHelp.stdout, /--format\|--pretty/);
for (const [argv, boundedArgv] of [
	[
		["log", "--max-count=9999"],
		["log", "--max-count=100"],
	],
	[
		["log", "--max-count", "9999"],
		["log", "--max-count", "100"],
	],
	[
		["log", "-n9999"],
		["log", "-n100"],
	],
	[
		["log", "-9999"],
		["log", "-100"],
	],
	[
		["log", "-n", "3", "--max-count=9999"],
		["log", "-n", "3", "--max-count=100"],
	],
] as const) {
	await client.cli({ argv: [...argv] });
	assert.deepEqual(calls.at(-1)?.argv, boundedArgv);
}
for (const argv of [
	["log", "--max-count=-1"],
	["log", "-n", "-1"],
	["log", "--max-count"],
	["log", "--max-count=NaN"],
]) {
	const count: number = calls.length;
	assert.equal((await client.cli({ argv })).exitCode, 126);
	assert.equal(
		calls.length,
		count,
		"invalid or unlimited log count never reaches native CLI",
	);
}
for (const cwd of ["/workspace/repo", "relative repo"]) {
	await client.cli({ argv: ["-C", cwd, "status"], cwd: "/workspace" });
	assert.deepEqual(calls.at(-1)?.argv, ["-C", cwd, "status"]);
	assert.equal(calls.at(-1)?.cwd, "/workspace");
	await client.cli({ argv: ["-C", cwd, "log", "--max-count=9999"] });
	assert.deepEqual(calls.at(-1)?.argv, ["-C", cwd, "log", "--max-count=100"]);
}
for (const argv of [
	["-C"],
	["-C", ""],
	["-C", "/a", "-C", "/b", "status"],
	["-C", "/a", "fetch"],
	["-C", "/a", "status", ...Array(62).fill("--short")],
]) {
	const before: number = calls.length;
	assert.equal((await client.cli({ argv })).exitCode, 126);
	assert.equal(calls.length, before);
}
console.log("Computer host Git policy tests passed.");
