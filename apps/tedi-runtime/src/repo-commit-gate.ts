/**
 * The push gate for repo_commit.
 *
 * A human push runs `.githooks/pre-push`, which runs the repo gates scoped to
 * the pushed range. A tedi never reaches that hook: repo_commit publishes over
 * the GitHub API, so nothing local is pushed. Without this gate a commit
 * with type errors, unformatted files or red suites can reach main and
 * auto-deploy.
 *
 * This runs the SAME script over the paths the tedi is about to publish, in the
 * workstation that holds the checkout those paths were read from.
 *
 * A repo_commit proposal must observe the gate running successfully. Unlike a
 * native Git push, this path never reaches the pre-push hook, so unavailable
 * validation cannot be treated as a successful check.
 */

/** Paths the gate refuses to pass to the script, so a path cannot become a flag. */
const UNSAFE_PATH_RE = /^-|[\s"'`$;&|<>()\\]/;

export interface RepoCommitGateVerdict {
	ok: boolean;
	/** False when the gate could not run at all. */
	ran: boolean;
	output: string;
}

export function buildRepoCommitGateCommand(paths: string[]): string | null {
	if (!paths.length || paths.some((p) => !p || UNSAFE_PATH_RE.test(p)))
		return null;
	return `bun scripts/ci/preflight-gates.mjs --files ${paths.join(" ")}`;
}

/**
 * Classify one workstation exec receipt.
 *
 * A receipt without an integer exitCode never observed the gate — a transport
 * timeout, a detached command, an unreachable workstation. That is unavailable,
 * not a failure.
 */
export function classifyRepoCommitGateResult(
	result: Record<string, unknown>,
): RepoCommitGateVerdict {
	const exitCode = result.exitCode;
	const output = [result.stdout, result.stderr, result.error]
		.filter((v): v is string => typeof v === "string" && v.length > 0)
		.join("\n")
		.slice(0, 4_000);
	if (!Number.isInteger(exitCode))
		return {
			ok: false,
			ran: false,
			output: output || "push gate did not run",
		};
	if (exitCode === 0) return { ok: true, ran: true, output };
	return { ok: false, ran: true, output: output || "push gate failed" };
}
