import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { detachedGitEnv } from "./git-env";

interface PackageManifest {
	name?: string;
	version?: string;
	license?: string | { type?: string };
	licenses?: Array<string | { type?: string }>;
	dist?: { integrity?: string };
}

export interface DependencyLicenseEntry {
	evidence:
		| "installed-package-license-file"
		| "installed-package-manifest"
		| "npm-registry-version-metadata";
	integrity: string;
	license: string;
	metadataSha256: string;
	name: string;
	usage: "development" | "runtime";
	version: string;
}

export interface DependencyLicenseRegistry {
	schemaVersion: 1;
	lockfiles: Array<{ path: string; sha256: string }>;
	entries: DependencyLicenseEntry[];
	summary: { packages: number; unresolved: number };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function packageLicense(manifest: PackageManifest): string {
	if (typeof manifest.license === "string" && manifest.license.trim()) {
		return manifest.license.trim();
	}
	if (
		typeof manifest.license === "object" &&
		manifest.license &&
		typeof manifest.license.type === "string"
	) {
		return manifest.license.type.trim() || "NOASSERTION";
	}
	const legacy = manifest.licenses
		?.map((license) =>
			typeof license === "string" ? license : (license.type ?? ""),
		)
		.filter(Boolean)
		.sort();
	return legacy && legacy.length > 0 ? legacy.join(" OR ") : "NOASSERTION";
}

function splitLocator(locator: string): { name: string; version?: string } {
	const separator = locator.startsWith("@")
		? locator.indexOf("@", 1)
		: locator.indexOf("@");
	if (separator < 1) throw new Error(`invalid Bun package locator: ${locator}`);
	const name = locator.slice(0, separator);
	const resolution = locator.slice(separator + 1);
	if (resolution.startsWith("npm:")) return splitLocator(resolution.slice(4));
	return { name, version: /^\d/.test(resolution) ? resolution : undefined };
}

export function lockedPackages(lockfiles: string[]): Map<string, string> {
	const packages = new Map<string, string>();
	for (const lockfile of lockfiles) {
		const lock = parse(lockfile) as { packages?: Record<string, unknown> };
		for (const raw of Object.values(lock.packages ?? {})) {
			if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
			const { name, version } = splitLocator(raw[0]);
			if (!version) continue;
			const integrity = raw.find(
				(value): value is string =>
					typeof value === "string" && value.startsWith("sha512-"),
			);
			if (!integrity)
				throw new Error(`${name}@${version} lacks lock integrity`);
			const key = `${name}@${version}`;
			const prior = packages.get(key);
			if (prior && prior !== integrity) {
				throw new Error(`conflicting lock integrity for ${key}`);
			}
			packages.set(key, integrity);
		}
	}
	return packages;
}

export function runtimePackageKeys(lockfiles: string[]): Set<string> {
	const runtime = new Set<string>();
	for (const content of lockfiles) {
		const lock = parse(content) as {
			packages?: Record<string, unknown>;
			workspaces?: Record<
				string,
				Record<string, Record<string, string> | string | undefined>
			>;
		};
		const records = new Map<
			string,
			{
				key: string;
				name: string;
				version?: string;
				dependencies: Record<string, string>;
			}
		>();
		for (const [key, raw] of Object.entries(lock.packages ?? {})) {
			if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
			const identity = splitLocator(raw[0]);
			const metadata = raw.find(
				(value) => value && typeof value === "object" && !Array.isArray(value),
			) as
				| Record<string, Record<string, string> | string | undefined>
				| undefined;
			records.set(key, {
				key,
				...identity,
				dependencies: {
					...(metadata?.dependencies as Record<string, string> | undefined),
					...(metadata?.optionalDependencies as
						| Record<string, string>
						| undefined),
				},
			});
		}
		const byName = new Map<
			string,
			Array<typeof records extends Map<any, infer V> ? V : never>
		>();
		for (const record of records.values()) {
			byName.set(record.name, [...(byName.get(record.name) ?? []), record]);
		}
		const resolveRecord = (name: string, requested: string) => {
			const candidates = byName.get(name) ?? [];
			return (
				candidates.find((candidate) => candidate.version === requested) ??
				candidates.find((candidate) => candidate.key === name) ??
				(candidates.length === 1 ? candidates[0] : undefined)
			);
		};
		const queue: Array<NonNullable<ReturnType<typeof resolveRecord>>> = [];
		for (const workspace of Object.values(lock.workspaces ?? {})) {
			for (const group of ["dependencies", "optionalDependencies"] as const) {
				for (const [name, requested] of Object.entries(
					(workspace[group] as Record<string, string> | undefined) ?? {},
				)) {
					const record = resolveRecord(name, requested);
					if (record) queue.push(record);
				}
			}
		}
		while (queue.length > 0) {
			const record = queue.shift()!;
			if (!record.version) continue;
			const identity = `${record.name}@${record.version}`;
			if (runtime.has(identity)) continue;
			runtime.add(identity);
			for (const [name, requested] of Object.entries(record.dependencies)) {
				const dependency = resolveRecord(name, requested);
				if (dependency) queue.push(dependency);
			}
		}
	}
	return runtime;
}

function trackedLockfiles(
	repositoryRoot: string,
	options: LockfileSelection,
): Array<{ path: string; content: string }> {
	const git = (args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: repositoryRoot,
			env: detachedGitEnv(),
			encoding: "utf8",
			maxBuffer: 128 * 1024 * 1024,
		});
		if (result.status !== 0) throw new Error(result.stderr.trim());
		return result.stdout;
	};
	const listed = options.ref
		? git(["ls-tree", "-r", "--name-only", options.ref])
		: git(["ls-files"]);
	return listed
		.split("\n")
		.filter((path) => path === "bun.lock" || path.endsWith("/bun.lock"))
		.filter((path) => !options.paths || options.paths.includes(path))
		.sort()
		.map((path) => ({
			path,
			content: options.ref
				? git(["show", `${options.ref}:${path}`])
				: readFileSync(resolve(repositoryRoot, path), "utf8"),
		}));
}

function installedManifestPaths(repositoryRoot: string): string[] {
	const store = resolve(repositoryRoot, "node_modules/.bun");
	// Without an install every locked package resolves from the npm registry.
	if (!existsSync(store)) return [];
	const manifests: string[] = [];
	for (const storeEntry of readdirSync(store, { withFileTypes: true })) {
		if (!storeEntry.isDirectory()) continue;
		const modules = resolve(store, storeEntry.name, "node_modules");
		if (!existsSync(modules)) continue;
		for (const packageEntry of readdirSync(modules, { withFileTypes: true })) {
			if (!packageEntry.isDirectory()) continue;
			if (!packageEntry.name.startsWith("@")) {
				const manifest = resolve(modules, packageEntry.name, "package.json");
				if (existsSync(manifest)) manifests.push(manifest);
				continue;
			}
			const scope = resolve(modules, packageEntry.name);
			for (const scopedEntry of readdirSync(scope, { withFileTypes: true })) {
				if (!scopedEntry.isDirectory()) continue;
				const manifest = resolve(scope, scopedEntry.name, "package.json");
				if (existsSync(manifest)) manifests.push(manifest);
			}
		}
	}
	return manifests.sort();
}

function installedEntries(
	repositoryRoot: string,
	locked: Map<string, string>,
): Map<string, DependencyLicenseEntry> {
	const overrides = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, "scripts/oss/dependency-license-overrides.json"),
			"utf8",
		),
	) as {
		entries: Array<{
			file: string;
			license: string;
			package: string;
			sha256: string;
		}>;
	};
	const overrideByPackage = new Map(
		overrides.entries.map((entry) => [entry.package, entry]),
	);
	const entries = new Map<string, DependencyLicenseEntry>();
	for (const path of installedManifestPaths(repositoryRoot)) {
		const content = readFileSync(path, "utf8");
		const manifest = JSON.parse(content) as PackageManifest;
		if (!manifest.name || !manifest.version) continue;
		const key = `${manifest.name}@${manifest.version}`;
		const integrity = locked.get(key);
		if (!integrity) continue;
		const override = overrideByPackage.get(key);
		const overrideContent = override
			? readFileSync(resolve(dirname(path), override.file), "utf8")
			: null;
		if (override && sha256(overrideContent ?? "") !== override.sha256) {
			throw new Error(`license-file override drift for ${key}`);
		}
		const entry: DependencyLicenseEntry = {
			evidence: override
				? "installed-package-license-file"
				: "installed-package-manifest",
			integrity,
			license: override?.license ?? packageLicense(manifest),
			metadataSha256: override?.sha256 ?? sha256(content),
			name: manifest.name,
			usage: "development",
			version: manifest.version,
		};
		const prior = entries.get(key);
		if (
			prior &&
			(prior.license !== entry.license ||
				prior.metadataSha256 !== entry.metadataSha256)
		) {
			throw new Error(`conflicting installed metadata for ${key}`);
		}
		entries.set(key, entry);
	}
	return entries;
}

async function fetchEntry(
	key: string,
	integrity: string,
): Promise<DependencyLicenseEntry> {
	const { name, version } = splitLocator(key);
	if (!version) throw new Error(`invalid exact package key: ${key}`);
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
	);
	if (!response.ok)
		throw new Error(`${key}: npm metadata HTTP ${response.status}`);
	const content = await response.text();
	const manifest = JSON.parse(content) as PackageManifest;
	if (manifest.name !== name || manifest.version !== version) {
		throw new Error(`${key}: npm metadata identity mismatch`);
	}
	if (manifest.dist?.integrity !== integrity) {
		throw new Error(`${key}: npm metadata integrity does not match bun.lock`);
	}
	return {
		evidence: "npm-registry-version-metadata",
		integrity,
		license: packageLicense(manifest),
		metadataSha256: sha256(content),
		name,
		usage: "development",
		version,
	};
}

export interface LockfileSelection {
	/** Read lockfiles from this commit instead of the working tree. */
	ref?: string;
	/** Limit the scan to these lockfile paths. */
	paths?: string[];
}

/**
 * Resolve the license of every package locked by the tracked `bun.lock` files.
 * Installed manifests answer most of them; packages this machine did not
 * install (other platforms' binaries, CMS template lockfiles) come from the npm
 * registry, and their metadata must match the lockfile integrity.
 */
export async function generateDependencyLicenseMetadata(
	repositoryRoot: string,
	options: LockfileSelection = {},
): Promise<DependencyLicenseRegistry> {
	const lockfiles = trackedLockfiles(repositoryRoot, options);
	const lockfileContents = lockfiles.map((lockfile) => lockfile.content);
	const locked = lockedPackages(lockfileContents);
	const runtime = runtimePackageKeys(lockfileContents);
	const installed =
		locked.size > 0 ? installedEntries(repositoryRoot, locked) : new Map();
	const entries: DependencyLicenseEntry[] = [];
	const missing: Array<[string, string]> = [];
	for (const [key, integrity] of locked) {
		const local = installed.get(key);
		if (local) entries.push(local);
		else missing.push([key, integrity]);
	}
	for (let index = 0; index < missing.length; index += 24) {
		entries.push(
			...(await Promise.all(
				missing
					.slice(index, index + 24)
					.map(([key, integrity]) => fetchEntry(key, integrity)),
			)),
		);
	}
	entries.sort((left, right) =>
		`${left.name}@${left.version}`.localeCompare(
			`${right.name}@${right.version}`,
		),
	);
	for (const entry of entries) {
		entry.usage = runtime.has(`${entry.name}@${entry.version}`)
			? "runtime"
			: "development";
	}
	return {
		schemaVersion: 1,
		lockfiles: lockfiles.map((lockfile) => ({
			path: lockfile.path,
			sha256: sha256(lockfile.content),
		})),
		entries,
		summary: {
			packages: entries.length,
			unresolved: entries.filter((entry) => entry.license === "NOASSERTION")
				.length,
		},
	};
}
