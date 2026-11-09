import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { kernelProcessCwd, kernelProcessFacts } from "./process-facts";

export interface LaneProcessFacts {
	pgid: number;
	/** Opaque per-instance start tokens; consistent within one reader. */
	start: string[];
	argv: string[];
}
type LaneProcessFactsReader = (pid: number) => LaneProcessFacts | undefined;
type LaneProcessCwdReader = (pid: number) => string | undefined;

function psFacts(pid: number): LaneProcessFacts | undefined {
	const result = spawnSync(
		"ps",
		["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="],
		{ encoding: "utf8", timeout: 2000, maxBuffer: 16384 },
	);
	if (result.status !== 0) return;
	const fields = result.stdout.trim().split(/\s+/);
	if (fields.length < 7) return;
	return {
		pgid: Number(fields[0]),
		start: fields.slice(1, 6),
		argv: fields.slice(6),
	};
}

function defaultFactsReader(pid: number): LaneProcessFacts | undefined {
	const kernel = kernelProcessFacts(pid);
	// On Linux an empty /proc cmdline means exec is still in progress. Falling
	// back to ps then would hash its lstart tokens, which never match the
	// kernel start tick read later, so the same process could not be reaped.
	if (kernel && (kernel.argv.length || process.platform === "linux"))
		return { pgid: kernel.pgid, start: kernel.start, argv: kernel.argv };
	try {
		return psFacts(pid);
	} catch {
		return;
	}
}

function defaultCwdReader(pid: number): string | undefined {
	try {
		const kernel = kernelProcessCwd(pid);
		if (kernel) return kernel;
		const result = spawnSync(
			"lsof",
			["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
			{
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 16384,
			},
		);
		if (result.status !== 0) return;
		const paths = result.stdout
			.split("\n")
			.filter((line) => line.startsWith("n"));
		if (paths.length === 1) return realpathSync(paths[0]!.slice(1));
	} catch {}
}

let factsReader: LaneProcessFactsReader = defaultFactsReader;
let cwdReader: LaneProcessCwdReader = defaultCwdReader;

/** Swap the process-fact readers (tests). No arguments restores the defaults. */
export function setLaneProcessReaders(
	facts?: LaneProcessFactsReader,
	cwd?: LaneProcessCwdReader,
): void {
	factsReader = facts ?? defaultFactsReader;
	cwdReader = cwd ?? defaultCwdReader;
}

/** A PID alone can be reused; bind recovery to its native session and OS start time. */
export function laneProcessIdentity(
	pid: number,
	session: string,
	cwd?: string,
): string | undefined {
	const facts = factsReader(pid);
	if (
		!facts ||
		facts.pgid !== pid ||
		!facts.argv.includes(session.slice(session.indexOf(":") + 1))
	)
		return;
	if (!cwd)
		return createHash("sha256")
			.update([facts.pgid, ...facts.start, ...facts.argv].join(" "))
			.digest("hex");
	try {
		const directory = realpathSync(cwd);
		if (cwdReader(pid) !== directory) return;
		// exec replaces argv, but preserves the process birth, group and cwd.
		return `v2:${createHash("sha256")
			.update(
				JSON.stringify([[facts.pgid, ...facts.start], session, directory]),
			)
			.digest("hex")}`;
	} catch {
		return;
	}
}
export function reapLaneProcess(
	pid: number,
	session: string,
	identity: string,
	cwd?: string,
): boolean {
	if (identity.startsWith("v2:") && !cwd) return false;
	if (
		laneProcessIdentity(
			pid,
			session,
			identity.startsWith("v2:") ? cwd : undefined,
		) !== identity
	)
		return false;
	try {
		process.kill(-pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
