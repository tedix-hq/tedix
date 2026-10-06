import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	breakingNotes,
	checkCommits,
	classifyCommit,
	defaultFromRef,
	INITIAL_HISTORY_REF,
	type CommitRecord,
	parseSubject,
	readCommitRange,
	renderReleaseNotes,
} from "./generate-release-notes";
import { detachedGitEnv } from "../oss/git-env";

const REPOSITORY_URL = "https://github.com/tedix-hq/tedix";
const temporaryRepositories: string[] = [];

afterEach(() => {
	for (const repository of temporaryRepositories.splice(0)) {
		rmSync(repository, { recursive: true, force: true });
	}
});

/**
 * Fixture git MUST run with {@link detachedGitEnv} and MUST carry its identity
 * on the command line.
 *
 * `.githooks/pre-push` exports `GIT_DIR` at the real repository, and a child
 * git that inherits it ignores its own `cwd`: `git config user.email` aimed at
 * a temp directory then wrote `Tedix Test <test@tedix.invalid>` into the
 * developer's actual checkout, and later commits — including ones pushed to
 * immutable main — were signed by an address that maps to no account. Passing
 * the identity with `-c` writes no config at all, so even a future env
 * regression cannot leak it.
 */
function git(
	repository: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): void {
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Tedix Test",
			"-c",
			"user.email=test@tedix.invalid",
			...args,
		],
		{ cwd: repository, env: { ...detachedGitEnv(), ...env } },
	);
}

function firstReleaseRepository(): string {
	const repository = mkdtempSync(resolve(tmpdir(), "tedix-release-notes-"));
	temporaryRepositories.push(repository);
	git(repository, ["init", "--initial-branch=main"]);
	writeFileSync(resolve(repository, "README.md"), "# First release\n");
	git(repository, ["add", "README.md"]);
	git(repository, ["commit", "-m", "feat: publish first release"], {
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	});
	return repository;
}

describe("first release range", () => {
	test("includes root history when no prior version tag exists", () => {
		const repository = firstReleaseRepository();
		expect(defaultFromRef(repository, "HEAD")).toBe(INITIAL_HISTORY_REF);
		expect(readCommitRange(repository, INITIAL_HISTORY_REF, "HEAD")).toEqual([
			expect.objectContaining({ subject: "feat: publish first release" }),
		]);
	});

	test("keeps root history when the current commit has the first version tag", () => {
		const repository = firstReleaseRepository();
		git(repository, ["tag", "v0.1.0"]);
		expect(defaultFromRef(repository, "v0.1.0")).toBe(INITIAL_HISTORY_REF);
	});
});

function commit(
	subject: string,
	overrides: Partial<Omit<CommitRecord, "subject">> = {},
): CommitRecord {
	const seed = subject.length.toString(16).padStart(2, "0");
	return {
		sha: overrides.sha ?? `${seed}${"abcdef0123456789".repeat(3)}`.slice(0, 40),
		subject,
		body: overrides.body ?? "",
		files: overrides.files ?? [],
	};
}

describe("conventional subject grammar", () => {
	test("parses a plain typed subject", () => {
		expect(parseSubject("fix: settle the turn")).toEqual({
			type: "fix",
			scopes: [],
			bang: false,
			description: "settle the turn",
		});
	});

	test("parses scope, multi-scope, and the breaking bang", () => {
		expect(parseSubject("feat(os): pin the Home thread")).toEqual({
			type: "feat",
			scopes: ["os"],
			bang: false,
			description: "pin the Home thread",
		});
		expect(parseSubject("feat(mcp,cli): cut payload amplification")).toEqual({
			type: "feat",
			scopes: ["mcp", "cli"],
			bang: false,
			description: "cut payload amplification",
		});
		expect(parseSubject("feat(auth)!: drop legacy slug routes")?.bang).toBe(
			true,
		);
		expect(parseSubject("refactor!: rename the gateway env")?.bang).toBe(true);
	});

	test("rejects non-conventional subjects", () => {
		expect(parseSubject("Update readme")).toBeNull();
		expect(parseSubject("fix settle the turn")).toBeNull();
		expect(parseSubject("fix:missing space")).toBeNull();
		expect(parseSubject("fix: ")).toBeNull();
		expect(parseSubject("Fix(api): uppercase type")).toBeNull();
		expect(parseSubject("fix(two words): spaced scope")).toBeNull();
		expect(parseSubject('Revert "feat(os): pin the thread"')).toBeNull();
	});
});

describe("breaking-change detection", () => {
	test("collects BREAKING footer lines from the body", () => {
		expect(
			breakingNotes(
				"Long explanation.\n\nBREAKING CHANGE: slug routes removed\nBREAKING-CHANGE: env renamed",
			),
		).toEqual([
			"BREAKING CHANGE: slug routes removed",
			"BREAKING-CHANGE: env renamed",
		]);
	});

	test("ignores mid-line mentions of the word", () => {
		expect(breakingNotes("this avoids BREAKING behavior later")).toEqual([]);
	});

	test("classifies bang subjects and footer bodies as breaking", () => {
		expect(classifyCommit(commit("feat(auth)!: drop routes")).breaking).toBe(
			true,
		);
		expect(
			classifyCommit(
				commit("fix(db): tighten types", {
					body: "BREAKING CHANGE: rows are now arrays",
				}),
			).breaking,
		).toBe(true);
		expect(classifyCommit(commit("fix(db): tighten types")).breaking).toBe(
			false,
		);
	});
});

describe("contract-surface classification", () => {
	test("flags only the stable contract path prefixes", () => {
		expect(
			classifyCommit(
				commit("feat(contracts): add schema", {
					files: ["packages/api-contract/src/contracts/cognitive.ts"],
				}),
			).contractSurfaces,
		).toEqual(["packages/api-contract/"]);
		expect(
			classifyCommit(
				commit("fix(db): partition the index", {
					files: ["packages/db/src/schema/work-items.ts"],
				}),
			).contractSurfaces,
		).toEqual(["packages/db/src/schema/"]);
		expect(
			classifyCommit(
				commit("fix(db): query change", {
					files: [
						"packages/db/src/queries/cognitive/skill-validation.ts",
						"apps/api/src/rpc/routers/cognitive.ts",
					],
				}),
			).contractSurfaces,
		).toEqual([]);
	});
});

describe("checkCommits", () => {
	test("reports each non-conventional commit with its sha", () => {
		const bad = commit("WIP stuff", { sha: "f".repeat(40) });
		const result = checkCommits([commit("fix(api): good"), bad]);
		expect(result.ok).toBe(false);
		expect(result.offenders).toHaveLength(1);
		expect(result.offenders[0]?.sha).toBe(bad.sha);
		expect(result.offenders[0]?.subject).toBe("WIP stuff");
	});

	test("passes a fully conventional range", () => {
		expect(
			checkCommits([
				commit("feat(mcp): add flow tools"),
				commit("style: format the drift"),
				commit("chore(deps): bump the agents batch"),
			]),
		).toEqual({ ok: true, offenders: [] });
	});
});

describe("renderReleaseNotes", () => {
	const records: CommitRecord[] = [
		commit("feat(mcp): flow.* Code Mode tools", { sha: "1".repeat(40) }),
		commit("feat(os): pin the Home thread", { sha: "2".repeat(40) }),
		commit("feat: teach the gateway the off-context pattern", {
			sha: "3".repeat(40),
		}),
		commit("fix(db): render drift statements", { sha: "4".repeat(40) }),
		commit("perf(api): trim isolate startup CPU", { sha: "5".repeat(40) }),
		commit("refactor(ci): make the warning gate differential", {
			sha: "6".repeat(40),
		}),
		commit("docs(oss): boundary statement", { sha: "7".repeat(40) }),
		commit("test(work): cover the wake lease", { sha: "8".repeat(40) }),
		commit("chore(repo): ignore the cache", { sha: "9".repeat(40) }),
		commit("WIP try things", { sha: "a".repeat(40) }),
		commit("feat(auth)!: require step-up everywhere", {
			sha: "b".repeat(40),
			body: "BREAKING CHANGE: sessions without su claims are rejected",
		}),
		commit("fix(contracts): use JsonRecordSchema for source metadata", {
			sha: "c".repeat(40),
			files: [
				"packages/api-contract/src/schemas/kernel-runtime.ts",
				"packages/db/src/schema/work-items.ts",
			],
		}),
	];
	const options = {
		version: "v0.2.0",
		from: "v0.1.0",
		to: "v0.2.0",
		repositoryUrl: REPOSITORY_URL,
	};

	test("is deterministic across renders", () => {
		expect(renderReleaseNotes(records, options)).toBe(
			renderReleaseNotes(records, options),
		);
	});

	test("orders sections and groups by type then scope", () => {
		const notes = renderReleaseNotes(records, options);
		const order = [
			"# Tedix v0.2.0",
			"## Breaking changes",
			"## Features",
			"## Fixes",
			"## Performance",
			"## Other changes",
			"## Contracts and compatibility",
			"## Unclassified commits",
		];
		const positions = order.map((heading) => notes.indexOf(heading));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		// Within Features: scopes sort ascending, scopeless entries last.
		const features = notes.slice(
			notes.indexOf("## Features"),
			notes.indexOf("## Fixes"),
		);
		const mcp = features.indexOf("**mcp:**");
		const os = features.indexOf("**os:**");
		const scopeless = features.indexOf("off-context pattern");
		expect(mcp).toBeGreaterThan(-1);
		expect(os).toBeGreaterThan(mcp);
		expect(scopeless).toBeGreaterThan(os);
	});

	test("links each entry to its commit by short sha", () => {
		const notes = renderReleaseNotes(records, options);
		expect(notes).toContain(
			`[${"1".repeat(9)}](${REPOSITORY_URL}/commit/${"1".repeat(40)})`,
		);
	});

	test("highlights breaking commits with their footer notes", () => {
		const notes = renderReleaseNotes(records, options);
		const breaking = notes.slice(
			notes.indexOf("## Breaking changes"),
			notes.indexOf("## Features"),
		);
		expect(breaking).toContain("**feat(auth)!:** require step-up everywhere");
		expect(breaking).toContain(
			"  - BREAKING CHANGE: sessions without su claims are rejected",
		);
	});

	test("collapses docs/test/chore into one count line by default", () => {
		const notes = renderReleaseNotes(records, options);
		expect(notes).toContain(
			"_3 internal commits (docs, test, chore) not listed — rerun with `--full` to include them._",
		);
		expect(notes).not.toContain("boundary statement");
	});

	test("lists the collapsed types as sections under --full", () => {
		const notes = renderReleaseNotes(records, { ...options, full: true });
		expect(notes).toContain("## Documentation");
		expect(notes).toContain("## Tests");
		expect(notes).toContain("## Chores");
		expect(notes).toContain("boundary statement");
		expect(notes).not.toContain("internal commits (docs, test, chore)");
	});

	test("lists contract-surface commits with their touched surfaces", () => {
		const notes = renderReleaseNotes(records, options);
		const section = notes.slice(
			notes.indexOf("## Contracts and compatibility"),
			notes.indexOf("## Unclassified commits"),
		);
		expect(section).toContain(
			"fix(contracts): use JsonRecordSchema for source metadata",
		);
		expect(section).toContain("`packages/api-contract`");
		expect(section).toContain("`packages/db/src/schema`");
		expect(section).not.toContain("flow.* Code Mode tools");
	});

	test("reports an explicit empty contract section when nothing touched them", () => {
		const notes = renderReleaseNotes([commit("fix(api): small")], options);
		expect(notes).toContain(
			"No commits in this range touched `packages/api-contract` or `packages/db/src/schema`.",
		);
	});

	test("keeps non-conventional commits visible as unclassified", () => {
		const notes = renderReleaseNotes(records, options);
		const section = notes.slice(notes.indexOf("## Unclassified commits"));
		expect(section).toContain("WIP try things");
	});

	test("renders an empty range without inventing content", () => {
		const notes = renderReleaseNotes([], options);
		expect(notes).toContain("Commit range: `v0.1.0..v0.2.0` — 0 commits.");
		expect(notes).toContain("No commits in range.");
		expect(notes).not.toContain("## Features");
	});

	test("never embeds a wall-clock date in the body", () => {
		const notes = renderReleaseNotes(records, options);
		expect(notes).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
	});
});
