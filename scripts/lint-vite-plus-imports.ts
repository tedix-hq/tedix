#!/usr/bin/env bun

/**
 * Vite+ module-specifier contract (`bun scripts/lint-vite-plus-imports.ts`, part of `lint:repo`): workspaces
 * import Vite and Vitest through `vite-plus` (e.g. `vite-plus/test`), never the
 * upstream packages, which resolve to a different runtime copy. Replaces the
 * oxlint JS-plugin rule; do not reintroduce `lint.jsPlugins`. Any finding exits 1.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AstNode, lineAt, parseModule, walk } from "./oxc-ast.ts";
import { detachedGitEnv } from "./oss/git-env.ts";

/** One rejected specifier, with the replacement the repo requires instead. */
export interface VitePlusImportFinding {
	file: string;
	line: number;
	from: string;
	to: string;
}

const VITE_PLUS_LINT_PLUGINS = "vite-plus/lint/plugins";
const VITE_PLUS_LINT_PLUGINS_DEV = "vite-plus/lint/plugins-dev";

/**
 * Basenames Vite+ treats as a config entry. Bare `vite` imports are legitimate
 * nowhere else, but inside one of these the file IS the Vite config and must
 * reach the Vite+ copy of `defineConfig`.
 */
const VITE_CONFIG_BASENAMES = new Set([
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.cts",
	"vitest.config.js",
	"vitest.config.mjs",
	"vitest.config.cjs",
]);

/**
 * Names `oxlint` exports as CONFIG surface rather than plugin-authoring API.
 * An import of any of these from `oxlint` is fine; an import of anything else
 * is the pre-Vite+ plugin API and belongs to `vite-plus/lint/plugins`.
 */
const OXLINT_CONFIG_SURFACE_EXPORTS = new Set([
	"defineConfig",
	"AllowWarnDeny",
	"DummyRule",
	"DummyRuleMap",
	"ExternalPluginEntry",
	"ExternalPluginsConfig",
	"OxlintConfig",
	"OxlintEnv",
	"OxlintGlobals",
	"OxlintOverride",
	"RuleCategories",
]);

const BROWSER_SUBPATH_REWRITES: Record<string, string> = {
	"@vitest/browser/context": "vite-plus/test/browser/context",
	"@vitest/browser/client": "vite-plus/test/client",
	"@vitest/browser/locators": "vite-plus/test/locators",
	"@vitest/browser/matchers": "vite-plus/test/matchers",
	"@vitest/browser/utils": "vite-plus/test/utils",
};

const BROWSER_PROVIDER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
	["@vitest/browser-playwright", "playwright"],
	["@vitest/browser-preview", "preview"],
	["@vitest/browser-webdriverio", "webdriverio"],
];

/**
 * The `vite-plus` specifier a package specifier must be written as, or `null`
 * when the repo has no opinion about it.
 *
 * `vitest/package.json` is deliberately `null`: it is a data file with no
 * Vite+ mirror, so rewriting it would break the import it appears in.
 */
export function vitePlusReplacementFor(specifier: string): string | null {
	if (specifier === "vite") return "vite-plus";
	if (specifier.startsWith("vite/")) return `vite-plus/${specifier.slice(5)}`;
	if (specifier === "vitest/config") return "vite-plus";
	if (specifier === "vitest") return "vite-plus/test";
	if (specifier === "vitest/package.json") return null;
	if (specifier.startsWith("vitest/")) {
		return `vite-plus/test/${specifier.slice(7)}`;
	}
	if (specifier === "@vitest/browser") return "vite-plus/test/browser";
	const browserSubpath = BROWSER_SUBPATH_REWRITES[specifier];
	if (browserSubpath) return browserSubpath;
	for (const [prefix, provider] of BROWSER_PROVIDER_PREFIXES) {
		if (specifier === prefix) return `vite-plus/test/${prefix.slice(8)}`;
		if (specifier === `${prefix}/context`) {
			return "vite-plus/test/browser/context";
		}
		if (specifier === `${prefix}/provider`) {
			return `vite-plus/test/browser/providers/${provider}`;
		}
	}
	if (specifier === "@oxlint/plugins") return VITE_PLUS_LINT_PLUGINS;
	if (specifier === "oxlint/plugins-dev") return VITE_PLUS_LINT_PLUGINS_DEV;
	return null;
}

function isViteSpecifier(specifier: string): boolean {
	return specifier === "vite" || specifier.startsWith("vite/");
}

/** `vitest` and its subpaths — the family a `declare module` may name. */
function isVitestFamily(specifier: string): boolean {
	return (
		specifier === "vitest" ||
		specifier.startsWith("vitest/") ||
		specifier === "@vitest/browser" ||
		specifier.startsWith("@vitest/browser/") ||
		specifier.startsWith("@vitest/browser-")
	);
}

/** `oxlint` and its subpaths — the other family a `declare module` may name. */
function isOxlintFamily(specifier: string): boolean {
	return (
		specifier === "oxlint" ||
		specifier.startsWith("oxlint/") ||
		specifier === "@oxlint/plugins"
	);
}

function basename(file: string): string {
	const slash = file.lastIndexOf("/");
	return slash === -1 ? file : file.slice(slash + 1);
}

function literalValue(node: unknown): string | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const candidate = node as AstNode;
	if (candidate.type !== "Literal") return undefined;
	return typeof candidate.value === "string" ? candidate.value : undefined;
}

function bindingName(node: unknown): string | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const candidate = node as AstNode;
	if (candidate.type === "Identifier") {
		return typeof candidate.name === "string" ? candidate.name : undefined;
	}
	return typeof candidate.value === "string" ? candidate.value : undefined;
}

/**
 * The `oxlint` plugin-authoring API, written against the package directly.
 *
 * `import { defineRule } from "oxlint"` predates the Vite+ re-export and has no
 * specifier rewrite of its own, so it is matched by the binding names instead:
 * named bindings only, none of which is part of oxlint's config surface.
 */
function importsOxlintPluginApi(node: AstNode): boolean {
	const specifiers = (node.specifiers ?? []) as AstNode[];
	if (specifiers.length === 0) return false;
	return specifiers.every(
		(specifier) =>
			specifier.type === "ImportSpecifier" &&
			!OXLINT_CONFIG_SURFACE_EXPORTS.has(bindingName(specifier.imported) ?? ""),
	);
}

function reExportsOxlintPluginApi(node: AstNode): boolean {
	const specifiers = (node.specifiers ?? []) as AstNode[];
	if (specifiers.length === 0) return false;
	return specifiers.every(
		(specifier) =>
			!OXLINT_CONFIG_SURFACE_EXPORTS.has(bindingName(specifier.local) ?? ""),
	);
}

/**
 * Every specifier in one module that must be written as a `vite-plus` one.
 *
 * Covers the same syntax the oxlint rule did: static imports, `export … from`,
 * `export * from`, dynamic `import()`, `import("x").T` type positions,
 * `import x = require("x")`, and `declare module "x"` — the last exempting the
 * `vitest` and `oxlint` families, whose augmentations must name the real
 * upstream module to merge with its types.
 */
export function findVitePlusImportViolations(
	file: string,
	source: string,
): VitePlusImportFinding[] {
	const findings: VitePlusImportFinding[] = [];
	const fileIsViteConfig = VITE_CONFIG_BASENAMES.has(basename(file));

	const report = (node: AstNode, from: string, to: string): void => {
		findings.push({ file, line: lineAt(source, node.start), from, to });
	};

	const check = (node: unknown): void => {
		const specifier = literalValue(node);
		if (specifier === undefined) return;
		// A Vite config file IS the Vite entry point; everywhere else a bare
		// `vite` import is a type-only or plugin import the upstream package
		// still owns, and the rule leaves it alone.
		if (!fileIsViteConfig && isViteSpecifier(specifier)) return;
		const replacement = vitePlusReplacementFor(specifier);
		if (!replacement) return;
		report(node as AstNode, specifier, replacement);
	};

	walk(parseModule(file, source), (node) => {
		switch (node.type) {
			case "ImportDeclaration": {
				check(node.source);
				if (
					literalValue(node.source) === "oxlint" &&
					importsOxlintPluginApi(node)
				) {
					report(node.source as AstNode, "oxlint", VITE_PLUS_LINT_PLUGINS);
				}
				return;
			}
			case "ExportNamedDeclaration": {
				check(node.source);
				if (
					literalValue(node.source) === "oxlint" &&
					reExportsOxlintPluginApi(node)
				) {
					report(node.source as AstNode, "oxlint", VITE_PLUS_LINT_PLUGINS);
				}
				return;
			}
			case "ExportAllDeclaration":
			case "ImportExpression":
			case "TSImportType": {
				check(node.source);
				return;
			}
			case "TSExternalModuleReference": {
				check(node.expression);
				return;
			}
			case "TSModuleDeclaration": {
				if (node.global === true) return;
				const id = literalValue(node.id);
				if (id !== undefined && (isVitestFamily(id) || isOxlintFamily(id))) {
					return;
				}
				check(node.id);
				return;
			}
			default:
				return;
		}
	});

	return findings;
}

/** The one-line message a finding prints. */
export function formatVitePlusImportFinding(
	finding: VitePlusImportFinding,
): string {
	return `${finding.file}:${finding.line} imports "${finding.from}"; use "${finding.to}" in a Vite+ workspace.`;
}

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MODULE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Every module in the working tree oxlint would have seen: tracked files plus
 * untracked ones that are not ignored. `--others` matters — a new file is
 * untracked until it is staged, and a gate that only reads the index reports
 * the file it was just asked about as clean.
 */
function workingTreeModules(): string[] {
	const listed = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: detachedGitEnv(),
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (listed.status !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr}`);
	}
	return listed.stdout
		.split("\0")
		.filter((file) => file !== "" && MODULE_EXTENSIONS.test(file));
}

export function runVitePlusImportLint(): VitePlusImportFinding[] {
	const findings: VitePlusImportFinding[] = [];
	for (const file of workingTreeModules()) {
		const source = readFileSync(join(REPO_ROOT, file), "utf8");
		// Cheap pre-filter: every rejected specifier contains one of these, and
		// skipping the parse for the ~99% of files without one keeps the gate
		// well under a second across the whole repo.
		if (!source.includes("vite") && !source.includes("oxlint")) continue;
		findings.push(...findVitePlusImportViolations(file, source));
	}
	return findings;
}

if (import.meta.main) {
	const findings = runVitePlusImportLint();
	if (findings.length > 0) {
		console.error("Vite+ import contract failed:");
		for (const finding of findings) {
			console.error(`  - ${formatVitePlusImportFinding(finding)}`);
		}
		process.exit(1);
	}
	console.log(
		"Vite+ import contract OK: every Vite and Vitest entry point is a vite-plus specifier.",
	);
}
