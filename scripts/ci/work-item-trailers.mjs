/**
 * Every commit pushed to the canonical repository names its Work Item.
 *
 * WHY. On 22-23 October 2026, 35 of 162 commits reached main without a
 * `Work-Item:` trailer, so the Work board kept shipped items open and could
 * not say what had landed. The trailer is the only link between a commit and
 * its Work Item; this check makes it required at push time.
 *
 * Merge commits and GitHub bot commits carry no Work and are skipped.
 */
import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../oss/git-env.ts";
import { defaultPushBase } from "./push-range-selection.mjs";

const TRAILER =
	/^Work-Item:[ \t]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[ \t]*$/im;
const BOT_EMAIL = /\[bot\]@users\.noreply\.github\.com$/i;

/** Commits in the push ranges that lack a `Work-Item: <uuid>` trailer. */
export function missingWorkItemTrailers(repoRoot, ranges) {
	const missing = [];
	const seen = new Set();
	for (const { base, head } of ranges) {
		const from = /^0+$/.test(base) ? defaultPushBase(repoRoot) : base;
		const result = spawnSync(
			"git",
			[
				"log",
				"--no-merges",
				"--format=%H%x1f%ae%x1f%s%x1f%B%x1e",
				from ? `${from}..${head}` : head,
			],
			{ cwd: repoRoot, encoding: "utf8", env: detachedGitEnv() },
		);
		if (result.status !== 0)
			throw new Error("Cannot read Work-Item push range");
		for (const record of result.stdout.split("\x1e")) {
			const [sha, email, subject, body] = record.trim().split("\x1f");
			if (!sha || seen.has(sha)) continue;
			seen.add(sha);
			if (BOT_EMAIL.test(email) || TRAILER.test(body ?? "")) continue;
			missing.push({ sha, subject });
		}
	}
	return missing;
}

export function workItemTrailerError(missing) {
	return [
		`${missing.length} commit(s) have no Work-Item trailer:`,
		...missing.map(({ sha, subject }) => `  ${sha.slice(0, 9)} ${subject}`),
		"Claim the Work Item first (tedix work find / create, then tedix work start).",
		"End each commit with both trailers in its last paragraph:",
		"  Work-Item: <uuid>",
		"  Agent-Session: <harness>:<session id>",
		'(git commit --amend --trailer "Work-Item: <uuid>" --trailer "Agent-Session: <harness>:<id>").',
	].join("\n");
}
