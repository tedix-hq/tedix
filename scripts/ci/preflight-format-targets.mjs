/**
 * Keep ordinary format checks on the files Git is pushing. Oxfmt still owns
 * supported formats and ignore rules; configuration/toolchain changes retain
 * the full check. Unknown ranges never become an empty successful check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env.ts";
import { selectPushRangeFiles } from "./push-range-selection.mjs";

const fullCheck = () => ["bun", "run", "format:check"];
/** @param {string} file */
const changesFormatter = (file) =>
	/(^|\/)(?:package\.json|bun\.lockb?|bunfig\.toml|\.gitignore|\.gitattributes|\.prettierignore|\.editorconfig|\.npmrc|\.node-version|\.nvmrc|\.tool-versions|vite\.config\.[^/]+|\.oxfmtrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?|prettier\.config\.[^/]+)$/.test(
		file,
	) ||
	file.startsWith("scripts/vite/") ||
	file === "scripts/ci/preflight-gates.mjs" ||
	file.startsWith("scripts/ci/preflight-format-targets.");

/** @param {string} repoRoot @param {string[]} args */
function git(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) throw new Error("unknown Git scope");
	return result.stdout;
}

/**
 * @param {string} repoRoot
 * @param {{ ranges: { base: string, head: string }[], all?: boolean }} options
 * @returns {string[] | null} canonical command, or null for only deleted paths
 */
export function formatCheckCommand(repoRoot, { ranges, all = false }) {
	if (all || ranges.length === 0) return fullCheck();
	try {
		const head = git(repoRoot, [
			"rev-parse",
			"--verify",
			"HEAD^{commit}",
		]).trim();
		// A full checkout scan remains the existing fallback when a push names
		// other trees. Never label the current files as verification of those trees.
		for (const range of ranges) {
			if (
				git(repoRoot, [
					"rev-parse",
					"--verify",
					`${range.head}^{commit}`,
				]).trim() !== head
			)
				return fullCheck();
		}
		const files = selectPushRangeFiles(repoRoot, ranges);
		if (files.some(changesFormatter)) return fullCheck();
		// Oxfmt accepts glob patterns as positional arguments. Ambiguous names
		// retain a full scan instead of introducing an escaping dialect here.
		if (
			files.some(
				(file) =>
					!file ||
					file.includes("\uFFFD") ||
					/[\0*?[\]{}\\]/.test(file) ||
					file.startsWith("/") ||
					file.split("/").includes(".."),
			)
		)
			return fullCheck();
		if (files.length === 0) return null;
		const present = new Set(
			git(repoRoot, [
				"--literal-pathspecs",
				"ls-tree",
				"-r",
				"--name-only",
				"-z",
				head,
				"--",
				...files,
			])
				.split("\0")
				.filter(Boolean),
		);
		const targets = files.filter((file) => present.has(file));
		// Explicit Oxfmt paths bypass automatic .gitignore discovery. Preserve
		// the directory-scan verdict whenever Git says a target is ignored.
		// Custom Prettier ignore files also retain the full scan, rather than
		// copying their matching rules into this selector.
		if (existsSync(join(repoRoot, ".prettierignore"))) return fullCheck();
		if (targets.length > 0) {
			const ignored = spawnSync(
				"git",
				["check-ignore", "--no-index", "-z", "--stdin"],
				{
					cwd: repoRoot,
					env: detachedGitEnv(),
					input: targets.join("\0") + "\0",
				},
			);
			if (ignored.error || ignored.status !== 1) return fullCheck();
		}
		// A tracked file missing from disk is uncertainty, not a deletion in
		// the pushed tree. lstat also prevents following a symlink out of scope.
		if (targets.some((file) => !lstatSync(join(repoRoot, file)).isFile()))
			return fullCheck();
		if (targets.length === 0) return null;
		return [
			...fullCheck(),
			"--",
			"--no-error-on-unmatched-pattern",
			"--",
			...targets.map((file) => `./${file}`),
		];
	} catch {
		return fullCheck();
	}
}
