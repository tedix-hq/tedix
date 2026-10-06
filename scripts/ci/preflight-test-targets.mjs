/**
 * Which workspaces the local pre-push preflight runs `vitest related` in, and
 * with which paths, derived from the changed files.
 *
 * This lived inline in preflight-gates.mjs as `relatedByWorkspace`, which
 * grouped every changed file under the workspace that OWNS it. A shared package
 * therefore only ever ran its OWN tests, and the consumer tests that encode its
 * contract — which live in another workspace — were never selected.
 *
 * For example, a change to
 * `packages/api-contract/src/schemas/mcp-capability-scopes.ts` must also run
 * `apps/mcp/src/mcp/codemode-auth.test.ts`, which asserts an unknown namespace
 * fails closed; running only the owning workspace's tests lets it go red.
 *
 * The dependents are DERIVED from each workspace's package.json, never listed
 * here. A hardcoded list stops covering a workspace the day someone adds one —
 * the sibling module `preflight-typecheck-targets.mjs` carries the same warning,
 * having been written to fix exactly that bug.
 *
 * Vitest resolves a path into another workspace through the workspace alias, so
 * a dependent runs the same `related` query against its own project config:
 *
 *   cd apps/mcp && vp test related ../../packages/api-contract/src/…/x.ts --run
 *
 * selects apps/mcp's 48 covering files. No new machinery is needed — the gate
 * only has to ask.
 */

const WORKSPACE_PATH = /^(apps|packages)\/([^/]+)\//;

/**
 * Paths are passed to `vitest related` from inside the target workspace, so a
 * file the workspace owns is relative to it and a file in another workspace is
 * reached by walking back out. Both roots are one level deep, hence `../..`.
 *
 * @param {string} file repo-relative changed path
 * @param {string} workspaceDir the workspace the command runs in
 * @returns {string} path as that workspace must spell it
 */
function pathForWorkspace(file, workspaceDir) {
	return file.startsWith(`${workspaceDir}/`)
		? file.slice(workspaceDir.length + 1)
		: `../../${file}`;
}

/**
 * Workspaces that declare a dependency on `packageName`, in any dependency
 * field: a devDependency is how a package under test is usually wired, and a
 * peerDependency still compiles against the changed source.
 *
 * @param {string} packageName e.g. "@tedix/api-contract"
 * @param {Map<string, {name?: string, deps: Set<string>}>} manifests by workspace dir
 * @returns {string[]} workspace dirs
 */
function dependentsOf(packageName, manifests) {
	const hits = [];
	for (const [workspaceDir, manifest] of manifests) {
		if (manifest.deps.has(packageName)) hits.push(workspaceDir);
	}
	return hits;
}

/**
 * The workspaces one changed file affects: the workspace that owns it, plus —
 * when it lives in a package — every workspace that depends on that package.
 * Apps are leaves (nothing imports an app), so only a package fans out.
 *
 * @param {string} file repo-relative changed path
 * @param {{manifests: Map<string, {deps: Set<string>}>, packageNameOf: Map<string, string | undefined>}} graph
 * @returns {string[]} workspace dirs, owner first
 */
function workspacesAffectedBy(file, graph) {
	const match = WORKSPACE_PATH.exec(file);
	if (!match) return [];
	const owner = `${match[1]}/${match[2]}`;
	if (match[1] !== "packages") return [owner];
	const packageName = graph.packageNameOf.get(owner);
	if (!packageName) return [owner];
	return [
		owner,
		...dependentsOf(packageName, graph.manifests).filter((d) => d !== owner),
	];
}

/**
 * Workspace dirs affected by a changed set — the same owner-plus-dependents
 * derivation the test gate uses, exported so the typecheck gate shares it
 * rather than growing a second copy that can drift.
 *
 * @param {string[] | null} files
 * @param {object} io
 * @param {(workspaceDir: string) => boolean} io.isRelevantWorkspace
 * @param {(workspaceDir: string) => {name?: string, deps: Set<string>} | null} io.readManifest
 * @param {string[]} io.workspaceDirs
 * @returns {string[]} sorted workspace dirs
 */
export function affectedWorkspaces(files, io) {
	if (!files || files.length === 0) return [];
	const manifests = new Map();
	const packageNameOf = new Map();
	for (const workspaceDir of io.workspaceDirs) {
		const manifest = io.readManifest(workspaceDir);
		packageNameOf.set(workspaceDir, manifest?.name);
		if (manifest && io.isRelevantWorkspace(workspaceDir)) {
			manifests.set(workspaceDir, manifest);
		}
	}
	const hits = new Set();
	for (const file of files) {
		for (const workspaceDir of workspacesAffectedBy(file, {
			manifests,
			packageNameOf,
		})) {
			if (io.isRelevantWorkspace(workspaceDir)) hits.add(workspaceDir);
		}
	}
	return [...hits].sort();
}

/**
 * @param {string[] | null} files changed paths, or null for "run everything"
 * @param {object} io
 * @param {(workspaceDir: string) => boolean} io.isTestableWorkspace true when the
 *   workspace has a vitest/vite config — without one there is nothing to run.
 * @param {(workspaceDir: string) => {name?: string, deps: Set<string>} | null} io.readManifest
 *   parsed package.json for a workspace, or null when it has none.
 * @param {string[]} io.workspaceDirs every workspace dir in the repo.
 * @returns {Map<string, string[]>} workspace dir -> paths to pass to `related`,
 *   each list deduplicated and sorted so the gate's command is stable.
 */
export function relatedTestTargetsByWorkspace(files, io) {
	/** @type {Map<string, Set<string>>} */
	const byWorkspace = new Map();
	if (!files || files.length === 0) return new Map();

	// Manifests are read once: a change to a widely-depended-on package asks the
	// same question for every changed file in it.
	/** @type {Map<string, {name?: string, deps: Set<string>}>} */
	const manifests = new Map();
	for (const workspaceDir of io.workspaceDirs) {
		if (!io.isTestableWorkspace(workspaceDir)) continue;
		const manifest = io.readManifest(workspaceDir);
		if (manifest) manifests.set(workspaceDir, manifest);
	}
	/** @type {Map<string, string | undefined>} */
	const packageNameOf = new Map();
	for (const workspaceDir of io.workspaceDirs) {
		packageNameOf.set(workspaceDir, io.readManifest(workspaceDir)?.name);
	}

	const add = (workspaceDir, file) => {
		if (!io.isTestableWorkspace(workspaceDir)) return;
		const list = byWorkspace.get(workspaceDir) ?? new Set();
		list.add(pathForWorkspace(file, workspaceDir));
		byWorkspace.set(workspaceDir, list);
	};

	for (const file of files) {
		for (const workspaceDir of workspacesAffectedBy(file, {
			manifests,
			packageNameOf,
		})) {
			add(workspaceDir, file);
		}
	}

	return new Map(
		[...byWorkspace.entries()]
			.map(([workspaceDir, paths]) => [workspaceDir, [...paths].sort()])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

/**
 * How a workspace runs its tests: "vitest" (answers a `related` query), "bun"
 * (no `related` query — the whole suite is the smallest honest unit), or null.
 *
 * Probing for a vitest/vite config file, as this gate did, was wrong in both
 * directions and hid 553 test files across 21 workspaces — including the two
 * most depended-on packages in the repo, packages/db (178 files) and
 * packages/api-contract (64), neither of which keeps a config at its root even
 * though `vp test related` runs in both perfectly. A workspace's own test
 * script is the honest answer to "how is this tested"; the config check stays
 * as the second half of the union for a workspace whose script delegates
 * elsewhere (apps/tedi-workstation-egress-broker runs `bun run test:workerd`).
 *
 * @param {{testScript?: string} | null} manifest
 * @param {boolean} hasViteConfig vitest.config.ts or vite.config.ts at its root
 * @returns {"vitest" | "bun" | null}
 */
export function testRunnerFor(manifest, hasViteConfig) {
	if (!manifest) return null;
	const script = manifest.testScript ?? "";
	if (/\bvp test\b|\bvitest\b/.test(script) || hasViteConfig) return "vitest";
	return script ? "bun" : null;
}
