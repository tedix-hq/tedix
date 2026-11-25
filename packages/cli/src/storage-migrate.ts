import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./supervise-drivers";
import {
	RUNNER_RECORDS_DIR,
	RUNNERS_FILE,
	type RunnerDuty,
	runnerKey,
} from "./supervise-runners";

/**
 * Everything the command-line tool and its runners keep on a Mac lives in
 * `~/.tedix`. Earlier versions also wrote `~/.local/share/tedix` (runner
 * source copies, plugins, scan rules, archives) and `~/.cache/tedix` (locks).
 * `migrateStorage` moves those into `~/.tedix` once, rewrites the files that
 * name the old paths, and removes the old folders. Nothing reads the old
 * paths afterwards. Every move is a rename on the same disk, so credentials
 * and exports are never read or copied. A move whose target already exists is
 * left alone and reported; the next start tries again.
 */

/** Backup copies kept per file; older ones are deleted. */
export const BACKUPS_KEPT = 3;

const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Renames `from` to `to`, or moves its entries one by one when `to` already
 * exists. An entry whose name already exists in `to` stays, and so does
 * `from`. True when `from` is gone afterwards.
 */
export function moveInto(
	from: string,
	to: string,
	say: (line: string) => void,
): boolean {
	if (!exists(from)) return true;
	if (!exists(to)) {
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		renameSync(from, to);
		say(`moved ${from} to ${to}`);
		return true;
	}
	if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) {
		say(`kept ${from}: ${to} already exists`);
		return false;
	}
	const kept: string[] = [];
	for (const name of readdirSync(from)) {
		if (exists(join(to, name))) kept.push(name);
		else renameSync(join(from, name), join(to, name));
	}
	if (kept.length) {
		say(`kept ${from}: ${kept.join(", ")} already in ${to}`);
		return false;
	}
	rmdirSync(from);
	say(`moved the contents of ${from} to ${to}`);
	return true;
}

/** Replaces every quoted occurrence of the folder `from` with `to` in a text file. */
function rewritePaths(
	file: string,
	from: string,
	to: string,
	quote: (path: string) => string,
	say: (line: string) => void,
) {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return;
	}
	const q = (path: string) => quote(path).slice(0, -1);
	const next = text
		.split(`${q(from)}/`)
		.join(`${q(to)}/`)
		.split(quote(from))
		.join(quote(to));
	if (next === text) return;
	const mode = statSync(file).mode & 0o777;
	writeFileSync(`${file}.moving`, next, { mode });
	renameSync(`${file}.moving`, file);
	say(`updated the folder names in ${file}`);
}

const json = (path: string) => JSON.stringify(path);

function git(repo: string, args: string[]) {
	return spawnSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		timeout: 60_000,
	});
}

type RunnerEntry = Pick<RunnerDuty, "organization" | "executor"> &
	Partial<Pick<RunnerDuty, "project" | "repo">>;

function readRunners(file: string): RunnerEntry[] {
	try {
		const runners = (
			JSON.parse(readFileSync(file, "utf8")) as { runners?: unknown }
		).runners;
		return Array.isArray(runners) ? (runners as RunnerEntry[]) : [];
	} catch {
		return [];
	}
}

/** Same base file: `x.json.bak-1`, `x.json.before-y`, `x.before-z.json`. */
function backupFamily(name: string): string | undefined {
	const match = /^(.+?)\.(?:json\.)?(?:bak|before)[-.]/.exec(name);
	return match?.[1];
}

/**
 * Deletes all but the newest `BACKUPS_KEPT` backup files of each file in
 * `folder`. Only plain files whose name says backup are touched.
 */
export function rotateBackups(folder: string, say: (line: string) => void) {
	const families = new Map<string, { name: string; at: number }[]>();
	for (const name of readdirSync(folder)) {
		const family = backupFamily(name);
		if (!family) continue;
		const stat = lstatSync(join(folder, name));
		if (!stat.isFile()) continue;
		const list = families.get(family) ?? [];
		list.push({ name, at: stat.mtimeMs });
		families.set(family, list);
	}
	for (const list of families.values()) {
		list.sort((a, b) => b.at - a.at);
		for (const { name } of list.slice(BACKUPS_KEPT)) {
			rmSync(join(folder, name), { force: true });
			say(`deleted the old backup ${join(folder, name)}`);
		}
	}
}

export interface StorageMigrationOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	say?: (line: string) => void;
}

/** Moves the CLI's folders outside `~/.tedix` into it. True when none is left. */
export function migrateStorage({
	env = process.env,
	home = homedir(),
	say = () => {},
}: StorageMigrationOptions = {}): boolean {
	const root = configDir(env);
	const oldShare = join(home, ".local", "share", "tedix");
	const oldCache = join(home, ".cache", "tedix");
	let done = true;
	const step = (label: string, run: () => boolean | void) => {
		try {
			if (run() === false) done = false;
		} catch (error) {
			done = false;
			say(`${label} failed: ${(error as Error).message}`);
		}
	};
	if (!exists(oldShare) && !exists(oldCache)) {
		step("backups", () => rotateBackups(root, say));
		step("launch agents", () => removeStaleLaunchAgents(home, say));
		return true;
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });

	// Runner source copies, and every file that names them.
	const oldRepos = join(oldShare, "lane-dispatcher");
	const newRepos = join(root, "runner-repos");
	step("runner repositories", () => {
		if (!exists(oldRepos)) return;
		const runnersFile = join(root, RUNNERS_FILE);
		const before = readRunners(runnersFile);
		if (!moveInto(oldRepos, newRepos, say)) return false;
		for (const file of [
			runnersFile,
			join(root, "agent-contexts.json"),
			join(root, "commit-handoffs.json"),
		])
			rewritePaths(file, oldRepos, newRepos, json, say);
		rewritePaths(
			join(env.CODEX_HOME || join(home, ".codex"), "config.toml"),
			oldRepos,
			newRepos,
			json,
			say,
		);
		for (const name of readdirSync(newRepos)) {
			const repo = join(newRepos, name);
			if (!exists(join(repo, ".git"))) continue;
			const repair = git(repo, ["worktree", "repair"]);
			if (repair.status !== 0)
				say(`git worktree repair in ${repo}: ${repair.stderr.trim()}`);
		}
		// A runner limited to a repository names its folders after that path.
		const after = readRunners(runnersFile);
		before.forEach((runner, index) => {
			const moved = after[index];
			if (!moved || runner.repo === moved.repo) return;
			const [from, to] = [runnerKey(runner), runnerKey(moved)];
			if (from === to) return;
			for (const [a, b] of [
				[join(root, "dispatchers", from), join(root, "dispatchers", to)],
				[
					join(root, `dev.tedix.lane-serve.${from}.log`),
					join(root, `dev.tedix.lane-serve.${to}.log`),
				],
				[
					join(root, ...RUNNER_RECORDS_DIR, `${from}.json`),
					join(root, ...RUNNER_RECORDS_DIR, `${to}.json`),
				],
			] as const)
				if (exists(a) && !exists(b)) renameSync(a, b);
			say(`runner ${runner.executor} now keeps its tasks in ${to}`);
		});
	});

	// Private scan rules: the runners' checkouts name the file in git config.
	const oldRules = join(oldShare, "private-scan-rules.json");
	const newRules = join(root, "private-scan-rules.json");
	step("private scan rules", () => {
		for (const name of exists(oldShare) ? readdirSync(oldShare) : [])
			if (name.startsWith("private-scan-rules.json"))
				if (!moveInto(join(oldShare, name), join(root, name), say))
					return false;
		if (!exists(newRepos)) return;
		for (const name of readdirSync(newRepos)) {
			const repo = join(newRepos, name);
			if (!exists(join(repo, ".git"))) continue;
			const configured = git(repo, [
				"config",
				"--local",
				"--get",
				"tedix.privateScanRules",
			]).stdout.trim();
			if (configured === oldRules)
				git(repo, ["config", "--local", "tedix.privateScanRules", newRules]);
		}
	});

	// The OpenCode plugin copy, and OpenCode's entry for it.
	const oldPlugins = join(oldShare, "plugins");
	step("plugins", () => {
		if (!exists(oldPlugins)) return;
		const opencodeConfig = join(
			env.XDG_CONFIG_HOME || join(home, ".config"),
			"opencode",
		);
		if (
			!moveInto(
				join(oldPlugins, "opencode"),
				join(root, "plugins", "opencode"),
				say,
			)
		)
			return false;
		for (const name of ["opencode.json", "opencode.jsonc"])
			rewritePaths(
				join(opencodeConfig, name),
				join(oldPlugins, "opencode"),
				join(root, "plugins", "opencode"),
				json,
				say,
			);
		// Earlier copies that no settings name any more.
		rmSync(oldPlugins, { recursive: true, force: true });
		say(`deleted the old plugin copies in ${oldPlugins}`);
	});

	step("archives", () =>
		moveInto(
			join(oldShare, "worktree-archives"),
			join(root, "worktree-archives"),
			say,
		),
	);

	// Locks are recreated where they are needed; anything else is kept.
	step("cache", () => {
		if (!exists(oldCache)) return;
		for (const name of readdirSync(oldCache))
			if (name.endsWith(".lock")) rmSync(join(oldCache, name), { force: true });
		return moveInto(oldCache, join(root, "cache"), say);
	});

	step("old folders", () => {
		if (!exists(oldShare)) return;
		const left = readdirSync(oldShare);
		if (left.length) {
			say(`kept ${oldShare}: ${left.join(", ")} not moved`);
			return false;
		}
		rmdirSync(oldShare);
		say(`deleted ${oldShare}`);
	});
	step("backups", () => rotateBackups(root, say));
	step("launch agents", () => removeStaleLaunchAgents(home, say));
	return done && !exists(oldShare) && !exists(oldCache);
}

/** Copies of runner LaunchAgents set aside by hand; launchd never loads them. */
function removeStaleLaunchAgents(home: string, say: (line: string) => void) {
	const folder = join(home, "Library", "LaunchAgents");
	if (!existsSync(folder)) return;
	for (const name of readdirSync(folder))
		if (/^dev\.tedix\..+\.plist\.before-/.test(name)) {
			rmSync(join(folder, name), { force: true });
			say(`deleted ${join(folder, name)}`);
		}
}
