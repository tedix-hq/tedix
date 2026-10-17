/**
 * Ship failed globally on 2026-10-17 when a Worker config and the private
 * production overlay diverged. Every config-changing commit must now name
 * the matching ops commit, per path. This offline gate checks the reference;
 * materialize:overlay in ops remains the authority on actual compatibility.
 */
import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../oss/git-env.ts";
import { selectPushRangeFiles } from "./push-range-selection.mjs";

export function isOverlayConfig(path) {
	return (
		/^(?:apps\/[^/]+|apps\/cms\/templates\/[^/]+|packages\/db)\/wrangler\.jsonc$/.test(
			path,
		) || /^apps\/[^/]+\/cloudflare\.config\.ts$/.test(path)
	);
}

export function missingOverlayReferences(paths, trailers) {
	const covered = new Set(
		trailers.split("\n").flatMap((line) => {
			const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
			return match && !/^0+$/.test(match[1]) ? [match[2]] : [];
		}),
	);
	return paths.filter(isOverlayConfig).filter((path) => !covered.has(path));
}

function git(root, args) {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`Cannot verify ops overlay references: git ${args[0]} failed`,
		);
	return result.stdout.trim();
}

export function checkOverlayReferences(root, ranges) {
	const errors = [];
	for (const { base, head } of ranges) {
		// New refs compare against main when available, just like the other gates.
		const from = /^0+$/.test(base)
			? git(root, ["merge-base", "origin/main", head])
			: base;
		const commits = git(root, ["rev-list", "--reverse", `${from}..${head}`])
			.split("\n")
			.filter(Boolean);
		for (const commit of commits) {
			const paths = selectPushRangeFiles(root, [
				{ base: `${commit}^`, head: commit },
			]);
			if (!paths.some(isOverlayConfig)) continue;
			const trailers = git(root, [
				"show",
				"-s",
				"--format=%(trailers:key=Ops-Overlay,valueonly)",
				commit,
			]);
			for (const path of missingOverlayReferences(paths, trailers)) {
				errors.push(
					`${commit.slice(0, 12)} ${path}: missing Ops-Overlay: <40-character ops commit SHA> ${path}`,
				);
			}
		}
	}
	return errors;
}
