import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { ArtifactsBinding } from "../types";
import { TEMPLATE_SNAPSHOTS } from "../template-snapshot";
import {
	normalizeCmsTemplateSlug,
	THEME_SOURCE_MANIFEST_PATH,
	type CmsTemplateSlug,
} from "../template-policy";
import { isPathEditable } from "./constraints";
import {
	commitRepoFiles,
	ARTIFACTS_ZERO_OID,
	type ThemeArtifactFileChange,
} from "./theme-artifact-commit";
import {
	readThemeArtifactBlob,
	readThemeArtifactTree,
	readThemeArtifactTreeEntries,
} from "./theme-artifacts";

export const STARTER_REPO_PREFIX = "cms-starter-";
export const STARTER_MARKER_PATH = ".cms-starter.json";
const MAIN_BRANCH = "main";
const MAX_STARTER_SCAN_COMMITS = 200;

export function starterRepoName(templateSlug: string): string {
	return `${STARTER_REPO_PREFIX}${normalizeCmsTemplateSlug(templateSlug)}`;
}

export function starterRemote(
	accountId: string,
	namespace: string,
	templateSlug: string,
): string {
	return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${starterRepoName(templateSlug)}.git`;
}

/** Content hash covering every file a template snapshot ships. */
export async function starterEntriesHash(
	entries: Readonly<Record<string, string>>,
): Promise<string> {
	const parts = await Promise.all(
		Object.keys(entries)
			.sort()
			.map(async (path) => `${path}:${await sha256Hex(entries[path]!)}`),
	);
	return sha256Hex(parts.join("\n"));
}

export async function starterSnapshotHash(
	templateSlug: CmsTemplateSlug,
): Promise<string> {
	const snapshot = TEMPLATE_SNAPSHOTS[templateSlug];
	if (!snapshot) throw new Error(`Unknown CMS template "${templateSlug}"`);
	return starterEntriesHash(snapshot);
}

export interface StarterMarker {
	templateSlug: string;
	snapshotHash: string;
	tedixCommit?: string;
	upstreamStarterRevision?: string;
}

export function starterMarkerContent(marker: StarterMarker): string {
	return `${JSON.stringify(marker, null, 2)}\n`;
}

async function refHead(repo: ArtifactsRepo, ref: string) {
	const [commit] = await repo.log({ ref, limit: 1 });
	return commit && /^[a-f0-9]{40}$/.test(commit.hash) ? commit.hash : null;
}

function isTreeEntry(entry: { type: string; mode: string }) {
	return entry.type === "tree" && ["40000", "040000"].includes(entry.mode);
}

function isFileEntry(entry: { type: string; mode: string }) {
	return (
		["blob", "exec"].includes(entry.type) &&
		["100644", "100755"].includes(entry.mode)
	);
}

/** path → blob oid for every regular file under a commit's root tree. */
export async function listRepoFiles(
	repo: ArtifactsRepo,
	commit: string,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	async function walk(
		treeHash: string,
		prefix: string,
		ancestors: Set<string>,
	) {
		if (ancestors.has(treeHash)) throw new Error("Cyclic Artifacts tree");
		const next = new Set(ancestors).add(treeHash);
		for (const entry of await readThemeArtifactTreeEntries(repo, treeHash)) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (isTreeEntry(entry)) await walk(entry.hash, path, next);
			else if (isFileEntry(entry)) files.set(path, entry.hash);
		}
	}
	const root = await readThemeArtifactTree(repo, commit);
	await walk(root, "", new Set());
	return files;
}

export async function readRepoText(
	repo: ArtifactsRepo,
	commit: string,
	path: string,
): Promise<string | null> {
	const parts = path.split("/").filter(Boolean);
	let hash = await readThemeArtifactTree(repo, commit);
	for (let index = 0; index < parts.length; index++) {
		const entry = (await readThemeArtifactTreeEntries(repo, hash)).find(
			(candidate) => candidate.name === parts[index],
		);
		if (!entry) return null;
		if (index === parts.length - 1) {
			if (!isFileEntry(entry)) return null;
			const blob = await readThemeArtifactBlob(repo, entry.hash);
			return blob.content;
		}
		if (!isTreeEntry(entry)) return null;
		hash = entry.hash;
	}
	return null;
}

async function readRepoMarker(
	repo: ArtifactsRepo,
	commit: string,
): Promise<StarterMarker | null> {
	const raw = await readRepoText(repo, commit, STARTER_MARKER_PATH);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StarterMarker>;
		return typeof parsed.snapshotHash === "string" &&
			typeof parsed.templateSlug === "string"
			? (parsed as StarterMarker)
			: null;
	} catch {
		return null;
	}
}

export interface StarterRepoState {
	repo: ArtifactsRepo;
	head: string;
	created: boolean;
	advanced: boolean;
}

/**
 * Ensure the per-template starter repo exists and its main branch carries a
 * commit whose marker matches the bundled template snapshot. Older starter
 * states remain in history so sites can diff against their recorded commit.
 */
export async function ensureStarterRepoCurrent(input: {
	artifacts: ArtifactsBinding;
	accountId: string;
	namespace: string;
	templateSlug: string;
	tedixCommit?: string;
	upstreamStarterRevision?: string;
}): Promise<StarterRepoState> {
	const slug = normalizeCmsTemplateSlug(input.templateSlug);
	const name = starterRepoName(slug);
	let repo: ArtifactsRepo;
	let created = false;
	try {
		repo = await input.artifacts.get(name);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/not.?found|NOT_FOUND|404/i.test(message)) throw error;
		await input.artifacts.create(name, {
			description: `CMS starter template source for "${slug}"`,
			readOnly: false,
			setDefaultBranch: MAIN_BRANCH,
		});
		repo = await input.artifacts.get(name);
		created = true;
	}

	const snapshotHash = await starterSnapshotHash(slug);
	const head = await refHead(repo, MAIN_BRANCH);
	const marker = head ? await readRepoMarker(repo, head) : null;
	if (head && marker?.snapshotHash === snapshotHash) {
		return { repo, head, created, advanced: false };
	}

	const snapshot = TEMPLATE_SNAPSHOTS[slug]!;
	const files: ThemeArtifactFileChange[] = Object.keys(snapshot)
		.sort()
		.map((path) => ({ path, content: snapshot[path]! }));
	files.push({
		path: STARTER_MARKER_PATH,
		content: starterMarkerContent({
			templateSlug: slug,
			snapshotHash,
			tedixCommit: input.tedixCommit,
			upstreamStarterRevision: input.upstreamStarterRevision,
		}),
	});

	const remote = starterRemote(input.accountId, input.namespace, slug);
	// One retry absorbs a concurrent starter-repo update.
	for (let attempt = 0; attempt < 2; attempt++) {
		const base = attempt === 0 ? head : await refHead(repo, MAIN_BRANCH);
		const result = await commitRepoFiles({
			repo,
			remote,
			ref: MAIN_BRANCH,
			baseCommit: base,
			expectedOldOid: base ?? ARTIFACTS_ZERO_OID,
			files,
			message: `Starter template "${slug}" snapshot ${snapshotHash.slice(0, 12)}`,
		});
		if (result.committed) {
			return { repo, head: result.commit, created, advanced: true };
		}
		if (!("conflict" in result)) {
			throw new Error(
				`Starter repo ${name} already matches snapshot ${snapshotHash.slice(0, 12)}`,
			);
		}
	}
	throw new Error(`Starter repo ${name} kept moving during sync; retry`);
}

export type StarterChangeStatus = "clean" | "conflict" | "current";
export type StarterChangeKind = "added" | "modified" | "deleted";

export interface StarterFileChange {
	path: string;
	kind: StarterChangeKind;
	status: StarterChangeStatus;
	baseHash: string | null;
	headHash: string | null;
	siteHash: string | null;
}

export interface StarterChangeset {
	fromCommit: string;
	toCommit: string;
	changes: StarterFileChange[];
	counts: { clean: number; conflict: number; current: number };
}

/**
 * Editable-file changes between two starter commits, classified against the
 * site's main-branch tree by blob hash. Git blob ids are content-addressed,
 * so hashes compare across repositories without reading contents.
 */
export async function listStarterChanges(input: {
	siteRepo: ArtifactsRepo;
	siteHead: string;
	starterRepo: ArtifactsRepo;
	fromCommit: string;
	toCommit: string;
	templateSlug: string;
}): Promise<StarterChangeset> {
	const slug = normalizeCmsTemplateSlug(input.templateSlug);
	const [baseFiles, headFiles, siteFiles] = await Promise.all([
		listRepoFiles(input.starterRepo, input.fromCommit),
		listRepoFiles(input.starterRepo, input.toCommit),
		listRepoFiles(input.siteRepo, input.siteHead),
	]);
	const paths = new Set<string>();
	for (const path of baseFiles.keys()) paths.add(path);
	for (const path of headFiles.keys()) paths.add(path);

	const changes: StarterFileChange[] = [];
	for (const path of [...paths].sort()) {
		if (path === THEME_SOURCE_MANIFEST_PATH) continue;
		if (!isPathEditable(path, slug)) continue;
		const baseHash = baseFiles.get(path) ?? null;
		const headHash = headFiles.get(path) ?? null;
		if (baseHash === headHash) continue;
		const siteHash = siteFiles.get(path) ?? null;
		const kind: StarterChangeKind =
			baseHash === null ? "added" : headHash === null ? "deleted" : "modified";
		const status: StarterChangeStatus =
			siteHash === headHash
				? "current"
				: siteHash === baseHash
					? "clean"
					: "conflict";
		changes.push({ path, kind, status, baseHash, headHash, siteHash });
	}
	const counts = { clean: 0, conflict: 0, current: 0 };
	for (const change of changes) counts[change.status] += 1;
	return {
		fromCommit: input.fromCommit,
		toCommit: input.toCommit,
		changes,
		counts,
	};
}

export interface StarterBaseline {
	commit: string;
	via: "explicit" | "theme_source" | "upstream_revision";
}

async function siteManifestFields(
	repo: ArtifactsRepo,
	commit: string,
): Promise<{ starterCommit?: string; upstreamStarterRevision?: string }> {
	const out: { starterCommit?: string; upstreamStarterRevision?: string } = {};
	for (const [path, key] of [
		[THEME_SOURCE_MANIFEST_PATH, "starterCommit"],
		["src/theme-release.json", "upstreamStarterRevision"],
	] as const) {
		const raw = await readRepoText(repo, commit, path);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (typeof parsed[key] === "string") {
				(out as Record<string, string>)[key] = parsed[key] as string;
			}
		} catch {
			// Malformed manifest: treat as absent rather than failing the read.
		}
	}
	return out;
}

/**
 * Resolve the starter commit a site last synced to. Order: explicit override,
 * `starterCommit` recorded in src/theme-source.json by a previous apply, then
 * the oldest starter commit whose marker shares the site's
 * theme-release.json upstreamStarterRevision.
 */
export async function resolveStarterBaseline(input: {
	siteRepo: ArtifactsRepo;
	siteHead: string;
	starterRepo: ArtifactsRepo;
	templateSlug: string;
	fromCommit?: string;
}): Promise<StarterBaseline | null> {
	const { siteRepo, siteHead, starterRepo } = input;
	if (input.fromCommit) {
		if (!/^[a-f0-9]{40}$/.test(input.fromCommit)) {
			throw new Error("fromCommit must be a 40-character commit SHA");
		}
		await readThemeArtifactTree(starterRepo, input.fromCommit);
		return { commit: input.fromCommit, via: "explicit" };
	}

	const fields = await siteManifestFields(siteRepo, siteHead);
	if (fields.starterCommit && /^[a-f0-9]{40}$/.test(fields.starterCommit)) {
		try {
			await readThemeArtifactTree(starterRepo, fields.starterCommit);
			return { commit: fields.starterCommit, via: "theme_source" };
		} catch {
			// Recorded commit was GC'd or belongs to a different starter history.
		}
	}

	if (fields.upstreamStarterRevision) {
		const wanted = fields.upstreamStarterRevision;
		const commits = await starterRepo.log({
			ref: MAIN_BRANCH,
			limit: MAX_STARTER_SCAN_COMMITS,
		});
		let match: string | null = null;
		for (const entry of commits) {
			const marker = await readRepoMarker(starterRepo, entry.hash);
			if (marker?.upstreamStarterRevision === wanted) match = entry.hash;
		}
		// log() is newest-first; keep the last (oldest) match so already-applied
		// starter states classify as "current" instead of inventing updates.
		if (match) return { commit: match, via: "upstream_revision" };
	}
	return null;
}

export interface StarterRepoCommitInfo {
	commit: string;
	snapshotHash: string | null;
	tedixCommit: string | null;
	upstreamStarterRevision: string | null;
	committedAt: string | null;
}

/** Recent starter commits with markers, newest first — for baseline pickers. */
export async function listStarterCommits(
	repo: ArtifactsRepo,
	limit = 10,
): Promise<StarterRepoCommitInfo[]> {
	const commits = await repo.log({ ref: MAIN_BRANCH, limit });
	const out: StarterRepoCommitInfo[] = [];
	for (const entry of commits) {
		const marker = await readRepoMarker(repo, entry.hash);
		out.push({
			commit: entry.hash,
			snapshotHash: marker?.snapshotHash ?? null,
			tedixCommit: marker?.tedixCommit ?? null,
			upstreamStarterRevision: marker?.upstreamStarterRevision ?? null,
			committedAt:
				typeof entry.committedAt === "number"
					? new Date(entry.committedAt * 1000).toISOString()
					: null,
		});
	}
	return out;
}

/** Merge starterCommit into the site's theme-source.json, preserving fields. */
export async function themeSourceWithStarterCommit(
	siteRepo: ArtifactsRepo,
	siteHead: string,
	starterCommit: string,
): Promise<ThemeArtifactFileChange> {
	const path = THEME_SOURCE_MANIFEST_PATH;
	const raw = await readRepoText(siteRepo, siteHead, path);
	let manifest: Record<string, unknown> = {};
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				manifest = parsed as Record<string, unknown>;
			}
		} catch {
			manifest = {};
		}
	}
	if (manifest.version === undefined) manifest.version = 2;
	manifest.starterCommit = starterCommit;
	return { path, content: `${JSON.stringify(manifest, null, 2)}\n` };
}
