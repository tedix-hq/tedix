/**
 * Which workspaces the local pre-push preflight type-checks, derived from the
 * changed paths, under both workspace roots (`apps/` and `packages/`), so a
 * newly added workspace is covered without editing a list.
 *
 * Returns workspace directories ("apps/os", "packages/cli"), not bare names,
 * because the gate runs `bun run --cwd <dir> type-check` and two roots can hold
 * the same name.
 */
const TYPE_CHECKED_WORKSPACE_ROOTS = ["apps", "packages"];

const WORKSPACE_PATH = new RegExp(
	`^(${TYPE_CHECKED_WORKSPACE_ROOTS.join("|")})/([^/]+)/`,
);

/**
 * A workspace's own prose at its root (`apps/os/README.md`). No `type-check`
 * script reads these: tsc never loads Markdown, neither Astro app keeps a
 * content collection, and the CMS template snapshot reads only `templates/`.
 * A docs sweep across workspace READMEs used to type-check 26 workspaces and
 * run the 45s D1 gate. Nested prose (a template's README) still counts.
 *
 * @param {string} file repo-relative changed path
 */
export function isWorkspaceProse(file) {
	return /^(apps|packages)\/[^/]+\/(README|AGENTS|CLAUDE|CHANGELOG)\.md$/.test(
		file,
	);
}

/**
 * @param {string[] | null} files changed paths, or null for "run everything"
 * @param {(workspaceDir: string) => boolean} workspaceExists
 * @returns {string[]} sorted workspace directories to type-check
 */
export function typeCheckTargets(files, workspaceExists) {
	if (files === null) return [];
	const targets = new Set();
	for (const file of files) {
		if (isWorkspaceProse(file)) continue;
		const match = WORKSPACE_PATH.exec(file);
		if (match === null) continue;
		const workspaceDir = `${match[1]}/${match[2]}`;
		if (workspaceExists(workspaceDir)) targets.add(workspaceDir);
	}
	return [...targets].sort();
}
