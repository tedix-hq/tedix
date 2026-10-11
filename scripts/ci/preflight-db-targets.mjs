/**
 * Whether a changed path is an input to the D1 schema gate
 * (`packages/db` `db:migrate:check`: Drizzle snapshot, migration history and
 * collision, destructive DDL, local migration chain). The gate takes ~45s, so
 * it runs only for the paths it reads.
 *
 * Its inputs are the Drizzle schema (`src/schema/`, the only source tree
 * drizzle.config.ts loads; it imports nothing else under `src/`), the
 * migrations (`drizzle/`), the checker scripts, and the package's config files.
 * The query modules and other runtime code under `src/` never reach it, and
 * neither does a workspace's prose.
 *
 * The schema also loads modules from other workspaces at runtime: enum value
 * lists and constants from `@tedix/api-contract/...`, and whatever those import
 * in turn. A change there can change the generated snapshot, so those files are
 * inputs too. They are DERIVED by walking the schema's static runtime imports
 * ({@link schemaRuntimeImports}), never listed here: a list stops covering a
 * file the day a schema module starts importing it. Type-only imports are not
 * followed; they are erased before drizzle-kit evaluates the schema.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeImportSpecifiers } from "../runtime-import-specifiers.mjs";
import { isWorkspaceProse } from "./preflight-typecheck-targets.mjs";

const DB = "packages/db/";
const SCHEMA = `${DB}src/schema/`;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const NO_IMPORTS = () => new Set();

/**
 * @param {string} file repo-relative changed path
 * @param {() => Set<string>} [schemaImports] lazily computed
 *   {@link schemaRuntimeImports}; asked only for a path outside packages/db, so
 *   a push that touches no other workspace never walks the graph.
 */
export function isD1SchemaGateInput(file, schemaImports = NO_IMPORTS) {
	if (!file.startsWith(DB)) return schemaImports().has(file);
	if (isWorkspaceProse(file)) return false;
	if (file.startsWith(`${DB}src/`)) return file.startsWith(SCHEMA);
	return true;
}

/**
 * @typedef {object} RepoReader
 * @property {(dir: string) => string[]} listFiles repo-relative files under
 *   `dir`, recursively
 * @property {(dir: string) => string[]} listDirs repo-relative child
 *   directories of `dir`
 * @property {(file: string) => string | undefined} readFile undefined when the
 *   file does not exist
 */

/**
 * Every repo file outside `packages/db/src/schema/` that the schema modules
 * reach through static runtime imports, transitively: relative specifiers, and
 * `@tedix/*` workspace specifiers resolved through that package's `exports`.
 * Third-party packages are not followed.
 *
 * @param {RepoReader} io
 * @returns {Set<string>} repo-relative paths
 */
export function schemaRuntimeImports(io) {
	const workspaces = workspacePackages(io);
	const queue = io
		.listFiles(SCHEMA)
		.filter((f) => /\.tsx?$/.test(f) && !TEST_FILE.test(f));
	const seen = new Set(queue);
	while (queue.length > 0) {
		const file = /** @type {string} */ (queue.pop());
		const source = io.readFile(file);
		if (source === undefined) continue;
		for (const specifier of runtimeImportSpecifiers(source)) {
			const target = resolveSpecifier(io, workspaces, file, specifier);
			if (target && !seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return new Set([...seen].filter((f) => !f.startsWith(SCHEMA)));
}

/**
 * A {@link RepoReader} over the working tree at `root`.
 * @param {string} root absolute repo root
 * @returns {RepoReader}
 */
export function fsRepoReader(root) {
	/** @param {string} dir */
	const entries = (dir) => {
		try {
			return readdirSync(join(root, dir), { withFileTypes: true });
		} catch {
			return [];
		}
	};
	return {
		listFiles(dir) {
			/** @type {string[]} */
			const out = [];
			for (const entry of entries(dir)) {
				const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
				if (entry.isDirectory()) out.push(...this.listFiles(path));
				else if (entry.isFile()) out.push(path);
			}
			return out;
		},
		listDirs(dir) {
			return entries(dir)
				.filter((e) => e.isDirectory())
				.map((e) => `${dir}/${e.name}`);
		},
		readFile(file) {
			try {
				return readFileSync(join(root, file), "utf8");
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * @param {RepoReader} io
 * @returns {Map<string, { dir: string, exports: unknown }>} by package name
 */
function workspacePackages(io) {
	const packages = new Map();
	for (const dir of io.listDirs("packages")) {
		const manifest = io.readFile(`${dir}/package.json`);
		if (manifest === undefined) continue;
		const { name, exports } = JSON.parse(manifest);
		if (typeof name === "string") packages.set(name, { dir, exports });
	}
	return packages;
}

/**
 * @param {RepoReader} io
 * @param {Map<string, { dir: string, exports: unknown }>} workspaces
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveSpecifier(io, workspaces, fromFile, specifier) {
	if (specifier.startsWith(".")) {
		const base = joinPath(dirOf(fromFile), specifier);
		return firstExisting(io, [
			`${base}.ts`,
			`${base}.tsx`,
			`${base}/index.ts`,
			`${base}/index.tsx`,
			// `./foo.js` is how ESM-correct TypeScript spells a `.ts` sibling.
			base.replace(/\.js$/, ".ts"),
			base,
		]);
	}
	const match = /^(@tedix\/[^/]+)(?:\/(.+))?$/.exec(specifier);
	const workspace = match && workspaces.get(match[1]);
	if (!match || !workspace) return undefined;
	const subpath = match[2] ? `./${match[2]}` : ".";
	const target = exportTarget(workspace.exports, subpath);
	if (!target) return undefined;
	return firstExisting(io, [joinPath(workspace.dir, target)]);
}

/**
 * @param {unknown} exports
 * @param {string} subpath
 * @returns {string | undefined}
 */
function exportTarget(exports, subpath) {
	if (typeof exports === "string") return subpath === "." ? exports : undefined;
	if (!exports || typeof exports !== "object") return undefined;
	/** @type {unknown} */
	let entry = /** @type {Record<string, unknown>} */ (exports)[subpath];
	while (entry && typeof entry === "object") {
		const conditions = /** @type {Record<string, unknown>} */ (entry);
		entry = conditions.import ?? conditions.default ?? conditions.types;
	}
	return typeof entry === "string" ? entry : undefined;
}

/**
 * @param {RepoReader} io
 * @param {string[]} candidates
 */
function firstExisting(io, candidates) {
	return candidates.find(
		(c) => /\.[cm]?[jt]sx?$/.test(c) && io.readFile(c) !== undefined,
	);
}

/** @param {string} file */
function dirOf(file) {
	return file.slice(0, Math.max(0, file.lastIndexOf("/")));
}

/**
 * Join and normalise repo-relative POSIX paths.
 * @param {string} base
 * @param {string} rel
 */
function joinPath(base, rel) {
	/** @type {string[]} */
	const parts = [];
	for (const part of `${base}/${rel}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return parts.join("/");
}
