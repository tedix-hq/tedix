import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface ProcessRow {
	pid: number;
	ppid: number;
	command: string;
}

type ProcessTableReader = () => ProcessRow[];

function readProcessTable(): ProcessRow[] {
	if (process.platform === "win32") return [];
	try {
		return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		})
			.split("\n")
			.flatMap((line) => {
				const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
				return match
					? [
							{
								pid: Number(match[1]),
								ppid: Number(match[2]),
								command: match[3]!,
							},
						]
					: [];
			});
	} catch {
		return [];
	}
}

let reader: ProcessTableReader = readProcessTable;
let cached: Map<number, ProcessRow> | undefined;

/** Replace the process-table reader (tests). Clears the cached table. */
export function setProcessTableReader(next?: ProcessTableReader): void {
	reader = next ?? readProcessTable;
	cached = undefined;
}

type HostHarness = "codex" | "claude-code";

/**
 * The harness that runs this process: the nearest Codex or Claude Code
 * ancestor. A Codex lane launched from a Claude Code shell inherits the
 * launcher's CLAUDE_CODE_SESSION_ID next to its own CODEX_THREAD_ID (and
 * the reverse for Claude started from Codex), so the environment alone is
 * ambiguous; the process tree is not. This only chooses between session ids
 * already present in the environment. It grants nothing: the chosen session
 * must still be registered and exchanged for its own credential.
 */
export function nearestHostHarness(
	env: NodeJS.ProcessEnv = process.env,
): HostHarness | undefined {
	const claudePid = Number(env.CLAUDE_PID?.trim());
	cached ??= new Map(reader().map((row) => [row.pid, row]));
	const rows = cached;
	let harness: HostHarness | undefined;
	let pid = process.pid;
	for (let hops = 0; pid > 1 && hops < 64; hops += 1) {
		const row = rows.get(pid);
		if (!row) break;
		const name = basename(row.command).toLowerCase();
		if (name === "codex") {
			harness = "codex";
			break;
		}
		if (pid === claudePid || name === "claude") {
			harness = "claude-code";
			break;
		}
		pid = row.ppid;
	}
	return harness;
}
