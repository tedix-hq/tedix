#!/usr/bin/env bun

/**
 * Package export-surface checks for Tedix public workspace packages.
 *
 * Verifies that declared `package.json#exports` targets exist and that imports
 * of the checked packages use exported subpaths instead of private source files.
 */

import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "./oss/git-env.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
	const result = spawnSync("git", ["ls-files"], {
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	if (result.status !== 0)
		throw new Error(result.stderr || "git ls-files failed");
	return result.stdout
		.split("\n")
		.filter(Boolean)
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

function importedSpecifiers(source: string): string[] {
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

const trackedSourceFiles = gitLsFiles().filter(isSourceTextFile);
for (const file of trackedSourceFiles) {
	if (IMPORT_SOURCE_FIXTURE_FILES.has(file)) continue;
	const source = readFileSync(file, "utf8");
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
