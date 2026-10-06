#!/usr/bin/env bun
/**
 * The dependency-manifest checks Sherif cannot make, offline, in one pass
 * (`bun run lint:deps` runs Sherif and then this):
 *
 *   1. CATALOG ESCAPES — a workspace hard-coding a version for a dependency the
 *      root `catalog` already declares (see `findCatalogEscapes`).
 *   2. LOCKFILE DRIFT — the committed `bun.lock` stale relative to the
 *      committed `package.json` files (everything below).
 *
 * LOCKFILE DRIFT.
 *
 * A dependency bumped in one workspace manifest without regenerating the
 * lockfile bites in two stages:
 *
 *   1. `bun install --frozen-lockfile` fails on a clean checkout of `main`.
 *   2. Regenerating the lockfile then reveals that only ONE member was bumped,
 *      so an honest resolve installs TWO copies of a shared transitive package
 *      (for example two `@tanstack/query-core` copies, whose `#private` fields
 *      make their types unassignable).
 *
 * Stage 2 is why the failure message below spends more words on the siblings
 * than on the lockfile.
 *
 * Deliberately a little stricter than `--frozen-lockfile`, which (as of Bun
 * 1.4.0) compares RESOLUTIONS,
 * not the literal ranges, so it accepts a manifest edit the already-locked
 * version still satisfies (`^3.0.0` -> `^3.0.1` against a locked 3.0.1) and
 * rejects one that forces a new resolution (a new dependency, a new member, a
 * range the lock cannot satisfy). This gate compares the recorded strings, so
 * it fails on both. That superset is the point: the tolerated case still leaves
 * `bun.lock` disagreeing with the manifest, so the next honest `bun install`
 * rewrites the lockfile in someone else's working tree — and it is the same
 * one-line fix either way. No semver evaluation, no registry read.
 *
 * WHAT THIS DOES *NOT* CHECK. A package declared at two different versions
 * across workspace members is already covered by Sherif's
 * `multiple-dependency-versions` (`bun run lint:deps`), and preflight already runs it unconditionally. This gate
 * covers only the gap Sherif has no opinion about: manifests and lockfile
 * disagreeing.
 *
 * The comparison mirrors what Bun records per workspace in `bun.lock` — the
 * manifest's identity, its four dependency maps, its optional peers — plus the
 * root-only resolution inputs (`catalog`/`catalogs`, `overrides`,
 * `patchedDependencies`, `trustedDependencies`). Anything Bun records but does
 * not resolve from is left alone; a false positive here makes the repo
 * unpushable for a cosmetic diff.
 */

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

/** The dependency maps Bun copies verbatim into each lockfile workspace entry. */
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

/** Root-only maps that feed resolution and are mirrored into the lockfile. */
const ROOT_MAP_FIELDS = ["overrides", "patchedDependencies"];

const label = (workspace) => (workspace === "" ? "<root>" : workspace);

/**
 * Expand the root `workspaces` globs to member directories, posix-separated
 * and relative to the repo root, matching the keys Bun writes in `bun.lock`.
 */
export function workspaceDirectories(rootManifest, root) {
	const patterns = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: (rootManifest.workspaces?.packages ?? []);
	const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
	const negative = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => globToRegExp(pattern.slice(1)));
	const dirs = new Set();
	for (const pattern of positive) {
		for (const match of globSync(`${pattern}/package.json`, { cwd: root })) {
			const dir = match.replaceAll("\\", "/").slice(0, -"/package.json".length);
			if (negative.some((re) => re.test(dir))) continue;
			dirs.add(dir);
		}
	}
	return [...dirs].sort();
}

function globToRegExp(pattern) {
	const source = pattern
		.split("/")
		.map((segment) =>
			segment === "**"
				? "[^\0]*"
				: segment
						.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
						.replaceAll("*", "[^/]*"),
		)
		.join("/");
	return new RegExp(`^${source}$`);
}

/**
 * Compare manifests against the lockfile. Pure: the runner owns all I/O so the
 * comparison can be driven from fixtures.
 *
 * @param manifests Map of workspace directory ("" for the root) to its parsed
 *   `package.json`.
 * @param lock The parsed `bun.lock`.
 */
export function findLockfileDrift({ manifests, lock }) {
	const findings = [];
	const recorded = lock.workspaces ?? {};

	for (const workspace of Object.keys(recorded)) {
		if (manifests.has(workspace)) continue;
		findings.push({
			workspace,
			what: "workspace member",
			manifest: "(no package.json)",
			lock: "recorded",
		});
	}

	for (const [workspace, manifest] of manifests) {
		const entry = recorded[workspace];
		if (entry === undefined) {
			findings.push({
				workspace,
				what: "workspace member",
				manifest: manifest.name ?? "(unnamed)",
				lock: "(not in bun.lock)",
			});
			continue;
		}

		for (const field of ["name", "version"]) {
			if ((manifest[field] ?? undefined) !== (entry[field] ?? undefined)) {
				findings.push({
					workspace,
					what: field,
					manifest: manifest[field] ?? "(unset)",
					lock: entry[field] ?? "(unset)",
				});
			}
		}

		for (const field of DEPENDENCY_FIELDS) {
			findings.push(
				...compareMaps(workspace, field, manifest[field], entry[field]),
			);
		}

		const declaredOptionalPeers = Object.entries(
			manifest.peerDependenciesMeta ?? {},
		)
			.filter(([, meta]) => meta?.optional === true)
			.map(([name]) => name);
		findings.push(
			...compareSets(
				workspace,
				"optional peer",
				declaredOptionalPeers,
				entry.optionalPeers,
			),
		);
	}

	const rootManifest = manifests.get("");
	if (rootManifest !== undefined) {
		for (const field of ROOT_MAP_FIELDS) {
			findings.push(
				...compareMaps("", field, rootManifest[field], lock[field]),
			);
		}
		findings.push(
			...compareMaps("", "catalog", rootManifest.catalog, lock.catalog),
		);
		for (const name of new Set([
			...Object.keys(rootManifest.catalogs ?? {}),
			...Object.keys(lock.catalogs ?? {}),
		])) {
			findings.push(
				...compareMaps(
					"",
					`catalogs.${name}`,
					rootManifest.catalogs?.[name],
					lock.catalogs?.[name],
				),
			);
		}
		findings.push(
			...compareSets(
				"",
				"trustedDependencies",
				rootManifest.trustedDependencies,
				lock.trustedDependencies,
			),
		);
	}

	return findings;
}

function compareMaps(workspace, field, declared = {}, recorded = {}) {
	const findings = [];
	for (const name of new Set([
		...Object.keys(declared ?? {}),
		...Object.keys(recorded ?? {}),
	])) {
		const left = declared?.[name];
		const right = recorded?.[name];
		if (left === right) continue;
		findings.push({
			workspace,
			what: `${field} · ${name}`,
			manifest: left ?? "(not declared)",
			lock: right ?? "(not in bun.lock)",
		});
	}
	return findings.sort((a, b) => a.what.localeCompare(b.what));
}

/** Order is not meaningful for these — Bun rewrites them sorted. */
function compareSets(workspace, what, declared = [], recorded = []) {
	const left = new Set(declared ?? []);
	const right = new Set(recorded ?? []);
	const findings = [];
	for (const name of [...new Set([...left, ...right])].sort()) {
		if (left.has(name) === right.has(name)) continue;
		findings.push({
			workspace,
			what: `${what} · ${name}`,
			manifest: left.has(name) ? "declared" : "(not declared)",
			lock: right.has(name) ? "recorded" : "(not in bun.lock)",
		});
	}
	return findings;
}

const INSTALLED_SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];

/**
 * The root `catalog` is the single version source: workspaces spell shared deps
 * as `"catalog:"`, so one edit moves all of them together. A workspace that
 * writes a literal version instead silently opts out — every later catalog bump
 * skips it, and nothing complains, because the escapee and the catalog are each
 * internally consistent. Sherif compares workspaces against each other, so it
 * stays quiet while hard-coded copies agree — exactly the state an escape
 * starts in, since it is usually created by copying a sibling's manifest.
 *
 * `peerDependencies` are exempt: a peer is a compatibility *range* the consumer
 * advertises, not a version this repo installs.
 */
export function findCatalogEscapes(manifests) {
	const rootManifest = manifests.get("") ?? {};
	const catalog =
		rootManifest.catalog ?? rootManifest.workspaces?.catalog ?? {};
	const escapes = [];
	for (const [workspace, manifest] of manifests) {
		for (const section of INSTALLED_SECTIONS) {
			for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
				if (!(dep in catalog)) continue;
				// `workspace:` is a local package, not a registry version.
				if (range === "catalog:" || range.startsWith("workspace:")) continue;
				escapes.push({ workspace, section, dep, range, catalog: catalog[dep] });
			}
		}
	}
	return escapes;
}

export function formatCatalogEscapes(escapes) {
	const lines = [
		"",
		`${escapes.length} dependenc${escapes.length === 1 ? "y" : "ies"} hard-coded despite a catalog entry.`,
		"",
	];
	for (const escape of escapes) {
		const agrees = escape.range === escape.catalog ? " (agrees today)" : "";
		lines.push(
			`  ${label(escape.workspace)} ${escape.section}: ${escape.dep} = "${escape.range}"` +
				` — catalog declares "${escape.catalog}"${agrees}`,
		);
	}
	lines.push(
		"",
		'  Replace the literal with "catalog:". An escape that agrees with the',
		"  catalog today is the dangerous case: it looks correct, and it silently",
		"  stops tracking at the next bump.",
		"",
	);
	return lines.join("\n");
}

export function loadRepo(root) {
	const readJson = (relative) =>
		parseJsonc(readFileSync(join(root, relative), "utf8"));
	const rootManifest = readJson("package.json");
	const manifests = new Map([["", rootManifest]]);
	for (const dir of workspaceDirectories(rootManifest, root)) {
		manifests.set(dir, readJson(`${dir}/package.json`));
	}
	return { manifests, lock: readJson("bun.lock") };
}

export function formatFailure(findings) {
	const lines = [
		"",
		"bun.lock does not match the committed package.json files.",
		"",
	];
	for (const finding of findings) {
		lines.push(`  ${label(finding.workspace)} · ${finding.what}`);
		lines.push(`      package.json: ${finding.manifest}`);
		lines.push(`      bun.lock:     ${finding.lock}`);
	}
	lines.push(
		"",
		"  The lockfile no longer describes these manifests. Where the locked",
		"  version cannot satisfy the new range, `bun install --frozen-lockfile`",
		"  fails on a clean checkout of main — for every agent and every CI job,",
		"  not just for you. Where it can, the next honest `bun install` silently",
		"  rewrites bun.lock in someone else's tree instead.",
		"",
		"  Fix BOTH halves. The second one is the half that costs hours:",
		"",
		"  1. Regenerate the lockfile beside the manifest change: run `bun install`",
		"     and commit bun.lock in the SAME commit as the package.json edit.",
		"",
		"  2. Check whether sibling workspace members declare the same package and",
		"     need the same bump. A package bumped in ONE member resolves honestly",
		"     to TWO copies of its shared transitive deps. That is not cosmetic:",
		"     two @tanstack/query-core copies gave QueryClient two mutually",
		"     non-assignable types (it carries a #private field), which broke every",
		"     useQuery overload in apps/os with a wall of type errors that reads",
		"     like a library bug. `bun run lint:deps` (Sherif) is the check for that",
		"     half — it fails on a package declared at two versions across the",
		"     workspace.",
		"",
	);
	return lines.join("\n");
}

if (import.meta.main) {
	const root =
		process.argv[2] ??
		join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const { manifests, lock } = loadRepo(root);
	const escapes = findCatalogEscapes(manifests);
	const drift = findLockfileDrift({ manifests, lock });
	if (escapes.length > 0) console.error(formatCatalogEscapes(escapes));
	if (drift.length > 0) console.error(formatFailure(drift));
	if (escapes.length > 0 || drift.length > 0) process.exit(1);
	console.log(
		`dependencies: no catalog escapes, and bun.lock is current for all ${manifests.size} workspace manifests`,
	);
}
