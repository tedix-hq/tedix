import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStorage } from "./storage-migrate";
import { runnerKey } from "./supervise-runners";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
	const result = spawnSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** A home laid out the way earlier versions left it. */
function oldHome() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "tedix-storage-")));
	homes.push(home);
	const share = join(home, ".local", "share", "tedix");
	const root = join(home, ".tedix");
	const source = join(share, "lane-dispatcher", "source-local");
	mkdirSync(source, { recursive: true });
	git(source, "init", "--quiet");
	writeFileSync(join(source, "README.md"), "source\n");
	git(source, "add", "README.md");
	git(source, "commit", "--quiet", "-m", "first");
	const run = join(root, "dispatchers", "abc", "runs", "item-1", "repo");
	mkdirSync(join(root, "dispatchers", "abc", "runs", "item-1"), {
		recursive: true,
	});
	git(source, "worktree", "add", "--quiet", "--detach", run);
	const rules = join(share, "private-scan-rules.json");
	writeFileSync(rules, '{"rules":[]}\n');
	git(source, "config", "tedix.privateScanRules", rules);
	const runners = [
		{ organization: "org_a", executor: "codex" as const, repo: source },
		{
			organization: "org_a",
			executor: "any-local" as const,
			project: "p1",
			repo: source,
		},
	];
	writeFileSync(
		join(root, "supervisor-runners.json"),
		`${JSON.stringify({ version: 1, runners }, null, "\t")}\n`,
	);
	const scoped = runnerKey(runners[1]!);
	mkdirSync(join(root, "dispatchers", scoped), { recursive: true });
	writeFileSync(join(root, "dispatchers", scoped, "receipt.json"), "{}");
	writeFileSync(join(root, "credentials.json"), "secret");
	mkdirSync(join(share, "plugins", "opencode"), { recursive: true });
	mkdirSync(join(share, "plugins", "tedix-0.2.12"), { recursive: true });
	mkdirSync(join(home, ".config", "opencode"), { recursive: true });
	writeFileSync(
		join(home, ".config", "opencode", "opencode.jsonc"),
		`{ "plugin": [${JSON.stringify(join(share, "plugins", "opencode", ".opencode-plugin"))}] }\n`,
	);
	mkdirSync(join(share, "worktree-archives", "old"), { recursive: true });
	mkdirSync(join(home, ".cache", "tedix", "notes"), { recursive: true });
	writeFileSync(join(home, ".cache", "tedix", "db-check.lock"), "");
	for (let day = 1; day <= 5; day++) {
		const name = join(root, `lane-routing.json.bak-2026110${day}`);
		writeFileSync(name, "{}");
		utimesSync(name, day * 1000, day * 1000);
	}
	mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(
		join(
			home,
			"Library",
			"LaunchAgents",
			"dev.tedix.lane-serve.x.plist.before-1",
		),
		"",
	);
	return { home, root, share, source, run, runners, scoped };
}

describe("migrateStorage", () => {
	it("moves everything into ~/.tedix, keeps runners working and deletes the old folders", () => {
		const f = oldHome();
		const env = { TEDIX_CONFIG_DIR: f.root } as NodeJS.ProcessEnv;
		expect(migrateStorage({ env, home: f.home })).toBe(true);

		const moved = join(f.root, "runner-repos", "source-local");
		expect(existsSync(join(f.home, ".local", "share", "tedix"))).toBe(false);
		expect(existsSync(join(f.home, ".cache", "tedix"))).toBe(false);
		const runners = JSON.parse(
			readFileSync(join(f.root, "supervisor-runners.json"), "utf8"),
		).runners;
		expect(runners.map((runner: { repo: string }) => runner.repo)).toEqual([
			moved,
			moved,
		]);
		// The run folder's link to its source copy follows the move.
		expect(git(f.run, "rev-parse", "--git-common-dir")).toBe(
			join(moved, ".git"),
		);
		// The scoped runner's folder follows its new key.
		const scoped = runnerKey(runners[1]);
		expect(scoped).not.toBe(f.scoped);
		expect(
			existsSync(join(f.root, "dispatchers", scoped, "receipt.json")),
		).toBe(true);
		expect(git(moved, "config", "tedix.privateScanRules")).toBe(
			join(f.root, "private-scan-rules.json"),
		);
		expect(
			readFileSync(
				join(f.home, ".config", "opencode", "opencode.jsonc"),
				"utf8",
			),
		).toContain(join(f.root, "plugins", "opencode", ".opencode-plugin"));
		expect(existsSync(join(f.root, "worktree-archives", "old"))).toBe(true);
		expect(existsSync(join(f.root, "cache", "notes"))).toBe(true);
		expect(readFileSync(join(f.root, "credentials.json"), "utf8")).toBe(
			"secret",
		);
		expect(
			readdirSync(f.root)
				.filter((name) => name.includes(".bak-"))
				.sort(),
		).toEqual([
			"lane-routing.json.bak-20261103",
			"lane-routing.json.bak-20261104",
			"lane-routing.json.bak-20261105",
		]);
		expect(readdirSync(join(f.home, "Library", "LaunchAgents"))).toEqual([]);

		// A second start finds nothing left to move.
		const lines: string[] = [];
		expect(
			migrateStorage({ env, home: f.home, say: (l) => lines.push(l) }),
		).toBe(true);
		expect(lines).toEqual([]);
	});

	it("leaves an old folder in place when its new place is taken, and says so", () => {
		const f = oldHome();
		const env = { TEDIX_CONFIG_DIR: f.root } as NodeJS.ProcessEnv;
		mkdirSync(join(f.root, "worktree-archives", "old"), { recursive: true });
		const lines: string[] = [];
		expect(
			migrateStorage({ env, home: f.home, say: (l) => lines.push(l) }),
		).toBe(false);
		expect(existsSync(join(f.share, "worktree-archives", "old"))).toBe(true);
		expect(lines.join("\n")).toContain("old already in");
	});
});
