import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const script = path.join(import.meta.dirname, "generate-migration.ts");
const published = "20260101000000_published";
const draft = "20260102000000_draft";
const fixtures: string[] = [];

const env = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.test",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.test",
};

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function writeMigration(root: string, name: string): void {
	const directory = path.join(root, "packages/db/drizzle", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "migration.sql"), `-- ${name}\n`);
}

/** A repo whose canonical main holds one published migration and HEAD adds one draft. */
function fixtureRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "restamp-"));
	fixtures.push(root);
	run("git", ["init", "-q", "-b", "main"], root);
	run(
		"git",
		["remote", "add", "origin", "https://github.com/tedix-hq/tedix.git"],
		root,
	);
	writeMigration(root, published);
	writeFileSync(
		path.join(root, "packages/db/migration-integrity.json"),
		`${JSON.stringify({ version: 1, migrations: [{ name: `${published}/migration.sql`, sha256: "0".repeat(64) }] }, null, "\t")}\n`,
	);
	run("git", ["add", "."], root);
	run("git", ["commit", "-qm", "published"], root);
	run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
	writeMigration(root, draft);
	run("git", ["add", "."], root);
	run("git", ["commit", "-qm", "draft"], root);
	return root;
}

function migrations(root: string): string[] {
	return readdirSync(path.join(root, "packages/db/drizzle")).sort();
}

afterAll(() => {
	for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("restamp from either working directory", () => {
	it.each(["", "packages/db"])(
		"keeps the published migration name when run from %j",
		(relative) => {
			const root = fixtureRepo();
			const cwd = path.join(root, relative);
			run("bun", [script, "--check-order"], cwd);
			run("bun", [script, "--restamp", draft], cwd);

			const [first, second, ...rest] = migrations(root);
			expect(rest).toEqual([]);
			expect(first).toBe(published);
			expect(second).toMatch(/^\d{14}_draft$/);
			expect(second > draft).toBe(true);
			expect(
				JSON.parse(
					readFileSync(
						path.join(root, "packages/db/migration-integrity.json"),
						"utf8",
					),
				).migrations.map(({ name }: { name: string }) => name),
			).toEqual([`${published}/migration.sql`]);
			expect(run("git", ["status", "--porcelain"], root)).toBe("");
		},
	);
});
