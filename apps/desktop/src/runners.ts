import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { log } from "./log";
import { configDir, findTedix, type RunResult, run, toolPath } from "./shell";

/**
 * This Mac's runners run under `tedix supervise`. On a Mac with the app, the
 * app starts it as its own child process while it is open and stops it when
 * it quits. The CLI's login service (`tedix supervise install`) stays for
 * Macs without the app; the app removes it, because two supervisors cannot
 * run at once.
 */
const SERVICE = "dev.tedix.supervisor";
const servicePlist = () =>
	join(homedir(), "Library", "LaunchAgents", `${SERVICE}.plist`);
const serviceName = () => `gui/${process.getuid?.()}/${SERVICE}`;
const pidFile = () => join(configDir(), "supervisor.pid");
/** Where the supervisor's own output goes; its log is `supervisor.log`. */
const outputFile = () => join(configDir(), "supervisor.app.log");
const STOP_WAIT_MS = 30_000;

let child: ChildProcess | undefined;
let startedAt = 0;
/** The runners should run: false before the first start and while quitting. */
let wanted = false;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
/** Quick exits in a row, for waiting longer before each next start. */
let quickExits = 0;
let stopping: Promise<void> | undefined;
/** Why the runners are not running, in one sentence for the person. */
let problem: string | undefined;

let changed: () => void = () => {};
/** Sets what is called when the runners start, stop or fail. */
export function onRunnersChange(listener: () => void): void {
	changed = listener;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * There while the person has paused the runners, so that opening the app
 * again leaves them stopped. Any start the person asks for removes it.
 */
const pausedFile = () => join(app.getPath("userData"), "runners-paused");
export const runnersPaused = () => existsSync(pausedFile());

/** The process this app started runs now. */
export function runnersRunning(): boolean {
	return Boolean(child && child.exitCode === null && child.signalCode === null);
}

/** One line for the menu: running, or why not. */
export function runnersProblem(): string | undefined {
	return runnersRunning() ? undefined : problem;
}

async function serviceLoaded(): Promise<boolean> {
	return (await run("/bin/launchctl", ["print", serviceName()])).ok;
}

/**
 * Unloads and deletes the CLI's login service. True when there was one, so
 * the caller knows this start took the runners over from it. Runs on every
 * start: `tedix supervise install` in a terminal puts it back.
 */
export async function removeLoginService(): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	if (!app.isPackaged && process.env.TEDIX_DEV_RUNNERS !== "1") return false;
	const loaded = await serviceLoaded();
	if (!loaded && !existsSync(servicePlist())) return false;
	log("runners: removing the dev.tedix.supervisor login service");
	if (loaded) {
		await run("/bin/launchctl", ["bootout", serviceName()]);
		// launchd gives the service up to 20 seconds to stop.
		for (let waited = 0; waited < 60 && (await serviceLoaded()); waited++)
			await pause(500);
	}
	rmSync(servicePlist(), { force: true });
	log("runners: the login service is removed; the app runs the runners now");
	return true;
}

/** The supervisor that holds the lock now, when it is not this app's child. */
function otherSupervisor(): number | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(pidFile(), "utf8"));
	} catch {
		return undefined;
	}
	if (!Number.isSafeInteger(pid) || pid <= 1 || pid === child?.pid) return;
	return alive(pid) ? pid : undefined;
}

/**
 * A supervisor left behind by an earlier copy of this app that ended
 * without stopping it (a crash, or a CLI too old to notice): its parent is
 * gone, so it is stopped. One started from a terminal is left alone.
 */
async function stopLeftBehind(): Promise<void> {
	const pid = otherSupervisor();
	if (!pid) return;
	const ps = await run("/bin/ps", ["-o", "ppid=,command=", "-p", String(pid)]);
	const [ppid, ...command] = ps.output.trim().split(/\s+/);
	if (ppid !== "1" || !command.join(" ").includes("supervise")) return;
	log(`runners: stopping a supervisor left behind (pid ${pid})`);
	await stopPid(pid);
}

async function stopPid(pid: number): Promise<void> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	for (let waited = 0; waited < STOP_WAIT_MS && alive(pid); waited += 250)
		await pause(250);
	if (!alive(pid)) return;
	await stopRunnerProcesses();
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* Gone. */
	}
}

/**
 * Each runner runs in its own process group and outlives a supervisor that
 * was killed. `tedix supervise runners` names the live ones; this stops them.
 */
async function stopRunnerProcesses(): Promise<void> {
	const tedix = findTedix();
	if (!tedix) return;
	let rows: { pid?: unknown }[] = [];
	try {
		rows =
			(
				JSON.parse(
					(await run(tedix, ["supervise", "runners"], { timeoutMs: 20_000 }))
						.output,
				) as { runners?: { pid?: unknown }[] }
			).runners ?? [];
	} catch {
		return;
	}
	for (const { pid } of rows)
		if (typeof pid === "number" && pid > 1)
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				/* Gone. */
			}
}

/** The supervisor's environment: the person's shell PATH finds their coding tools. */
function supervisorEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env))
		if (!key.startsWith("ELECTRON_")) env[key] = value;
	env.PATH = toolPath();
	// The supervisor stops when this app is gone, also after a crash.
	env.TEDIX_SUPERVISOR_PARENT = String(process.pid);
	return env;
}

function fail(reason: string): RunResult {
	problem = reason;
	log(`runners: ${reason}`);
	changed();
	return { ok: false, output: reason };
}

/**
 * Starts `tedix supervise` as this app's child, and keeps it running until
 * `stopRunners`. Resolves once it has run for two seconds, or with the reason
 * it did not start.
 */
export async function startRunners(): Promise<RunResult> {
	if (process.platform !== "darwin")
		return fail("Run tedix supervise yourself on this system.");
	// Like `tedix://` links, the runners belong to the installed app.
	if (!app.isPackaged && process.env.TEDIX_DEV_RUNNERS !== "1")
		return fail(
			"Tedix Dev leaves this Mac's runners to the installed app. Start it with TEDIX_DEV_RUNNERS=1 to run them from here.",
		);
	wanted = true;
	rmSync(pausedFile(), { force: true });
	clearTimeout(restartTimer);
	restartTimer = undefined;
	if (runnersRunning()) return { ok: true, output: "" };
	await stopping;
	await removeLoginService();
	await stopLeftBehind();
	// Quit was chosen while this start waited.
	if (!wanted) return { ok: false, output: "Tedix is quitting." };
	const other = otherSupervisor();
	if (other)
		return fail(
			`Another tedix supervise (process ${other}) runs this Mac's runners. Stop it, then choose Restart Runners.`,
		);
	const tedix = findTedix();
	if (!tedix) return fail("The Tedix command-line tool was not found.");
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const output = openSync(outputFile(), "a", 0o600);
	let started: ChildProcess;
	try {
		started = spawn(tedix, ["supervise"], {
			cwd: homedir(),
			env: supervisorEnv(),
			stdio: ["ignore", output, output],
		});
	} finally {
		closeSync(output);
	}
	child = started;
	startedAt = Date.now();
	problem = undefined;
	log(`runners: started tedix supervise (pid ${started.pid})`);
	const exited = new Promise<number | null>((resolve) => {
		started.once("error", (error) => {
			problem = `tedix supervise did not start: ${error.message}`;
			resolve(null);
		});
		started.once("exit", (code) => resolve(code));
	});
	void exited.then((code) => onExit(started, code));
	changed();
	const early = await Promise.race([exited, pause(2000).then(() => "running")]);
	if (early === "running") return { ok: true, output: "" };
	return {
		ok: false,
		output: problem ?? `tedix supervise ended at once (exit ${early}).`,
	};
}

function onExit(ended: ChildProcess, code: number | null): void {
	if (child !== ended) return;
	child = undefined;
	if (!wanted) {
		log(`runners: tedix supervise stopped (exit ${code})`);
		return changed();
	}
	quickExits = Date.now() - startedAt < 60_000 ? quickExits + 1 : 0;
	const delay = Math.min(5_000 * 2 ** Math.max(0, quickExits - 1), 5 * 60_000);
	problem ??= `tedix supervise ended (exit ${code}); it starts again in ${Math.round(delay / 1000)} seconds. Its output is in ~/.tedix/supervisor.app.log.`;
	log(`runners: ${problem}`);
	changed();
	restartTimer = setTimeout(() => {
		restartTimer = undefined;
		if (wanted) void startRunners();
	}, delay);
}

/**
 * Stops the runners this app started and waits for them, at most 30
 * seconds before it stops them by force.
 */
export function stopRunners(): Promise<void> {
	wanted = false;
	clearTimeout(restartTimer);
	restartTimer = undefined;
	const current = child;
	if (!current || !runnersRunning()) return stopping ?? Promise.resolve();
	stopping ??= (async () => {
		log("runners: stopping tedix supervise");
		const pid = current.pid;
		if (pid) await stopPid(pid);
		for (let waited = 0; child === current && waited < 50; waited++)
			await pause(100);
	})().finally(() => {
		stopping = undefined;
	});
	return stopping;
}

/** Stops the runners until the person resumes or restarts them; tasks running on this Mac stop. */
export async function pauseRunners(): Promise<void> {
	writeFileSync(pausedFile(), "");
	log("runners: paused by the person");
	await stopRunners();
	changed();
}

/** Stops the runners and starts them again: after a new command-line tool or a changed runner. */
export async function restartRunners(): Promise<RunResult> {
	await stopRunners();
	return startRunners();
}
