#!/usr/bin/env bun

/**
 * Fail when a workspace grows a new circular import beyond the baseline (policy in
 * `import-cycle-policy.ts`). Lexes comment-stripped source with anchored regexes.
 * Type-only imports/exports and `await import()` are not counted: neither can
 * create an initialization-order hazard.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	type CycleBaseline,
	evaluateCycles,
	findCycles,
	type WorkspaceCycles,
} from "./import-cycle-policy";

const repoRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(repoRoot, "scripts", "import-cycles-baseline.json");

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

/** Blank out comment bodies so a commented-out import is not counted. */
export function stripComments(source: string): string {
	// Replace comment bodies with spaces rather than deleting them, so the
	// anchored `^\s*` matches below cannot be fooled into joining two lines.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(m, lead) => lead + " ".repeat(m.length - lead.length),
		);
}

/**
 * Relative specifiers carrying a STATIC runtime edge.
 *
 * Bare specifiers (`@tedix/db/...`, `hono`) are skipped: cross-package edges
 * are the package-boundary lint's job, and following them would make every
 * workspace's graph the whole repo.
 */
export function runtimeImportSpecifiers(source: string): string[] {
	const text = stripComments(source);
	const specifiers: string[] = [];

	// `import ... from "x"` / `export ... from "x"`, rejecting the type-only
	// forms. `[^;]*?` keeps the match inside one statement.
	const fromRe =
		/^[ \t]*(?:import|export)[ \t]+(?!type[ \t])[^;]*?from[ \t]*["']([^"']+)["']/gm;
	// Side-effect import: `import "x";`
	const bareRe = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;

	for (const re of [fromRe, bareRe]) {
		let match = re.exec(text);
		while (match !== null) {
			const specifier = match[1];
			if (specifier?.startsWith(".")) specifiers.push(specifier);
			match = re.exec(text);
		}
	}
	return specifiers;
}

function runtimeImports(file: string): string[] {
	return runtimeImportSpecifiers(readFileSync(file, "utf8"));
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

function readBaseline(): CycleBaseline {
	const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
	if (!parsed || typeof parsed.workspaces !== "object") {
		throw new Error(`${baselinePath} is missing a "workspaces" object.`);
	}
	return parsed as CycleBaseline;
}

function writeBaseline(measured: WorkspaceCycles[]): void {
	const workspaces: Record<string, number> = {};
	for (const entry of measured.sort((a, b) =>
		a.workspace.localeCompare(b.workspace),
	)) {
		workspaces[entry.workspace] = entry.cycles.length;
	}
	const baseline: CycleBaseline = {
		$comment:
			"Import cycles per workspace. Data, not policy — refresh with " +
			"`bun scripts/lint-import-cycles.ts --update-baseline` and commit it like " +
			"a lockfile. A count may only SHRINK; the judgement is the direction, " +
			"not the number, so this needs no written justification. A workspace " +
			"absent from this list is held at zero.",
		workspaces,
	};
	writeFileSync(baselinePath, `${JSON.stringify(baseline, null, "\t")}\n`);
}

if (import.meta.main) {
	const measured = workspaceRoots().map(measureWorkspace);

	if (process.argv.includes("--update-baseline")) {
		writeBaseline(measured);
		const total = measured.reduce((sum, e) => sum + e.cycles.length, 0);
		console.log(
			`import-cycle baseline updated (${measured.length} workspaces, ${total} cycle(s)).`,
		);
		process.exit(0);
	}

	const verdict = evaluateCycles({ measured, baseline: readBaseline() });
	for (const failure of verdict.failures) console.error(failure);
	for (const improvement of verdict.improvements) console.log(improvement);
	if (!verdict.ok) process.exit(1);
	console.log(verdict.summary);
}
