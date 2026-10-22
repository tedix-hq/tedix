import { spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	NULL_SHA,
	parsePushRanges,
	pushesToCanonicalRepo,
} from "../../../scripts/ci/push-range-selection.mjs";
import { assertMigrationOrder } from "./check-migrations";
import {
	DrizzleKitCommandError,
	exitForDrizzleKitError,
	requireNoChanges,
	runDrizzleKit,
	type DrizzleKitResponse,
} from "./drizzle-kit-command";
import {
	parseMigrationIntegrityManifest,
	syncMigrationIntegrity,
} from "./migration-integrity";

const migrationDirectory = "packages/db/drizzle";

function git(args: string[], cwd = process.cwd()): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	if (result.status !== 0)
		throw new Error(
			`git ${args.join(" ")}: ${result.stderr || result.error?.message}`,
		);
	return result.stdout.trim();
}

function canonicalMain(): string {
	const remotes = git(["remote"]).split("\n");
	for (const remote of remotes) {
		if (pushesToCanonicalRepo(git(["remote", "get-url", remote]))) {
			return git([
				"rev-parse",
				"--verify",
				`refs/remotes/${remote}/main^{commit}`,
			]);
		}
	}
	throw new Error(
		"Cannot find canonical tedix-hq/tedix remote main; fetch it before checking or restamping migrations.",
	);
}

function migrationNamesAt(revision: string): string[] {
	if (revision === NULL_SHA) return [];
	return git(["ls-tree", "--name-only", `${revision}:${migrationDirectory}`])
		.split("\n")
		.filter((name) => /^\d{14}_[^/]+$/.test(name))
		.map((name) => `${name}/migration.sql`)
		.sort();
}

function checkMigrationPushOrder(argv: string[]): void {
	const main = canonicalMain();
	const canonical = migrationNamesAt(main);
	const ranges = parsePushRanges(argv);
	if (!ranges.length) ranges.push({ base: main, head: "HEAD" });
	for (const { base, head } of ranges) {
		const before = migrationNamesAt(base);
		const known = new Set(before);
		const added = migrationNamesAt(head).filter((name) => !known.has(name));
		// The hook's base can be a branch or a new ref. Neither may hide a
		// migration already landed on canonical main.
		assertMigrationOrder(added, [...new Set([...canonical, ...before])].sort());
	}
	console.log(
		"Migration timestamps sort strictly after canonical main and the push base",
	);
}

function restampMigration(name: string): void {
	if (!/^\d{14}_[a-zA-Z0-9_-]+$/.test(name))
		throw new Error("Expected a migration directory name");
	const root = git(["rev-parse", "--show-toplevel"]);
	const main = canonicalMain();
	if (git(["status", "--porcelain"], root))
		throw new Error(
			"Restamp requires a clean worktree; commit your changes first.",
		);
	git(["merge-base", "--is-ancestor", main, "HEAD"], root);
	if (git(["rev-list", "--count", `${main}..HEAD`], root) !== "1") {
		throw new Error(
			"Restamp amends only a single unpublished commit. Squash your unpublished commits, then retry; published commits are never amended.",
		);
	}
	const recorded = migrationNamesAt(main);
	if (recorded.includes(`${name}/migration.sql`))
		throw new Error(
			`${name}: already on canonical main; applied history cannot be restamped`,
		);
	const directory = path.join(root, migrationDirectory);
	const names = readdirSync(directory)
		.filter((entry) => /^\d{14}_[^/]+$/.test(entry))
		.sort();
	if (!names.includes(name)) throw new Error(`${name}: migration not found`);
	const published = new Set(recorded.map((entry) => entry.split("/")[0]));
	const drafts = names.filter((entry) => !published.has(entry));
	const suffix = drafts.slice(drafts.indexOf(name));
	const manifestPath = path.join(root, "packages/db/migration-integrity.json");
	const manifest = parseMigrationIntegrityManifest(
		readFileSync(manifestPath, "utf8"),
	);
	// Verify the remote prefix before replacing any locally recorded names.
	const remoteManifest = git(
		["show", `${main}:packages/db/migration-integrity.json`],
		root,
	);
	const history = parseMigrationIntegrityManifest(remoteManifest);
	for (const entry of history.migrations) {
		if (
			!manifest.migrations.some(
				(local) => local.name === entry.name && local.sha256 === entry.sha256,
			)
		)
			throw new Error(`${entry.name}: canonical ledger entry changed`);
	}
	const previous = names.filter((entry) => !suffix.includes(entry)).at(-1);
	const after = previous
		? new Date(
				`${previous.slice(0, 4)}-${previous.slice(4, 6)}-${previous.slice(6, 8)}T${previous.slice(8, 10)}:${previous.slice(10, 12)}:${previous.slice(12, 14)}Z`,
			).getTime() + 1000
		: 0;
	let timestamp = Math.max(Math.floor(Date.now() / 1000) * 1000, after);
	const moves = suffix.map((oldName) => {
		const stamp = new Date(timestamp)
			.toISOString()
			.replace(/\D/g, "")
			.slice(0, 14);
		timestamp += 1000;
		return { oldName, newName: `${stamp}${oldName.slice(14)}` };
	});
	for (const { oldName, newName } of moves) {
		if (newName !== oldName && existsSync(path.join(directory, newName)))
			throw new Error(`${newName}: destination already exists`);
	}
	for (const { oldName, newName } of moves) {
		if (oldName !== newName)
			renameSync(path.join(directory, oldName), path.join(directory, newName));
		for (const entry of manifest.migrations) {
			if (entry.name === `${oldName}/migration.sql`)
				entry.name = `${newName}/migration.sql`;
		}
	}
	manifest.migrations.sort((a, b) => a.name.localeCompare(b.name));
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	git(
		["add", "--", migrationDirectory, "packages/db/migration-integrity.json"],
		root,
	);
	git(["commit", "--amend", "--no-edit"], root);
	console.log(
		`Restamped ${moves.map(({ oldName, newName }) => `${oldName} -> ${newName}`).join(", ")}. Retry bun run push.`,
	);
}

export function finishMigrationGeneration(
	response: DrizzleKitResponse,
	mode: "check" | "generate",
	sync: typeof syncMigrationIntegrity = syncMigrationIntegrity,
): string[] {
	if (mode === "check") {
		requireNoChanges(response, "Drizzle schema snapshot check");
		return sync("check").migrations.map(({ name }) => name);
	}

	if (response.status === "missing_hints") {
		throw new DrizzleKitCommandError(
			`Migration generation needs hints:\n${JSON.stringify(response.unresolved, null, 2)}`,
			2,
		);
	}
	if (response.status === "error") {
		throw new DrizzleKitCommandError(
			`Migration generation failed (${response.error.code}):\n${JSON.stringify(response.error, null, 2)}`,
		);
	}
	if (response.status === "ok" && !response.migration_path) {
		throw new DrizzleKitCommandError(
			"Migration generation returned ok without a migration_path",
		);
	}

	return sync("draft").migrations.map(({ name }) => name);
}

export function generateMigration(argv: string[]): void {
	const check = argv.includes("--check");
	const drizzleArgs = argv.filter((arg) => arg !== "--check");
	if (
		drizzleArgs.some((arg) => arg === "--explain" || arg.startsWith("--output"))
	) {
		throw new DrizzleKitCommandError(
			"Use --check for dry runs; output mode is fixed to machine-readable JSON",
		);
	}

	// Validate recorded history before Drizzle can create any draft files.
	if (!check) syncMigrationIntegrity("draft");
	const response = runDrizzleKit([
		"generate",
		...drizzleArgs,
		...(check ? ["--explain"] : []),
	]);
	const files = finishMigrationGeneration(
		response,
		check ? "check" : "generate",
	);

	if (check) {
		console.log(
			`Drizzle schema snapshot is current; migration integrity matches (${files.length} migration(s))`,
		);
	} else if (response.status === "no_changes") {
		console.log(
			`No Drizzle schema changes; recorded history verified (${files.length} migration(s)). Pending drafts remain unrecorded; review them before bun scripts/migration-integrity.ts --write`,
		);
	} else {
		console.log(
			`Generated unrecorded draft ${response.migration_path}; review SQL and snapshot, then run bun scripts/migration-integrity.ts --write`,
		);
	}
}

if (
	import.meta.main ||
	(process.argv[1] &&
		path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
	try {
		const argv = process.argv.slice(2);
		if (argv.includes("--check-order")) checkMigrationPushOrder(argv);
		else if (argv[0] === "--restamp") restampMigration(argv[1] ?? "");
		else generateMigration(argv);
	} catch (error) {
		exitForDrizzleKitError(error);
	}
}
