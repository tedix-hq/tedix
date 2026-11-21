import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunners, servingRunner } from "./runners-file";
import { configDir, findTedix, lastLine, run } from "./shell";

export interface RunnerRow {
	index: number;
	executor: string;
	organization: string;
	enabled: boolean;
	running: boolean;
	version?: string;
	problem?: string;
}

/** What the app shows about this computer, read from the CLI and the files it keeps. */
export interface Status {
	cliFound: boolean;
	cliVersion: string;
	runners: RunnerRow[];
	servingIndex?: number;
	machineName: string;
	machineWrite: boolean;
	notes: string[];
	activeRuns: number;
	machineToolsUp: boolean;
	machineToolsEvent: string;
}

async function json(
	path: string,
): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

function alive(pid: unknown): boolean {
	if (typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const LIVE_PHASES = ["preparing", "admitted", "running", "settling"];

/**
 * Run records in a runner's folder, counted while their agent process is
 * alive and their phase is one of a run in progress: the rule of the CLI's
 * own Mac status. A record without a process never counts.
 */
async function activeRuns(folder: string): Promise<number> {
	const names = await readdir(folder).catch(() => []);
	let count = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const text = await readFile(join(folder, name), "utf8").catch(() => "");
		if (!text.includes('"pid"')) continue;
		try {
			const record = JSON.parse(text) as { phase?: unknown; pid?: unknown };
			if (LIVE_PHASES.includes(String(record.phase)) && alive(record.pid))
				count += 1;
		} catch {
			/* A record being written. */
		}
	}
	return count;
}

/** Tasks running on this Mac now, over every runner's folder. */
export async function activeRunCount(): Promise<number> {
	const root = join(configDir(), "dispatchers");
	let count = 0;
	for (const name of await readdir(root).catch(() => []))
		count += await activeRuns(join(root, name));
	return count;
}

async function machineToolsEvent(): Promise<string> {
	try {
		const file = await open(join(configDir(), "dev.tedix.machine-tools.log"));
		try {
			const { size } = await file.stat();
			const length = Math.min(size, 4096);
			const { buffer } = await file.read(
				Buffer.alloc(length),
				0,
				length,
				size - length,
			);
			return String(JSON.parse(lastLine(buffer.toString("utf8"))).event ?? "");
		} finally {
			await file.close();
		}
	} catch {
		return "";
	}
}

export async function loadStatus(): Promise<Status> {
	const entries = readRunners();
	const serving = servingRunner(entries);
	const status: Status = {
		cliFound: true,
		cliVersion: "",
		runners: entries.map((entry) => ({
			index: entry.index,
			executor: entry.executor,
			organization: entry.organization,
			enabled: entry.enabled,
			running: false,
		})),
		servingIndex: serving?.index,
		machineName:
			serving?.machineName ??
			entries.find((entry) => entry.enabled && entry.machineName)
				?.machineName ??
			"",
		machineWrite: serving?.machineWriteMode === "allow",
		notes: [],
		activeRuns: 0,
		machineToolsUp:
			process.platform !== "win32" &&
			(await run("pgrep", ["-f", "--", "--machine-tools-only"])).ok,
		machineToolsEvent: await machineToolsEvent(),
	};
	const tedix = findTedix();
	if (!tedix) return { ...status, cliFound: false };
	status.cliVersion = lastLine((await run(tedix, ["--version"])).output);

	// `tedix supervise runners` prints the saved runners in file order with
	// whether each is running, plus the supervisor's duty-status file.
	let report: { runners?: unknown[]; duties?: unknown[] } = {};
	try {
		report = JSON.parse((await run(tedix, ["supervise", "runners"])).output);
	} catch {
		status.notes.push("Could not read the runner list from the CLI");
	}
	const listed = (report.runners ?? []) as Record<string, unknown>[];
	const duties = (report.duties ?? []) as Record<string, unknown>[];
	for (const [index, item] of listed.entries()) {
		const row = status.runners[index];
		if (!row || item.executor !== row.executor) continue;
		const folder = join(configDir(), "dispatchers", String(item.runner));
		row.running = item.running === true;
		const version = (await json(join(folder, "health-source.json")))
			?.cliVersion;
		if (typeof version === "string") row.version = version;
		if (!row.enabled) continue;
		const problem = duties.find((duty) => duty.id === item.runner)?.lastProblem;
		if (typeof problem === "string") row.problem = problem;
		status.activeRuns += await activeRuns(folder);
	}
	for (const duty of duties)
		if (duty.kind === "task" && typeof duty.lastProblem === "string")
			status.notes.push(`${String(duty.id)}: ${duty.lastProblem}`);
	return status;
}

/** The one line the status strip shows. */
export function summary(status: Status): string {
	if (!status.cliFound) return "Tedix CLI not found on PATH or in ~/.local/bin";
	const enabled = status.runners.filter((runner) => runner.enabled);
	const running = enabled.filter((runner) => runner.running).length;
	return [
		`${running} of ${enabled.length} runners running`,
		`${status.activeRuns} active ${status.activeRuns === 1 ? "run" : "runs"}`,
		`machine tools ${status.machineToolsUp ? "running" : "not running"}`,
		`CLI ${status.cliVersion}`,
	]
		.filter(Boolean)
		.join(" · ");
}
