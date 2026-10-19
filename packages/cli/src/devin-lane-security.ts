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

/** Keep Git usable without exposing credential helpers, includes or token-bearing config. */
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
}
