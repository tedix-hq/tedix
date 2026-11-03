import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	symlinkSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	repoSnapshotManifest,
	repoSnapshotCommand,
	readRepoSnapshotResult,
	REPO_SNAPSHOT_SCRIPT,
} from "./repo-commit-snapshot";

const linuxImage = process.env.TEDIX_EXACT_TREE_LINUX_IMAGE;
const nativeSupported = process.platform === "linux" || Boolean(linuxImage);

async function fixture(
	check: string,
	run: (f: {
		dir: string;
		baseSha: string;
		git: (...a: string[]) => string;
		write: (p: string, c: string) => void;
	}) => Promise<void>,
) {
	if (!nativeSupported) return;
	const dir = mkdtempSync(join(tmpdir(), "exact-tree-test-"));
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	const write = (p: string, c: string) => {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), c);
	};
	try {
		git("init", "-q");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.invalid");
		git("remote", "add", "origin", "https://github.com/example/repository.git");
		write("selected.txt", "old");
		write("unselected.txt", "base");
		write("deleted.txt", "remove");
		write("scripts/ci/preflight-gates.mjs", check);
		git("add", ".");
		git("commit", "-qm", "base");
		await run({ dir, baseSha: git("rev-parse", "HEAD"), git, write });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
async function gate(
	f: { dir: string; baseSha: string },
	changes: Array<{ path: string; content: string | null }>,
	script = REPO_SNAPSHOT_SCRIPT,
	environment: Record<string, string> = {},
) {
	const manifest = await repoSnapshotManifest({
		owner: "example",
		repo: "repository",
		baseSha: f.baseSha,
		changes,
	});
	let command = "bash",
		args = ["-c", repoSnapshotCommand(manifest)];
	if (linuxImage) {
		writeFileSync(
			join(f.dir, ".snapshot-test.js"),
			"process.argv.splice(1,1);\n" + script,
		);
		mkdirSync(join(f.dir, ".snapshot-tools"), { recursive: true });
		writeFileSync(
			join(f.dir, ".snapshot-tools/bun"),
			'#!/bin/sh\nexec node "$@"\n',
			{ mode: 0o755 },
		);
		command = "docker";
		args = [
			"run",
			"--rm",
			"--network",
			"none",
			"--platform",
			"linux/amd64",
			"--memory",
			"1g",
			"--cpus",
			"2",
			"--pids-limit",
			"128",
			"--volume",
			`${f.dir}:/fixture`,
			"--workdir",
			"/fixture",
			"--env",
			"PATH=/fixture/.snapshot-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"--env",
			"GIT_CONFIG_COUNT=1",
			"--env",
			"GIT_CONFIG_KEY_0=safe.directory",
			"--env",
			"GIT_CONFIG_VALUE_0=/fixture",
			...Object.entries(environment).flatMap(([key, value]) => [
				"--env",
				`${key}=${value}`,
			]),
			linuxImage,
			"node",
			"/fixture/.snapshot-test.js",
			JSON.stringify(manifest),
		];
	} else if (script !== REPO_SNAPSHOT_SCRIPT) {
		writeFileSync(
			join(f.dir, ".snapshot-test.js"),
			"process.argv.splice(1,1);\n" + script,
		);
		command = "bun";
		args = [join(f.dir, ".snapshot-test.js"), JSON.stringify(manifest)];
	}
	const result = spawnSync(command, args, {
		cwd: f.dir,
		env: { ...process.env, ...environment },
		encoding: "utf8",
		timeout: 45000,
		maxBuffer: 5 * 1024 * 1024,
	});
	return {
		...result,
		parsed: readRepoSnapshotResult(result.stdout ?? "", manifest),
	};
}

// Unselected dirty content is absent, selected overlay and declared deletions are present.
await fixture(
	`import fs from 'node:fs'; if(fs.readFileSync('selected.txt','utf8')!=='new'||fs.readFileSync('unselected.txt','utf8')!=='base'||fs.existsSync('deleted.txt'))process.exit(1);`,
	async (f) => {
		f.write("selected.txt", "new");
		f.write("unselected.txt", "dirty");
		const r = await gate(f, [
			{ path: "selected.txt", content: "new" },
			{ path: "deleted.txt", content: null },
		]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.parsed);
		assert.equal(readFileSync(join(f.dir, "unselected.txt"), "utf8"), "dirty");
		assert.equal(f.git("rev-parse", "HEAD"), f.baseSha);
		assert.equal(
			f.git("worktree", "list", "--porcelain").split("worktree ").length,
			2,
		);
	},
);

// Negative control: dirty unselected code would make the old mutable check pass.
await fixture(
	`import fs from 'node:fs';if(fs.readFileSync('unselected.txt','utf8')!=='dirty')process.exit(1);`,
	async (f) => {
		f.write("selected.txt", "new");
		f.write("unselected.txt", "dirty");
		assert.equal(
			spawnSync("bun", ["scripts/ci/preflight-gates.mjs"], { cwd: f.dir })
				.status,
			0,
		);
		const r = await gate(f, [{ path: "selected.txt", content: "new" }]);
		assert.notEqual(r.status, 0);
		assert.equal(r.parsed, null);
	},
);

await fixture("", async (f) => {
	f.write("selected.txt", "actual");
	const r = await gate(f, [{ path: "selected.txt", content: "different" }]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /snapshot_source_mismatch/);
});

// Relative dependency workspace links must resolve into isolated source, never original dirty packages.
await fixture(
	`import fs from 'node:fs';if(fs.readFileSync('node_modules/workspace/value.txt','utf8')!=='base-package'||fs.readFileSync('apps/example/node_modules/workspace/value.txt','utf8')!=='base-package')process.exit(1);`,
	async (f) => {
		f.write("package.json", "{}");
		f.write("apps/example/package.json", "{}");
		f.write("packages/workspace/value.txt", "base-package");
		f.git("add", ".");
		f.git("commit", "-qm", "workspace");
		f.baseSha = f.git("rev-parse", "HEAD");
		mkdirSync(join(f.dir, "node_modules"));
		mkdirSync(join(f.dir, "apps/example/node_modules"));
		symlinkSync(
			"../../../packages/workspace",
			join(f.dir, "apps/example/node_modules/workspace"),
		);
		symlinkSync("../packages/workspace", join(f.dir, "node_modules/workspace"));
		f.write("packages/workspace/value.txt", "dirty-package");
		f.write("selected.txt", "new");
		const r = await gate(f, [{ path: "selected.txt", content: "new" }]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.parsed);
	},
);

await fixture("", async (f) => {
	mkdirSync(join(f.dir, "deep"));
	symlinkSync("../..", join(f.dir, "deep/link"));
	symlinkSync("deep/link/../../outside", join(f.dir, "rootlink"));
	f.git("add", ".");
	f.git("commit", "-qm", "links");
	f.baseSha = f.git("rev-parse", "HEAD");
	f.write("selected.txt", "new");
	const r = await gate(f, [{ path: "selected.txt", content: "new" }]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /symlink_escape/);
});

await fixture(
	`import fs from 'node:fs';fs.writeFileSync('selected.txt','rewritten');`,
	async (f) => {
		f.write("selected.txt", "new");
		const r = await gate(f, [{ path: "selected.txt", content: "new" }]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /snapshot_raw_tree_mismatch/);
	},
);

await fixture("", async (f) => {
	f.write("selected.txt", "new");
	await assert.rejects(
		repoSnapshotManifest({
			owner: "example",
			repo: "repository",
			baseSha: f.baseSha,
			changes: [{ path: "selected.txt", content: "x".repeat(65537) }],
		}),
		/content_limit/,
	);
	await assert.rejects(
		repoSnapshotManifest({
			owner: "example",
			repo: "repository",
			baseSha: f.baseSha,
			changes: [{ path: "../escape", content: "x" }],
		}),
		/invalid_snapshot_path/,
	);
});
await fixture("", async (f) => {
	f.write("oversized", "x".repeat(8388609));
	f.git("add", ".");
	f.git("commit", "-qm", "large base");
	f.baseSha = f.git("rev-parse", "HEAD");
	f.write("selected.txt", "new");
	const r = await gate(f, [{ path: "selected.txt", content: "new" }]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /snapshot_tree_byte_limit/);
	assert.equal(
		f.git("worktree", "list", "--porcelain").split("worktree ").length,
		2,
		"oversized tree refused before temporary checkout",
	);
});
await fixture(
	`import fs from 'node:fs'; const value=fs.readFileSync('node_modules/value','utf8'); console.log(value); if(value!=='allowed')process.exit(1);`,
	async (f) => {
		f.write("package.json", "{}");
		f.git("add", ".");
		f.git("commit", "-qm", "dependencies");
		f.baseSha = f.git("rev-parse", "HEAD");
		f.write("node_modules/value", "allowed");
		f.write("selected.txt", "new");
		const injection = `if(relative === "node_modules") { fs.mkdirSync("/tmp/exact-tree-external-"+process.pid); fs.writeFileSync("/tmp/exact-tree-external-"+process.pid+"/value","forbidden"); fs.renameSync(path.join(source,"node_modules"),path.join(source,"node_modules-original")); fs.symlinkSync("/tmp/exact-tree-external-"+process.pid,path.join(source,"node_modules")); }`;
		const script =
			REPO_SNAPSHOT_SCRIPT.replace(
				"const directory = fs.opendirSync(anchored);",
				"const directory = fs.opendirSync(anchored);" + injection,
			) +
			`\nfs.rmSync("/tmp/exact-tree-external-"+process.pid,{recursive:true,force:true});`;
		assert.notEqual(script, REPO_SNAPSHOT_SCRIPT);
		const r = await gate(f, [{ path: "selected.txt", content: "new" }], script);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(
			!r.stdout.includes("forbidden"),
			"held directory cannot read swapped external cache",
		);
	},
);

await fixture(
	`import fs from 'node:fs';if(fs.readFileSync('helper.txt','utf8')!=='dirty')process.exit(1);`,
	async (f) => {
		f.write("helper.txt", "base");
		f.write(".gitattributes", "helper.txt filter=trick\n");
		f.git("add", ".");
		f.git("commit", "-qm", "filtered source");
		f.baseSha = f.git("rev-parse", "HEAD");
		f.git("config", "filter.trick.smudge", "sed s/base/dirty/g");
		f.git("config", "filter.trick.clean", "sed s/dirty/base/g");
		f.write("selected.txt", "new");
		const filteredControl = REPO_SNAPSHOT_SCRIPT.replaceAll(
			"\n verifyRawTree();",
			"",
		).replace(
			' if (git(["rev-parse", "HEAD^{tree}"]',
			' git(["add","-u"],{cwd:checkout}); if(git(["write-tree"],{cwd:checkout}).trim()!==tree)refuse("control_clean_tree_mismatch");\n if (git(["rev-parse", "HEAD^{tree}"]',
		);
		assert.notEqual(filteredControl, REPO_SNAPSHOT_SCRIPT);
		const control = await gate(
			f,
			[{ path: "selected.txt", content: "new" }],
			filteredControl,
		);
		assert.equal(control.status, 0, control.stderr);
		const actual = await gate(f, [{ path: "selected.txt", content: "new" }]);
		assert.notEqual(actual.status, 0);
		assert.match(actual.stderr, /snapshot_raw_tree_mismatch/);
	},
);

await fixture(
	`import fs from 'node:fs';if(fs.readFileSync('nested/file.txt','utf8')!=='new')process.exit(1);`,
	async (f) => {
		f.write("nested/file.txt", "base");
		f.git("add", ".");
		f.git("commit", "-qm", "nested source");
		f.baseSha = f.git("rev-parse", "HEAD");
		f.write("nested/file.txt", "new");
		const injection = `if(f.path==='nested/file.txt'){fs.mkdirSync('/tmp/exact-selected-'+process.pid);fs.writeFileSync('/tmp/exact-selected-'+process.pid+'/file.txt','forbidden');fs.renameSync(path.join(source,'nested'),path.join(source,'nested-original'));fs.symlinkSync('/tmp/exact-selected-'+process.pid,path.join(source,'nested'));}`;
		const script =
			REPO_SNAPSHOT_SCRIPT.replace(
				"  let fd;",
				"  " + injection + "\n  let fd;",
			) +
			`\nfs.rmSync('/tmp/exact-selected-'+process.pid,{recursive:true,force:true});`;
		assert.notEqual(script, REPO_SNAPSHOT_SCRIPT);
		const r = await gate(
			f,
			[{ path: "nested/file.txt", content: "new" }],
			script,
		);
		assert.equal(r.status, 0, r.stderr);
	},
);

await fixture("", async (f) => {
	f.write("selected.txt", "new");
	const r = await gate(
		f,
		[{ path: "selected.txt", content: "new" }],
		REPO_SNAPSHOT_SCRIPT,
		{
			GIT_DIR: "/no-such-repo",
			GIT_WORK_TREE: "/no-such-tree",
			GIT_INDEX_FILE: "/no-such-index",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.worktree",
			GIT_CONFIG_VALUE_0: "/no-such-tree",
		},
	);
	assert.equal(r.status, 0, r.stderr);
});

if (!nativeSupported) {
	const r = spawnSync("bun", ["-e", REPO_SNAPSHOT_SCRIPT, "{}"], {
		encoding: "utf8",
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /snapshot_directory_anchor_unavailable/);
	console.log(
		"exact tree snapshot: unsupported host refuses; Linux causal cases require Linux or TEDIX_EXACT_TREE_LINUX_IMAGE",
	);
} else
	console.log(
		"exact tree snapshot: causal source, deletion, dependency, directory-swap and containment tests passed",
	);
