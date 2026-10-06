#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
	type DependencyLicenseRegistry,
	generateDependencyLicenseMetadata,
} from "./dependency-license-metadata";
import { checkPublicSurface } from "./public-surface";
import {
	checkRepositoryProvenance,
	type ProvenanceEntry,
	type ProvenanceRegistry,
} from "./third-party-provenance";
import { detachedGitEnv } from "./git-env";

/** Exact-commit blob bytes for selected paths, read in batches of 100. */
export function readCommitBlobs(
	repositoryRoot: string,
	commit: string,
	paths: string[],
	selectedPaths: ReadonlySet<string>,
): Map<string, Buffer> {
	if (!/^[0-9a-f]{40}$/.test(commit))
		throw new Error("Expected exact commit SHA");
	for (const path of paths) {
		if (!selectedPaths.has(path) || /[\r\n\0]/.test(path)) {
			throw new Error(`Path not selected for batch read: ${path}`);
		}
	}
	const contents = new Map<string, Buffer>();
	for (let start = 0; start < paths.length; start += 100) {
		const batch = paths.slice(start, start + 100);
		const result = spawnSync("git", ["cat-file", "--batch"], {
			cwd: repositoryRoot,
			env: detachedGitEnv(),
			input: batch.map((path) => `${commit}:${path}\n`).join(""),
			maxBuffer: 128 * 1024 * 1024,
		});
		if (result.status !== 0) throw new Error("Git blob batch failed");
		let offset = 0;
		for (const path of batch) {
			const end = result.stdout.indexOf(10, offset);
			if (end < 0) throw new Error("Truncated Git blob header");
			const header = result.stdout.subarray(offset, end).toString("utf8");
			const match = /^[0-9a-f]{40} blob ([0-9]+)$/.exec(header);
			if (!match) throw new Error(`Missing or non-blob object: ${path}`);
			const size = Number(match[1]);
			offset = end + 1;
			if (
				!Number.isSafeInteger(size) ||
				size > result.stdout.length - offset - 1 ||
				result.stdout[offset + size] !== 10
			) {
				throw new Error(`Truncated Git blob: ${path}`);
			}
			contents.set(
				path,
				Buffer.from(result.stdout.subarray(offset, offset + size)),
			);
			offset += size + 1;
		}
		if (offset !== result.stdout.length)
			throw new Error("Unexpected trailing Git batch data");
	}
	return contents;
}

export const RELEASE_EVIDENCE_GENERATOR_VERSION = "2";

const ARTIFACT_NAMES = [
	"license-inventory.json",
	"migration-metadata.json",
	"provenance.json",
	"source.cdx.json",
] as const;

const INTENDED_LICENSES = {
	"agpl-product": "AGPL-3.0-only",
	"apache-ecosystem": "Apache-2.0",
	"mit-ecosystem": "MIT",
} as const;

interface SourceInput {
	kind: "lockfile" | "manifest" | "registry";
	path: string;
	sha256: string;
}

interface ComponentProperty {
	name: string;
	value: string;
}

interface ComponentHash {
	alg: "SHA-256" | "SHA-512";
	content: string;
}

interface CycloneComponent {
	"bom-ref": string;
	type: "application" | "container" | "library";
	name: string;
	version?: string;
	purl?: string;
	hashes?: ComponentHash[];
	licenses?: Array<{ license: { id?: string; name?: string } }>;
	properties: ComponentProperty[];
}

interface LockedPackage {
	component: CycloneComponent;
	ecosystem: "npm";
	license: string;
	licenseEvidence: string;
	locator: string;
}

interface RequirementPackage {
	component: CycloneComponent;
	ecosystem: "pypi";
	license: string;
	licenseEvidence: string;
	locator: string;
}

interface ContainerPackage {
	component: CycloneComponent;
	ecosystem: "container";
	license: string;
	licenseEvidence: string;
	locator: string;
}

interface PackageManifest {
	name?: string;
	version?: string;
}

interface BunLock {
	packages?: Record<string, unknown>;
}

interface NonNpmLicenseRegistry {
	schemaVersion: 1;
	entries: Array<{
		artifactSha256: string;
		ecosystem: "container" | "pypi";
		evidence: string;
		license: string;
		locator: string;
		sourcePaths: string[];
	}>;
}

interface GeneratedEvidence {
	artifacts: string[];
	commit: string;
	outputDirectory: string;
}

class CommitSource {
	readonly commit: string;
	readonly files: string[];
	readonly trackedFiles: string[];

	constructor(
		private readonly repositoryRoot: string,
		requestedRef: string,
		selectedFiles?: string[],
	) {
		this.commit = this.gitText([
			"rev-parse",
			"--verify",
			`${requestedRef}^{commit}`,
		]).trim();
		const trackedFiles = this.gitText([
			"ls-tree",
			"-r",
			"--name-only",
			this.commit,
		])
			.split("\n")
			.filter(Boolean)
			.sort();
		this.trackedFiles = trackedFiles;
		if (selectedFiles) {
			const tracked = new Set(trackedFiles);
			for (const path of selectedFiles) {
				if (!tracked.has(path))
					throw new Error(`${path} is not tracked at ${this.commit}`);
			}
			this.files = [...selectedFiles].sort();
		} else {
			this.files = trackedFiles;
		}
	}

	readBuffer(path: string): Buffer {
		if (!this.files.includes(path)) {
			throw new Error(`${path} is not tracked at ${this.commit}`);
		}
		return this.git(["show", `${this.commit}:${path}`]);
	}

	readText(path: string): string {
		return this.readBuffer(path).toString("utf8");
	}

	readBuffers(paths: string[]): Map<string, Buffer> {
		return readCommitBlobs(
			this.repositoryRoot,
			this.commit,
			paths,
			new Set(this.files),
		);
	}

	/**
	 * Batched counterpart to readText, for the loops that read one file per
	 * iteration. Each of those cost a `git show` subprocess, which is what put
	 * the release-evidence test over its deadline.
	 */
	readTexts(paths: string[]): Map<string, string> {
		const buffers = this.readBuffers(paths);
		const texts = new Map<string, string>();
		for (const [path, contents] of buffers) {
			texts.set(path, contents.toString("utf8"));
		}
		return texts;
	}

	commitEpoch(): number {
		const value = this.gitText([
			"show",
			"-s",
			"--format=%ct",
			this.commit,
		]).trim();
		return parseEpoch(value, "commit timestamp");
	}

	private gitText(args: string[]): string {
		return this.git(args).toString("utf8");
	}

	private git(args: string[]): Buffer {
		const result = spawnSync("git", args, {
			cwd: this.repositoryRoot,
			env: detachedGitEnv(),
			maxBuffer: 128 * 1024 * 1024,
		});
		if (result.status !== 0) {
			throw new Error(
				result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`,
			);
		}
		return result.stdout;
	}
}

function parseEpoch(value: string, source: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${source} must be Unix seconds`);
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch)) {
		throw new Error(`${source} is outside the supported range`);
	}
	return epoch;
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonc<T>(content: string, path: string): T {
	const errors: ParseError[] = [];
	const value = parse(content, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	}) as T;
	if (errors.length > 0) {
		throw new Error(`${path} is not valid JSONC (error ${errors[0]?.error})`);
	}
	return value;
}

function properties(
	values: Array<[string, string | null | undefined]>,
): ComponentProperty[] {
	return values
		.filter((entry): entry is [string, string] => entry[1] != null)
		.map(([name, value]) => ({ name, value }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

function licenseDeclaration(value: string) {
	return value === "NOASSERTION"
		? [{ license: { name: value } }]
		: [{ license: { id: value } }];
}

function splitNpmLocator(locator: string): {
	name: string;
	resolution: string;
	version?: string;
} {
	const separator = locator.startsWith("@")
		? locator.indexOf("@", 1)
		: locator.indexOf("@");
	if (separator < 1) throw new Error(`invalid Bun package locator: ${locator}`);
	const name = locator.slice(0, separator);
	const resolution = locator.slice(separator + 1);
	if (resolution.startsWith("npm:")) {
		return splitNpmLocator(resolution.slice("npm:".length));
	}
	return {
		name,
		resolution,
		version: /^\d/.test(resolution) ? resolution : undefined,
	};
}

function npmPurl(
	name: string,
	version: string | undefined,
): string | undefined {
	if (!version) return undefined;
	if (name.startsWith("@")) {
		const [scope, packageName] = name.slice(1).split("/");
		if (!scope || !packageName) return undefined;
		return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
	}
	return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function integrityHash(
	integrity: string | undefined,
): ComponentHash | undefined {
	if (!integrity?.startsWith("sha512-")) return undefined;
	return {
		alg: "SHA-512",
		content: Buffer.from(integrity.slice("sha512-".length), "base64").toString(
			"hex",
		),
	};
}

function thirdPartyLicenseForPackage(
	name: string,
	version: string | undefined,
	locator: string,
	entries: ProvenanceEntry[],
): { evidence: string; license: string; sha256?: string } | undefined {
	for (const entry of [...entries].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		if (!entry.license) continue;
		if (version && entry.upstream.revision === `npm:${name}@${version}`) {
			return { evidence: entry.id, license: entry.license.spdx };
		}
		const artifact = entry.artifacts?.find((candidate) =>
			locator.includes(basename(candidate.path)),
		);
		if (artifact) {
			return {
				evidence: entry.id,
				license: entry.license.spdx,
				sha256: artifact.sha256,
			};
		}
	}
	return undefined;
}

function installedLicenseForPackage(
	name: string,
	version: string | undefined,
	registry: DependencyLicenseRegistry,
): { evidence: string; license: string; sha256?: string } | undefined {
	if (!version) return undefined;
	const entry = registry.entries.find(
		(candidate) => candidate.name === name && candidate.version === version,
	);
	if (!entry || entry.license === "NOASSERTION") return undefined;
	return {
		evidence: `${entry.evidence}:sha256:${entry.metadataSha256}`,
		license: entry.license,
	};
}

function nonNpmLicenseForPackage(
	ecosystem: "container" | "pypi",
	locator: string,
	registry: NonNpmLicenseRegistry,
): NonNpmLicenseRegistry["entries"][number] | undefined {
	return registry.entries.find(
		(entry) => entry.ecosystem === ecosystem && entry.locator === locator,
	);
}

function validateNonNpmLicenseRegistry(
	registry: NonNpmLicenseRegistry,
	trackedFiles: string[],
): void {
	if (registry.schemaVersion !== 1) {
		throw new Error("non-npm license metadata has an unsupported schema");
	}
	const keys = new Set<string>();
	for (const entry of registry.entries) {
		const key = `${entry.ecosystem}:${entry.locator}`;
		if (keys.has(key))
			throw new Error(`duplicate non-npm license entry: ${key}`);
		keys.add(key);
		if (entry.license === "NOASSERTION") {
			throw new Error(
				`non-npm license entry cannot assert NOASSERTION: ${key}`,
			);
		}
		if (!/^[a-f0-9]{64}$/.test(entry.artifactSha256)) {
			throw new Error(`non-npm license entry has an invalid SHA-256: ${key}`);
		}
		if (!entry.evidence.startsWith("https://")) {
			throw new Error(`non-npm license evidence must use HTTPS: ${key}`);
		}
		if (
			entry.sourcePaths.length === 0 ||
			new Set(entry.sourcePaths).size !== entry.sourcePaths.length ||
			!entry.sourcePaths.every((path, index) =>
				index === 0 ? true : path > (entry.sourcePaths[index - 1] ?? ""),
			)
		) {
			throw new Error(
				`non-npm license source paths must be non-empty, unique, and sorted: ${key}`,
			);
		}
		for (const path of entry.sourcePaths) {
			if (!trackedFiles.includes(path)) {
				throw new Error(
					`non-npm license source path is not tracked: ${key}:${path}`,
				);
			}
		}
	}
}

function lockedPackages(
	tree: CommitSource,
	lockfiles: string[],
	registry: ProvenanceRegistry,
	dependencyLicenses: DependencyLicenseRegistry,
): LockedPackage[] {
	const packages: LockedPackage[] = [];
	for (const lockfile of lockfiles) {
		const lock = parseJsonc<BunLock>(tree.readText(lockfile), lockfile);
		for (const [lockKey, rawValue] of Object.entries(lock.packages ?? {}).sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			if (!Array.isArray(rawValue) || typeof rawValue[0] !== "string") {
				throw new Error(
					`${lockfile} has an invalid package entry for ${lockKey}`,
				);
			}
			const locator = rawValue[0];
			if (locator.includes("@workspace:")) continue;
			const integrity = rawValue.find(
				(value): value is string =>
					typeof value === "string" && value.startsWith("sha512-"),
			);
			const { name, resolution, version } = splitNpmLocator(locator);
			const knownLicense =
				thirdPartyLicenseForPackage(name, version, locator, registry.entries) ??
				installedLicenseForPackage(name, version, dependencyLicenses);
			const hashes = [
				integrityHash(integrity),
				knownLicense?.sha256
					? ({ alg: "SHA-256", content: knownLicense.sha256 } as const)
					: undefined,
			]
				.filter((hash): hash is ComponentHash => hash != null)
				.sort((left, right) => left.alg.localeCompare(right.alg));
			const license = knownLicense?.license ?? "NOASSERTION";
			packages.push({
				component: {
					"bom-ref": `npm:${lockfile}:${lockKey}`,
					type: "library",
					name,
					...(version ? { version } : {}),
					...(npmPurl(name, version) ? { purl: npmPurl(name, version) } : {}),
					...(hashes.length > 0 ? { hashes } : {}),
					licenses: licenseDeclaration(license),
					properties: properties([
						["tedix:component-kind", "locked-npm"],
						["tedix:bun-integrity", integrity],
						["tedix:bun-lock-key", lockKey],
						["tedix:bun-locator", locator],
						["tedix:bun-resolution", resolution],
						["tedix:license-evidence", knownLicense?.evidence],
						["tedix:lockfile", lockfile],
					]),
				},
				ecosystem: "npm",
				license,
				licenseEvidence:
					knownLicense?.evidence ??
					"NOASSERTION: dependency license is absent from selected-ref source metadata",
				locator,
			});
		}
	}
	return packages.sort((left, right) =>
		left.component["bom-ref"].localeCompare(right.component["bom-ref"]),
	);
}

function pythonRequirements(
	tree: CommitSource,
	requirementFiles: string[],
	registry: NonNpmLicenseRegistry,
): RequirementPackage[] {
	const packages: RequirementPackage[] = [];
	const requirementTexts = tree.readTexts(requirementFiles);
	for (const path of requirementFiles) {
		const requirementText = requirementTexts.get(path);
		if (requirementText === undefined)
			throw new Error(`Missing batch read for ${path}`);
		for (const [index, rawLine] of requirementText.split("\n").entries()) {
			const requirement = rawLine.replace(/\s+#.*$/, "").trim();
			if (!requirement || requirement.startsWith("#")) continue;
			const match = requirement.match(
				/^([A-Za-z0-9._-]+)(\[[^\]]+\])?\s*(.*)$/,
			);
			if (!match?.[1]) {
				throw new Error(`${path}:${index + 1} has an unsupported requirement`);
			}
			const name = match[1];
			const extras = match[2];
			const constraint = match[3]?.trim();
			const exactVersion = constraint?.match(/^==\s*([^,;\s]+)/)?.[1];
			const knownLicense = nonNpmLicenseForPackage(
				"pypi",
				requirement,
				registry,
			);
			const license = knownLicense?.license ?? "NOASSERTION";
			packages.push({
				component: {
					"bom-ref": `pypi:${path}:${index + 1}`,
					type: "library",
					name,
					...(exactVersion ? { version: exactVersion } : {}),
					...(exactVersion
						? {
								purl: `pkg:pypi/${encodeURIComponent(name.toLowerCase())}@${encodeURIComponent(exactVersion)}`,
							}
						: {}),
					...(knownLicense
						? {
								hashes: [
									{
										alg: "SHA-256" as const,
										content: knownLicense.artifactSha256,
									},
								],
							}
						: {}),
					licenses: licenseDeclaration(license),
					properties: properties([
						["tedix:component-kind", "python-requirement"],
						["tedix:requirement", requirement],
						["tedix:requirement-constraint", constraint],
						["tedix:requirement-extras", extras],
						["tedix:license-evidence", knownLicense?.evidence],
						["tedix:source-path", path],
					]),
				},
				ecosystem: "pypi",
				license,
				licenseEvidence:
					knownLicense?.evidence ??
					"NOASSERTION: exact requirement has no tracked license metadata",
				locator: requirement,
			});
		}
	}
	return packages.sort((left, right) =>
		left.component["bom-ref"].localeCompare(right.component["bom-ref"]),
	);
}

function splitContainerImage(image: string): {
	name: string;
	version?: string;
} {
	const digestIndex = image.indexOf("@");
	if (digestIndex > 0) {
		const taggedName = image.slice(0, digestIndex);
		const digest = image.slice(digestIndex + 1);
		const slashIndex = taggedName.lastIndexOf("/");
		const colonIndex = taggedName.lastIndexOf(":");
		if (colonIndex > slashIndex) {
			return {
				name: taggedName.slice(0, colonIndex),
				version: `${taggedName.slice(colonIndex + 1)}@${digest}`,
			};
		}
		return {
			name: taggedName,
			version: digest,
		};
	}
	const slashIndex = image.lastIndexOf("/");
	const colonIndex = image.lastIndexOf(":");
	if (colonIndex > slashIndex) {
		return {
			name: image.slice(0, colonIndex),
			version: image.slice(colonIndex + 1),
		};
	}
	return { name: image };
}

function resolveContainerArguments(content: string): Map<number, string> {
	const argumentsByName = new Map<string, string>();
	const resolvedByLine = new Map<number, string>();
	for (const [index, line] of content.split("\n").entries()) {
		const argument = line.match(
			/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/i,
		);
		if (argument?.[1] && argument[2]) {
			argumentsByName.set(argument[1], argument[2]);
		}
		if (!/^\s*FROM\s+/i.test(line)) continue;
		const tokens = line.trim().split(/\s+/).slice(1);
		while (tokens[0]?.startsWith("--")) tokens.shift();
		const locator = tokens[0];
		if (!locator) continue;
		resolvedByLine.set(
			index,
			locator.replace(
				/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
				(match, braced: string | undefined, bare: string | undefined) =>
					argumentsByName.get(braced ?? bare ?? "") ?? match,
			),
		);
	}
	return resolvedByLine;
}

function containerImages(
	tree: CommitSource,
	dockerfiles: string[],
	registry: NonNpmLicenseRegistry,
): ContainerPackage[] {
	const packages: ContainerPackage[] = [];
	const dockerfileTexts = tree.readTexts(dockerfiles);
	for (const path of dockerfiles) {
		const content = dockerfileTexts.get(path);
		if (content === undefined)
			throw new Error(`Missing batch read for ${path}`);
		const resolvedByLine = resolveContainerArguments(content);
		for (const [index, line] of content.split("\n").entries()) {
			if (!/^\s*FROM\s+/i.test(line)) continue;
			const tokens = line.trim().split(/\s+/).slice(1);
			while (tokens[0]?.startsWith("--")) tokens.shift();
			const sourceLocator = tokens[0];
			if (!sourceLocator)
				throw new Error(`${path}:${index + 1} has no base image`);
			const locator = resolvedByLine.get(index) ?? sourceLocator;
			const { name, version } = splitContainerImage(locator);
			const knownLicense = nonNpmLicenseForPackage(
				"container",
				locator,
				registry,
			);
			const license = knownLicense?.license ?? "NOASSERTION";
			packages.push({
				component: {
					"bom-ref": `container:${path}:${index + 1}`,
					type: "container",
					name,
					...(version ? { version } : {}),
					...(knownLicense
						? {
								hashes: [
									{
										alg: "SHA-256" as const,
										content: knownLicense.artifactSha256,
									},
								],
							}
						: {}),
					licenses: licenseDeclaration(license),
					properties: properties([
						["tedix:component-kind", "container-base-image"],
						["tedix:container-locator", locator],
						["tedix:container-source-locator", sourceLocator],
						["tedix:license-evidence", knownLicense?.evidence],
						["tedix:source-path", path],
					]),
				},
				ecosystem: "container",
				license,
				licenseEvidence:
					knownLicense?.evidence ??
					"NOASSERTION: exact base image has no tracked license metadata",
				locator,
			});
		}
	}
	return packages.sort((left, right) =>
		left.component["bom-ref"].localeCompare(right.component["bom-ref"]),
	);
}

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

export function generateReleaseEvidence(
	repositoryRoot: string,
	options: {
		/** From generateDependencyLicenseMetadata for the same ref. */
		dependencyLicenses: DependencyLicenseRegistry;
		out: string;
		ref?: string;
		selectedFiles?: string[];
		sourceDateEpoch?: string;
		sourceScope?: string;
	},
): GeneratedEvidence {
	const requestedRef = options.ref ?? "HEAD";
	const tree = new CommitSource(
		repositoryRoot,
		requestedRef,
		options.selectedFiles,
	);
	const publicSurface = checkPublicSurface(repositoryRoot, tree.commit, false);
	if (publicSurface.errors.length > 0) {
		throw new Error(
			`public surface validation failed:\n${publicSurface.errors.join("\n")}`,
		);
	}
	const thirdPartyValidation = checkRepositoryProvenance(repositoryRoot, {
		ref: tree.commit,
	});
	if (thirdPartyValidation.errors.length > 0) {
		throw new Error(
			`third-party provenance validation failed:\n${thirdPartyValidation.errors.join("\n")}`,
		);
	}

	const publicSurfacePath = "scripts/oss/public-surface.json";
	const thirdPartyPath = "scripts/oss/third-party-sources.json";
	const nonNpmLicensePath = "scripts/oss/non-npm-license-metadata.json";
	const registry = JSON.parse(
		tree.readText(thirdPartyPath),
	) as ProvenanceRegistry;
	const { dependencyLicenses } = options;
	const nonNpmLicenses = JSON.parse(
		tree.readText(nonNpmLicensePath),
	) as NonNpmLicenseRegistry;
	validateNonNpmLicenseRegistry(nonNpmLicenses, tree.trackedFiles);
	const selectedNonNpmLicenses: NonNpmLicenseRegistry = {
		schemaVersion: 1,
		entries: nonNpmLicenses.entries.filter((entry) =>
			entry.sourcePaths.some((path) => tree.files.includes(path)),
		),
	};
	const lockfiles = tree.files
		.filter((path) => path === "bun.lock" || path.endsWith("/bun.lock"))
		.sort();
	const requirementFiles = tree.files
		.filter((path) => path.endsWith("/requirements.txt"))
		.sort();
	const dockerfiles = tree.files
		.filter((path) => /^Dockerfile(?:\..+)?$/.test(basename(path)))
		.sort();
	const migrations = tree.files
		.filter((path) => path.startsWith("packages/db/") && path.endsWith(".sql"))
		.sort();
	if (!lockfiles.includes("bun.lock")) {
		throw new Error("bun.lock is not tracked at the selected commit");
	}

	const epoch = options.sourceDateEpoch
		? parseEpoch(options.sourceDateEpoch, "SOURCE_DATE_EPOCH")
		: tree.commitEpoch();
	const timestamp = new Date(epoch * 1000).toISOString();
	const evidenceWorkspaces = options.selectedFiles
		? publicSurface.resolved.filter((workspace) =>
				tree.files.includes(`${workspace.path}/package.json`),
			)
		: publicSurface.resolved;
	const workspaceManifestTexts = tree.readTexts(
		evidenceWorkspaces.map((workspace) => `${workspace.path}/package.json`),
	);
	const workspaceManifests = new Map(
		evidenceWorkspaces.map((workspace) => {
			const manifestPath = `${workspace.path}/package.json`;
			const manifestText = workspaceManifestTexts.get(manifestPath);
			if (manifestText === undefined)
				throw new Error(`Missing batch read for ${manifestPath}`);
			return [
				workspace.path,
				JSON.parse(manifestText) as PackageManifest,
			] as const;
		}),
	);
	const workspaceComponents: CycloneComponent[] = evidenceWorkspaces.map(
		(workspace) => {
			const manifest = workspaceManifests.get(workspace.path) ?? {};
			const intendedLicense = INTENDED_LICENSES[workspace.licenseClass];
			return {
				"bom-ref": `workspace:${workspace.path}`,
				type: workspace.path.startsWith("apps/") ? "application" : "library",
				name: workspace.name ?? workspace.path,
				...(manifest.version ? { version: manifest.version } : {}),
				licenses: licenseDeclaration(intendedLicense),
				properties: properties([
					["tedix:component-kind", "workspace"],
					["tedix:current-declared-license", workspace.declaredLicense],
					["tedix:intended-license-class", workspace.licenseClass],
					["tedix:public-decision", workspace.decision],
					["tedix:workspace-path", workspace.path],
				]),
			};
		},
	);
	const npmPackages = lockedPackages(
		tree,
		lockfiles,
		registry,
		dependencyLicenses,
	);
	const pythonPackages = pythonRequirements(
		tree,
		requirementFiles,
		selectedNonNpmLicenses,
	);
	const containers = containerImages(tree, dockerfiles, selectedNonNpmLicenses);
	const usedNonNpmLocators = new Set(
		[...pythonPackages, ...containers].map(
			(entry) => `${entry.ecosystem}:${entry.locator}`,
		),
	);
	const staleNonNpmEntries = selectedNonNpmLicenses.entries.filter(
		(entry) => !usedNonNpmLocators.has(`${entry.ecosystem}:${entry.locator}`),
	);
	if (staleNonNpmEntries.length > 0) {
		throw new Error(
			`stale non-npm license metadata: ${staleNonNpmEntries
				.map((entry) => `${entry.ecosystem}:${entry.locator}`)
				.join(", ")}`,
		);
	}
	const components = [
		...workspaceComponents,
		...npmPackages.map((entry) => entry.component),
		...pythonPackages.map((entry) => entry.component),
		...containers.map((entry) => entry.component),
	].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

	/*
	 * One `git show` per input meant a subprocess for every workspace manifest,
	 * requirements file, Dockerfile, lockfile and registry — the same per-file
	 * cost the migration hashes already avoid via readBuffers. Collect the paths
	 * first and read them through the bounded exact-commit batch instead. The
	 * batch reader enforces the exact commit SHA, rejects any path outside the
	 * selected set, and fails loudly on a missing or non-blob object, so the
	 * verification this evidence rests on is unchanged.
	 */
	const sourceInputRequests: ReadonlyArray<{
		kind: SourceInput["kind"];
		path: string;
	}> = [
		{ kind: "manifest", path: "package.json" },
		...evidenceWorkspaces.map((workspace) => ({
			kind: "manifest" as const,
			path: `${workspace.path}/package.json`,
		})),
		...requirementFiles.map((path) => ({
			kind: "manifest" as const,
			path,
		})),
		...dockerfiles.map((path) => ({ kind: "manifest" as const, path })),
		...lockfiles.map((path) => ({ kind: "lockfile" as const, path })),
		{ kind: "registry", path: publicSurfacePath },
		{ kind: "registry", path: thirdPartyPath },
		{ kind: "registry", path: nonNpmLicensePath },
	];
	const sourceInputBuffers = tree.readBuffers(
		sourceInputRequests.map((request) => request.path),
	);
	const sourceInputs = sourceInputRequests
		.map(({ kind, path }) => {
			const contents = sourceInputBuffers.get(path);
			if (!contents) throw new Error(`Missing batch read for ${path}`);
			return { kind, path, sha256: sha256(contents) };
		})
		.sort((left, right) =>
			`${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`),
		);
	const sourceBom = {
		bomFormat: "CycloneDX",
		specVersion: "1.6",
		version: 1,
		metadata: {
			timestamp,
			tools: {
				components: [
					{
						type: "application",
						name: "tedix-oss-release-evidence",
						version: RELEASE_EVIDENCE_GENERATOR_VERSION,
					},
				],
			},
			component: {
				"bom-ref": `source:${tree.commit}`,
				type: "application",
				name: "tedix",
				version: tree.commit,
				properties: properties([
					["tedix:public-commit", tree.commit],
					["tedix:scope", options.sourceScope ?? "selected-ref tracked source"],
				]),
			},
		},
		components,
	};
	const npmOccurrences = new Map<string, string[]>();
	for (const entry of npmPackages) {
		const key = `${entry.component.name}@${entry.component.version ?? ""}`;
		npmOccurrences.set(key, [
			...(npmOccurrences.get(key) ?? []),
			entry.component["bom-ref"],
		]);
	}
	type DependencyInventoryEntry = {
		ecosystem: "container" | "npm" | "pypi";
		license: string;
		licenseEvidence: string;
		locators: string[];
		name: string;
		usage: "development" | "runtime";
		version: string | null;
	};
	const inventoryEntries: DependencyInventoryEntry[] = [
		...dependencyLicenses.entries.map((entry) => ({
			ecosystem: "npm" as const,
			license: entry.license,
			licenseEvidence: `${entry.evidence}:sha256:${entry.metadataSha256}`,
			locators: [
				...new Set(npmOccurrences.get(`${entry.name}@${entry.version}`) ?? []),
			].sort(),
			name: entry.name,
			usage: entry.usage,
			version: entry.version,
		})),
		...[...pythonPackages, ...containers].map((entry) => ({
			ecosystem: entry.ecosystem,
			license: entry.license,
			licenseEvidence: entry.licenseEvidence,
			locators: [entry.locator],
			name: entry.component.name,
			usage: "runtime" as const,
			version: entry.component.version ?? null,
		})),
	];
	const inventoryByPackage = new Map<string, DependencyInventoryEntry>();
	for (const entry of inventoryEntries) {
		const key = `${entry.ecosystem}:${entry.name}@${entry.version ?? ""}`;
		const prior = inventoryByPackage.get(key);
		inventoryByPackage.set(key, {
			...entry,
			locators: [
				...new Set([...(prior?.locators ?? []), ...entry.locators]),
			].sort(),
		});
	}
	const dependencyInventory = [...inventoryByPackage.values()].sort(
		(left, right) =>
			`${left.ecosystem}:${left.name}@${left.version ?? ""}`.localeCompare(
				`${right.ecosystem}:${right.name}@${right.version ?? ""}`,
			),
	);
	const licenseInventory = {
		schemaVersion: 1,
		publicCommit: tree.commit,
		workspaces: evidenceWorkspaces.map((workspace) => ({
			currentDeclaredLicense: workspace.declaredLicense,
			decision: workspace.decision,
			intendedLicense: INTENDED_LICENSES[workspace.licenseClass],
			intendedLicenseClass: workspace.licenseClass,
			name: workspace.name,
			path: workspace.path,
		})),
		thirdParty: [...registry.entries]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((entry) => ({
				artifacts: [...(entry.artifacts ?? [])].sort((left, right) =>
					left.path.localeCompare(right.path),
				),
				id: entry.id,
				license: entry.license?.spdx ?? "NOASSERTION",
				licenseTextPath: entry.license?.textPath ?? null,
				reviewStatus: entry.reviewStatus,
				sourceKind: entry.sourceKind,
				upstream: entry.upstream,
			})),
		dependencies: dependencyInventory,
		summary: {
			dependencies: dependencyInventory.length,
			thirdPartyEntries: registry.entries.length,
			unknownDependencyLicenses: dependencyInventory.filter(
				(entry) => entry.license === "NOASSERTION",
			).length,
			workspaces: evidenceWorkspaces.length,
		},
	};
	const migrationBuffers = tree.readBuffers(migrations);
	const migrationMetadata = {
		schemaVersion: 1,
		publicCommit: tree.commit,
		migrations: migrations.map((path) => ({
			path,
			sha256: sha256(migrationBuffers.get(path)!),
		})),
	};
	const provenance = {
		schemaVersion: 1,
		generator: {
			name: "tedix-oss-release-evidence",
			version: RELEASE_EVIDENCE_GENERATOR_VERSION,
		},
		generatedAt: timestamp,
		sourceDateEpoch: epoch,
		publicCommit: tree.commit,
		requestedRef,
		sourceInputs,
		artifactScope: {
			dockerfiles,
			limitations: [
				"source evidence is unsigned",
				"container evidence covers Dockerfile base images, not built-image packages",
			],
			lockfiles,
			migrations,
			publicWorkspaces: evidenceWorkspaces.map((workspace) => workspace.path),
			pythonRequirements: requirementFiles,
			source:
				options.sourceScope ??
				"tracked files from the exact selected Git commit",
		},
		publicSurfaceWarnings: [...publicSurface.warnings].sort(),
	};

	const outputDirectory = resolve(options.out);
	mkdirSync(outputDirectory, { recursive: true });
	const rendered = new Map<string, string>([
		["source.cdx.json", stableJson(sourceBom)],
		["license-inventory.json", stableJson(licenseInventory)],
		["provenance.json", stableJson(provenance)],
		["migration-metadata.json", stableJson(migrationMetadata)],
	]);
	for (const name of ARTIFACT_NAMES) {
		writeFileSync(resolve(outputDirectory, name), rendered.get(name) ?? "");
	}
	const checksums = ARTIFACT_NAMES.map(
		(name) => `${sha256(rendered.get(name) ?? "")}  ${name}`,
	).join("\n");
	writeFileSync(resolve(outputDirectory, "checksums.txt"), `${checksums}\n`);

	return {
		artifacts: [...ARTIFACT_NAMES, "checksums.txt"].sort(),
		commit: tree.commit,
		outputDirectory,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const allowed = new Set(["--out", "--ref"]);
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		if (!name || !allowed.has(name)) throw new Error(`unknown option: ${name}`);
		if (!args[index + 1]) throw new Error(`${name} requires a value`);
	}
	const out = optionValue(args, "--out");
	if (!out) throw new Error("--out <directory> is required");
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	const ref = optionValue(args, "--ref") ?? "HEAD";
	const result = generateReleaseEvidence(repositoryRoot, {
		dependencyLicenses: await generateDependencyLicenseMetadata(
			repositoryRoot,
			{ ref },
		),
		out,
		ref,
		sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
	});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
