import assert from "node:assert/strict";

// Platform tracing is a source-test boundary; collection and publication are real.
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
const { publishComputerWorkspaceSnapshot } =
	await import("./computer-workspace-snapshot");
const { WORKSPACE_SNAPSHOT_MAX_FILE_CHARS, WORKSPACE_SNAPSHOT_MAX_FILES } =
	await import("./workspace-fs");

type SnapshotInput = Parameters<typeof publishComputerWorkspaceSnapshot>[0];
function computer(
	files: Map<string, string | null | Error>,
	key = "a",
): SnapshotInput["computer"] {
	// The production collector is exercised unchanged; this fixture supplies
	// directory/read operations without pulling unrelated workspace methods in.
	return {
		scope: { kind: "conversation", key },
		snapshotPrefix: `workspace/${key}/`,
		workspace: {
			async readDir() {
				return [...files.keys()].map((name) => ({
					name,
					type: "file",
					size: 0,
					mtime: 0,
				}));
			},
			async readFile(path: string) {
				const value = files.get(path);
				if (value instanceof Error) throw value;
				return value ?? null;
			},
		} as unknown as SnapshotInput["computer"]["workspace"],
	};
}
const published = new Map([
	["workspace/a/old.md", "old A"],
	["workspace/b/keep.md", "B unchanged"],
]);
let active = true;
let readinessChecks = 0;
let revokeAfterAcknowledgment = false;
const assertReady = async () => {
	readinessChecks++;
	if (!active) throw new Error("original snapshot operation held");
};
const acknowledgedCommit = "a".repeat(40);
const commits: Array<Parameters<SnapshotInput["commit"]>[0]> = [];
const commit: SnapshotInput["commit"] = async (snapshot) => {
	await assertReady();
	commits.push(snapshot);
	const wanted = new Set(snapshot.files.map(({ path }) => path));
	let removedCount = 0;
	for (const path of published.keys()) {
		if (path.startsWith(snapshot.prefix) && !wanted.has(path)) {
			published.delete(path);
			removedCount++;
		}
	}
	for (const { path, content } of snapshot.files) published.set(path, content);
	if (revokeAfterAcknowledgment) active = false;
	return {
		commitOid: acknowledgedCommit,
		pushedRefs: { "refs/heads/main": { ok: true, error: "" } },
		acknowledgedRef: "refs/heads/main" as const,
		fileCount: snapshot.files.length,
		writtenCount: snapshot.files.length,
		removedCount,
	};
};
const emptied = await publishComputerWorkspaceSnapshot({
	computer: computer(new Map()),
	commit,
});
assert.deepEqual(emptied, {
	ok: true,
	commitOid: acknowledgedCommit,
	scope: { kind: "conversation", key: "a" },
	prefix: "workspace/a/",
	fileCount: 0,
	removedCount: 1,
	skipped: [],
	truncated: false,
});
assert.deepEqual([...published], [["workspace/b/keep.md", "B unchanged"]]);
assert.equal(readinessChecks, 1);
assert.deepEqual(
	commits[0]?.files,
	[],
	"a truly empty workspace must still replace its snapshot prefix",
);
const newFiles = new Map<string, string | null | Error>([
	["notes.md", "new A"],
]);
await publishComputerWorkspaceSnapshot({
	computer: computer(newFiles),
	commit,
	message: "  published A  ",
});
assert.equal(published.get("workspace/a/notes.md"), "new A");
assert.equal(published.get("workspace/b/keep.md"), "B unchanged");
assert.equal(commits[1]?.message, "published A");

for (const [label, files] of [
	[
		"unreadable",
		new Map<string, string | null | Error>([
			["missing.md", new Error("storage failure")],
		]),
	],
	["missing", new Map<string, string | null | Error>([["missing.md", null]])],
	[
		"too large",
		new Map<string, string | null | Error>([
			["huge.md", "x".repeat(WORKSPACE_SNAPSHOT_MAX_FILE_CHARS + 1)],
		]),
	],
	[
		"partial",
		new Map<string, string | null | Error>(
			Array.from({ length: WORKSPACE_SNAPSHOT_MAX_FILES + 1 }, (_, i) => [
				`file-${i}`,
				"small",
			]),
		),
	],
] as const) {
	const count = commits.length;
	const before = [...published];
	const result = await publishComputerWorkspaceSnapshot({
		computer: computer(files),
		commit,
	});
	assert.equal(
		(result as { error: string }).error,
		"workspace_snapshot_incomplete",
		label,
	);
	assert.equal(
		commits.length,
		count,
		`${label} collection must not erase a complete published snapshot`,
	);
	assert.deepEqual([...published], before);
}
// Revocation while collection is awaited must stop the original commit effect.
{
	const scoped = computer(new Map([["notes.md", "held replacement"]]));
	const originalRead = scoped.workspace.readFile.bind(scoped.workspace);
	scoped.workspace.readFile = async (path) => {
		const result = await originalRead(path);
		active = false;
		return result;
	};
	const before = [...published],
		count = commits.length;
	const denied = (await publishComputerWorkspaceSnapshot({
		computer: scoped,
		commit,
	})) as { ok: boolean; error: string };
	assert.equal(denied.ok, false);
	assert.match(denied.error, /original snapshot operation held/);
	assert.deepEqual([...published], before);
	assert.equal(commits.length, count);
	active = true;
	revokeAfterAcknowledgment = true;
	const acknowledged = (await publishComputerWorkspaceSnapshot({
		computer: computer(new Map([["notes.md", "acknowledged original"]])),
		commit,
	})) as { ok: boolean; commitOid: string; fileCount: number };
	assert.equal(active, false);
	assert.equal(acknowledged.ok, true);
	assert.equal(acknowledged.commitOid, acknowledgedCommit);
	assert.equal(acknowledged.fileCount, 1);
	assert.equal(published.get("workspace/a/notes.md"), "acknowledged original");
	active = true;
	revokeAfterAcknowledgment = false;
}
const brokenDirectory = computer(new Map());
brokenDirectory.workspace.readDir = async () => {
	throw new Error("directory unavailable");
};
const before = commits.length;
await assert.rejects(
	publishComputerWorkspaceSnapshot({ computer: brokenDirectory, commit }),
	/directory unavailable/,
);
assert.equal(commits.length, before);
console.log("Computer scoped snapshot publication tests passed.");
