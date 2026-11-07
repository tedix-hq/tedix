#!/usr/bin/env bun
/**
 * Cut the CLI release version bump: `bun changeset version`, then
 * `bun install`, then the lockfile drift check — in that order.
 *
 * `bun changeset version` rewrites `packages/cli/package.json` and folds the
 * pending `.changeset/` notes into `packages/cli/CHANGELOG.md`, and nothing
 * else. `bun.lock` records each workspace's version verbatim, so the bumped
 * manifest now disagrees with the lockfile and the pre-push `lint:deps` gate
 * (`scripts/ci/check-deps.mjs`) fails on the release commit. On 7 Nov 2026
 * that gate stopped a release push twice and the push queue refused a third
 * attempt without a human override, stalling the release.
 *
 * The missing step is mechanical, so this script owns it: bump, regenerate
 * the lockfile, then run the same check the gate runs. A release that reaches
 * "commit" here is one the pre-push hook has already seen pass. Rerunning is
 * safe: a second `changeset version` with no pending notes is a no-op and
 * `bun install` is idempotent, so a retry after a failed push repairs the
 * lockfile instead of compounding the drift.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReleaseStep {
	argv: string[];
	why: string;
}

/**
 * The order is the contract: `bun install` must run AFTER `changeset version`
 * has rewritten the manifest, and the drift check must run last — it is the
 * proof the release commit passes the gate a bare `changeset version` fails.
 */
export function releaseSteps(): ReleaseStep[] {
	return [
		{
			argv: ["bun", "changeset", "version"],
			why: "bump packages/cli/package.json and fold .changeset/ notes into the CHANGELOG",
		},
		{
			argv: ["bun", "install"],
			why: "regenerate bun.lock so its recorded workspace version matches the bump",
		},
		{
			argv: ["bun", "scripts/ci/check-deps.mjs"],
			why: "fail here, not inside the push queue, if bun.lock still drifts",
		},
	];
}

type Runner = (argv: string[], cwd: string) => number;

function spawnStatus(argv: string[], cwd: string): number {
	const result = spawnSync(argv[0] as string, argv.slice(1), {
		cwd,
		stdio: "inherit",
	});
	if (result.error) {
		process.stderr.write(`${argv.join(" ")}: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

export function runRelease(
	root: string,
	steps: ReleaseStep[] = releaseSteps(),
	run: Runner = spawnStatus,
): number {
	for (const step of steps) {
		process.stdout.write(`\n$ ${step.argv.join(" ")}\n  ${step.why}\n`);
		const status = run(step.argv, root);
		if (status !== 0) {
			process.stderr.write(
				`\nrelease:version failed at \`${step.argv.join(" ")}\` (exit ${status})\n`,
			);
			return status;
		}
	}
	return 0;
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "../..");
	const status = runRelease(root);
	if (status === 0) {
		const manifest = JSON.parse(
			readFileSync(resolve(root, "packages/cli/package.json"), "utf8"),
		);
		process.stdout.write(
			`\nVersion bumped to ${manifest.version}. Edit the new entry in` +
				` packages/cli/CHANGELOG.md into plain user language with its date,` +
				` then commit everything this changed — including bun.lock — as` +
				` \`chore(cli): release ${manifest.version}\`.\n`,
		);
	}
	process.exit(status);
}
