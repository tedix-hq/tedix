#!/usr/bin/env bun
/**
 * Seed cms-starter-<slug> Artifacts repos with the template history sites need
 * for theme_starter_diff / theme_starter_apply baselines.
 *
 * For every commit that touched apps/cms/templates/<slug> (plus the shared
 * tedix locked sources marketing falls back to), the script rebuilds the
 * template snapshot exactly as generate-template-snapshot.ts collects it and
 * pushes one starter commit per distinct snapshot, marked with the Tedix
 * commit and the template's upstreamStarterRevision.
 *
 * Requires: git, bun, and Artifacts write access:
 *   CMS_ARTIFACTS_ACCOUNT_ID   Cloudflare account id
 *   CMS_ARTIFACTS_TOKEN        Artifacts token with write scope on the namespace
 *   CMS_ARTIFACTS_NAMESPACE    default "tedix-prod"
 *
 * Usage:
 *   bun apps/cms/scripts/seed-starter-repos.ts [--slug tedix] [--dry-run]
 *
 * The Worker keeps these repos current afterwards; re-run after large template
 * history imports or to repair a repo.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CMS_TEMPLATE_SLUGS } from "../src/template-policy";
import { collectTemplateEntries } from "./generate-template-snapshot";
import {
	starterEntriesHash,
	starterMarkerContent,
	starterRepoName,
	starterRemote,
} from "../src/agent/starter-source";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const TEMPLATE_PREFIX = "apps/cms/templates";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const slugFlag = args.indexOf("--slug");
const onlySlug = slugFlag !== -1 ? args[slugFlag + 1] : undefined;

const accountId = process.env.CMS_ARTIFACTS_ACCOUNT_ID;
const token = process.env.CMS_ARTIFACTS_TOKEN;
const namespace = process.env.CMS_ARTIFACTS_NAMESPACE ?? "tedix-prod";
if (!dryRun && (!accountId || !token)) {
	console.error(
		"CMS_ARTIFACTS_ACCOUNT_ID and CMS_ARTIFACTS_TOKEN are required (or pass --dry-run)",
	);
	process.exit(1);
}

function git(cwd: string, argv: string[]): string {
	const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function upstreamRevision(entries: Record<string, string>): string | undefined {
	const raw = entries["src/theme-release.json"];
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { upstreamStarterRevision?: unknown };
		return typeof parsed.upstreamStarterRevision === "string"
			? parsed.upstreamStarterRevision
			: undefined;
	} catch {
		return undefined;
	}
}

async function main() {
	const slugs = onlySlug
		? [onlySlug as (typeof CMS_TEMPLATE_SLUGS)[number]]
		: CMS_TEMPLATE_SLUGS;
	const scratch = await mkdtemp(join(tmpdir(), "cms-starter-seed-"));
	try {
		for (const slug of slugs) {
			// Every commit touching this template; marketing also reads shared
			// locked files from templates/tedix, so include that history.
			const paths =
				slug === "marketing"
					? [`${TEMPLATE_PREFIX}/marketing`, `${TEMPLATE_PREFIX}/tedix`]
					: [`${TEMPLATE_PREFIX}/${slug}`];
			const revs = git(REPO_ROOT, [
				"log",
				"--format=%H",
				"--reverse",
				"--",
				...paths,
			])
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			if (revs.length === 0) {
				console.log(`[seed] ${slug}: no template history, skipped`);
				continue;
			}

			const seen = new Set<string>();
			const states: Array<{
				rev: string;
				entries: Record<string, string>;
				snapshotHash: string;
			}> = [];
			for (const rev of revs) {
				const extractDir = join(scratch, `${slug}-${rev.slice(0, 8)}`);
				await mkdir(extractDir, { recursive: true });
				// Extract via tar into a dir that mirrors apps/cms/templates.
				const tar = spawnSync(
					"bash",
					[
						"-c",
						`git -C "${REPO_ROOT}" archive ${rev} ${TEMPLATE_PREFIX} | tar -x -C "${extractDir}"`,
					],
					{ encoding: "utf8" },
				);
				if (tar.status !== 0) {
					throw new Error(`archive ${rev} failed: ${tar.stderr}`);
				}
				const collected = await collectTemplateEntries(
					slug as never,
					join(extractDir, "apps", "cms"),
				);
				const entries = Object.fromEntries(
					collected.map((entry) => [entry.rel, entry.content]),
				);
				const snapshotHash = await starterEntriesHash(entries);
				if (seen.has(snapshotHash)) continue;
				seen.add(snapshotHash);
				states.push({ rev, entries, snapshotHash });
				console.log(
					`[seed] ${slug}: ${rev.slice(0, 12)} -> snapshot ${snapshotHash.slice(0, 12)} (${Object.keys(entries).length} files)`,
				);
			}

			if (states.length === 0) continue;
			if (dryRun) {
				console.log(`[seed] ${slug}: dry-run, ${states.length} commits`);
				continue;
			}

			// Build the starter history in a scratch git repo, then push once.
			const work = join(scratch, `${slug}-work`);
			await mkdir(work, { recursive: true });
			git(work, ["init", "-b", "main"]);
			git(work, ["config", "user.name", "Tedix Starter Seed"]);
			git(work, ["config", "user.email", "starter-seed@tedix.dev"]);
			let hasCommit = false;
			for (const state of states) {
				// Reset worktree to just this snapshot.
				if (hasCommit) {
					git(work, ["rm", "-rf", "."]);
					git(work, ["clean", "-fdx"]);
				}
				for (const [path, content] of Object.entries(state.entries)) {
					const target = join(work, path);
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, content);
				}
				const marker = starterMarkerContent({
					templateSlug: slug,
					snapshotHash: state.snapshotHash,
					tedixCommit: state.rev,
					upstreamStarterRevision: upstreamRevision(state.entries),
				});
				await writeFile(join(work, ".cms-starter.json"), marker);
				git(work, ["add", "-A"]);
				git(work, [
					"commit",
					"-m",
					`Starter "${slug}" snapshot ${state.snapshotHash.slice(0, 12)} (tedix ${state.rev.slice(0, 12)})`,
				]);
				hasCommit = true;
			}
			const remote = starterRemote(accountId!, namespace, slug);
			const push = spawnSync(
				"git",
				[
					"-C",
					work,
					"-c",
					`http.extraHeader=Authorization: Bearer ${token}`,
					"push",
					remote,
					"HEAD:refs/heads/main",
				],
				{ encoding: "utf8" },
			);
			if (push.status !== 0) {
				console.error(`[seed] ${slug}: push failed: ${push.stderr}`);
				process.exitCode = 1;
				continue;
			}
			console.log(
				`[seed] ${slug}: pushed ${states.length} commits -> ${remote}`,
			);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("[seed-starter-repos] failed:", error);
		process.exit(1);
	});
}
