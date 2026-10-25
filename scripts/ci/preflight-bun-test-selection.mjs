/**
 * Which test files a bun-runner workspace runs for a change.
 *
 * `vitest related` answers this for the vitest workspaces; bun:test has no
 * such query, so the gate ran a bun workspace's WHOLE suite whenever any file
 * it or a dependency owns changed. packages/cli (2,000 cases, serial) and
 * apps/tedi-runtime (250 test files, each its own process) sit downstream of
 * packages/db, api-contract and mcp-shared, so half of all pushes paid 1–3
 * minutes for suites that could not see the change.
 *
 * This module walks the import graph instead: a test file runs when a changed
 * file is reachable from it — through relative imports and through
 * `@tedix/<package>/<subpath>` imports resolved by that package's `exports`
 * map, exactly as Bun resolves them. The selection falls back to the whole
 * suite, with the reason named, when it cannot be trusted:
 *
 * - an import it cannot resolve (an alias it does not know, a missing file),
 *   or a file it cannot parse — an incomplete graph would hide a test;
 * - a change to the suite's own infrastructure (bunfig.toml, package.json,
 *   tsconfig, a vitest config, the lockfile) — no import edge records those;
 * - more than SELECTION_FILE_LIMIT changed code files — a refactor of that
 *   size wants the whole suite, and the graph adds nothing at that point.
 *
 * Two deliberate over-selections keep it honest. A test that reads the repo
 * through the filesystem (`import.meta.dirname`, `__dirname`) pins behavior
 * of files it never imports — do-canonical-transcript.guard.test.ts reads
 * do.ts as text — so it always runs. And the bunfig `preload` modules run
 * before every test, so they are an import of every test file.
 *
 * Pure: every filesystem read goes through `io`, so the test exercises the
 * graph on an in-memory repo. `fsBunSelectionIo` is the real one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parseSync } from "oxc-parser";

/** Above this many changed code files the whole suite runs. */
export const SELECTION_FILE_LIMIT = 50;

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".jsx"];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, ".json"];
/** A test file the workspace's runner could pick up. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const ROOT_TSCONFIG = /^tsconfig[^/]*\.json$/;
/** `.js` in a TypeScript import names the `.ts` next to it. */
const JS_TO_TS = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".jsx": [".tsx"] };
/** A test that reads the checkout as data rather than importing it. */
const READS_REPO = /import\.meta\.dir(name)?\b|__dirname\b/;

function isCodeFile(file) {
	return CODE_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * A file whose change no import edge can represent: the runner's own
 * configuration and the dependency set. Root-level entries affect every
 * workspace; the workspace's own live under its directory.
 *
 * @param {string} file repo-relative
 * @param {string} workspaceDir
 */
export function isBunSuiteInfrastructure(file, workspaceDir) {
	if (
		file === "bun.lock" ||
		file === "package.json" ||
		file === "bunfig.toml" ||
		ROOT_TSCONFIG.test(file)
	) {
		return true;
	}
	if (!file.startsWith(`${workspaceDir}/`)) return false;
	const name = file.slice(workspaceDir.length + 1);
	return (
		name === "package.json" ||
		name === "bunfig.toml" ||
		name === "scripts/run-tests.ts" ||
		ROOT_TSCONFIG.test(name) ||
		/^vitest[^/]*\.config\.[cm]?[jt]s$/.test(name) ||
		/^vite\.config\.[cm]?[jt]s$/.test(name)
	);
}

/**
 * Root compiler configuration has no code-file import edge, so it must also
 * select Bun workspaces before the per-workspace file selection runs.
 *
 * @param {string[]} changedFiles repo-relative
 * @param {Iterable<string>} relatedWorkspaces selected by the import graph
 * @param {string[]} bunWorkspaces all workspaces with a Bun test runner
 * @returns {string[]}
 */
export function selectBunTestWorkspaces(
	changedFiles,
	relatedWorkspaces,
	bunWorkspaces,
) {
	const rootConfigChanged = changedFiles.some((file) =>
		ROOT_TSCONFIG.test(file),
	);
	const related = new Set(relatedWorkspaces);
	return bunWorkspaces.filter(
		(workspace) => rootConfigChanged || related.has(workspace),
	);
}

/**
 * The `preload = [...]` entries of a bunfig.toml, workspace-relative as
 * written. A regex is enough: the file is three lines and the key is a plain
 * string array.
 *
 * @param {string | null} source
 * @returns {string[]}
 */
export function bunfigPreloads(source) {
	const match = /^\s*preload\s*=\s*\[([^\]]*)\]/m.exec(source ?? "");
	if (!match) return [];
	return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/**
 * Module specifiers one source file imports, statically or dynamically, in
 * source order. Type-only imports count: a type change can still break a
 * test that asserts on the shape. A dynamic import whose argument is not a
 * string literal names nothing the graph can follow and is dropped. A computed
 * require cannot be represented by an edge, so it fails the selection closed.
 *
 * @param {string} path for the parser's language choice and error messages
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(path, source) {
	const parsed = parseSync(path, source, { lang: languageOf(path) });
	const failure = parsed.errors[0];
	if (failure) throw new Error(`${path}: ${failure.message}`);
	const specifiers = [];
	for (const entry of parsed.module.staticImports) {
		specifiers.push(entry.moduleRequest.value);
	}
	for (const statement of parsed.module.staticExports) {
		for (const entry of statement.entries) {
			if (entry.moduleRequest) specifiers.push(entry.moduleRequest.value);
		}
	}
	for (const entry of parsed.module.dynamicImports) {
		const text = source.slice(
			entry.moduleRequest.start,
			entry.moduleRequest.end,
		);
		const literal = /^(["'])([^"'\n]*)\1$/.exec(text.trim());
		if (literal) specifiers.push(literal[2]);
	}
	for (const specifier of requireSpecifiers(parsed.program, path)) {
		specifiers.push(specifier);
	}
	return specifiers;
}

function requireSpecifiers(node, path) {
	const specifiers = [];
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (
			value.type === "CallExpression" &&
			value.callee?.type === "Identifier" &&
			value.callee.name === "require"
		) {
			const [argument] = value.arguments;
			if (
				value.arguments.length !== 1 ||
				argument?.type !== "Literal" ||
				typeof argument.value !== "string"
			) {
				throw new Error(`${path}: computed require call`);
			}
			specifiers.push(argument.value);
			return;
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(node);
	return specifiers;
}

function languageOf(path) {
	if (path.endsWith(".tsx")) return "tsx";
	if (path.endsWith(".jsx")) return "jsx";
	if (/\.[cm]?js$/.test(path)) return "js";
	return "ts";
}

/**
 * Repo-relative dependencies of a specifier, including workspace manifests
 * that control resolution. External packages have no repo dependencies;
 * unresolved repo imports throw.
 *
 * @param {string} specifier
 * @param {string} importer repo-relative
 * @param {object} io
 */
function resolveSpecifier(specifier, importer, io) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const target = posix.normalize(
			posix.join(posix.dirname(importer), specifier),
		);
		return [resolveFile(target, io, `${importer} imports ${specifier}`)];
	}
	const configs = aliasConfigDependencies(specifier, importer, io);
	if (/^(~\/|@\/|#)/.test(specifier)) {
		throw new Error(
			`${importer} imports ${specifier}: unresolved local alias requires full suite`,
		);
	}
	if (specifier.startsWith("@tedix/")) {
		return [...configs, ...resolveWorkspaceImport(specifier, importer, io)];
	}
	return configs;
}

/** Aliases need Bun's resolver; never prune a suite on an ignored alias. */
function aliasConfigDependencies(specifier, importer, io) {
	if (/^(node|bun):/.test(specifier)) return [];
	let dir = posix.dirname(importer);
	while (!io.isFile(posix.join(dir, "tsconfig.json"))) {
		if (dir === ".") return [];
		dir = posix.dirname(dir);
	}
	const configs = new Set();
	const visit = (file, ancestors = new Set()) => {
		if (ancestors.has(file))
			throw new Error(`${file}: circular tsconfig extends`);
		if (configs.has(file)) return;
		configs.add(file);
		const errors = [];
		const source = io.readSource(file);
		const config =
			source === null
				? null
				: parseJsonc(source, errors, { allowTrailingComma: true });
		if (!config || errors.length)
			throw new Error(`${file}: cannot read tsconfig`);
		const options = config.compilerOptions ?? {};
		for (const pattern of Object.keys(options.paths ?? {})) {
			const star = pattern.indexOf("*");
			if (
				pattern === specifier ||
				(star !== -1 &&
					specifier.startsWith(pattern.slice(0, star)) &&
					specifier.endsWith(pattern.slice(star + 1)))
			) {
				throw new Error(
					`${importer} imports ${specifier}: local alias ${pattern} in ${file} requires full suite`,
				);
			}
		}
		if (options.baseUrl !== undefined) {
			throw new Error(
				`${importer} imports ${specifier}: baseUrl in ${file} requires full suite`,
			);
		}
		const parents =
			config.extends === undefined
				? []
				: Array.isArray(config.extends)
					? config.extends
					: [config.extends];
		for (const parent of parents) {
			let target;
			if (parent.startsWith(".")) {
				target = posix.join(posix.dirname(file), parent);
			} else {
				const parts = parent.split("/");
				const name = parts.splice(0, parent.startsWith("@") ? 2 : 1).join("/");
				const packageDir = io.packageDir(name);
				if (!packageDir || !parts.length)
					throw new Error(`${file}: unresolved tsconfig extends ${parent}`);
				target = posix.join(packageDir, ...parts);
			}
			if (!io.isFile(target)) target += ".json";
			visit(target, new Set([...ancestors, file]));
		}
	};
	visit(posix.join(dir, "tsconfig.json"));
	return [...configs];
}

/**
 * `@tedix/<name>[/<subpath>]` through the package's `exports` map, the way
 * Bun resolves the workspace symlink. A package without an `exports` field
 * resolves its root to `main`/`module`.
 */
function resolveWorkspaceImport(specifier, importer, io) {
	const [scope, name, ...rest] = specifier.split("/");
	const packageName = `${scope}/${name}`;
	const packageDir = io.packageDir(packageName);
	if (!packageDir) {
		throw new Error(
			`${importer} imports ${specifier}: unknown workspace package`,
		);
	}
	const subpath = rest.length ? `./${rest.join("/")}` : ".";
	const manifest = io.readManifest(packageDir) ?? {};
	const target = exportTarget(manifest, subpath);
	if (!target) {
		throw new Error(
			`${importer} imports ${specifier}: ${packageName} does not export ${subpath}`,
		);
	}
	return [
		`${packageDir}/package.json`,
		resolveFile(
			posix.normalize(posix.join(packageDir, target)),
			io,
			`${importer} imports ${specifier}`,
		),
	];
}

/**
 * The relative path an `exports` entry maps `subpath` to, honoring conditional
 * objects and a single `*` pattern, or null.
 */
function exportTarget(manifest, subpath) {
	const exports = manifest.exports;
	if (exports === undefined) {
		if (subpath !== ".") return null;
		return manifest.module ?? manifest.main ?? null;
	}
	if (typeof exports === "string") return subpath === "." ? exports : null;
	if (subpath in exports) return conditionTarget(exports[subpath]);
	// Package patterns rank by longest literal prefix, then longest key.
	const patterns = Object.entries(exports)
		.filter(
			([key]) => key.includes("*") && key.indexOf("*") === key.lastIndexOf("*"),
		)
		.sort(([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
	for (const [pattern, value] of patterns) {
		const star = pattern.indexOf("*");
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (
			subpath.startsWith(prefix) &&
			subpath.endsWith(suffix) &&
			subpath.length > prefix.length + suffix.length
		) {
			const captured = subpath.slice(
				prefix.length,
				subpath.length - suffix.length,
			);
			const target = conditionTarget(value);
			return target ? target.replaceAll("*", captured) : null;
		}
	}
	return null;
}

function conditionTarget(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	for (const condition of ["bun", "import", "default", "require"]) {
		if (condition in value) return conditionTarget(value[condition]);
	}
	for (const nested of Object.values(value)) {
		const target = conditionTarget(nested);
		if (target) return target;
	}
	return null;
}

/**
 * The first existing candidate for a path: as written, with a source
 * extension, as a directory index, or — for an ESM-style `.js` — the `.ts`
 * it stands for.
 */
function resolveFile(target, io, context) {
	const candidates = [target];
	for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${target}${ext}`);
	for (const ext of CODE_EXTENSIONS) candidates.push(`${target}/index${ext}`);
	for (const [from, tos] of Object.entries(JS_TO_TS)) {
		if (target.endsWith(from)) {
			for (const to of tos) candidates.push(target.slice(0, -from.length) + to);
		}
	}
	for (const candidate of candidates) {
		if (io.isFile(candidate)) return candidate;
	}
	throw new Error(`${context}: no file resolves it`);
}

/**
 * @typedef {object} SelectionIo
 * @property {(file: string) => boolean} isFile repo-relative path names a file
 * @property {(file: string) => string | null} readSource
 * @property {(packageName: string) => string | undefined} packageDir
 *   workspace dir publishing a package name
 * @property {(workspaceDir: string) => Record<string, unknown> | null} readManifest
 *   parsed package.json
 * @property {(workspaceDir: string) => string[]} listTestFiles repo-relative
 * @property {Map<string, string[]>} [dependencyCache] direct imports by file,
 *   shared across workspaces in one gate run
 */

/**
 * @param {object} input
 * @param {string} input.workspaceDir e.g. "packages/cli"
 * @param {string[]} input.changedFiles repo-relative, every changed path
 * @param {SelectionIo} input.io
 * @returns {{mode: "all", reason: string} | {mode: "files", files: string[], total: number}}
 *   `files` are workspace-relative, sorted, ready for the runner's argv
 */
export function selectBunTestFiles({ workspaceDir, changedFiles, io }) {
	const infrastructure = changedFiles.find((file) =>
		isBunSuiteInfrastructure(file, workspaceDir),
	);
	if (infrastructure) {
		return { mode: "all", reason: `${infrastructure} changed` };
	}
	const changedCode = changedFiles.filter(isCodeFile);
	if (changedCode.length > SELECTION_FILE_LIMIT) {
		return {
			mode: "all",
			reason: `${changedCode.length} code files changed, above ${SELECTION_FILE_LIMIT}`,
		};
	}

	const testFiles = io
		.listTestFiles(workspaceDir)
		.filter((f) => TEST_FILE.test(f));
	const changed = new Set(changedFiles);
	const preloads = bunfigPreloads(
		io.readSource(`${workspaceDir}/bunfig.toml`),
	).map((entry) => posix.normalize(posix.join(workspaceDir, entry)));
	const dependencies = io.dependencyCache ?? new Map();

	const directImports = (file) => {
		const cached = dependencies.get(file);
		if (cached) return cached;
		let resolved = [];
		if (isCodeFile(file)) {
			const source = io.readSource(file);
			if (source === null) throw new Error(`${file}: cannot read`);
			resolved = importSpecifiers(file, source).flatMap((specifier) =>
				resolveSpecifier(specifier, file, io),
			);
		}
		dependencies.set(file, resolved);
		return resolved;
	};

	/** Does any changed file sit in `root`'s import closure (itself included)? */
	const reachesChange = (root) => {
		const seen = new Set();
		const stack = [root];
		while (stack.length) {
			const file = stack.pop();
			if (seen.has(file)) continue;
			seen.add(file);
			if (changed.has(file)) return true;
			for (const dep of directImports(file)) stack.push(dep);
		}
		return false;
	};

	const selected = [];
	try {
		const preloadChanged = preloads.some(reachesChange);
		for (const testFile of testFiles) {
			const source = io.readSource(testFile) ?? "";
			if (
				preloadChanged ||
				READS_REPO.test(source) ||
				reachesChange(testFile)
			) {
				selected.push(testFile);
			}
		}
	} catch (error) {
		return { mode: "all", reason: `import graph incomplete: ${error.message}` };
	}
	if (selected.length === testFiles.length) {
		return { mode: "all", reason: "every test file reaches a changed file" };
	}
	return {
		mode: "files",
		files: selected.map((f) => f.slice(workspaceDir.length + 1)).sort(),
		total: testFiles.length,
	};
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".wrangler", ".turbo"]);

/**
 * The real repository, read lazily and cached for the lifetime of one gate
 * run: a changed shared package asks the same questions from every bun
 * workspace that depends on it.
 *
 * @param {string} repoRoot absolute
 * @param {string[]} workspaceDirs every workspace dir in the repo
 * @returns {SelectionIo}
 */
export function fsBunSelectionIo(repoRoot, workspaceDirs) {
	const manifests = new Map();
	const readManifest = (workspaceDir) => {
		if (manifests.has(workspaceDir)) return manifests.get(workspaceDir);
		let manifest = null;
		try {
			manifest = JSON.parse(
				readFileSync(join(repoRoot, workspaceDir, "package.json"), "utf8"),
			);
		} catch {
			manifest = null;
		}
		manifests.set(workspaceDir, manifest);
		return manifest;
	};
	let packageDirs;
	const packageDir = (packageName) => {
		if (!packageDirs) {
			packageDirs = new Map();
			for (const workspaceDir of workspaceDirs) {
				const name = readManifest(workspaceDir)?.name;
				if (typeof name === "string") packageDirs.set(name, workspaceDir);
			}
		}
		return packageDirs.get(packageName);
	};
	const fileKinds = new Map();
	const isFile = (file) => {
		if (fileKinds.has(file)) return fileKinds.get(file);
		let result = false;
		try {
			result = statSync(join(repoRoot, file)).isFile();
		} catch {
			result = false;
		}
		fileKinds.set(file, result);
		return result;
	};
	const listTestFiles = (workspaceDir) => {
		const found = [];
		const walk = (dir) => {
			for (const entry of readdirSync(join(repoRoot, dir), {
				withFileTypes: true,
			})) {
				if (entry.isDirectory()) {
					if (!SKIPPED_DIRS.has(entry.name)) walk(`${dir}/${entry.name}`);
				} else if (TEST_FILE.test(entry.name)) {
					found.push(`${dir}/${entry.name}`);
				}
			}
		};
		if (existsSync(join(repoRoot, workspaceDir))) walk(workspaceDir);
		return found.sort();
	};
	return {
		isFile,
		readSource: (file) => {
			try {
				return readFileSync(join(repoRoot, file), "utf8");
			} catch {
				return null;
			}
		},
		packageDir,
		readManifest,
		listTestFiles,
		dependencyCache: new Map(),
	};
}
