/**
 * Report which OTHER agent sessions have recently touched the paths you are
 * about to work on.
 *
 * The gap this closes is a reading gap, not a missing feature. The board
 * already records who holds what: `tedix work resource-list` shows file-scoped
 * exclusive pools, and every commit carries `Agent-Session:`. But
 * `tedix work list` returns titles only, finding a live attempt costs one call
 * per item, and nothing puts either in front of a fresh harness session.
 *
 * Agents re-treading each other's ground is a common rework mode, so the
 * cheapest intervention is to make neighbours visible before work starts
 * rather than after it collides.
 *
 * Deliberately git-only: no board call, no network, no credential — and it
 * needs no adoption. Commits are attributed in two tiers: an `Agent-Session:`
 * trailer when the repository governs its agents, otherwise the AI
 * `Co-Authored-By:` line that Claude Code, Codex and Cursor append to their own
 * commits, paired with the commit author. The second tier is why this is useful
 * on a repository that has never heard of Tedix. It also stays usable when the
 * gateway is down.
 *
 * Scans local HEAD union every remote-tracking ref. `git log --since=...`
 * with no revision means HEAD, and an agent is most likely to be behind
 * origin/main at the start of a task — exactly when it runs this check and
 * exactly when the duplicated work is still avoidable. Remote-tracking refs are already on disk, so the wider range
 * costs no network and keeps the no-credential promise above; `--fetch` is the
 * opt-in that refreshes them first.
 *
 * Coverage is always stated, and it is a different claim from the attribution
 * sentences below: those say whether the repository RECORDS an agent identity,
 * this says which commits were READ at all. A checkout with no remote-tracking
 * refs — offline clone, fresh `git init`, no remote — still runs and still
 * exits 0, but it says its scan is local-only. Narrowing back to HEAD silently
 * is the bug itself, so silence is the one thing this must never do.
 *
 * ADVISORY BY DESIGN: always exits 0. A check that blocks on overlap teaches
 * people to skip it, and overlap is frequently legitimate — two agents may
 * correctly touch one hot file. This reports; the reader decides.
 *
 * Zero dependencies. `tedix who` renders the same scan for someone with no
 * Tedix vocabulary; this file's own `main` is `bun run work:neighbours`.
 *
 * Usage:
 *   bun run work:neighbours                 # your uncommitted paths
 *   bun run work:neighbours --paths a.ts,b/ # explicit paths
 *   bun run work:neighbours --hours 48
 *   bun run work:neighbours --json
 *   bun run work:neighbours --fetch          # opt in to a git fetch
 */

import { execFileSync } from "node:child_process";

export type GitRunner = (args: string[]) => string;

/**
 * Which revisions the scan can read. `revs` is what gets passed to `git log`:
 * `HEAD` when the checkout has one, plus `--remotes` when any remote-tracking
 * ref exists. Both are conditional because `git log --remotes` errors out in a
 * repository that has none.
 */
export interface Scan {
	hasHead: boolean;
	remoteRefs: string[];
	revs: string[];
}

export type AttributionTier = "session" | "coauthor";

export interface Commits {
	sessions: Map<string, string>;
	items: Map<string, string>;
	files: Map<string, Set<string>>;
	coAuthors: Map<string, string>;
	authors: Map<string, string>;
}

export interface Actor {
	id: string;
	label: string;
	tier: AttributionTier;
}

export interface NeighbourRow {
	session: string;
	tier: AttributionTier;
	commits: number;
	workItems: string[];
	paths: string[];
}

/**
 * Separators that cannot occur in a git commit body.
 *
 * Built with `String.fromCharCode` on purpose. Written as a unicode escape
 * the formatter rewrites them to LITERAL control characters, which are
 * invisible in a diff, in review, and in an editor — and this repo has
 * already lost regex escapes to a formatter once. Do not 'tidy' these back
 * into string literals.
 */
const FIELD = String.fromCharCode(31); // US, unit separator
const RECORD = String.fromCharCode(30); // RS, record separator
/** Marks a commit header line in the name-only pass. STX. */
const COMMIT_MARK = String.fromCharCode(2);

const AGENT_SESSION = /^Agent-Session:[ \t]*(\S+)/m;
const WORK_ITEM = /^Work-Item:[ \t]*(\S+)/m;
/**
 * An AI co-author trailer, which the coding harnesses add by themselves.
 * This is the whole reason the fallback tier exists: a repository that has
 * never heard of Tedix still records WHICH agent wrote a commit, because
 * Claude Code, Codex and Cursor all sign their own work.
 */
const AI_COAUTHOR = /^Co-[Aa]uthored-[Bb]y:[ \t]*([^<\n]*?)\s*</m;
const AI_NAME =
	/(claude|codex|cursor|copilot|gemini|opencode|devin|openai|anthropic)/i;

export function parseArgs(argv: string[]) {
	const args = {
		fetch: false,
		hours: 24,
		json: false,
		paths: [] as string[],
		session: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index] ?? "";
		if (value === "--json") args.json = true;
		else if (value === "--fetch") args.fetch = true;
		else if (value === "--hours") args.hours = Number(argv[++index]);
		else if (value === "--session") args.session = String(argv[++index] ?? "");
		else if (value === "--paths")
			args.paths = String(argv[++index] ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
		else if (!value.startsWith("--")) args.paths.push(value);
	}
	if (!Number.isFinite(args.hours) || args.hours <= 0) args.hours = 24;
	return args;
}

/**
 * Decide which revisions the scan reads, and how honest it can be about them.
 *
 * Three strategies were on the table. Fetching on every invocation would make a
 * fast local check depend on the network and on a credential, breaking the
 * git-only promise in the header, so it is opt-in (`--fetch`) only. Reading
 * only the tracking ref would go blind in a repo with no remote and would miss
 * local work that has not been pushed. The union of local `HEAD` and every
 * `refs/remotes/*` ref is what ships: both halves are already on disk, it needs
 * no remote name guess (`--remotes` covers `@{upstream}`, `origin/main`, and
 * any other), and git dedupes commits reachable from several of them.
 *
 * What it cannot do is see a commit pushed since the last fetch. That is a real
 * limit, so it is printed rather than assumed away.
 */
export function resolveScan(run: GitRunner): Scan {
	let hasHead = false;
	try {
		run(["rev-parse", "--verify", "--quiet", "HEAD"]);
		hasHead = true;
	} catch {
		hasHead = false;
	}
	let remoteRefs: string[] = [];
	try {
		remoteRefs = run(["for-each-ref", "--format=%(refname)", "refs/remotes/"])
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		remoteRefs = [];
	}
	const revs: string[] = [];
	if (hasHead) revs.push("HEAD");
	// `--remotes` is a rev argument, not an option: it expands to every
	// remote-tracking ref. Adding it with no such ref present makes git log
	// error out, so it is conditional.
	if (remoteRefs.length > 0) revs.push("--remotes");
	return { hasHead, remoteRefs, revs };
}

/**
 * One line saying what the scan could actually READ, printed every run.
 *
 * Deliberately distinct from the attribution sentences in {@link render}: those
 * answer "does this repository record who an agent is", this answers "which
 * commits did I even look at". A reader hitting an empty result needs to know
 * which of the two they are in.
 */
export function coverageNote(scan: Scan): string {
	if (scan.revs.length === 0) {
		return "Coverage: NOTHING scanned — this checkout has no commits and no remote-tracking refs.";
	}
	if (scan.remoteRefs.length === 0) {
		return "Coverage: REDUCED — read local history only. No remote-tracking ref exists here, so a commit another session has already pushed is invisible to this scan. `git fetch` (or --fetch) widens it.";
	}
	const count = scan.remoteRefs.length;
	return `Coverage: read local HEAD plus ${count} remote-tracking ref${
		count === 1 ? "" : "s"
	} as of your last fetch; anything pushed since then is invisible until you fetch.`;
}

/**
 * Two passes, deliberately. A single `git log --name-only` interleaves the
 * commit BODY with the file list, and a body line containing a slash is
 * indistinguishable from a path — the ad-hoc version of this check reported
 * prose as filenames. Bodies come from one pass with explicit separators,
 * paths from another that emits nothing else.
 */
export function readCommits(
	run: GitRunner,
	hours: number,
	scan: Scan = resolveScan(run),
): Commits {
	const since = `--since=${hours}.hours`;
	if (scan.revs.length === 0)
		return {
			sessions: new Map(),
			items: new Map(),
			files: new Map(),
			coAuthors: new Map(),
			authors: new Map(),
		};
	const bodies = run([
		"log",
		since,
		`--pretty=format:%H${FIELD}%b${RECORD}`,
		...scan.revs,
	]);
	const sessions = new Map<string, string>();
	const items = new Map<string, string>();
	const coAuthors = new Map<string, string>();
	const authors = new Map<string, string>();
	for (const record of bodies.split(RECORD)) {
		const trimmed = record.trim();
		if (!trimmed) continue;
		const [sha, body = ""] = trimmed.split(FIELD);
		if (!sha) continue;
		const session = AGENT_SESSION.exec(body)?.[1] ?? "";
		if (session) sessions.set(sha.trim(), session);
		const item = WORK_ITEM.exec(body)?.[1] ?? "";
		if (item) items.set(sha.trim(), item);
		const coAuthor = AI_COAUTHOR.exec(body)?.[1]?.trim() ?? "";
		if (coAuthor && AI_NAME.test(coAuthor)) coAuthors.set(sha.trim(), coAuthor);
	}

	// The commit author distinguishes two people driving the same harness. It
	// is only consulted in the fallback tier, where no session key exists.
	const authored = run([
		"log",
		since,
		`--pretty=format:%H${FIELD}%ae`,
		...scan.revs,
	]);
	for (const line of authored.split("\n")) {
		const [sha, email = ""] = line.trim().split(FIELD);
		if (sha) authors.set(sha.trim(), email.trim());
	}

	const named = run([
		"log",
		since,
		`--pretty=format:${COMMIT_MARK}%H`,
		"--name-only",
		...scan.revs,
	]);
	const files = new Map<string, Set<string>>();
	let current = "";
	for (const line of named.split("\n")) {
		if (line.startsWith(COMMIT_MARK)) {
			current = line.slice(1).trim();
			continue;
		}
		const path = line.trim();
		if (!current || !path) continue;
		if (!files.has(current)) files.set(current, new Set());
		files.get(current)!.add(path);
	}
	return { sessions, items, files, coAuthors, authors };
}

/** A path is in scope when it equals, or sits under, one of the given paths. */
export function overlaps(path: string, scope: string[]): boolean {
	if (scope.length === 0) return true;
	return scope.some(
		(entry) =>
			path === entry ||
			path.startsWith(entry.endsWith("/") ? entry : `${entry}/`),
	);
}

/**
 * Who made this commit, and how confidently do we know.
 *
 * Tier 1 is the `Agent-Session:` trailer: a harness and a session id, exact.
 * Tier 2 is the harness signing its own work — Claude Code, Codex and Cursor
 * all append an AI `Co-Authored-By:` without being asked — paired with the
 * commit author, because two people driving the same harness are two
 * neighbours. Tier 2 is why this is useful in a repository that has never
 * adopted anything of ours; tier 1 is why it is precise in one that has.
 */
export function actorOf(
	sha: string,
	{ sessions, coAuthors, authors }: Commits,
): Actor | null {
	const session = sessions.get(sha);
	if (session) return { id: session, label: session, tier: "session" };
	const co = coAuthors.get(sha);
	if (!co) return null;
	const harness = AI_NAME.exec(co)?.[1]?.toLowerCase() ?? "agent";
	const who = authors.get(sha) ?? "";
	const id = `${harness}|${who}`;
	return { id, label: who ? `${harness} · ${who}` : harness, tier: "coauthor" };
}

export function buildReport(
	commits: Commits,
	scope: string[],
	mySession: string,
): NeighbourRow[] {
	const { items, files } = commits;
	const neighbours = new Map<
		string,
		{
			commits: (string | null)[];
			paths: Set<string>;
			label: string;
			tier: AttributionTier;
		}
	>();
	for (const [sha, paths] of files) {
		const actor = actorOf(sha, commits);
		if (!actor) continue;
		const session = actor.id;
		if (session === mySession) continue;
		const hits = [...paths].filter((path) => overlaps(path, scope));
		if (hits.length === 0) continue;
		if (!neighbours.has(session))
			neighbours.set(session, {
				commits: [],
				paths: new Set(),
				label: actor.label,
				tier: actor.tier,
			});
		const row = neighbours.get(session)!;
		row.commits.push(items.get(sha) ?? null);
		for (const hit of hits) row.paths.add(hit);
	}
	return [...neighbours.entries()]
		.map(([session, row]) => ({
			session: row.label,
			tier: row.tier,
			commits: row.commits.length,
			workItems: [
				...new Set(row.commits.filter((id): id is string => Boolean(id))),
			],
			paths: [...row.paths].sort(),
		}))
		.sort((a, b) => b.paths.length - a.paths.length);
}

/**
 * How many commits in the window carry ANY agent attribution. Reported so an
 * empty result can say which empty it is. This whole tool exists because
 * information that is never surfaced may as well not exist, and "no neighbours"
 * printed over a repository that simply records no agent identity is the same
 * failure wearing a friendlier face.
 */
export function attributedCommitCount(commits: Commits): number {
	let n = 0;
	for (const sha of commits.files.keys()) if (actorOf(sha, commits)) n += 1;
	return n;
}

/**
 * `attributed` is how many commits in the window carry ANY agent identity, so
 *   an empty report can say which empty it is. `null` means uncounted.
 *   `coverage` says which commits were read at all — a separate claim, and the
 *   one that matters most under an empty result.
 */
export function render(
	report: NeighbourRow[],
	{
		hours,
		scope,
		attributed = null,
		coverage = "",
	}: {
		hours: number;
		scope: string[];
		attributed?: number | null;
		coverage?: string;
	},
): string {
	const footer = coverage ? ["", coverage] : [];
	if (report.length === 0) {
		if (attributed === 0) {
			return [
				`No commit in the last ${hours}h carries an agent identity, so this`,
				"cannot tell you whether anyone is nearby — only that the repository",
				"does not record it. Agent commits are recognised by an",
				"`Agent-Session:` trailer, or by the `Co-Authored-By:` line Claude",
				"Code, Codex and Cursor add to their own commits.",
				...footer,
			].join("\n");
		}
		return [
			`No other agent touched ${
				scope.length ? "these paths" : "this repo"
			} in the last ${hours}h.`,
			...footer,
		].join("\n");
	}
	const lines = [
		`${report.length} other agent session${
			report.length === 1 ? "" : "s"
		} touched your paths in the last ${hours}h:`,
		"",
	];
	for (const row of report) {
		// A busy session can carry a dozen Work Items. Printing every UUID turns
		// the one line a reader scans into a wall, so show enough to go look and
		// count the rest.
		const shown = row.workItems.slice(0, 3).map((id) => id.slice(0, 8));
		const rest = row.workItems.length - shown.length;
		const items = row.workItems.length
			? `[${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}]`
			: "[no Work-Item trailer]";
		// A co-author-tier row is a real neighbour identified less precisely; say
		// so rather than let it read as a session key.
		const tier = row.tier === "coauthor" ? "  ~" : "";
		lines.push(
			`  ${row.session}  ${row.commits} commit${
				row.commits === 1 ? "" : "s"
			}  ${items}${tier}`,
		);
		for (const path of row.paths.slice(0, 8)) lines.push(`      ${path}`);
		if (row.paths.length > 8)
			lines.push(`      … ${row.paths.length - 8} more`);
		lines.push("");
	}
	if (report.some((row) => row.tier === "coauthor")) {
		lines.push(
			"~ identified from the harness's own Co-Authored-By trailer plus the commit",
			"  author, because those commits carry no Agent-Session. Same neighbour,",
			"  coarser identity: two sessions of one harness by one author merge.",
			"",
		);
	}
	lines.push(
		"Overlap is not automatically a conflict — two agents may correctly touch one",
		"hot file. Read their Work Item before you start, or narrow your scope:",
		"`tedix work context <id>` and `tedix work resource-list`.",
		...footer,
	);
	return lines.join("\n");
}

export function gitRunner(cwd: string): GitRunner {
	return (args) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
}

export function changedPaths(run: GitRunner): string[] {
	try {
		const tracked = run(["diff", "--name-only", "HEAD"]);
		const untracked = run(["ls-files", "--others", "--exclude-standard"]);
		return [...tracked.split("\n"), ...untracked.split("\n")]
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const run = gitRunner(process.cwd());
	const scope = args.paths.length > 0 ? args.paths : changedPaths(run);
	const mySession = args.session || process.env.TEDIX_AGENT_SESSION || "";
	// Opt-in only, and never fatal: a failed fetch leaves the on-disk tracking
	// refs in place and the coverage line already says they may be stale.
	let fetched = false;
	if (args.fetch) {
		try {
			run(["fetch", "--quiet", "--all"]);
			fetched = true;
		} catch {
			fetched = false;
		}
	}
	const scan = resolveScan(run);
	const coverage = coverageNote(scan);
	const commits = readCommits(run, args.hours, scan);
	const report = buildReport(commits, scope, mySession);
	const attributed = attributedCommitCount(commits);
	if (args.json) {
		console.log(
			JSON.stringify(
				{
					hours: args.hours,
					scope,
					attributed,
					coverage,
					fetched: args.fetch ? fetched : null,
					remoteRefs: scan.remoteRefs.length,
					neighbours: report,
				},
				null,
				2,
			),
		);
	} else {
		if (args.fetch && !fetched) {
			console.log("--fetch failed; scanning the refs already on disk.");
		}
		console.log(
			render(report, { hours: args.hours, scope, attributed, coverage }),
		);
	}
	// Advisory: never fail a caller's pipeline over an overlap.
	process.exit(0);
}

if (import.meta.main) main();
