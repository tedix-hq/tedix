/**
 * Git tells the hooks it runs which repository invoked them, through a handful
 * of environment variables. Anything in this directory may run from the
 * pre-push hook — the secret-scan gate does, and the OSS test suites run there
 * whenever a push touches `scripts/`. A child `git` that inherits those
 * variables ignores its own `cwd` and operates on the invoking repository
 * instead, so a scan reads the wrong tree and a fixture writes to the real
 * repo. Both failures are invisible by hand and appear only from inside the
 * hook, which is the only place that matters.
 *
 * Identity variables are deliberately left alone: callers set GIT_AUTHOR_* and
 * GIT_COMMITTER_* to make bootstrap and fixture commits reproducible.
 */
const GIT_LOCATION_VARS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
];

/** `env` for spawning git so that `cwd` decides the repository, not the hook. */
export function detachedGitEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => !GIT_LOCATION_VARS.includes(key)),
	) as NodeJS.ProcessEnv;
}
