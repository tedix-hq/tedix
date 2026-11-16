/**
 * Answers one question for a gate that just failed: does it fail on the push
 * base too, without this change?
 *
 * On 16 Nov 2026 a finished change was refused because origin/main itself
 * failed `type-check apps/os` in a file the change never touched. The session
 * was told to fix its change, could not, and spent its retry budget. Re-running
 * the same gate on a clean checkout of the base is the only offline way to tell
 * the two apart, so that is what this does, and only after a failure: a
 * passing push never pays for it.
 *
 * The answer is "yes" only when it is safe to say so. A gate whose command
 * names the changed files or the pushed commits cannot be compared; a base run
 * that timed out proves nothing; and a failure that names a file of this change
 * stays the change's failure even when main is red in the same gate.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gateFailureKind } from "../dev/push-gate-failure.ts";
import { detachedGitEnv } from "../oss/git-env.ts";

/** At most this many failed gates are re-run on the base; the push lock is held meanwhile. */
export const MAX_BASE_RERUNS = 2;

/**
 * Gates whose command depends on the tree alone. Formatting, related tests,
 * the secret scan and migration order take the changed files or the pushed
 * range as arguments and mean nothing on the base.
 */
export function gateComparableOnBase(name) {
	return /^(lint:|actionlint$|workflow timeouts|generated Worker types|D1 schema|widget build$|cms-runtime build$|type-check|procedure parity |tests \(|license map|CMS )/.test(
		name,
	);
}

/**
 * Whether a failed gate's output names a file this change touches. Workspace
 * tools print paths relative to their package, so both spellings count.
 */
export function failureNamesChangedFile(output, files) {
	if (files === null) return true;
	return files.some((file) => {
		const local = file.replace(/^(?:apps|packages)\/[^/]+\//, "");
		return (
			output.includes(file) ||
			(local !== file && local.includes("/") && output.includes(local))
		);
	});
}

function run(command, cwd) {
	const result = spawnSync(command[0], command.slice(1), {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		env: { ...detachedGitEnv(), NO_COLOR: "1", FORCE_COLOR: "0" },
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		signal: result.signal,
		spawnFailed: result.error !== undefined,
	};
}

/**
 * A lazily created, detached checkout of `base` beside the repository's other
 * worktrees (tools cannot load a workspace from inside Git's own directory).
 * `failsToo(gate)` re-runs one gate there; `remove()` deletes the checkout.
 */
export function baseCheckout({
	repoRoot,
	base,
	install = ["bun", "install", "--frozen-lockfile"],
}) {
	/** undefined: not tried yet; null: could not be prepared. */
	let dir;
	const prepare = () => {
		if (dir !== undefined) return dir;
		dir = null;
		const common = run(["git", "rev-parse", "--git-common-dir"], repoRoot);
		if (!common.ok) return null;
		const home = join(
			dirname(resolve(repoRoot, common.output.trim())),
			".worktrees",
		);
		mkdirSync(home, { recursive: true });
		const created = mkdtempSync(join(home, "push-base-"));
		if (
			run(["git", "worktree", "add", "--detach", created, base], repoRoot).ok &&
			(install === null || run(install, created).ok)
		)
			dir = created;
		else discard(created);
		return dir;
	};
	const discard = (path) => {
		run(["git", "worktree", "remove", "--force", path], repoRoot);
		rmSync(path, { recursive: true, force: true });
	};
	return {
		failsToo(gate) {
			const checkout = prepare();
			if (!checkout) return false;
			const move = (path) =>
				path === repoRoot || path.startsWith(`${repoRoot}/`)
					? `${checkout}${path.slice(repoRoot.length)}`
					: path;
			const result = run(gate.cmd.map(move), move(gate.cwd ?? repoRoot));
			return (
				!result.ok &&
				!/Script not found|Missing script/i.test(result.output) &&
				gateFailureKind(result) === "change"
			);
		},
		remove() {
			if (dir) discard(dir);
			dir = null;
		},
	};
}

/**
 * Marks as "main" the failed gates that fail on the base as well. Mutates and
 * returns `failures` ({ gate, output, kind }).
 */
export function markBaseFailures(failures, { files, checkout }) {
	const candidates = failures
		.filter(
			(failure) =>
				failure.kind === "change" &&
				gateComparableOnBase(failure.gate.name) &&
				!failureNamesChangedFile(failure.output, files),
		)
		.slice(0, MAX_BASE_RERUNS);
	try {
		for (const failure of candidates)
			if (checkout.failsToo(failure.gate)) failure.kind = "main";
	} finally {
		checkout.remove();
	}
	return failures;
}
