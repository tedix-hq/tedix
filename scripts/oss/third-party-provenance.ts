#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { detachedGitEnv } from "./git-env";

export interface ProvenanceCoverage {
	exactPaths?: string[];
	prefixes?: string[];
}

export interface ProvenanceEntry {
	id: string;
	sourceKind: string;
	reviewStatus: "blocked" | "needs-review" | "verified";
	coverage: ProvenanceCoverage;
	upstream: {
		repository: string | null;
		revision: string | null;
		integrity?: string;
		version?: string;
	};
	license: {
		spdx: string;
		textPath: string;
	} | null;
	artifacts?: Array<{ path: string; sha256: string }>;
	notice: string | null;
	blocker?: string;
}

export interface ProvenanceRegistry {
	schemaVersion: 1;
	entries: ProvenanceEntry[];
}

export interface ProvenanceResult {
	errors: string[];
	notice: string;
	summary: {
		blocked: number;
		entries: number;
		needsReview: number;
		verified: number;
	};
}

interface SourceTree {
	files: string[];
	readBuffer(path: string): Buffer;
	readText(path: string): string;
}

function git(
	repositoryRoot: string,
	args: string[],
	encoding: "buffer" | "utf8" = "utf8",
): Buffer | string {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		encoding: encoding === "utf8" ? "utf8" : undefined,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const stderr = Buffer.isBuffer(result.stderr)
			? result.stderr.toString("utf8")
			: result.stderr;
		throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

function sourceTree(repositoryRoot: string, requestedRef?: string): SourceTree {
	if (requestedRef) {
		const commit = String(
			git(repositoryRoot, [
				"rev-parse",
				"--verify",
				`${requestedRef}^{commit}`,
			]),
		).trim();
		const files = String(
			git(repositoryRoot, ["ls-tree", "-r", "--name-only", commit]),
		)
			.split("\n")
			.filter(Boolean)
			.sort();
		return {
			files,
			readBuffer: (path) =>
				git(repositoryRoot, ["show", `${commit}:${path}`], "buffer") as Buffer,
			readText: (path) =>
				String(git(repositoryRoot, ["show", `${commit}:${path}`])),
		};
	}

	const files = String(
		git(repositoryRoot, [
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
		]),
	)
		.split("\n")
		.filter(Boolean)
		.sort();
	return {
		files,
		readBuffer: (path) => {
			const absolute = resolve(repositoryRoot, path);
			return lstatSync(absolute).isSymbolicLink()
				? Buffer.from(readlinkSync(absolute))
				: readFileSync(absolute);
		},
		readText: (path) => readFileSync(resolve(repositoryRoot, path), "utf8"),
	};
}

function covers(entry: ProvenanceEntry, path: string): boolean {
	if (entry.coverage.exactPaths?.includes(path)) return true;
	return Boolean(
		entry.coverage.prefixes?.some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`),
		),
	);
}

function vendoredRoots(files: string[]): string[] {
	return [
		...new Set(
			files.flatMap((path) => {
				const segments = path.split("/");
				const index = segments.indexOf("vendor");
				return index === -1 || !segments[index + 1]
					? []
					: [segments.slice(0, index + 2).join("/")];
			}),
		),
	].sort();
}

export function renderThirdPartyNotices(registry: ProvenanceRegistry): string {
	const verified = registry.entries
		.filter((entry) => entry.reviewStatus === "verified")
		.sort((left, right) => left.id.localeCompare(right.id));
	const pending = registry.entries
		.filter((entry) => entry.reviewStatus !== "verified")
		.sort((left, right) => left.id.localeCompare(right.id));
	const lines = [
		"# Third-Party Notices",
		"",
		"This repository includes the third-party code listed below. This file is",
		"generated from `scripts/oss/third-party-sources.json`.",
		"",
	];
	for (const entry of verified) {
		lines.push(`## ${entry.id}`, "", entry.notice ?? "", "");
		if (entry.license) {
			lines.push(
				`License: ${entry.license.spdx} (` + `\`${entry.license.textPath}\`)`,
				"",
			);
		}
	}
	if (pending.length > 0) lines.push("## Pending review", "");
	for (const entry of pending) {
		lines.push(
			`- **${entry.id}:** ${entry.blocker ?? "Provenance review is incomplete."}`,
		);
	}
	if (pending.length > 0) lines.push("");
	return lines.join("\n");
}

export function validateProvenance(
	registry: ProvenanceRegistry,
	tree: SourceTree,
): ProvenanceResult {
	const errors: string[] = [];
	const ids = new Set<string>();
	const fileSet = new Set(tree.files);

	if (registry.schemaVersion !== 1) errors.push("unsupported registry schema");
	for (const entry of registry.entries) {
		if (ids.has(entry.id)) errors.push(`duplicate entry id: ${entry.id}`);
		ids.add(entry.id);
		const matchedFiles = tree.files.filter((path) => covers(entry, path));
		if (matchedFiles.length === 0) {
			errors.push(`${entry.id}: coverage matches no source files`);
		}
		if (entry.reviewStatus === "verified") {
			if (!entry.upstream.repository)
				errors.push(`${entry.id}: verified entry needs an upstream repository`);
			if (!entry.upstream.revision)
				errors.push(`${entry.id}: verified entry needs an upstream revision`);
			if (!entry.license)
				errors.push(`${entry.id}: verified entry needs license evidence`);
			if (!entry.notice)
				errors.push(`${entry.id}: verified entry needs NOTICE text`);
		}
		if (entry.license && !fileSet.has(entry.license.textPath)) {
			errors.push(
				`${entry.id}: missing license text ${entry.license.textPath}`,
			);
		}
		for (const artifact of entry.artifacts ?? []) {
			if (!fileSet.has(artifact.path)) {
				errors.push(`${entry.id}: missing artifact ${artifact.path}`);
				continue;
			}
			const actual = createHash("sha256")
				.update(tree.readBuffer(artifact.path))
				.digest("hex");
			if (actual !== artifact.sha256) {
				errors.push(
					`${entry.id}: ${artifact.path} SHA-256 ${actual} != ${artifact.sha256}`,
				);
			}
		}
	}

	for (const path of [
		...vendoredRoots(tree.files),
		...tree.files.filter(
			(file) =>
				file.startsWith("patches/") || /\/patches\/.*\.patch$/.test(file),
		),
	]) {
		const isPatch = /(^|\/)patches\/.*\.patch$/.test(path);
		if (
			!registry.entries.some((entry) =>
				isPatch
					? entry.sourceKind === "dependency-patch" &&
						entry.coverage.exactPaths?.includes(path)
					: covers(entry, path),
			)
		) {
			errors.push(`unregistered third-party source: ${path}`);
		}
	}

	return {
		errors: errors.sort(),
		notice: renderThirdPartyNotices(registry),
		summary: {
			blocked: registry.entries.filter(
				(entry) => entry.reviewStatus === "blocked",
			).length,
			entries: registry.entries.length,
			needsReview: registry.entries.filter(
				(entry) => entry.reviewStatus === "needs-review",
			).length,
			verified: registry.entries.filter(
				(entry) => entry.reviewStatus === "verified",
			).length,
		},
	};
}

export function checkRepositoryProvenance(
	repositoryRoot: string,
	options: { ref?: string; strict?: boolean } = {},
): ProvenanceResult {
	const tree = sourceTree(repositoryRoot, options.ref);
	const registryPath = "scripts/oss/third-party-sources.json";
	if (!tree.files.includes(registryPath)) {
		throw new Error(`${registryPath} is not present in the selected source`);
	}
	const registry = JSON.parse(
		tree.readText(registryPath),
	) as ProvenanceRegistry;
	const result = validateProvenance(registry, tree);
	const noticesPath = "THIRD_PARTY_NOTICES.md";
	if (!tree.files.includes(noticesPath)) {
		result.errors.push(`${noticesPath} is missing`);
	} else if (tree.readText(noticesPath) !== result.notice) {
		result.errors.push(
			`${noticesPath} does not match scripts/oss/third-party-sources.json`,
		);
	}
	if (
		options.strict &&
		result.summary.blocked + result.summary.needsReview > 0
	) {
		result.errors.push(
			"strict provenance validation requires every entry to be verified",
		);
	}
	return result;
}

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	const result = checkRepositoryProvenance(repositoryRoot, {
		ref: optionValue(args, "--ref"),
		strict: args.includes("--strict"),
	});
	console.log(
		JSON.stringify({ errors: result.errors, summary: result.summary }, null, 2),
	);
	if (result.errors.length > 0) process.exit(1);
}
