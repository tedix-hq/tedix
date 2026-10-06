import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	attributedCommitCount,
	buildReport,
	coverageNote,
	overlaps,
	parseArgs,
	readCommits,
	render,
	resolveScan,
} from "./neighbours";

/**
 * This suite MUST spawn git with {@link detachedGitEnv}. The pre-push hook runs
 * the changed-script tests with `GIT_DIR` pointing at the real repository, and
 * a child git that inherits it ignores its own `cwd`, so fixture identities
 * would reach the real checkout. Identity is passed with `-c` so nothing writes config at all.
 */
const root = mkdtempSync(join(tmpdir(), "tedix-neighbours-"));

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
}

function commit(message: string, files: Record<string, string>): void {
	for (const [path, body] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	git(["add", "."]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--quiet",
		"-m",
		message,
	]);
}

const ALICE = "claude-code:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "11111111-1111-4111-8111-111111111111";

git(["init", "--quiet", "-b", "main"]);
commit(
	`fix(api): alice edits the router\n\nWork-Item: ${ITEM}\nAgent-Session: ${ALICE}\n`,
	{ "apps/api/router.ts": "alice", "docs/notes.md": "n" },
);
commit(`feat(cli): bob edits the cli\n\nAgent-Session: ${BOB}\n`, {
	"packages/cli/work.ts": "bob",
});
// A commit whose BODY contains a slash-bearing line. The naive single-pass
// implementation reported this prose as a filename.
commit(
	`docs: prose mentioning a path\n\nSee apps/api/router.ts for the contract.\nAgent-Session: ${BOB}\n`,
	{ "README.md": "r" },
);
// An ordinary human commit: no trailer, must never appear as a neighbour.
commit("chore: human commit with no session", { "human.txt": "h" });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[]) =>
	execFileSync("git", args, {
		cwd: root,
		env: detachedGitEnv(),
		encoding: "utf8",
	});

/**
 * A checkout deliberately BEHIND its remote: the neighbour's commit is
 * reachable only from `refs/remotes/origin/main`, never from HEAD. A HEAD-only
 * scan would report "No other agent session touched these paths" here.
 */
const behind = mkdtempSync(join(tmpdir(), "tedix-neighbours-behind-"));

function behindGit(args: string[]): string {
	return execFileSync("git", args, {
		cwd: behind,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
}

function behindCommit(message: string, files: Record<string, string>): void {
	for (const [path, body] of Object.entries(files)) {
		const full = join(behind, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	behindGit(["add", "."]);
	behindGit([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--quiet",
		"-m",
		message,
	]);
}

behindGit(["init", "--quiet", "-b", "main"]);
behindCommit("chore: base", { "apps/api/router.ts": "base" });
const behindBase = behindGit(["rev-parse", "HEAD"]).trim();
// Bob's work exists only ahead of where this checkout sits.
behindCommit(
	`fix(api): bob pushed ahead of you\n\nWork-Item: ${ITEM}\nAgent-Session: ${BOB}\n`,
	{
		"apps/api/router.ts": "bob",
	},
);
// A second remote-only commit attributed the other way: no Agent-Session, just
// the harness's own co-author line. Its label needs the commit AUTHOR, which
// comes from a third `git log` pass — so this is what catches that pass being
// left on a HEAD-only range while the other two are widened.
behindCommit(
	"chore(api): a harness that never heard of Tedix\n\nCo-Authored-By: Codex <noreply@openai.invalid>\n",
	{ "apps/api/helper.ts": "codex" },
);
const behindTip = behindGit(["rev-parse", "HEAD"]).trim();
behindGit(["update-ref", "refs/remotes/origin/main", behindTip]);
behindGit(["update-ref", "refs/heads/main", behindBase]);
behindGit(["checkout", "--quiet", "--force", "main"]);

afterAll(() => rmSync(behind, { recursive: true, force: true }));

const runBehind = (args: string[]) =>
	execFileSync("git", args, {
		cwd: behind,
		env: detachedGitEnv(),
		encoding: "utf8",
	});

describe("neighbours behind the remote", () => {
	test("sees a neighbour whose commit is only on the remote-tracking ref", () => {
		// Precondition: the commit really is unreachable from local HEAD.
		expect(behindGit(["rev-parse", "HEAD"]).trim()).toBe(behindBase);
		const scan = resolveScan(runBehind);
		expect(scan.remoteRefs).toContain("refs/remotes/origin/main");
		expect(scan.revs).toEqual(["HEAD", "--remotes"]);

		const report = buildReport(
			readCommits(runBehind, 24, scan),
			["apps/api/router.ts"],
			"",
		);
		expect(report.map((row) => row.session)).toEqual([BOB]);
		expect(report[0]!.paths).toEqual(["apps/api/router.ts"]);
		expect(report[0]!.workItems).toEqual([ITEM]);
	});

	test("reads the author pass over the same range as the rest", () => {
		const report = buildReport(
			readCommits(runBehind, 24, resolveScan(runBehind)),
			["apps/api/helper.ts"],
			"",
		);
		expect(report).toHaveLength(1);
		// "codex" alone would mean the author lookup came back empty because
		// that pass only saw HEAD.
		expect(report[0]!.session).toBe("codex · fixture@example.invalid");
		expect(report[0]!.tier).toBe("coauthor");
	});

	test("the HEAD-only range this replaced could not see it", () => {
		// Pins the defect: scanning HEAD alone still reports nothing, so the fix
		// is the widened range and not some incidental fixture change.
		const headOnly = buildReport(
			readCommits(runBehind, 24, {
				hasHead: true,
				remoteRefs: [],
				revs: ["HEAD"],
			}),
			["apps/api/router.ts"],
			"",
		);
		expect(headOnly).toEqual([]);
	});

	test("names the remote refs it could see", () => {
		const note = coverageNote(resolveScan(runBehind));
		expect(note).toContain("remote-tracking ref");
		expect(note).not.toContain("REDUCED");
	});
});

describe("neighbours", () => {
	test("attributes each file to the session that committed it", () => {
		const report = buildReport(readCommits(run, 24), [], "");
		const sessions = report.map((row) => row.session).sort();
		expect(sessions).toEqual([ALICE, BOB].sort());
		const alice = report.find((row) => row.session === ALICE)!;
		expect(alice.paths).toContain("apps/api/router.ts");
		expect(alice.workItems).toEqual([ITEM]);
	});

	test("never mistakes a slash-bearing body line for a path", () => {
		const report = buildReport(readCommits(run, 24), [], "");
		const bob = report.find((row) => row.session === BOB)!;
		// Bob's prose mentions apps/api/router.ts but he never edited it.
		expect(bob.paths).not.toContain("apps/api/router.ts");
		expect(bob.paths).toContain("README.md");
		expect(bob.paths).toContain("packages/cli/work.ts");
	});

	test("excludes the caller's own session", () => {
		const report = buildReport(readCommits(run, 24), [], ALICE);
		expect(report.map((row) => row.session)).toEqual([BOB]);
	});

	test("ignores commits with no Agent-Session trailer", () => {
		const report = buildReport(readCommits(run, 24), [], "");
		expect(report.flatMap((row) => row.paths)).not.toContain("human.txt");
	});

	test("narrows to the caller's scope", () => {
		const report = buildReport(readCommits(run, 24), ["apps/api"], "");
		expect(report).toHaveLength(1);
		expect(report[0]!.session).toBe(ALICE);
		expect(report[0]!.paths).toEqual(["apps/api/router.ts"]);
	});

	test("scope matches a directory prefix, not a string prefix", () => {
		// `apps/ap` must not match `apps/api/router.ts`.
		expect(overlaps("apps/api/router.ts", ["apps/ap"])).toBe(false);
		expect(overlaps("apps/api/router.ts", ["apps/api"])).toBe(true);
		expect(overlaps("apps/api/router.ts", ["apps/api/router.ts"])).toBe(true);
	});

	test("states reduced coverage when the checkout has no remote at all", () => {
		// The fixture repo has no remote. It must still run — and must SAY the
		// scan is local-only rather than quietly narrowing back to HEAD.
		const scan = resolveScan(run);
		expect(scan.remoteRefs).toEqual([]);
		expect(scan.revs).toEqual(["HEAD"]);
		const report = buildReport(readCommits(run, 24, scan), [], "");
		expect(report.length).toBeGreaterThan(0);
		const note = coverageNote(scan);
		expect(note).toContain("REDUCED");
		expect(render(report, { hours: 24, scope: [], coverage: note })).toContain(
			"REDUCED",
		);
		expect(render([], { hours: 24, scope: [], coverage: note })).toContain(
			"REDUCED",
		);
	});

	test("keeps the range claim separate from the identity claim", () => {
		// Two different 'nothing found' stories share one screen: attribution
		// says whether the repo RECORDS an agent, coverage says which commits
		// were READ. A reader must be able to tell which one they hit, so
		// neither sentence may stand in for the other.
		const note = coverageNote({
			hasHead: true,
			remoteRefs: [],
			revs: ["HEAD"],
		});
		const both = render([], {
			hours: 24,
			scope: [],
			attributed: 0,
			coverage: note,
		});
		expect(both).toContain("carries an agent identity");
		expect(both).toContain("Coverage: REDUCED");
		// The identity sentence never claims the scan was complete, and the
		// coverage line never claims anything about identity.
		expect(note).not.toContain("identity");
		const wide = coverageNote({
			hasHead: true,
			remoteRefs: ["refs/remotes/origin/main"],
			revs: ["HEAD", "--remotes"],
		});
		expect(wide).not.toContain("REDUCED");
		expect(
			render([], { hours: 24, scope: [], attributed: 7, coverage: wide }),
		).toContain("No other agent touched");
	});

	test("says so plainly when nobody is nearby", () => {
		// `attributed` is non-zero: the window HAS agent commits, none of them
		// near these paths. That is a different sentence from "cannot tell".
		const text = render([], {
			hours: 24,
			scope: ["apps/api"],
			attributed: 3,
		});
		expect(text).toContain("No other agent touched");
		expect(text).toContain("24h");
	});

	test("names the work item so the reader can go read it", () => {
		const report = buildReport(readCommits(run, 24), ["apps/api"], "");
		// Short form: enough to run `tedix work context <id>`, not a UUID wall.
		expect(render(report, { hours: 24, scope: ["apps/api"] })).toContain(
			ITEM.slice(0, 8),
		);
	});

	test("caps the work-item list instead of printing a wall of UUIDs", () => {
		const many = [
			{
				session: BOB,
				commits: 12,
				workItems: Array.from({ length: 12 }, (_, index) =>
					`${index}`.repeat(8),
				),
				paths: ["apps/api/router.ts"],
				tier: "session" as const,
			},
		];
		const text = render(many, { hours: 24, scope: [], attributed: 12 });
		expect(text).toContain("+9 more");
		expect(text.split("\n")[2]!.length).toBeLessThan(120);
	});

	test("parses flags", () => {
		expect(parseArgs(["--hours", "48", "--json"])).toMatchObject({
			hours: 48,
			json: true,
		});
		expect(parseArgs(["--fetch"]).fetch).toBe(true);
		expect(parseArgs([]).fetch).toBe(false);
		expect(parseArgs(["--paths", "a.ts, b/"]).paths).toEqual(["a.ts", "b/"]);
		expect(parseArgs(["x.ts", "y.ts"]).paths).toEqual(["x.ts", "y.ts"]);
		// A nonsense window must not silently become "everything".
		expect(parseArgs(["--hours", "0"]).hours).toBe(24);
	});
});

/**
 * The fallback tier is what makes this useful to someone who has never adopted
 * anything of ours. Claude Code, Codex and Cursor sign their own commits with
 * an AI `Co-Authored-By:` line without being asked, so a repository with zero
 * `Agent-Session:` trailers still records which agent wrote what.
 */
describe("neighbours without any Tedix adoption", () => {
	const root2 = mkdtempSync(join(tmpdir(), "tedix-neighbours-oss-"));
	const git2 = (args: string[]) =>
		execFileSync("git", args, {
			cwd: root2,
			env: detachedGitEnv(),
			encoding: "utf8",
		});
	function commit2(
		message: string,
		files: Record<string, string>,
		email: string,
	): void {
		for (const [path, body] of Object.entries(files)) {
			const full = join(root2, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, body);
		}
		git2(["add", "."]);
		git2([
			"-c",
			"user.name=Dev",
			"-c",
			`user.email=${email}`,
			"commit",
			"--quiet",
			"-m",
			message,
		]);
	}

	git2(["init", "--quiet", "-b", "main"]);
	commit2(
		"feat: alice ships a route\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n",
		{ "api/route.ts": "a" },
		"alice@example.com",
	);
	commit2(
		"fix: bob edits the same route\n\nCo-authored-by: Cursor Agent <agent@example.invalid>\n",
		{ "api/route.ts": "b" },
		"bob@example.com",
	);
	// A HUMAN co-author must never be mistaken for an agent.
	commit2(
		"chore: pair programmed\n\nCo-Authored-By: Carol <carol@example.com>\n",
		{ "api/human.ts": "c" },
		"alice@example.com",
	);

	const run2 = (args: string[]) =>
		execFileSync("git", args, {
			cwd: root2,
			env: detachedGitEnv(),
			encoding: "utf8",
		});

	test("finds agents with no Agent-Session anywhere in the repo", () => {
		const report = buildReport(readCommits(run2, 24), ["api"], "");
		const labels = report.map((row) => row.session).sort();
		expect(labels).toEqual([
			"claude · alice@example.com",
			"cursor · bob@example.com",
		]);
		expect(report.every((row) => row.tier === "coauthor")).toBe(true);
	});

	test("never counts a human co-author as an agent", () => {
		const report = buildReport(readCommits(run2, 24), [], "");
		expect(report.flatMap((row) => row.paths)).not.toContain("api/human.ts");
	});

	test("marks the coarser tier in the output so it does not read as a session", () => {
		const report = buildReport(readCommits(run2, 24), ["api"], "");
		const text = render(report, { hours: 24, scope: ["api"], attributed: 2 });
		expect(text).toContain("~");
		expect(text).toContain("Co-Authored-By");
	});

	test("distinguishes 'nobody nearby' from 'this repo records nothing'", () => {
		const cannotTell = render([], { hours: 24, scope: [], attributed: 0 });
		expect(cannotTell).toContain("cannot tell");
		const nobody = render([], { hours: 24, scope: [], attributed: 7 });
		expect(nobody).toContain("No other agent touched");
		expect(nobody).not.toContain("cannot tell");
	});

	test("counts how many commits carry any agent identity", () => {
		expect(attributedCommitCount(readCommits(run2, 24))).toBe(2);
	});

	afterAll(() => rmSync(root2, { recursive: true, force: true }));
});
