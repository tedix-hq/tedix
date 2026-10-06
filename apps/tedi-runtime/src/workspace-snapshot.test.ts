/**
 * workspace_snapshot collection — behavioral coverage over the real VFS
 * (bun:sqlite DO-storage fixture, same pattern as r2-mount.test.ts):
 *   1. regular files collect with correct relative paths and content;
 *   2. the structural exclusions hold (`repo/` clones never snapshot);
 *   3. oversized files are skipped-with-reason, never truncated silently;
 *   4. the maxFiles cap flags `truncated` instead of wedging;
 * plus the runtime wiring: registration, Git tools bound to the same scope,
 * write-mutex serialization, the workspace/ prefix, and the escape guard.
 * Run: `bun run src/workspace-snapshot.test.ts`.
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { commitPrefixSnapshot } from "./artifacts-git";

import type { WorkspaceVfsStorage } from "./workspace-fs";
// Only platform tracing/RPC boundaries are mocked; the VFS and snapshot
// publication below use their real application implementations.
const bunTestModule = "bun:test";
const { mock: platformMock } = await import(bunTestModule);
platformMock.module("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	RpcTarget: class {},
	tracing: {},
	exports: {},
	env: {},
}));
platformMock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
const { tediDo } = await import("../test/tedi-do");
const { ScopedComputerWorkspace } = await import("./computer-workspace-scope");
const {
	adaptVfsToWorkspaceFs,
	collectWorkspaceSnapshotFiles,
	createTediWorkspaceVfs,
} = await import("./workspace-fs");

function makeStorage(): WorkspaceVfsStorage {
	const db = new Database(":memory:");
	return {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				let rows: Record<string, unknown>[] = [];
				try {
					rows =
						(db.query(query).all(...(bindings as never[])) as Record<
							string,
							unknown
						>[]) ?? [];
				} catch (err) {
					if (bindings.length === 0) db.run(query);
					else throw err;
				}
				const snapshot = rows;
				return {
					toArray: () => snapshot,
					one: () => snapshot[0],
					raw: () => snapshot.map((r) => Object.values(r)),
					[Symbol.iterator]() {
						return snapshot[Symbol.iterator]();
					},
				};
			},
		},
		transactionSync<T>(closure: () => T): T {
			db.run("BEGIN");
			try {
				const result = closure();
				db.run("COMMIT");
				return result;
			} catch (error) {
				db.run("ROLLBACK");
				throw error;
			}
		},
	} as unknown as WorkspaceVfsStorage;
}

const ws = createTediWorkspaceVfs(makeStorage());
const fs = adaptVfsToWorkspaceFs(ws);

await fs.mkdir("", { recursive: true });
await fs.writeFile("NOTES.md", "top-level note");
await fs.writeFile("plans/q3.md", "quarter plan");
await fs.writeFile("repo/tedix/src/index.ts", "// cloned repo — excluded");
await fs.writeFile("big.txt", "x".repeat(500));

// 1 + 2 + 3: collection, exclusion, oversize skip.
const collection = await collectWorkspaceSnapshotFiles(fs, {
	maxFileChars: 400,
});
assert.deepEqual(
	collection.files.map((f) => f.path).sort(),
	["NOTES.md", "plans/q3.md"],
	"regular files collect; repo/ is structurally excluded",
);
assert.equal(
	collection.files.find((f) => f.path === "plans/q3.md")?.content,
	"quarter plan",
	"content survives collection byte-for-byte",
);
assert.deepEqual(
	collection.skipped,
	[{ path: "big.txt", reason: "too-large" }],
	"oversized files are skipped with a reason",
);
assert.equal(collection.truncated, false, "no truncation below the cap");

// 4: cap flags truncated.
const capped = await collectWorkspaceSnapshotFiles(fs, {
	maxFiles: 1,
	maxFileChars: 400,
});
assert.equal(capped.truncated, true, "maxFiles cap flags truncated");
assert.equal(capped.files.length, 1, "cap bounds the file set");

// The runtime registers workspace_snapshot and binds the native Git tools to
// the same scoped workspace they were built for.
{
	const scope = { kind: "conversation", key: "main" } as const;
	const computer = {
		scope,
		snapshotPrefix: "workspace/scope-1/",
		workspace: fs,
		tools: () => ({}),
	};
	const used: Array<[string, unknown]> = [];
	const agent = tediDo({
		computerWorkspace: () => computer,
		computerEnvironment: () => ({}),
		async repoCloneTool(_input: unknown, bound: unknown) {
			used.push(["clone", bound]);
			return { ok: true };
		},
		async gitCliTool(_input: unknown, bound: unknown) {
			used.push(["git", bound]);
			return { ok: true };
		},
	});
	const tools = agent.workspaceAiTools(scope, null) as Record<
		string,
		{ execute: (input: unknown, options: unknown) => Promise<unknown> }
	>;
	assert.ok(tools.workspace_snapshot, "workspace_snapshot is a native tool");
	const options = { toolCallId: "t", messages: [] };
	await tools.clone_repo!.execute(
		{ url: "https://github.com/acme/app" },
		options,
	);
	await tools.run_git!.execute({ args: ["status"] }, options);
	assert.deepEqual(used, [
		["clone", computer],
		["git", computer],
	]);
}

// commitPrefixSnapshot rejects files outside its prefix before admission or any write.
let rejectedPrefixGateCalls = 0;
await assert.rejects(
	commitPrefixSnapshot({
		assertReady: async () => {
			rejectedPrefixGateCalls++;
		},
		artifacts: {} as never,
		accountId: "account",
		namespace: "ns",
		tediId: "tedi-1",
		slug: "acme",
		prefix: "workspace/scope-1/",
		files: [{ path: "memory/MEMORY.md", content: "x" }],
		message: "m",
	}),
	/snapshot file escapes its prefix/,
);

assert.equal(
	rejectedPrefixGateCalls,
	0,
	"invalid prefix cannot admit or issue an artifact effect",
);

// Snapshot commits serialize on the daily-log write mutex (one repo, one
// writer), under the originating scope's prefix.
{
	const committed: Array<{ prefix: string; paths: string[] }> = [];
	let readinessChecks = 0;
	const acknowledgedCommit = "a".repeat(40);
	const { mock } = createRequire(import.meta.url)("bun:test") as {
		mock: {
			module(name: string, factory: () => Record<string, unknown>): void;
		};
	};
	const artifactsGit = await import("./artifacts-git");
	mock.module("./artifacts-git", () => ({
		...artifactsGit,
		async commitPrefixSnapshot(args: {
			assertReady: () => Promise<void>;
			prefix: string;
			files: Array<{ path: string }>;
		}) {
			assert.equal(
				typeof args.assertReady,
				"function",
				"runtime must supply the originating operation's mandatory gate",
			);
			await args.assertReady();
			readinessChecks++;
			committed.push({
				prefix: args.prefix,
				paths: args.files.map((file) => file.path),
			});
			return {
				commitOid: acknowledgedCommit,
				pushedRefs: { "refs/heads/main": { ok: true, error: "" } },
				acknowledgedRef: "refs/heads/main" as const,
				fileCount: args.files.length,
				writtenCount: args.files.length,
				removedCount: 0,
			};
		},
	}));
	const snapshotWs = adaptVfsToWorkspaceFs(
		createTediWorkspaceVfs(makeStorage()),
	);
	await snapshotWs.mkdir("", { recursive: true });
	await snapshotWs.writeFile("NOTES.md", "note");
	let releaseDailyLog!: () => void;
	const agent = tediDo({
		env: { ARTIFACTS: {}, CF_ACCOUNT_ID: "account" },
		state: { tediId: "tedi-1", slug: "acme" },
		async ensureIdentity() {},
		dailyLogWriteLock: new Promise<void>((resolve) => {
			releaseDailyLog = resolve;
		}),
	});
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "original-snapshot-run",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: { kind: "snapshot", scope: "main" },
		expectedGeneration: 1,
	});
	const snapshot = agent.workspaceSnapshotTool(
		{},
		{
			scope: { kind: "conversation", key: "main" },
			snapshotPrefix: "workspace/scope-1/",
			workspace: snapshotWs,
		},
		"original-snapshot-run",
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(committed, [], "waits for the in-flight daily-log write");
	releaseDailyLog();
	const result = (await snapshot) as {
		ok: boolean;
		commitOid: string;
		fileCount: number;
	};
	assert.equal(readinessChecks, 1);
	assert.equal(result.ok, true);
	assert.equal(result.commitOid, acknowledgedCommit);
	assert.equal(result.fileCount, 1);
	assert.deepEqual(committed, [
		{ prefix: "workspace/scope-1/", paths: ["workspace/scope-1/NOTES.md"] },
	]);
	// The binding callback retains this original run through the write-mutex await.
	let releaseHeld!: () => void;
	agent.dailyLogWriteLock = new Promise<void>((resolve) => {
		releaseHeld = resolve;
	});
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "original-held-run",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: { kind: "snapshot", scope: "main" },
		expectedGeneration: 1,
	});
	const pending = agent.workspaceSnapshotTool(
		{},
		{
			scope: { kind: "conversation", key: "main" },
			snapshotPrefix: "workspace/scope-1/",
			workspace: snapshotWs,
		},
		"original-held-run",
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await agent.ctx.storage.put("wfcancel:original-held-run", true);
	releaseHeld();
	const rejected = (await pending) as { ok: boolean; error: string };
	assert.equal(rejected.ok, false);
	assert.match(rejected.error, /canceled/);
	assert.equal(
		committed.length,
		1,
		"revocation during mutex await prevents the actual commit boundary",
	);
}

// Snapshots own only the originating scope beneath workspace/.
{
	const scoped = new ScopedComputerWorkspace(
		{
			idFromName: () => ({ toString: () => "scope-id" }),
			get: () => ({}),
		} as unknown as ConstructorParameters<typeof ScopedComputerWorkspace>[0],
		{ kind: "conversation", key: "main" },
		"owner",
		async () => "tedi-1",
	);
	assert.equal(scoped.snapshotPrefix, "workspace/scope-id/");
}

console.log("workspace-snapshot OK");
