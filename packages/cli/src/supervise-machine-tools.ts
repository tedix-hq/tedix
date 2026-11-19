import { homedir } from "node:os";
import { join } from "node:path";
import { laneChildEnv } from "./lane-child-env";
import { machineToolsIdentity } from "./lane-machine-tools";
import { selfCommand } from "./shared";
import { configDir, supervisorLog } from "./supervise-drivers";
import {
	capRunnerLog,
	EXIT_WINDOW_MS,
	readRunnerDuties,
	RUNNER_RESTART_BASE_MS,
	RUNNER_RESTART_MAX_MS,
	RUNNER_UPDATE_EXIT_CODE,
	type RunnerChild,
	type RunnerDutiesDeps,
	runnerKey,
	runnerServeArgs,
	spawnRunner,
} from "./supervise-runners";

export const MACHINE_TOOLS_LOG = "dev.tedix.machine-tools.log";

/**
 * Keeps one process per machine answering a tedi's machine tool calls, apart
 * from the runners: a runner busy with agent runs answered them minutes late.
 * It is started with the arguments of the runner the saved settings pick, so
 * it signs in as that runner does, and restarted like a runner.
 */
export class MachineToolsDuty {
	private running: { child: RunnerChild; startedAt: number } | undefined;
	private exits: number[] = [];
	private restartAt = 0;

	constructor(
		private readonly deps: Pick<
			RunnerDutiesDeps,
			"env" | "now" | "log" | "spawn" | "program"
		>,
	) {}

	private log(line: string) {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(
			`machine tools: ${line}`,
		);
	}

	tick(): void {
		let runners;
		try {
			runners = readRunnerDuties(this.deps.env);
		} catch {
			// The runners check reports an unreadable file; leave the process be.
			return;
		}
		const key = machineToolsIdentity(this.deps.env, runners).serving?.key;
		const runner = runners.find(
			(entry) => entry.enabled && runnerKey(entry) === key,
		);
		if (!runner) return this.stop();
		const log = join(configDir(this.deps.env), MACHINE_TOOLS_LOG);
		capRunnerLog(log);
		const now = (this.deps.now ?? Date.now)();
		if (this.running || this.restartAt > now) return;
		const [command, prefix] = (this.deps.program ?? selfCommand)();
		let child: RunnerChild | undefined;
		try {
			child = (this.deps.spawn ?? spawnRunner)(
				command,
				[...prefix, ...runnerServeArgs(runner), "--machine-tools-only"],
				{ cwd: homedir(), env: laneChildEnv(this.deps.env), log },
			);
		} catch {
			/* Counted as an exit below. */
		}
		if (!child?.pid) return this.noteExit(null, now);
		const entry = { child, startedAt: now };
		this.running = entry;
		this.log(`started (pid ${child.pid})`);
		child.onExit((code) => {
			if (this.running !== entry) return;
			this.running = undefined;
			const at = (this.deps.now ?? Date.now)();
			// Left for changed settings or an updated CLI: start again at once.
			if (
				code === RUNNER_UPDATE_EXIT_CODE &&
				at - entry.startedAt >= RUNNER_RESTART_BASE_MS
			)
				return this.log("left to restart on the current settings and CLI");
			this.noteExit(code, at);
		});
	}

	private noteExit(code: number | null, now: number) {
		this.exits = this.exits.filter((at) => now - at < EXIT_WINDOW_MS);
		this.exits.push(now);
		const delay = Math.min(
			RUNNER_RESTART_BASE_MS * 2 ** (this.exits.length - 1),
			RUNNER_RESTART_MAX_MS,
		);
		this.restartAt = now + delay;
		this.log(
			`exited (${code === null ? "no exit code" : `code ${code}`}); restart in ${Math.round(delay / 1000)}s`,
		);
	}

	/** Called when no runner serves machine tools and when the supervisor exits. */
	stop(): void {
		const entry = this.running;
		if (!entry) return;
		this.running = undefined;
		this.log("stopping");
		entry.child.stop("SIGTERM");
	}
}
