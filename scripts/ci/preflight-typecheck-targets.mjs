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
 * @param {string[] | null} files changed paths, or null for "run everything"
 * @param {(workspaceDir: string) => boolean} workspaceExists
 * @returns {string[]} sorted workspace directories to type-check
 */
export function typeCheckTargets(files, workspaceExists) {
	if (files === null) return [];
	const targets = new Set();
	for (const file of files) {
		const match = WORKSPACE_PATH.exec(file);
		if (match === null) continue;
		const workspaceDir = `${match[1]}/${match[2]}`;
		if (workspaceExists(workspaceDir)) targets.add(workspaceDir);
	}
	return [...targets].sort();
}
