import {
	attributedCommitCount,
	buildReport,
	changedPaths,
	coverageNote,
	gitRunner,
	type NeighbourRow,
	readCommits,
	resolveScan,
} from "./neighbours";

/**
 * `tedix who` reports agent attribution from local git history using the
 * shared `work:neighbours` detection logic, without requiring Work-board data.
 */

export interface WhoOptions {
	paths: string[];
	hours: number;
	json: boolean;
	/** Excluded from the result; defaults to the caller's own session key. */
	self?: string;
}

/**
 * Every result states the local-only data boundary. Update this statement if
 * repository data is ever sent over the network.
 */
export const DATA_BOUNDARY =
	"Reads your local git history. Your code, paths and commit messages stay on this machine.";

/**
 * Missing attribution cannot establish that no other agent touched the files.
 * Render that uncertainty separately from an empty attributed result.
 */
export function renderWho(
	report: Pick<NeighbourRow, "session" | "tier" | "commits" | "paths">[],
	options: {
		hours: number;
		scope: string[];
		attributed: number;
		coverage: string;
	},
): string {
	const { hours, scope, attributed, coverage } = options;
	const where = scope.length ? "these files" : "this repository";
	const lines: string[] = [DATA_BOUNDARY, ""];

	if (report.length === 0) {
		lines.push(
			attributed === 0
				? `No commit in the last ${hours}h records which agent wrote it, so this cannot tell you who has been in ${where} — only that the repository does not say. Agents are recognised by the \`Co-Authored-By\` line Claude Code, Codex and Cursor add to their own commits.`
				: `Nobody else has been in ${where} in the last ${hours}h.`,
			"",
			coverage,
		);
		return lines.join("\n");
	}

	lines.push(
		`${report.length} other agent${report.length === 1 ? "" : "s"} touched ${where} in the last ${hours}h:`,
		"",
	);
	for (const row of report) {
		lines.push(
			`  ${row.session}  ${row.commits} commit${row.commits === 1 ? "" : "s"}`,
		);
		for (const path of row.paths.slice(0, 6)) lines.push(`      ${path}`);
		if (row.paths.length > 6)
			lines.push(`      … ${row.paths.length - 6} more`);
		lines.push("");
	}
	if (report.some((row) => row.tier === "coauthor")) {
		lines.push(
			"Identity comes from each harness's own co-author line plus the commit",
			"author, so two sessions of one harness by one person appear as one entry.",
			"",
		);
	}
	lines.push(
		"Overlapping with someone is not automatically a conflict — two agents may",
		"correctly touch one busy file. It is worth knowing before you start.",
		"",
		coverage,
	);
	return lines.join("\n");
}

export async function runWhoCommand(options: WhoOptions): Promise<number> {
	const run = gitRunner(process.cwd());
	let scan: ReturnType<typeof resolveScan>;
	try {
		scan = resolveScan(run);
	} catch {
		console.error(
			"tedix who reads a git repository, and this directory is not one.",
		);
		return 1;
	}
	const scope = options.paths.length > 0 ? options.paths : changedPaths(run);
	const commits = readCommits(run, options.hours, scan);
	const report = buildReport(commits, scope, options.self ?? "");
	const attributed = attributedCommitCount(commits);
	const coverage = coverageNote(scan);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					dataBoundary: DATA_BOUNDARY,
					hours: options.hours,
					scope,
					attributed,
					coverage,
					agents: report,
				},
				null,
				2,
			),
		);
	} else {
		console.log(
			renderWho(report, { hours: options.hours, scope, attributed, coverage }),
		);
	}
	// Advisory: overlap is information, never a failure.
	return 0;
}
