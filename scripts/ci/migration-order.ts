/**
 * Fails when a pushed commit adds a D1 migration whose timestamp sorts before
 * the newest migration already on the push base (origin/main).
 *
 * Production applies migrations in name order and the live ledger check is
 * positional. A migration that lands with an older timestamp than one Ship has
 * already applied puts the ledger out of order, and every later deploy stops
 * at "Live D1 migration ledger diverged". On 2026-10-21 two migrations rebased
 * behind an applied one blocked every surface. The local integrity manifest
 * cannot see this: it is rewritten in the same commit. Only a comparison with
 * the base can.
 *
 * Usage: bun scripts/ci/migration-order.ts [--base <rev> --head <rev>]...
 * Without a range it compares HEAD with origin/main.
 */

import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../oss/git-env.ts";
import { NULL_SHA, parsePushRanges } from "./push-range-selection.mjs";

const DRIZZLE_DIR = "packages/db/drizzle";
const MIGRATION_DIR = /^\d{14}_[^/]+$/;

/** Migrations the head adds that do not sort after every base migration. */
export function findOutOfOrderMigrations(
	baseNames: readonly string[],
	headNames: readonly string[],
): { latestBase: string | undefined; outOfOrder: string[] } {
	const base = new Set(baseNames);
	const latestBase = [...baseNames].sort().at(-1);
	if (latestBase === undefined) return { latestBase, outOfOrder: [] };
	const outOfOrder = headNames
		.filter((name) => !base.has(name) && name <= latestBase)
		.sort();
	return { latestBase, outOfOrder };
}

function migrationNamesAt(repoRoot: string, revision: string): string[] {
	const result = spawnSync(
		"git",
		["ls-tree", "--name-only", `${revision}:${DRIZZLE_DIR}`],
		{ cwd: repoRoot, encoding: "utf8", env: detachedGitEnv() },
	);
	if (result.error || result.status !== 0) {
		throw new Error(
			`cannot list ${DRIZZLE_DIR} at ${revision}: ${result.error?.message ?? result.stderr.trim()}`,
		);
	}
	return result.stdout.split("\n").filter((name) => MIGRATION_DIR.test(name));
}

function main(argv: string[]): number {
	const repoRoot = process.cwd();
	const ranges = parsePushRanges(argv);
	if (ranges.length === 0) ranges.push({ base: "origin/main", head: "HEAD" });
	let failed = false;
	for (const { base, head } of ranges) {
		if (base === NULL_SHA) continue;
		const { latestBase, outOfOrder } = findOutOfOrderMigrations(
			migrationNamesAt(repoRoot, base),
			migrationNamesAt(repoRoot, head),
		);
		if (outOfOrder.length === 0) continue;
		failed = true;
		console.error(
			`${head} adds migration(s) that sort before ${latestBase}, the newest on ${base}:\n${outOfOrder.map((name) => `  ${name}`).join("\n")}\nProduction may already have applied ${latestBase}; an older timestamp diverges its ledger and blocks every deploy.`,
		);
	}
	if (!failed) console.log("Migration timestamps sort after the push base");
	return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
