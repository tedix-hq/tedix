import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import { gateInProfile, migrationOrderGate } from "./preflight-profiles.mjs";

const root = resolve(import.meta.dir, "../..");
const old = "20260101000000_old";
const latest = "20260103000000_main";

function fixture(
	run: (dir: string, git: (...args: string[]) => string) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), "migration-push-"));
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: {
				...detachedGitEnv(),
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	try {
		git("init", "-b", "main");
		git("config", "user.name", "Migration test");
		git("config", "user.email", "migration@example.invalid");
		git("remote", "add", "canonical", "https://github.com/tedix-hq/tedix.git");
		addMigration(dir, latest);
		writeFileSync(
			join(dir, "packages/db/migration-integrity.json"),
			JSON.stringify({
				version: 1,
				migrations: [
					{ name: `${latest}/migration.sql`, sha256: "a".repeat(64) },
				],
			}),
		);
		git("add", ".");
		git("commit", "-m", "base");
		git("update-ref", "refs/remotes/canonical/main", "HEAD");
		run(dir, git);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function addMigration(dir: string, name: string) {
	const path = join(dir, "packages/db/drizzle", name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "migration.sql"), "SELECT 1;\n");
	writeFileSync(
		join(path, "snapshot.json"),
		'{"id":"stable","prevIds":["parent"]}\n',
	);
}

function check(dir: string, ...args: string[]) {
	return spawnSync(
		"node",
		[
			join(root, "node_modules/jiti/lib/jiti-cli.mjs"),
			join(root, "packages/db/scripts/generate-migration.ts"),
			...args,
		],
		{ cwd: dir, encoding: "utf8" },
	);
}

test("migration order is fast and docs-only pushes do not select it", () => {
	expect(gateInProfile(migrationOrderGate([], []).name, "local-fast")).toBe(
		true,
	);
	expect(migrationOrderGate(["README.md"], []).when).toBe(false);
	expect(
		migrationOrderGate([`packages/db/drizzle/${old}/migration.sql`], []).when,
	).toBe(true);
});

test("two new migrations must both follow canonical main even with a different push base", () =>
	fixture((dir, git) => {
		const base = git("rev-parse", "HEAD");
		for (const name of ["20260104000000_a", "20260105000000_b"])
			addMigration(dir, name);
		git("add", ".");
		git("commit", "-m", "new");
		expect(
			check(dir, "--check-order", "--base", base, "--head", "HEAD").status,
		).toBe(0);
		addMigration(dir, old);
		git("add", ".");
		git("commit", "-m", "older");
		const result = check(
			dir,
			"--check-order",
			"--base",
			"HEAD^",
			"--head",
			"HEAD",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`bun run --cwd packages/db migration:restamp ${old}`,
		);
	}));

test("equal timestamps are refused even when the slug sorts later", () =>
	fixture((dir, git) => {
		addMigration(dir, "20260103000000_zzz");
		git("add", ".");
		git("commit", "-m", "equal");
		expect(check(dir, "--check-order").status).toBe(1);
	}));

test("a branch push base cannot hide a newer canonical migration", () =>
	fixture((dir, git) => {
		const base = git("rev-parse", "HEAD");
		addMigration(dir, "20260105000000_remote");
		git("add", ".");
		git("commit", "-m", "remote");
		git("update-ref", "refs/remotes/canonical/main", "HEAD");
		git("reset", "--hard", base);
		addMigration(dir, "20260104000000_branch");
		git("add", ".");
		git("commit", "-m", "branch");
		expect(
			check(dir, "--check-order", "--base", base, "--head", "HEAD").status,
		).toBe(1);
	}));

test("restamp refuses dirty trees and multiple unpublished commits without touching migration names", () =>
	fixture((dir, git) => {
		addMigration(dir, old);
		git("add", ".");
		git("commit", "-m", "draft");
		writeFileSync(join(dir, "notes.txt"), "pending");
		expect(check(dir, "--restamp", old).stderr).toContain("clean worktree");
		git("add", ".");
		git("commit", "-m", "notes");
		expect(check(dir, "--restamp", old).stderr).toContain(
			"single unpublished commit",
		);
		expect(
			readFileSync(
				join(dir, "packages/db/drizzle", old, "migration.sql"),
				"utf8",
			),
		).toBe("SELECT 1;\n");
	}));

test(
	"restamp preserves SQL, snapshots and canonical history and amends only the unpublished commit",
	() =>
		fixture((dir, git) => {
			addMigration(dir, old);
			addMigration(dir, "20260102000000_next");
			const names = [old, "20260102000000_next", latest];
			const manifest = {
				version: 1,
				migrations: names.map((name) => ({
					name: `${name}/migration.sql`,
					sha256: "a".repeat(64),
				})),
			};
			writeFileSync(
				join(dir, "packages/db/migration-integrity.json"),
				JSON.stringify(manifest),
			);
			git("add", ".");
			git("commit", "-m", "lane\n\nWork-Item: test");
			const base = git("rev-parse", "HEAD^");
			const result = check(dir, "--restamp", old);
			expect(result.status).toBe(0);
			expect(git("rev-parse", "HEAD^")).toBe(base);
			expect(git("status", "--porcelain")).toBe("");
			expect(git("log", "-1", "--format=%B")).toContain("Work-Item: test");
			expect(check(dir, "--check-order").status).toBe(0);
			const updated = JSON.parse(
				readFileSync(join(dir, "packages/db/migration-integrity.json"), "utf8"),
			);
			expect(updated.migrations[0]).toEqual(manifest.migrations[2]);
			for (const entry of updated.migrations.slice(1)) {
				expect(
					readFileSync(join(dir, "packages/db/drizzle", entry.name), "utf8"),
				).toBe("SELECT 1;\n");
				expect(
					readFileSync(
						join(
							dir,
							"packages/db/drizzle",
							entry.name.replace("migration.sql", "snapshot.json"),
						),
						"utf8",
					),
				).toContain('"id":"stable"');
			}
			expect(check(dir, "--restamp", latest).status).toBe(1);
		}),
	30000,
);

describe("ops overlay", () => {
	const root = mkdtempSync(join(tmpdir(), "overlay-gate-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const script = resolve(import.meta.dir, "preflight-gates.mjs");
	const sha = "a".repeat(40);
	const path = "apps/example/wrangler.jsonc";
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	mkdirSync(join(root, "apps/example"), { recursive: true });
	writeFileSync(join(root, path), "{}\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	git("switch", "-qc", "scratch/unpaired-config");
	writeFileSync(join(root, path), '{"vars":{"NEW_BINDING":"example"}}\n');
	git("add", ".");
	git("commit", "-qm", "deliberate unpaired scratch config");
	const missing = git("rev-parse", "HEAD");
	git(
		"commit",
		"--amend",
		"-qm",
		`paired config\n\nOps-Overlay: ${sha} ${path}`,
	);
	const paired = git("rev-parse", "HEAD");
	writeFileSync(join(root, path), '{"vars":{"OTHER_BINDING":"example"}}\n');
	git("add", ".");
	git("commit", "-qm", "later config without its own trailer");
	const laterMissing = git("rev-parse", "HEAD");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(join(bin, "git"), `#!/bin/sh\nexec '${realGit}' "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);

	function check(head: string, response?: string) {
		const gh = join(bin, "gh");
		rmSync(gh, { force: true });
		if (response) {
			writeFileSync(gh, `#!/bin/sh\n${response}\n`);
			chmodSync(gh, 0o755);
		}
		return spawnSync(
			process.execPath,
			[script, "--ops-overlay-only", "--base", base, "--head", head],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, PATH: bin, TEDIX_PUSH_TRAIN_RANGES: "[]" },
			},
		);
	}

	test("deliberate config without an overlay trailer is rejected without pushing", () => {
		const result = check(missing);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`${path}: missing Ops-Overlay`);
		expect(git("remote")).toBe("");
		expect(git("branch", "--show-current")).toBe("scratch/unpaired-config");
	});

	test("an earlier paired commit cannot cover a later unpaired config change", () => {
		expect(check(laterMissing).status).toBe(1);
	});

	test("online check resolves the exact ops commit", () => {
		const result = check(
			paired,
			`test "$1" = api || exit 1\ntest "$2" = repos/tedix-hq/tedix-cloud-ops/commits/${sha} || exit 1\nprintf '${sha}\\n'`,
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	test("missing gh and GitHub errors warn and preserve the offline decision", () => {
		for (const response of [undefined, "exit 1", "exit 127"]) {
			const result = check(paired, response);
			expect(result.status).toBe(0);
			expect(result.stderr).toContain(
				"GitHub unavailable; keeping offline trailer check",
			);
		}
	});

	test("a successful lookup returning the wrong SHA fails", () => {
		const result = check(paired, `printf '${"b".repeat(40)}\\n'`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("GitHub returned a different commit");
	});
});
