#!/usr/bin/env bun

/**
 * Package export-surface checks for Tedix public workspace packages.
 *
 * Verifies that declared `package.json#exports` targets exist and that imports
 * of the checked packages use exported subpaths instead of private source files.
 * Enforces Vite+ module specifiers in the same working-tree scan.
 */

import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "./oss/git-env.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AstNode, lineAt, parseModule, walk } from "./oxc-ast.ts";

/**
 * Every workspace that declares `exports` is checked; the list is discovered, not
 * curated. A workspace without `exports` (apps, private leaves) is skipped.
 */
function discoverExportingPackageDirs(): string[] {
	const root = readJson("package.json");
	const globs = Array.isArray(root.workspaces)
		? (root.workspaces as unknown[]).filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	const dirs: string[] = [];
	for (const glob of globs) {
		const parent = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
		if (!existsSync(parent)) continue;
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(parent, entry.name);
			const packageJsonPath = join(dir, "package.json");
			if (!existsSync(packageJsonPath)) continue;
			const exportsField = readJson(packageJsonPath).exports;
			if (
				!exportsField ||
				typeof exportsField !== "object" ||
				Array.isArray(exportsField)
			) {
				continue;
			}
			dirs.push(dir);
		}
	}
	return dirs.sort();
}

const TEXT_SOURCE_EXTENSIONS = new Set([
	".astro",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
]);

// This unit test embeds intentionally invalid import statements as string
// fixtures for the DB-access linter; they are not executable package imports.
const IMPORT_SOURCE_FIXTURE_FILES = new Set(["scripts/lint-db-access.test.ts"]);

type PackageInfo = {
	dir: string;
	name: string;
	exportKeys: Set<string>;
};

function gitLsFiles(): string[] {
	const result = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{
			encoding: "utf8",
			env: detachedGitEnv(),
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.status !== 0)
		throw new Error(result.stderr || "git ls-files failed");
	return result.stdout
		.split("\0")
		.filter((path) => isSourceTextFile(path) || /\.[cm]?[jt]sx?$/.test(path))
		.filter((path) => existsSync(path) && statSync(path).isFile())
		.sort();
}

function extension(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot);
}

function isSourceTextFile(path: string): boolean {
	return TEXT_SOURCE_EXTENSIONS.has(extension(path));
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectStringTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	return Object.values(value as Record<string, unknown>).flatMap((entry) =>
		collectStringTargets(entry),
	);
}

function exportKeyForSpecifier(packageName: string, specifier: string): string {
	return specifier === packageName
		? "."
		: `.${specifier.slice(packageName.length)}`;
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function importedSpecifiers(source: string): string[] {
	const withoutComments = stripComments(source);
	const out = new Set<string>();
	const staticImportExport =
		/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
	const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of withoutComments.matchAll(staticImportExport)) {
		if (match[1]) out.add(match[1]);
	}
	for (const match of withoutComments.matchAll(dynamicImport)) {
		if (match[1]) out.add(match[1]);
	}
	return [...out].sort();
}

function lineNumber(text: string, needle: string): number {
	const index = text.indexOf(needle);
	if (index < 0) return 1;
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (text.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

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

if (import.meta.main) {
	const failures: string[] = [];
	const packages: PackageInfo[] = [];

	for (const dir of discoverExportingPackageDirs()) {
		const packageJsonPath = join(dir, "package.json");
		const pkg = readJson(packageJsonPath);
		const name = typeof pkg.name === "string" ? pkg.name : "";
		const exportsField = pkg.exports;
		if (!name) failures.push(`${packageJsonPath}: missing package name`);
		if (
			!exportsField ||
			typeof exportsField !== "object" ||
			Array.isArray(exportsField)
		) {
			failures.push(`${packageJsonPath}: expected object package.json#exports`);
			continue;
		}
		const exportKeys = new Set<string>();
		for (const [key, value] of Object.entries(exportsField)) {
			exportKeys.add(key);
			if (!key.startsWith(".")) {
				failures.push(
					`${packageJsonPath}: export key ${key} must start with '.'`,
				);
			}
			for (const target of collectStringTargets(value)) {
				if (!target.startsWith("./")) {
					failures.push(
						`${packageJsonPath}: export ${key} target ${target} must be package-relative`,
					);
					continue;
				}
				const targetPath = join(dir, target);
				if (!existsSync(targetPath)) {
					failures.push(
						`${packageJsonPath}: export ${key} target does not exist: ${target}`,
					);
				}
			}
		}
		packages.push({ dir, name, exportKeys });
	}

	const trackedSourceFiles = gitLsFiles();
	for (const file of trackedSourceFiles) {
		const source = readFileSync(file, "utf8");
		if (
			/\.[cm]?[jt]sx?$/.test(file) &&
			(source.includes("vite") || source.includes("oxlint"))
		) {
			failures.push(
				...findVitePlusImportViolations(file, source).map(
					formatVitePlusImportFinding,
				),
			);
		}
		if (IMPORT_SOURCE_FIXTURE_FILES.has(file)) continue;
		const specifiers = importedSpecifiers(source);
		for (const specifier of specifiers) {
			const pkg = packages.find(
				(candidate) =>
					specifier === candidate.name ||
					specifier.startsWith(`${candidate.name}/`),
			);
			if (!pkg) continue;
			const exportKey = exportKeyForSpecifier(pkg.name, specifier);
			if (!pkg.exportKeys.has(exportKey)) {
				failures.push(
					`${file}:${lineNumber(source, specifier)} imports ${specifier}, but ${pkg.dir}/package.json does not export ${exportKey}`,
				);
			}
		}
	}

	if (failures.length > 0) {
		console.error("package export check failed:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}

	console.log(
		`package export check passed (${packages.length} packages, ${trackedSourceFiles.length} source files checked)`,
	);
}
