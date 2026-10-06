/**
 * Template ↔ sandbox sync helpers.
 *
 * Shared logic for the theme_resync_template + theme_diff_template MCP tools
 * AND the deploy workflow's preflight step. Pulled out into its own module so
 * the workflow can call the same code path without going through MCP.
 *
 * Strategy: the Site Builder Worker bundles a snapshot of the canonical starters
 * (`templates/{tedix,marketing}/**`) at build time via scripts/generate-template-snapshot.ts.
 * Resync writes those bytes back into the sandbox; diff hashes the sandbox
 * file vs the snapshot and reports paths whose hashes differ.
 */

import type { CmsSandbox } from "../sandbox";
import {
	TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE,
	TEMPLATE_SNAPSHOTS,
} from "../template-snapshot";
import { isPathLocked } from "./constraints";
import { normalizeCmsTemplateSlug } from "../template-policy";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const WORKSPACE = "/workspace";

/** Select the generated snapshot and paths after canonical slug normalization. */
export function snapshotForTemplate(templateSlug?: string): {
	snapshot: Readonly<Record<string, string>>;
	paths: readonly string[];
} {
	const slug = normalizeCmsTemplateSlug(templateSlug);
	return {
		snapshot: TEMPLATE_SNAPSHOTS[slug]!,
		paths: TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE[slug]!,
	};
}

export type ResyncScope = "locked" | "all" | "files";
export type DiffScope = "locked" | "all";

export interface DriftEntry {
	path: string;
	locked: boolean;
	sandboxHash: string;
	repoHash: string;
}

export interface DiffResult {
	drifted: DriftEntry[];
	clean: boolean;
	scope: DiffScope;
	checked: number;
}

export interface ResyncResult {
	copied: string[];
	removed: string[];
	skipped: string[];
	scope: ResyncScope;
}

const ABSENT_HASH = "absent";

function pathsForDiffScope(
	scope: DiffScope,
	snapshotPaths: readonly string[],
	templateSlug?: string,
): string[] {
	if (scope === "locked") {
		return snapshotPaths.filter((path) => isPathLocked(path, templateSlug));
	}
	return [...snapshotPaths];
}

function pathsForResyncScope(
	scope: ResyncScope,
	files: string[] | undefined,
	snapshot: Readonly<Record<string, string>>,
	snapshotPaths: readonly string[],
	templateSlug?: string,
): { paths: string[]; skipped: string[] } {
	if (scope === "files") {
		const paths: string[] = [];
		const skipped: string[] = [];
		for (const p of files ?? []) {
			if (snapshot[p] !== undefined) paths.push(p);
			else skipped.push(p);
		}
		return { paths, skipped };
	}
	if (scope === "all") {
		return { paths: [...snapshotPaths], skipped: [] };
	}
	// "locked" — default
	return {
		paths: snapshotPaths.filter((path) => isPathLocked(path, templateSlug)),
		skipped: [],
	};
}

async function readSandboxContent(
	sandbox: CmsSandbox,
	relPath: string,
): Promise<string | null> {
	try {
		const result = await sandbox.readFile(`${WORKSPACE}/${relPath}`);
		return result.content;
	} catch {
		return null;
	}
}

export async function diffTemplate(
	sandbox: CmsSandbox,
	scope: DiffScope = "locked",
	templateSlug?: string,
): Promise<DiffResult> {
	const { snapshot, paths: snapshotPaths } = snapshotForTemplate(templateSlug);
	const paths = pathsForDiffScope(scope, snapshotPaths, templateSlug);
	const drifted: DriftEntry[] = [];

	await Promise.all(
		paths.map(async (path) => {
			const repo = snapshot[path];
			if (repo === undefined) return;
			const sandboxContent = await readSandboxContent(sandbox, path);

			if (sandboxContent === null) {
				const repoHash = await sha256Hex(repo);
				drifted.push({
					path,
					locked: isPathLocked(path, templateSlug),
					sandboxHash: ABSENT_HASH,
					repoHash,
				});
				return;
			}

			const [sandboxHash, repoHash] = await Promise.all([
				sha256Hex(sandboxContent),
				sha256Hex(repo),
			]);
			if (sandboxHash !== repoHash) {
				drifted.push({
					path,
					locked: isPathLocked(path, templateSlug),
					sandboxHash,
					repoHash,
				});
			}
		}),
	);

	drifted.sort((a, b) => a.path.localeCompare(b.path));
	return { drifted, clean: drifted.length === 0, scope, checked: paths.length };
}

export async function resyncTemplate(
	sandbox: CmsSandbox,
	args: {
		scope?: ResyncScope;
		paths?: string[];
		confirm?: boolean;
		templateSlug?: string;
		workspace?: string;
	},
): Promise<ResyncResult> {
	const scope = args.scope ?? "locked";
	const workspace = args.workspace ?? WORKSPACE;
	if (scope === "all" && !args.confirm) {
		throw new Error(
			'theme_resync_template scope="all" requires confirm:true — this overwrites every editable theme file with the canonical starter, including any vibe-coded customizations.',
		);
	}
	if (scope === "files" && (!args.paths || args.paths.length === 0)) {
		throw new Error(
			'theme_resync_template scope="files" requires a non-empty paths array.',
		);
	}

	const { snapshot, paths: snapshotPaths } = snapshotForTemplate(
		args.templateSlug,
	);
	const { paths, skipped } = pathsForResyncScope(
		scope,
		args.paths,
		snapshot,
		snapshotPaths,
		args.templateSlug,
	);
	const removed: string[] = [];
	if (scope === "all") {
		// Explicit starter initialization may begin from the baked Tedix scaffold.
		// Remove only absent files still identical to a known scaffold. Preserve
		// authored files; no-active-deployment does not mean no unpublished work.
		const oldScaffolds = new Map<string, Set<string>>();
		for (const other of Object.values(TEMPLATE_SNAPSHOTS)) {
			for (const [path, content] of Object.entries(other)) {
				if (snapshot[path] !== undefined) continue;
				const values = oldScaffolds.get(path) ?? new Set<string>();
				values.add(content);
				oldScaffolds.set(path, values);
			}
		}
		for (const [path, values] of oldScaffolds) {
			const current = await sandbox
				.readFile(`${workspace}/${path}`)
				.then((file) => file.content)
				.catch(() => null);
			if (current !== null && values.has(current)) {
				await sandbox.deleteFile(`${workspace}/${path}`);
				removed.push(path);
			}
		}
	}
	const copied: string[] = [];
	const preparedDirectories = new Set<string>();

	for (const path of paths) {
		const content = snapshot[path];
		if (content === undefined) {
			skipped.push(path);
			continue;
		}
		// A newly provisioned sandbox may have none of the nested starter
		// directories yet, including src/auth and src/components/blocks.
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent && !preparedDirectories.has(parent)) {
			await sandbox.mkdir(`${workspace}/${parent}`, {
				recursive: true,
			});
			preparedDirectories.add(parent);
		}
		await sandbox.writeFile(`${workspace}/${path}`, content);
		copied.push(path);
	}

	copied.sort();
	skipped.sort();
	return { copied, removed: removed.sort(), skipped, scope };
}
