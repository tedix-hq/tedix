import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** Linked worktrees keep their index and commit objects outside the source tree. */
export function devinGitWritePaths(cwd: string): string[] {
	const result = spawnSync(
		"git",
		[
			"-c",
			"core.fsmonitor=false",
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-dir",
			"--git-common-dir",
		],
		{ cwd, encoding: "utf8", timeout: 10_000 },
	);
	if (result.status !== 0) return [];
	const [top, gitDir, commonDir] = result.stdout.trim().split("\n");
	if (!top || !gitDir || !commonDir || realpathSync(top) !== realpathSync(cwd))
		throw new Error("Devin Git scope requires the lane worktree root");
	if (gitDir === commonDir) return [];
	if (
		!realpathSync(gitDir).startsWith(
			realpathSync(join(commonDir, "worktrees")) + sep,
		) ||
		realpathSync(readFileSync(join(gitDir, "gitdir"), "utf8").trim()) !==
			realpathSync(join(cwd, ".git"))
	)
		throw new Error("Cannot verify Devin worktree Git metadata");
	const paths = [
		`${gitDir}/**`,
		`${commonDir}/objects/**`,
		`${commonDir}/push-code/**`,
		`${commonDir}/push-queue/**`,
		`${commonDir}/push-queue.lock`,
		`${commonDir}/push-queue-retries.jsonl`,
		`${commonDir}/push-queue-retries.jsonl.tmp`,
		`${commonDir}/push-queue-history.jsonl`,
		`${commonDir}/push-queue-history.jsonl.tmp`,
		`${commonDir}/push-results/**`,
		`${commonDir}/refs/remotes/origin/main`,
		`${commonDir}/refs/remotes/origin/main.lock`,
		`${commonDir}/logs/refs/remotes/origin/main`,
		`${commonDir}/ci-completion.log`,
	];
	const branch = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (branch.status === 0) {
		const ref = branch.stdout.trim();
		if (!/^refs\/heads\/[\w./-]+$/.test(ref) || ref.includes(".."))
			throw new Error("Unsupported Devin branch reference");
		paths.push(
			`${commonDir}/${ref}`,
			`${commonDir}/${ref}.lock`,
			`${commonDir}/logs/${ref}`,
		);
	} else if (branch.status !== 1)
		throw new Error("Cannot resolve Devin branch reference");
	if (
		paths.some((path) => /[()\n\r*?\[\]{}]/.test(path.replace(/\/\*\*$/, "")))
	)
		throw new Error("Unsupported Devin Git metadata path");
	return paths;
}

/** Deny-first globs exclude only the literal example filename, not real env variants. */
export function devinEnvironmentReadDenials(): string[] {
	return [".env", ".dev.vars"].flatMap((name) => {
		const suffix = "example";
		const prefix = `**/${name}.`;
		return [
			`**/${name}`,
			`**/${name}/**`,
			`**/${name}.*/**`,
			...Array.from(suffix, (character, index) => [
				prefix + suffix.slice(0, index),
				`${prefix}${suffix.slice(0, index)}[!${character}]*`,
			]).flat(),
			`${prefix}${suffix}?*`,
		];
	});
}

/** Keep dispatcher worktrees readable; deny the credential stores, not ~/.tedix/**. */
export function devinSecretPaths(env = process.env) {
	const stores = [
		"credentials.json",
		"external-agents.json",
		"agent-contexts.json",
		"session-scopes/**",
	];
	return [
		...stores.map((path) => `~/.tedix/${path}`),
		...(env.TEDIX_CONFIG_DIR
			? stores.map((path) => join(resolve(env.TEDIX_CONFIG_DIR!), path))
			: []),
		"~/.aws/**",
		"~/.azure/**",
		"~/.kube/**",
		"~/.gnupg/**",
		"~/.npmrc",
		"~/.netrc",
		"~/.git-credentials",
		"~/.gitconfig",
		"~/.codex/auth.json",
		"~/.claude/.credentials.json",
		"~/.docker/config.json",
		"~/.pypirc",
		"~/.local/share/devin/credentials.toml",
		"~/.local/share/devin/mcp/oauth/**",
		...(env.XDG_DATA_HOME
			? [join(resolve(env.XDG_DATA_HOME), "devin/mcp/oauth/**")]
			: []),
	].flatMap((path) =>
		path.startsWith("~/") ? [path, join(homedir(), path.slice(2))] : [path],
	);
}

/** Run before ACP creation and every resume, including retained failed worktrees. */
export function assertDevinProjectHooks(cwd: string) {
	const paths = [".devin", ".claude"];
	const blocked =
		"Devin project hooks differ from HEAD or contain executable hooks; inspect .devin/ and .claude/ before retrying";
	const root = realpathSync(cwd);
	for (const path of paths) {
		if (
			existsSync(join(root, path)) &&
			lstatSync(join(root, path)).isSymbolicLink()
		)
			throw new Error(blocked);
	}
	// A lane can commit its own plant: matching a mutable HEAD alone is insufficient.
	if (existsSync(join(root, ".devin/hooks.v1.json"))) throw new Error(blocked);
	for (const path of [
		".devin/config.json",
		".devin/config.local.json",
		".devin/mcp_config.json",
		".devin/mcp_config.local.json",
		".claude/settings.json",
		".claude/settings.local.json",
	]) {
		const file = join(root, path);
		if (!existsSync(file)) continue;
		if (!realpathSync(file).startsWith(root + sep)) throw new Error(blocked);
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			throw new Error(blocked);
		}
		if (
			!isRecord(value) ||
			(value.hooks !== undefined &&
				(!isRecord(value.hooks) || Object.keys(value.hooks).length > 0))
		)
			throw new Error(blocked);
		if (
			value.mcpServers !== undefined &&
			(!isRecord(value.mcpServers) || Object.keys(value.mcpServers).length > 0)
		)
			throw new Error(
				"Devin lanes use the Tedix CLI; remove project MCP servers before retrying",
			);
	}
	const gitOptions = [
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.hooksPath=/dev/null",
	];
	const gitEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
	// Metadata-only fixtures and new non-Git workspaces must contain no hooks.
	const repository = spawnSync(
		"git",
		[...gitOptions, "rev-parse", "--show-toplevel"],
		{
			cwd,
			env: gitEnv,
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	if (repository.status !== 0) {
		if (paths.some((path) => existsSync(join(cwd, path))))
			throw new Error("Cannot verify Devin project hooks outside Git");
		return;
	}
	const filters = spawnSync(
		"git",
		[
			...gitOptions,
			"config",
			"--null",
			"--name-only",
			"--get-regexp",
			"^filter\\..*\\.(clean|smudge|process|required)$",
		],
		{ cwd, env: gitEnv, encoding: "utf8", timeout: 10_000 },
	);
	if (filters.status !== 0 && filters.status !== 1) throw new Error(blocked);
	const drivers = new Set(
		filters.stdout
			.split("\0")
			.filter(Boolean)
			.map((key) => key.replace(/\.(?:clean|smudge|process|required)$/, "")),
	);
	for (const driver of drivers) {
		if (!/^filter\.[a-zA-Z0-9_.-]+$/.test(driver)) throw new Error(blocked);
		for (const operation of ["clean", "smudge", "process"])
			gitOptions.push("-c", `${driver}.${operation}=`);
		gitOptions.push("-c", `${driver}.required=false`);
	}
	for (const args of [
		[
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--exit-code",
			"HEAD",
			"--",
			...paths,
		],
		["ls-files", "--others", "--", ...paths],
	]) {
		const result = spawnSync("git", [...gitOptions, ...args], {
			cwd,
			env: gitEnv,
			encoding: "utf8",
			timeout: 10_000,
		});
		if (result.status !== 0 || result.stdout.length > 0)
			throw new Error(
				"Devin project hooks differ from HEAD; inspect .devin/ and .claude/ before retrying",
			);
	}
}

/** Keep Git usable without copying helper scripts, includes or token-bearing config. */
export function writeDevinGitIdentity(path: string, cwd: string) {
	writeFileSync(path, "", { mode: 0o600, flag: "wx" });
	for (const key of ["user.name", "user.email"]) {
		const identity = spawnSync("git", ["config", "--get", key], {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
		});
		if (identity.status === 1) continue;
		if (identity.status !== 0)
			throw new Error("Cannot resolve Git author identity for Devin lane");
		const saved = spawnSync(
			"git",
			["config", "--file", path, "--add", "--", key, identity.stdout.trim()],
			{ cwd, encoding: "utf8", timeout: 10_000 },
		);
		if (saved.status !== 0)
			throw new Error("Cannot prepare Devin Git author identity");
	}
	// The macOS helper uses the existing Keychain; no credential file is exposed.
	if (process.platform === "darwin") {
		const saved = spawnSync(
			"git",
			[
				"config",
				"--file",
				path,
				"credential.https://github.com.helper",
				"osxkeychain",
			],
			{ cwd, encoding: "utf8", timeout: 10_000 },
		);
		if (saved.status !== 0)
			throw new Error("Cannot configure Devin Git Keychain access");
	}
}
