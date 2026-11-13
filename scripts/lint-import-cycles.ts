#!/usr/bin/env bun

/**
 * Reject every circular import (policy in
 * `import-cycle-policy.ts`). Edges come from `runtime-import-specifiers.mjs`,
 * which skips type-only imports/exports and `await import()`: neither can
 * create an initialization-order hazard.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	evaluateCycles,
	findCycles,
	type WorkspaceCycles,
} from "./import-cycle-policy";
import { runtimeImportSpecifiers } from "./runtime-import-specifiers.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const RESOLUTION_ORDER = [
	".ts",
	".tsx",
	".d.ts",
	"/index.ts",
	"/index.tsx",
	// `./foo.js` is how ESM-correct TypeScript spells a `.ts` sibling.
	"",
];

function isSourceFile(path: string): boolean {
	if (path.endsWith(".d.ts")) return false;
	// Generated modules are excluded because nobody can refactor them: the
	// `routeTree.gen.ts` modules emitted by TanStack Router can contain cycles by
	// design, and reporting them forever would train everyone to ignore this
	// check's output.
	if (path.includes(".generated.") || /\.gen\.tsx?$/.test(path)) return false;
	return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) walk(full, out);
		else if (isSourceFile(full)) out.push(full);
	}
	return out;
}

/**
 * Relative specifiers carrying a STATIC runtime edge.
 *
 * Bare specifiers (`@tedix/db/...`, `hono`) are skipped: cross-package edges
 * are the package-boundary lint's job, and following them would make every
 * workspace's graph the whole repo.
 */
function runtimeImports(file: string): string[] {
	return runtimeImportSpecifiers(readFileSync(file, "utf8")).filter((s) =>
		s.startsWith("."),
	);
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
	const base = resolve(dirname(fromFile), specifier);
	for (const suffix of RESOLUTION_ORDER) {
		const candidate = suffix.startsWith("/")
			? join(base, suffix.slice(1))
			: `${base}${suffix}`;
		try {
			if (statSync(candidate).isFile() && isSourceFile(candidate)) {
				return candidate;
			}
		} catch {
			// keep trying
		}
	}
	// `./foo.js` -> `./foo.ts`
	const swapped = base.replace(/\.js$/, ".ts");
	try {
		if (swapped !== base && statSync(swapped).isFile()) return swapped;
	} catch {
		// unresolvable (generated, or a genuinely missing file) — not this
		// lint's problem; tsc reports it.
	}
	return null;
}

function measureWorkspace(workspace: string): WorkspaceCycles {
	const root = join(repoRoot, workspace);
	const files = walk(root);
	const graph = new Map<string, string[]>();

	for (const file of files) {
		const edges: string[] = [];
		for (const specifier of runtimeImports(file)) {
			const target = resolveSpecifier(file, specifier);
			// Only edges INSIDE this workspace; see runtimeImports().
			if (target && target.startsWith(`${root}/`)) {
				edges.push(relative(root, target));
			}
		}
		graph.set(relative(root, file), [...new Set(edges)].sort());
	}

	return { workspace, cycles: findCycles(graph) };
}

export function workspaceRoots(): string[] {
	const roots: string[] = [];
	for (const group of ["apps", "packages"]) {
		let entries: string[];
		try {
			entries = readdirSync(join(repoRoot, group));
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			for (const sourceDir of ["src", "app"]) {
				const candidate = join(group, entry, sourceDir);
				try {
					if (statSync(join(repoRoot, candidate)).isDirectory()) {
						roots.push(candidate);
					}
				} catch {
					// no such source dir in this workspace
				}
			}
		}
	}
	return roots;
}

if (import.meta.main) {
	const verdict = evaluateCycles(workspaceRoots().map(measureWorkspace));
	for (const failure of verdict.failures) console.error(failure);
	console.log(verdict.summary);
	if (!verdict.ok) process.exit(1);
}
