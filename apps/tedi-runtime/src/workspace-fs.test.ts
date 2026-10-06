import {
	boundGitCliOutput,
	GIT_CLI_ALLOWED_SUBCOMMANDS,
	GIT_CLI_LOG_MAX_COUNT,
	GIT_CLI_OUTPUT_MAX_BYTES,
	validateGitCliArgs,
} from "./computer-git-policy";
/**
 * Behavioral coverage for the DO-SQLite VFS workspace adapter
 * (src/workspace-fs.ts). Runs the REAL `@cloudflare/computer`
 * VFS over an in-memory SQLite storage. The fixture adapts Cloudflare
 * Computer's MIT-licensed SQLite test storage from node:sqlite to bun:sqlite;
 * anything that works here works on the DO SQL surface, which is a subset.
 *
 * Also pins the run_git argv gate and the clone_repo core (mocked
 * clone dep: URL shape, Basic auth header, token redaction).
 *
 * Run: `bun run src/workspace-fs.test.ts`.
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import {
	confineGitCwd,
	probeRepoCheckoutKb,
	REPO_CLONE_MAX_CHECKOUT_KB,
	REPO_CLONE_VFS_DIR,
	replaceRepoFallbackSnapshot,
	runRepoClone,
} from "./repo-load";
import {
	adaptVfsToWorkspaceFs,
	writeReversibleWorkspaceFile,
	restoreWorkspaceFile,
	createTediWorkspaceVfs,
	toVfsPath,
	WORKSPACE_GLOB_DEFAULT_EXCLUDE,
	WorkspacePathError,
	type WorkspaceVfsStorage,
} from "./workspace-fs";
import { getTediWorkspaceClient } from "../test/workspace-client";

// ── In-memory DO-storage fixture (bun:sqlite port) ──────────────────

function toSQLiteValue(
	value: unknown,
): string | number | bigint | null | Uint8Array {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Uint8Array) return value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint"
	) {
		return value;
	}
	throw new TypeError(`cannot bind value of type ${typeof value}`);
}

function makeStorage(): WorkspaceVfsStorage {
	const db = new Database(":memory:");
	return {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				let rows: Record<string, unknown>[] = [];
				try {
					rows =
						(db
							.query(query)
							.all(...(bindings.map(toSQLiteValue) as never[])) as Record<
							string,
							unknown
						>[]) ?? [];
				} catch (err) {
					// Multi-statement DDL (schema init) can't prepare(); run it raw.
					if (bindings.length === 0) {
						db.run(query);
					} else {
						throw err;
					}
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

// ── Adapter behavior over the real VFS ──────────────────────────────

const workspaceClient = await getTediWorkspaceClient(
	createTediWorkspaceVfs(makeStorage()),
);
const ws = adaptVfsToWorkspaceFs(workspaceClient);

// Missing reads return null under the workspace file contract.
assert.equal(await ws.readFile("repo/missing.ts"), null);
assert.equal(await ws.readFileBytes("repo/missing.bin"), null);
assert.equal(await ws.stat("repo/missing.ts"), null);
assert.equal(await ws.exists("repo/missing.ts"), false);

// Relative-path write/read roundtrip with implicit parent creation.
await ws.writeFile("repo/src/a.ts", "export const a = 1;\n");
assert.equal(await ws.readFile("repo/src/a.ts"), "export const a = 1;\n");
assert.equal(await ws.exists("repo/src/a.ts"), true);

// Bytes roundtrip (git object shape — binary-safe).
const bytes = new Uint8Array([0, 1, 2, 250, 255]);
await ws.writeFileBytes("repo/.git/objects/blob", bytes);
assert.deepEqual(await ws.readFileBytes("repo/.git/objects/blob"), bytes);

// appendFile creates then extends.
await ws.appendFile("scratch/log.txt", "one\n");
await ws.appendFile("scratch/log.txt", "two\n");
assert.equal(await ws.readFile("scratch/log.txt"), "one\ntwo\n");

// stat/readDir return the relative-path convention (no /workspace leak).
const stat = await ws.stat("repo/src/a.ts");
assert.ok(stat && stat.type === "file" && stat.size > 0);
assert.equal(stat.path, "repo/src/a.ts");
const entries = await ws.readDir("repo/src");
assert.ok(entries.some((e) => e.name === "a.ts" && e.type === "file"));
assert.ok(entries.every((e) => !e.path.startsWith("/workspace")));

// Native directory pagination carries the metadata that stat exposes.
assert.equal(entries.find((entry) => entry.name === "a.ts")?.size, stat.size);
assert.equal(
	entries.find((entry) => entry.name === "a.ts")?.updatedAt,
	stat.updatedAt,
);
await ws.writeFile("repo/src/page.ts", "page");
assert.deepEqual(
	(await ws.readDir("repo/src", { offset: 1, limit: 1 })).map(
		(entry) => entry.name,
	),
	["page.ts"],
);
assert.deepEqual(await ws.readDir("repo/src", { offset: 2, limit: 1 }), []);
await ws.rm("repo/src/page.ts");

// A storage failure while creating a parent must propagate without attempting
// a write. The filesystem cannot safely infer readiness from a failed mkdir.
{
	const failure = new Error("directory storage unavailable");
	let writes = 0;
	const adapter = adaptVfsToWorkspaceFs({
		fs: {
			stat: async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
			mkdir: async () => {
				throw failure;
			},
			writeFile: async () => {
				writes++;
			},
		},
	} as never);
	await assert.rejects(
		adapter.writeFile("new/file.txt", "data"),
		(error) => error === failure,
	);
	assert.equal(writes, 0);
}

// glob finds files across the tree with relative paths.
const globbed = await ws.glob("**/*.ts");
assert.ok(globbed.some((e) => e.path === "repo/src/a.ts"));

// ── Default glob exclusions ─────────────────────────────────────────
//
// The bound has to be real, not advisory: the noise a tedi workspace
// actually grows (a native clone's .git object store, and the
// node_modules / npm-global trees a workstation lease installs into the
// synced workspace) must not be walked or returned by default, while the
// tedi's own checkout stays fully visible.
await ws.writeFile("repo/.git/hooks/pre-commit.ts", "// hook\n");
await ws.writeFile("repo/node_modules/dep/index.ts", "// dep\n");
await ws.writeFile("npm-global/lib/tool.ts", "// tool\n");
{
	const paths = (await ws.glob("**/*.ts")).map((e) => e.path);
	assert.ok(paths.includes("repo/src/a.ts"));
	assert.ok(!paths.includes("repo/.git/hooks/pre-commit.ts"));
	assert.ok(!paths.includes("repo/node_modules/dep/index.ts"));
	assert.ok(!paths.includes("npm-global/lib/tool.ts"));

	// The directory itself is pruned, not merely its matching children:
	// nothing under an excluded root reaches the result for any pattern.
	const everything = (await ws.glob("**/*")).map((e) => e.path);
	assert.ok(everything.includes("repo/src"));
	assert.ok(!everything.includes("repo/.git"));
	assert.ok(!everything.some((p) => p.startsWith("repo/.git/")));
	assert.ok(!everything.some((p) => p.startsWith("repo/node_modules")));
	assert.ok(!everything.some((p) => p.startsWith("npm-global")));
}
{
	// An explicit empty set is a caller asking for the unfiltered walk — a
	// tool whose job is "find everything" must stay able to reach it.
	const paths = (await ws.glob("**/*.ts", { exclude: [] })).map((e) => e.path);
	assert.ok(paths.includes("repo/.git/hooks/pre-commit.ts"));
	assert.ok(paths.includes("repo/node_modules/dep/index.ts"));
	assert.ok(paths.includes("npm-global/lib/tool.ts"));
}
{
	// Widening: spread the default set and add to it.
	const paths = (
		await ws.glob("**/*", {
			exclude: [...WORKSPACE_GLOB_DEFAULT_EXCLUDE, "**/scratch"],
		})
	).map((e) => e.path);
	assert.ok(paths.includes("repo/src/a.ts"));
	assert.ok(!paths.some((p) => p.startsWith("scratch")));
	assert.ok(!paths.some((p) => p.startsWith("repo/node_modules")));
}
{
	// Overriding: a narrower set replaces the default rather than merging,
	// so an entry the caller drops really comes back.
	const paths = (
		await ws.glob("**/*.ts", { exclude: ["**/node_modules"] })
	).map((e) => e.path);
	assert.ok(paths.includes("repo/.git/hooks/pre-commit.ts"));
	assert.ok(!paths.includes("repo/node_modules/dep/index.ts"));
}
// The tedi's own checkout and its identity mount are deliberately NOT in the
// default set: hiding them would be a bug, not an optimisation.
assert.ok(!WORKSPACE_GLOB_DEFAULT_EXCLUDE.some((p) => /(^|\/)repo$/.test(p)));
assert.ok(!WORKSPACE_GLOB_DEFAULT_EXCLUDE.some((p) => p.includes(".r2")));
await ws.rm("repo/.git/hooks/pre-commit.ts");
await ws.rm("repo/node_modules/dep/index.ts");
await ws.rm("npm-global/lib/tool.ts");

// cp + mv + rm.
await ws.cp("repo/src/a.ts", "repo/src/b.ts");
assert.equal(await ws.readFile("repo/src/b.ts"), "export const a = 1;\n");
await ws.mv("repo/src/b.ts", "repo/src/c.ts");
assert.equal(await ws.readFile("repo/src/b.ts"), null);
assert.equal(await ws.readFile("repo/src/c.ts"), "export const a = 1;\n");
await ws.rm("repo/src/c.ts");
assert.equal(await ws.readFile("repo/src/c.ts"), null);
await ws.rm("repo/src/c.ts", { force: true }); // force: missing is fine

// Moves retain native inode/subtree/link identity; failed moves leave both sides intact.
await ws.writeFileBytes("moves/source/nested/data.bin", bytes);
const sourceInode = (await workspaceClient.fs.stat("/workspace/moves/source"))
	.inode;
await ws.mv("moves/source", "moves/destination");
assert.equal(await ws.stat("moves/source"), null);
assert.equal(
	(await workspaceClient.fs.stat("/workspace/moves/destination")).inode,
	sourceInode,
);
assert.deepEqual(
	await ws.readFileBytes("moves/destination/nested/data.bin"),
	bytes,
);

await ws.writeFile("moves/target.txt", "target bytes");
await workspaceClient.fs.symlink("target.txt", "/workspace/moves/link");
const linkInode = (await workspaceClient.fs.lstat("/workspace/moves/link"))
	.inode;
await ws.mv("moves/link", "moves/renamed-link");
assert.equal(await ws.lstat("moves/link"), null);
assert.equal((await ws.lstat("moves/renamed-link"))?.type, "symlink");
assert.equal(
	(await workspaceClient.fs.lstat("/workspace/moves/renamed-link")).inode,
	linkInode,
);
assert.equal(await ws.readlink("moves/renamed-link"), "target.txt");
assert.equal(await ws.readFile("moves/target.txt"), "target bytes");
assert.equal(await ws.readFile("moves/renamed-link"), "target bytes");

await ws.writeFile("moves/replacement.txt", "replacement");
await ws.mv("moves/replacement.txt", "moves/target.txt");
assert.equal(await ws.readFile("moves/replacement.txt"), null);
assert.equal(await ws.readFile("moves/target.txt"), "replacement");
await ws.writeFile("moves/occupied/keep.txt", "keep");
await assert.rejects(() => ws.mv("moves/destination", "moves/occupied"), {
	code: "ENOTEMPTY",
});
assert.deepEqual(
	await ws.readFileBytes("moves/destination/nested/data.bin"),
	bytes,
);
assert.equal(await ws.readFile("moves/occupied/keep.txt"), "keep");
await assert.rejects(
	() => ws.mv("moves/destination", "moves/destination/nested/inside"),
	{ code: "EINVAL" },
);
assert.deepEqual(
	await ws.readFileBytes("moves/destination/nested/data.bin"),
	bytes,
);
await assert.rejects(
	() => ws.mv("moves/target.txt", "missing-parent/destination"),
	{ code: "ENOENT" },
);
assert.equal(await ws.readFile("moves/target.txt"), "replacement");
await assert.rejects(
	() => ws.mv("../outside", "moves/safe"),
	WorkspacePathError,
);
await assert.rejects(
	() => ws.mv("moves/target.txt", "../outside"),
	WorkspacePathError,
);
assert.equal(await ws.readFile("moves/target.txt"), "replacement");

const mounted = adaptVfsToWorkspaceFs(
	await getTediWorkspaceClient(
		createTediWorkspaceVfs(makeStorage(), { identityMount: async () => null }),
	),
);
await mounted.writeFile("source.txt", "preserve on failure");
await assert.rejects(() => mounted.mv("source.txt", ".r2/forbidden.txt"), {
	code: "EROFS",
});
assert.equal(await mounted.readFile("source.txt"), "preserve on failure");

// DurableCodeWorkspace extras: deleteFile + diffContent.
assert.equal(await ws.deleteFile("repo/src/a.ts"), true);
assert.equal(await ws.deleteFile("repo/src/a.ts"), false);
await ws.writeFile("repo/d.ts", "old\n");
const patch = await ws.diffContent("repo/d.ts", "new\n");
assert.ok(patch.includes("-old") && patch.includes("+new"));

// ── Path conventions + confinement ─────────────────────────────────
// Workspace tools describe paths as absolute, but those are logical
// workspace paths. They must root inside the VFS rather than being mistaken
// for already-materialized VFS paths.
assert.equal(toVfsPath("/cert/result.txt"), "/workspace/cert/result.txt");
assert.equal(toVfsPath("/etc/passwd"), "/workspace/etc/passwd");
assert.throws(
	() => toVfsPath("../secret"),
	WorkspacePathError,
	"relative parent-escape must be rejected",
);
assert.throws(
	() => toVfsPath("repo/../../etc/shadow"),
	WorkspacePathError,
	"nested escape must be rejected",
);
assert.throws(
	() => toVfsPath("/workspace/../etc/x"),
	WorkspacePathError,
	"absolute in-then-out escape must be rejected",
);
// In-root paths (including harmless internal `..`) are allowed and normalized.
assert.equal(toVfsPath("repo/x"), "/workspace/repo/x");
assert.equal(toVfsPath("scratch/../repo/x"), "/workspace/repo/x");
assert.equal(toVfsPath("/workspace/repo/x"), "/workspace/repo/x");
assert.equal(
	toVfsPath(".r2/identity/SOUL.md"),
	"/workspace/.r2/identity/SOUL.md",
);

// Behavioral: the confinement is enforced through the adapter surface
// (the same surface bash/codemode/git tools call) — an escaping write/read
// throws WorkspacePathError instead of touching anything outside /workspace.
await assert.rejects(
	() => ws.writeFile("../escape.txt", "nope"),
	WorkspacePathError,
	"adapter writeFile must reject an escaping path",
);
await assert.rejects(
	() => ws.readFile("/workspace/../etc/passwd"),
	WorkspacePathError,
	"adapter readFile must reject an explicit VFS-root escape",
);
// A legitimate write still roundtrips after the guard is in place.
await ws.writeFile("scratch/confined.txt", "ok\n");
assert.equal(await ws.readFile("scratch/confined.txt"), "ok\n");

// clone_repo's exact-file fallback is a replacement snapshot, not an overlay
// on prior repo/ contents. Stage the fetched file, then prove stale source and
// .git state are both removed while the requested file survives.
await ws.writeFile("repo/stale/turn-work.test.ts", "stale\n");
await ws.writeFile("repo/.git/config", "stale git\n");
await ws.writeFile("repo/src/fresh.ts", "fresh\n");
await replaceRepoFallbackSnapshot(
	{
		readFile: (path) => ws.readFile(path),
		writeFile: (path, content) => ws.writeFile(path, content),
		removeRepoDir: () => ws.rm("repo", { recursive: true, force: true }),
	},
	[{ path: "src/fresh.ts", bytes: 6 }],
);
assert.equal(await ws.readFile("repo/src/fresh.ts"), "fresh\n");
assert.equal(await ws.readFile("repo/stale/turn-work.test.ts"), null);
assert.equal(await ws.readFile("repo/.git/config"), null);

console.log("workspace-fs adapter over real VFS: all assertions passed");

// ── run_git argv gate ───────────────────────────────────────────────

assert.deepEqual(validateGitCliArgs(["status"]), {
	ok: true,
	argv: ["status"],
});
assert.equal(validateGitCliArgs([]).ok, false);
assert.equal(validateGitCliArgs(["push", "origin"]).ok, false);
assert.equal(validateGitCliArgs(["fetch"]).ok, false);
assert.equal(validateGitCliArgs(["pull"]).ok, false);
assert.equal(validateGitCliArgs(["clone", "x"]).ok, false);
for (const sub of ["status", "diff", "log", "commit", "checkout"]) {
	assert.ok(GIT_CLI_ALLOWED_SUBCOMMANDS.has(sub), `${sub} must be allowed`);
}
assert.ok(!GIT_CLI_ALLOWED_SUBCOMMANDS.has("push"), "push must stay blocked");
// Too-many-args is rejected.
assert.equal(
	validateGitCliArgs(Array.from({ length: 200 }, () => "x")).ok,
	false,
);

// ── run_git bounds: log default, cwd confinement, output cap ─────────
// A bare `git log` gets a --max-count injected; an explicit count is left alone.
const loggedDefault = validateGitCliArgs(["log"]);
assert.ok(loggedDefault.ok && loggedDefault.argv.length === 2);
assert.equal(
	loggedDefault.ok && loggedDefault.argv[1],
	`--max-count=${GIT_CLI_LOG_MAX_COUNT}`,
);
const loggedExplicit = validateGitCliArgs(["log", "-n", "3"]);
assert.deepEqual(loggedExplicit, { ok: true, argv: ["log", "-n", "3"] });
const loggedShort = validateGitCliArgs(["log", "-5"]);
assert.deepEqual(loggedShort, { ok: true, argv: ["log", "-5"] });

// cwd confinement: default, in-root, and rejected escapes.
assert.deepEqual(confineGitCwd(undefined), {
	ok: true,
	cwd: REPO_CLONE_VFS_DIR,
});
assert.deepEqual(confineGitCwd("src"), {
	ok: true,
	cwd: `${REPO_CLONE_VFS_DIR}/src`,
});
assert.deepEqual(confineGitCwd("/workspace/repo/src"), {
	ok: true,
	cwd: `${REPO_CLONE_VFS_DIR}/src`,
});
assert.equal(confineGitCwd("../..").ok, false, "cwd climbing out is rejected");
assert.equal(
	confineGitCwd("/workspace/.r2").ok,
	false,
	"cwd into a sibling mount is rejected",
);
assert.equal(confineGitCwd("/etc").ok, false, "absolute escape is rejected");

// output cap: oversize stdout is truncated + flagged; small output untouched.
const bigOut = boundGitCliOutput({
	ok: true,
	exitCode: 0,
	stdout: "x".repeat(GIT_CLI_OUTPUT_MAX_BYTES + 100),
	stderr: "",
});
assert.ok(
	(bigOut.stdout as string).length < GIT_CLI_OUTPUT_MAX_BYTES + 100 &&
		(bigOut.stdout as string).includes("truncated"),
);
assert.equal(bigOut.outputTruncated, true);
const smallOut = boundGitCliOutput({ ok: true, exitCode: 0, stdout: "hi" });
assert.equal(smallOut.stdout, "hi");
assert.equal(smallOut.outputTruncated, undefined);

// ── clone_repo core (mocked clone dep) ──────────────────────────────

const cloneCalls: Array<Record<string, unknown>> = [];
const cloneDeps = {
	db: {
		prepare: (sql: string) => ({
			bind: () => ({
				first: async <T>(): Promise<T | null> => {
					if (sql.includes("repo_config")) {
						return {
							repo_config: JSON.stringify({
								repoUrl: "https://github.com/tedix-hq/tedix",
								branch: "main",
							}),
						} as unknown as T;
					}
					return { encrypted_value: "enc" } as unknown as T;
				},
			}),
		}),
	},
	masterKey: undefined, // no PAT decryptable → no_github_pat path
	clone: async (options: Record<string, unknown>) => {
		cloneCalls.push(options);
	},
};

const noPat = await runRepoClone(cloneDeps, { tediId: "t-1" });
assert.deepEqual(noPat, { ok: false, error: "no_github_pat" });
assert.equal(cloneCalls.length, 0);

// ── Happy path end-to-end through runRepoClone (not the mock) ────────
// Real GITHUB_PAT encryption so auth resolution, option construction, and
// token redaction are actually regression-covered — the prior test called
// the clone mock by hand and proved none of that.
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32))); // 32 zero bytes
const TEDI_ID = "t-1";
const TOKEN = "ghp_secrettoken123";
const encryptedPat = await encryptTediSecret(MASTER_KEY, TEDI_ID, TOKEN);

/** Mock db serving repo_config + a REAL encrypted GITHUB_PAT. */
function authedDb() {
	return {
		prepare: (sql: string) => ({
			bind: () => ({
				first: async <T>(): Promise<T | null> => {
					if (sql.includes("repo_config")) {
						return {
							repo_config: JSON.stringify({
								repoUrl: "https://github.com/tedix-hq/tedix",
								branch: "main",
							}),
						} as unknown as T;
					}
					return { encrypted_value: encryptedPat } as unknown as T;
				},
			}),
		}),
	};
}

/**
 * git/trees fixture: the probe measures the bytes a shallow checkout
 * materialises, so a stub returns blob entries whose sizes sum to `kb`.
 * Directory entries carry no size and must not be counted.
 */
function treeFetch(kb: number, truncated = false): typeof fetch {
	return (async () =>
		new Response(
			JSON.stringify({
				tree: [
					{ path: "src", type: "tree" },
					{ path: "src/index.ts", type: "blob", size: kb * 1024 },
				],
				truncated,
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;
}

const e2eCalls: Array<Record<string, unknown>> = [];
const okResult = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async (o: Record<string, unknown>) => {
			e2eCalls.push(o);
		},
		removeCloneDir: async () => {},
		// Checkout probe returns a small working tree → clone proceeds.
		fetchImpl: treeFetch(1234),
	},
	{ tediId: TEDI_ID, ref: "main" },
);
assert.equal(okResult.ok, true, "e2e clone should succeed");
assert.equal(okResult.gitAvailable, true);
assert.equal(okResult.snapshotIsolated, true);
assert.equal(e2eCalls.length, 1, "runRepoClone must invoke clone exactly once");
const e2eOpts = e2eCalls[0] as Record<string, unknown>;
assert.equal(e2eOpts.dir, REPO_CLONE_VFS_DIR);
assert.equal(e2eOpts.url, "https://github.com/tedix-hq/tedix.git");
assert.equal(e2eOpts.singleBranch, true);
assert.equal(e2eOpts.depth, 1);
assert.equal(
	(e2eOpts.headers as Record<string, string>).Authorization,
	`Basic ${btoa(`x-access-token:${TOKEN}`)}`,
	"runRepoClone builds Basic auth from the decrypted PAT",
);

// Credential redaction: a clone error carrying the token is scrubbed.
const redactResult = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async () => {
			throw new Error(`fatal: auth failed for x-access-token:${TOKEN}`);
		},
		removeCloneDir: async () => {},
		fetchImpl: treeFetch(10),
	},
	{ tediId: TEDI_ID },
);
assert.equal(redactResult.ok, false);
assert.equal(redactResult.error, "clone_failed");
assert.ok(
	typeof redactResult.reason === "string" &&
		!redactResult.reason.includes(TOKEN),
	"the PAT must never leak into a clone error reason",
);

// ── The size probe measures the materialised checkout, not history ───
{
	const probeAuth = { owner: "tedix-hq", repo: "tedix", token: TOKEN };
	const urls: string[] = [];

	// Blob bytes are summed; tree entries carry no size and are ignored.
	const measured = await probeRepoCheckoutKb(
		{ ...probeAuth, ref: "main" },
		(async (url: string) => {
			urls.push(String(url));
			return new Response(
				JSON.stringify({
					tree: [
						{ path: "a", type: "tree" },
						{ path: "a/b.ts", type: "blob", size: 2048 },
						{ path: "c.ts", type: "blob", size: 1024 },
						{ path: "sub", type: "commit" },
					],
					truncated: false,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch,
	);
	assert.deepEqual(measured, { ok: true, checkoutKb: 3 });
	assert.ok(
		urls[0]?.includes("/git/trees/main?recursive=1"),
		"the probe reads the tip tree of the ref being cloned, not /repos metadata",
	);

	// A packed history far above the ceiling no longer blocks a small tree:
	// the old `size` field is not consulted at all.
	const historyHeavy = await probeRepoCheckoutKb(
		probeAuth,
		(async () =>
			new Response(
				JSON.stringify({
					size: REPO_CLONE_MAX_CHECKOUT_KB * 10,
					tree: [{ path: "a.ts", type: "blob", size: 1024 }],
					truncated: false,
				}),
				{ status: 200 },
			)) as unknown as typeof fetch,
	);
	assert.deepEqual(historyHeavy, { ok: true, checkoutKb: 1 });

	// Over the ceiling on materialised bytes → typed rejection.
	const overBytes = await probeRepoCheckoutKb(
		probeAuth,
		treeFetch(REPO_CLONE_MAX_CHECKOUT_KB + 1),
	);
	assert.deepEqual(overBytes, {
		ok: false,
		error: "too_large_for_native",
		checkoutKb: REPO_CLONE_MAX_CHECKOUT_KB + 1,
		reason: "tree_bytes",
	});

	// A truncated tree is itself the verdict: GitHub truncates above 100k
	// entries, which is past agent scale whatever the byte total says.
	const truncated = await probeRepoCheckoutKb(probeAuth, treeFetch(1, true));
	assert.deepEqual(truncated, {
		ok: false,
		error: "too_large_for_native",
		checkoutKb: null,
		reason: "tree_truncated",
	});

	// A slash-bearing branch is ambiguous against the trees route; the probe
	// keeps the gate by retrying the remote default tip.
	const retried: string[] = [];
	const slashRef = await probeRepoCheckoutKb(
		{ ...probeAuth, ref: "feature/x" },
		(async (url: string) => {
			retried.push(String(url));
			if (retried.length === 1) return new Response("", { status: 404 });
			return new Response(
				JSON.stringify({
					tree: [{ path: "a.ts", type: "blob", size: 1024 }],
					truncated: false,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch,
	);
	assert.deepEqual(slashRef, { ok: true, checkoutKb: 1 });
	assert.equal(retried.length, 2);
	assert.ok(retried[1]?.includes("/git/trees/HEAD?recursive=1"));

	// Fail-open on an unusable probe: rate limit, and a thrown fetch.
	assert.deepEqual(
		await probeRepoCheckoutKb(
			probeAuth,
			(async () =>
				new Response("", { status: 403 })) as unknown as typeof fetch,
		),
		{ ok: true, checkoutKb: null },
	);
	assert.deepEqual(
		await probeRepoCheckoutKb(probeAuth, (async () => {
			throw new Error(`network down for x-access-token:${TOKEN}`);
		}) as unknown as typeof fetch),
		{ ok: true, checkoutKb: null },
		"a probe failure must never carry the PAT out, and must fail open",
	);
}

// ── Checkout-size ceiling → typed workstation escalation ─────────────
const tooBig = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async () => {
			throw new Error("clone should never run for an oversized repo");
		},
		fetchImpl: treeFetch(REPO_CLONE_MAX_CHECKOUT_KB + 1),
	},
	{ tediId: TEDI_ID },
);
assert.equal(tooBig.ok, false);
assert.equal(tooBig.error, "too_large_for_native");
assert.equal(tooBig.escalate, "workstation", "oversize clone escalates typed");

// A sparse checkout is not exempt from the Git ceiling: isomorphic-git still
// downloads the tip tree's complete blob set. Exact paths automatically fall
// back to repo_load instead of forcing a workstation.
const sparseCalls: Array<Record<string, unknown>> = [];
const fallbackCalls: Array<{ ref?: string; paths: string[] }> = [];
const replacementCalls: unknown[][] = [];
const sparseTooBig = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async (o: Record<string, unknown>) => {
			sparseCalls.push(o);
		},
		removeCloneDir: async () => {},
		fetchImpl: treeFetch(REPO_CLONE_MAX_CHECKOUT_KB + 1),
		loadFilesFallback: async (input) => {
			fallbackCalls.push(input);
			return {
				ok: true,
				files: input.paths.map((path) => ({ path, bytes: 1 })),
				fileCount: input.paths.length,
			};
		},
		replaceFallbackSnapshot: async (files) => {
			replacementCalls.push(files);
		},
	},
	{ tediId: TEDI_ID, ref: "main", paths: ["packages/db"] },
);
assert.equal(sparseTooBig.ok, true);
assert.equal(sparseTooBig.mode, "repo_load_fallback");
assert.equal(sparseTooBig.gitAvailable, false);
assert.equal(sparseTooBig.snapshotIsolated, true);
assert.deepEqual(sparseTooBig.cloneSkipped, {
	reason: "too_large_for_native",
	checkoutKb: REPO_CLONE_MAX_CHECKOUT_KB + 1,
	limitKb: REPO_CLONE_MAX_CHECKOUT_KB,
	oversizeReason: "tree_bytes",
});
assert.deepEqual(fallbackCalls, [{ ref: "main", paths: ["packages/db"] }]);
assert.deepEqual(replacementCalls, [[{ path: "packages/db", bytes: 1 }]]);
assert.equal(
	sparseCalls.length,
	0,
	"oversized sparse clone is rejected before clone",
);

const isolationFailure = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async () => {
			throw new Error("clone must not run for an oversized repo");
		},
		removeCloneDir: async () => {},
		fetchImpl: treeFetch(REPO_CLONE_MAX_CHECKOUT_KB + 1),
		loadFilesFallback: async () => ({
			ok: true,
			files: [{ path: "src/fresh.ts", bytes: 6 }],
			fileCount: 1,
		}),
		replaceFallbackSnapshot: async () => {
			throw new Error("replacement failed");
		},
	},
	{ tediId: TEDI_ID, paths: ["src/fresh.ts"] },
);
assert.equal(isolationFailure.ok, false);
assert.equal(isolationFailure.error, "repo_load_fallback_isolation_failed");
assert.equal(isolationFailure.escalate, "workstation");

const isolationUnavailable = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async () => {
			throw new Error("clone must not run for an oversized repo");
		},
		removeCloneDir: async () => {},
		fetchImpl: treeFetch(REPO_CLONE_MAX_CHECKOUT_KB + 1),
		loadFilesFallback: async () => ({
			ok: true,
			files: [{ path: "src/fresh.ts", bytes: 6 }],
			fileCount: 1,
		}),
	},
	{ tediId: TEDI_ID, paths: ["src/fresh.ts"] },
);
assert.equal(isolationUnavailable.ok, false);
assert.equal(
	isolationUnavailable.error,
	"repo_load_fallback_isolation_unavailable",
);
assert.equal(isolationUnavailable.escalate, "workstation");

const sparseOk = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async (o: Record<string, unknown>) => {
			sparseCalls.push(o);
		},
		removeCloneDir: async () => {},
		fetchImpl: treeFetch(10),
	},
	{ tediId: TEDI_ID, paths: ["packages/db"] },
);
assert.equal(sparseOk.ok, true);
assert.equal(
	sparseCalls.length,
	1,
	"bounded sparse clone proceeds after the size probe",
);

// ── A failed clone cleans the partial tree so a retry is clean ───────
let removed = 0;
const failThenClean = await runRepoClone(
	{
		db: authedDb() as unknown as typeof cloneDeps.db,
		masterKey: MASTER_KEY,
		clone: async () => {
			throw new Error("network reset mid-clone");
		},
		removeCloneDir: async () => {
			removed += 1;
		},
		fetchImpl: treeFetch(10),
	},
	{ tediId: TEDI_ID },
);
assert.equal(failThenClean.ok, false);
assert.equal(
	removed,
	2,
	"a clone must clear both the prior tree and its failed partial tree",
);

// Ref validation still happens before any network attempt.
const badRef = await runRepoClone(
	{ ...cloneDeps, masterKey: undefined },
	{ tediId: "t-1", ref: "../evil" },
);
assert.equal(badRef.ok, false);

console.log("workspace-fs.test.ts OK");

// Register the native Git factory at Workspace construction. A client getter
// alone must not pass this test while every repository operation fails at runtime.
{
	const workspace = createTediWorkspaceVfs(makeStorage());
	const client = await getTediWorkspaceClient(workspace);
	const result = await client.git.cli({
		argv: ["init"],
		cwd: "/workspace/repo",
	});
	assert.equal(result.exitCode, 0, JSON.stringify(result));
	const status = await client.git.cli({
		argv: ["status", "--short"],
		cwd: "/workspace/repo",
	});
	assert.equal(status.exitCode, 0, JSON.stringify(status));
	assert.equal(status.stdout.trim(), "");
}

{
	const path = "guarded-undo.txt";
	await ws.writeFile(path, "before");
	const receipt = await writeReversibleWorkspaceFile(ws, path, "approved");
	assert.equal(receipt.previousContent, "before");
	await ws.writeFile(path, "newer");
	await assert.rejects(
		restoreWorkspaceFile(ws, path, "approved", receipt.previousContent),
		/workspace_rollback_conflict/,
	);
	assert.equal(await ws.readFile(path), "newer");
	await ws.deleteFile(path);
	await assert.rejects(
		restoreWorkspaceFile(ws, path, "approved", receipt.previousContent),
		/workspace_rollback_conflict/,
	);
	assert.equal(await ws.readFile(path), null);
	const created = await writeReversibleWorkspaceFile(ws, path, "");
	assert.equal(created.previousContent, null);
	await restoreWorkspaceFile(ws, path, "", null);
	assert.equal(await ws.readFile(path), null);
	await ws.writeFile(path, "");
	const empty = await writeReversibleWorkspaceFile(ws, path, "approved");
	await restoreWorkspaceFile(ws, path, "approved", empty.previousContent);
	assert.equal(await ws.readFile(path), "");
	await assert.rejects(
		restoreWorkspaceFile(ws, path, "", undefined as never),
		/Invalid reversible/,
	);
	assert.equal(await ws.readFile(path), "");
	await assert.rejects(
		writeReversibleWorkspaceFile(ws, path, "x".repeat(250001)),
		/reversible workspace limit/,
	);
	assert.equal(await ws.readFile(path), "");
}
