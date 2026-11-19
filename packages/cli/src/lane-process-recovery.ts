import { laneCommand } from "./lane-command";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { CODEX_LANE_CONFIG_ARG } from "./codex-lane-thread";
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
	return parsePsFacts(result);
}

function parsePsFacts(result: {
	status: number | null;
	stdout: string;
}): LaneProcessFacts | undefined {
	if (result.status !== 0) return;
	const fields = result.stdout.trim().split(/\s+/);
	if (fields.length < 7) return;
	return {
		pgid: Number(fields[0]),
		start: fields.slice(1, 6),
		argv: fields.slice(6),
	};
}

function nativeFacts(pid: number) {
	const kernel = kernelProcessFacts(pid);
	// During Linux exec, an empty cmdline must keep its kernel birth token;
	// ps lstart tokens would not match the kernel reader on a later pass.
	if (kernel && (kernel.argv.length || process.platform === "linux"))
		return kernel;
}

function defaultFactsReader(pid: number): LaneProcessFacts | undefined {
	const kernel = nativeFacts(pid);
	if (kernel) return kernel;
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

async function psFactsAsync(
	pid: number,
): Promise<LaneProcessFacts | undefined> {
	const result = await laneCommand(
		"ps",
		["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="],
		{ encoding: "utf8", timeout: 2000, maxBuffer: 16384 },
	);
	return parsePsFacts(result);
}

async function asyncFactsReader(
	pid: number,
): Promise<LaneProcessFacts | undefined> {
	const kernel = nativeFacts(pid);
	if (kernel) return kernel;
	try {
		return await psFactsAsync(pid);
	} catch {
		return;
	}
}

async function asyncCwdReader(pid: number): Promise<string | undefined> {
	try {
		const kernel = kernelProcessCwd(pid);
		if (kernel) return kernel;
		const result = await laneCommand(
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
	return identityFromFacts(
		pid,
		session,
		cwd,
		facts,
		cwd ? cwdReader(pid) : undefined,
	);
}

function identityFromFacts(
	pid: number,
	session: string,
	cwd: string | undefined,
	facts: LaneProcessFacts | undefined,
	processCwd: string | undefined,
): string | undefined {
	if (!facts || facts.pgid !== pid) return;
	const nativeId = session.slice(session.indexOf(":") + 1);
	if (
		!facts.argv.includes(nativeId) &&
		!(
			cwd &&
			session.startsWith("codex:") &&
			facts.argv.includes("app-server") &&
			facts.argv.includes(CODEX_LANE_CONFIG_ARG)
		)
	)
		return;
	if (!cwd)
		return createHash("sha256")
			.update([facts.pgid, ...facts.start, ...facts.argv].join(" "))
			.digest("hex");
	try {
		const directory = realpathSync(cwd);
		if (processCwd !== directory) return;
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

export async function laneProcessIdentityAsync(
	pid: number,
	session: string,
	cwd?: string,
) {
	const facts = await (factsReader === defaultFactsReader
		? asyncFactsReader(pid)
		: factsReader(pid));
	const directory = cwd
		? await (cwdReader === defaultCwdReader
				? asyncCwdReader(pid)
				: cwdReader(pid))
		: undefined;
	return identityFromFacts(pid, session, cwd, facts, directory);
}

/** Wait briefly for a newly spawned process to expose its post-exec argv. */
export async function waitForLaneProcessIdentity(
	pid: number,
	session: string,
	cwd?: string,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<string | undefined> {
	const attempts = options.attempts ?? 30;
	const delayMs = options.delayMs ?? 100;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const identity = await laneProcessIdentityAsync(pid, session, cwd);
		if (identity) return identity;
		if (attempt + 1 < attempts)
			await new Promise<void>((resolve) => {
				setTimeout(resolve, delayMs).unref();
			});
	}
}

export async function reapLaneProcess(
	pid: number,
	session: string,
	identity: string,
	cwd?: string,
): Promise<boolean> {
	if (identity.startsWith("v2:") && !cwd) return false;
	if (
		(await laneProcessIdentityAsync(
			pid,
			session,
			identity.startsWith("v2:") ? cwd : undefined,
		)) !== identity
	)
		return false;
	try {
		process.kill(-pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
