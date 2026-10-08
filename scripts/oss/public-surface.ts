#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detachedGitEnv } from "./git-env";

/**
 * Three decisions, not two. `private` exists so a workspace can be classified
 * as NEVER exported: before it, exclusion depended entirely on the handful of
 * path carve-outs in `public-files.json#privateExceptions`, so a workspace that
 * nobody had thought about was published by default. `defaults.decision` is now
 * pinned to `private` (enforced below), which makes the unclassified case fail
 * CLOSED — an unreviewed workspace is withheld, not shipped — while every
 * currently public workspace keeps its classification as an explicit override.
 */
const DECISIONS = ["private", "public-ecosystem", "public-product"] as const;
const REQUIRED_DEFAULT_DECISION = "private";
const LICENSE_CLASSES = [
	"agpl-product",
	"apache-ecosystem",
	"mit-ecosystem",
] as const;

type PublicDecision = (typeof DECISIONS)[number];
type LicenseClass = (typeof LICENSE_CLASSES)[number];

interface SurfaceClassification {
	decision: PublicDecision;
	licenseClass: LicenseClass;
}

export interface PublicSurfaceManifest {
	schemaVersion: 1;
	approvalStatus: "owner-approved-pending-counsel" | "ratified";
	authority: {
		productSource: "public-main";
		managedBuildInput: "public-commit-plus-private-configuration";
		privateOpsAllowsPersistentProductPatches: false;
		privateOpsAllowed: string[];
		privateOpsForbidden: string[];
		securityEmbargo: {
			maximumDays: number;
			requiresAuditedIssue: boolean;
			requiresNamedOwner: boolean;
			requiresExpiry: boolean;
			requiresPublicBackportOrDisclosure: boolean;
		};
	};
	defaults: SurfaceClassification;
	overrides: Array<SurfaceClassification & { path: string }>;
}

const DEPENDENCY_GROUPS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

interface PackageManifest {
	name?: string;
	license?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

export interface LocalDependency {
	group: (typeof DEPENDENCY_GROUPS)[number];
	name: string;
	specifier: string;
	targets: string[];
}

/** A tracked first-party package manifest outside any `vendor/` tree. */
export interface WorkspaceCandidate {
	declaredLicense: string | null;
	localDependencies: LocalDependency[];
	name: string | null;
	path: string;
}

// One `git cat-file --batch` call reads every requested blob; spawning one
// `git show` per manifest cost ~2.4 s per inventory pass.
export function readBlobs(
	repositoryRoot: string,
	commit: string,
	paths: string[],
): Map<string, string> {
	const result = spawnSync("git", ["cat-file", "--batch"], {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		input: paths.map((path) => `${commit}:${path}\n`).join(""),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr.toString("utf8").trim() || "git cat-file --batch failed",
		);
	}
	const stdout = result.stdout;
	const blobs = new Map<string, string>();
	let offset = 0;
	for (const path of paths) {
		const headerEnd = stdout.indexOf(0x0a, offset);
		if (headerEnd === -1) {
			throw new Error(`git cat-file --batch returned no entry for ${path}`);
		}
		const header = stdout.subarray(offset, headerEnd).toString("utf8");
		const [, type, sizeText] = header.split(" ");
		if (!type || type === "missing" || !sizeText) {
			throw new Error(`${commit}:${path} is not a readable object`);
		}
		const size = Number(sizeText);
		const contentStart = headerEnd + 1;
		blobs.set(
			path,
			stdout.subarray(contentStart, contentStart + size).toString("utf8"),
		);
		offset = contentStart + size + 1;
	}
	return blobs;
}

function isWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function vendoredRoot(path: string): string | null {
	const segments = path.split("/");
	const vendorIndex = segments.indexOf("vendor");
	if (vendorIndex === -1 || !segments[vendorIndex + 1]) return null;
	return segments.slice(0, vendorIndex + 2).join("/");
}

/**
 * Every first-party package project at `ref`: each tracked `package.json` except
 * the root and vendored copies, with its dependency edges to other candidates.
 */
export function discoverWorkspaceCandidates(
	repositoryRoot: string,
	ref = "HEAD",
): WorkspaceCandidate[] {
	const commit = git(repositoryRoot, [
		"rev-parse",
		"--verify",
		`${ref}^{commit}`,
	]).trim();
	const trackedFiles = git(repositoryRoot, [
		"ls-tree",
		"-r",
		"--name-only",
		commit,
	])
		.split("\n")
		.filter(Boolean);
	const allManifestPaths = trackedFiles.filter(
		(path) => path !== "package.json" && path.endsWith("/package.json"),
	);
	const manifests = new Map(
		[...readBlobs(repositoryRoot, commit, allManifestPaths)].map(
			([path, text]) => [path, JSON.parse(text) as PackageManifest],
		),
	);
	const vendoredRoots = [
		...new Set(trackedFiles.map(vendoredRoot).filter((path) => path !== null)),
	];
	const isVendored = (path: string) =>
		vendoredRoots.some((root) => isWithinRoot(path, root));
	const manifestPaths = allManifestPaths.filter((path) => !isVendored(path));
	const packagePathsByName = new Map<string, string[]>();
	for (const manifestPath of manifestPaths) {
		const name = manifests.get(manifestPath)?.name;
		if (!name) continue;
		packagePathsByName.set(name, [
			...(packagePathsByName.get(name) ?? []),
			manifestPath.slice(0, -"/package.json".length),
		]);
	}
	for (const paths of packagePathsByName.values()) paths.sort();
	const vendoredPackageNames = new Set(
		allManifestPaths.filter(isVendored).flatMap((path) => {
			const name = manifests.get(path)?.name;
			return name ? [name] : [];
		}),
	);
	return manifestPaths.sort().map((manifestPath): WorkspaceCandidate => {
		const manifest = manifests.get(manifestPath) ?? {};
		const localDependencies = DEPENDENCY_GROUPS.flatMap((group) =>
			Object.entries(manifest[group] ?? {}).flatMap(
				([name, specifier]): LocalDependency[] => {
					const targets = packagePathsByName.get(name) ?? [];
					if (
						targets.length === 0 &&
						(!specifier.startsWith("workspace:") ||
							vendoredPackageNames.has(name))
					) {
						return [];
					}
					return [{ group, name, specifier, targets }];
				},
			),
		).sort((left, right) =>
			`${left.group}:${left.name}`.localeCompare(
				`${right.group}:${right.name}`,
			),
		);
		return {
			declaredLicense: manifest.license ?? null,
			localDependencies,
			name: manifest.name ?? null,
			path: manifestPath.slice(0, -"/package.json".length),
		};
	});
}

function git(repositoryRoot: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

export interface ResolvedPublicWorkspace extends SurfaceClassification {
	declaredLicense: string | null;
	localDependencies: LocalDependency[];
	name: string | null;
	path: string;
}

export interface PublicSurfaceResult {
	errors: string[];
	warnings: string[];
	resolved: ResolvedPublicWorkspace[];
	summary: {
		agplProduct: number;
		apacheEcosystem: number;
		mitEcosystem: number;
		private: number;
		publicEcosystem: number;
		publicProduct: number;
		workspaces: number;
	};
}

/** Workspace roots the export may copy: everything not classified `private`. */
export function publicWorkspaceRoots(result: PublicSurfaceResult): string[] {
	return result.resolved
		.filter((entry) => entry.decision !== "private")
		.map((entry) => entry.path)
		.sort();
}

/** Workspace roots the export must withhold, including nested ones. */
export function privateWorkspaceRoots(result: PublicSurfaceResult): string[] {
	return result.resolved
		.filter((entry) => entry.decision === "private")
		.map((entry) => entry.path)
		.sort();
}

function isDecision(value: string): value is PublicDecision {
	return DECISIONS.includes(value as PublicDecision);
}

function isLicenseClass(value: string): value is LicenseClass {
	return LICENSE_CLASSES.includes(value as LicenseClass);
}

export function validatePublicSurface(
	manifest: PublicSurfaceManifest,
	candidates: WorkspaceCandidate[],
): PublicSurfaceResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const candidatePaths = candidates.map((candidate) => candidate.path).sort();
	const candidatePathSet = new Set(candidatePaths);
	if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schema");
	if (!isDecision(manifest.defaults.decision)) {
		errors.push(`invalid default decision: ${manifest.defaults.decision}`);
	} else if (manifest.defaults.decision !== REQUIRED_DEFAULT_DECISION) {
		// The default is what an UNCLASSIFIED workspace inherits. Anything other
		// than `private` publishes source nobody reviewed.
		errors.push(
			`default decision must be ${REQUIRED_DEFAULT_DECISION} so an unclassified workspace fails closed: ${manifest.defaults.decision}`,
		);
	}
	if (!isLicenseClass(manifest.defaults.licenseClass)) {
		errors.push(
			`invalid default license class: ${manifest.defaults.licenseClass}`,
		);
	}

	const overrides = new Map<string, SurfaceClassification>();
	for (const override of manifest.overrides) {
		if (!candidatePathSet.has(override.path)) {
			errors.push(`override references unknown workspace: ${override.path}`);
		}
		if (overrides.has(override.path)) {
			errors.push(`duplicate workspace override: ${override.path}`);
		}
		if (!isDecision(override.decision)) {
			errors.push(
				`invalid decision for ${override.path}: ${override.decision}`,
			);
		}
		if (!isLicenseClass(override.licenseClass)) {
			errors.push(
				`invalid license class for ${override.path}: ${override.licenseClass}`,
			);
		}
		overrides.set(override.path, override);
	}
	for (const path of candidatePaths) {
		if (!overrides.has(path)) {
			errors.push(`workspace requires explicit classification: ${path}`);
		}
	}

	const resolved = candidates
		.map((candidate): ResolvedPublicWorkspace => ({
			...(overrides.get(candidate.path) ?? manifest.defaults),
			declaredLicense: candidate.declaredLicense,
			localDependencies: candidate.localDependencies,
			name: candidate.name,
			path: candidate.path,
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	const resolvedByPath = new Map(resolved.map((entry) => [entry.path, entry]));
	for (const entry of resolved) {
		for (const dependency of entry.localDependencies) {
			for (const target of dependency.targets) {
				const targetEntry = resolvedByPath.get(target);
				if (!targetEntry) {
					errors.push(
						`${entry.path} depends on unclassified local workspace ${target}`,
					);
				} else if (
					entry.decision !== "private" &&
					targetEntry.decision === "private"
				) {
					// A published workspace whose manifest names a withheld one
					// exports a lockfile that cannot install.
					errors.push(
						`${entry.path} (${entry.decision}) has ${dependency.group} edge to private workspace ${target}; a published workspace may not depend on a withheld one`,
					);
				} else if (
					entry.decision === "public-ecosystem" &&
					dependency.group !== "devDependencies" &&
					targetEntry.licenseClass === "agpl-product"
				) {
					errors.push(
						`${entry.path} (${entry.licenseClass}) has ${dependency.group} edge to AGPL product workspace ${target}; permissive ecosystem packages must not require AGPL product code`,
					);
				}
			}
		}
	}

	const authority = manifest.authority;
	if (authority.productSource !== "public-main") {
		errors.push("product source authority must be public-main");
	}
	if (authority.privateOpsAllowsPersistentProductPatches !== false) {
		errors.push("private operations must forbid persistent product patches");
	}
	for (const required of [
		"product-source",
		"persistent-product-patches",
		"tenant-schema-or-migrations",
		"public-contract-implementations",
		"undisclosed-managed-product-fork",
	]) {
		if (!authority.privateOpsForbidden.includes(required)) {
			errors.push(`private operations missing forbidden class: ${required}`);
		}
	}
	if (
		authority.securityEmbargo.maximumDays > 30 ||
		!authority.securityEmbargo.requiresAuditedIssue ||
		!authority.securityEmbargo.requiresNamedOwner ||
		!authority.securityEmbargo.requiresExpiry ||
		!authority.securityEmbargo.requiresPublicBackportOrDisclosure
	) {
		errors.push(
			"security embargo must be bounded, owned, audited, and settled",
		);
	}
	if (manifest.approvalStatus !== "ratified") {
		warnings.push(
			"license classes are owner-approved but still require counsel",
		);
	}

	return {
		errors: errors.sort(),
		warnings,
		resolved,
		summary: {
			agplProduct: resolved.filter(
				(entry) => entry.licenseClass === "agpl-product",
			).length,
			apacheEcosystem: resolved.filter(
				(entry) => entry.licenseClass === "apache-ecosystem",
			).length,
			mitEcosystem: resolved.filter(
				(entry) => entry.licenseClass === "mit-ecosystem",
			).length,
			private: resolved.filter((entry) => entry.decision === "private").length,
			publicEcosystem: resolved.filter(
				(entry) => entry.decision === "public-ecosystem",
			).length,
			publicProduct: resolved.filter(
				(entry) => entry.decision === "public-product",
			).length,
			workspaces: resolved.length,
		},
	};
}

function gitShow(repositoryRoot: string, ref: string, path: string): string {
	const result = spawnSync("git", ["show", `${ref}:${path}`], {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `cannot read ${path} at ${ref}`);
	}
	return result.stdout;
}

export function checkPublicSurface(
	repositoryRoot: string,
	ref = "HEAD",
	manifestFromWorkingTree = true,
): PublicSurfaceResult {
	const manifestPath = "scripts/oss/public-surface.json";
	const manifest = JSON.parse(
		manifestFromWorkingTree
			? readFileSync(resolve(repositoryRoot, manifestPath), "utf8")
			: gitShow(repositoryRoot, ref, manifestPath),
	) as PublicSurfaceManifest;
	return validatePublicSurface(
		manifest,
		discoverWorkspaceCandidates(repositoryRoot, ref),
	);
}

const SPDX_BY_CLASS: Record<LicenseClass, string> = {
	"agpl-product": "AGPL-3.0-only",
	"apache-ecosystem": "Apache-2.0",
	"mit-ecosystem": "MIT",
};

/**
 * License metadata agrees with the classification: the root manifest declares
 * AGPL-3.0-only and every workspace manifest declares its class's SPDX id.
 */
export function licenseMetadataErrors(
	repositoryRoot: string,
	result: PublicSurfaceResult,
): string[] {
	const root = JSON.parse(
		readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
	) as { license?: string };
	const errors =
		root.license === "AGPL-3.0-only"
			? []
			: ["root package.json must declare AGPL-3.0-only"];
	for (const workspace of result.resolved) {
		const spdx = SPDX_BY_CLASS[workspace.licenseClass];
		if (workspace.declaredLicense !== spdx) {
			errors.push(
				`${workspace.path} declares ${workspace.declaredLicense ?? "no license"}; its class requires ${spdx}`,
			);
		}
	}
	return errors;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const refIndex = args.indexOf("--ref");
	const ref = refIndex === -1 ? "HEAD" : args[refIndex + 1];
	if (!ref) throw new Error("--ref requires a Git ref");
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	const result = checkPublicSurface(
		repositoryRoot,
		ref,
		!args.includes("--manifest-from-ref"),
	);
	result.errors.push(...licenseMetadataErrors(repositoryRoot, result));
	console.log(
		JSON.stringify(
			{
				errors: result.errors,
				summary: result.summary,
				warnings: result.warnings,
			},
			null,
			2,
		),
	);
	if (result.errors.length > 0) process.exit(1);
}
