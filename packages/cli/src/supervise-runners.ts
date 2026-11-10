import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { laneChildEnv } from "./lane-child-env";
import { selfCommand } from "./shared";
import { alive, configDir, supervisorLog } from "./supervise-drivers";
import {
	readDutyStatuses,
	recordDutyStatus,
	type SupervisorDutyStatus,
} from "./supervise-duty-status";
import { laneProcessIdentity } from "./lane-process-recovery";
import { dispatcherNextCheckAt } from "./dispatcher-health";

/**
 * Runners as duties of the one supervisor. A runner is the process on this
 * machine that picks up accepted Work for one executor and carries it out
 * (`tedix lane serve`).
 *
 * `tedix lane serve --install` used to write one macOS LaunchAgent per
 * executor. Each ran on its own clock with its own restart policy and nothing
 * noticed when one dropped out. Now `~/.tedix/supervisor-runners.json` lists the
 * dispatchers, and the supervisor starts each as a child, restarts it with a
 * backoff when it exits, stops it when it leaves the list, and adopts a child
 * that outlived a crashed supervisor instead of starting a second one. The
 * dispatcher keeps its directory, log and health source, so dispatcher health
 * reads the same way as before.
 */

export const RUNNERS_FILE = "supervisor-runners.json";
/** Child records live beside the supervisor's own state, never in a runner's
 * directory: the runner treats every `.json` there as a Work receipt. */
export const RUNNER_RECORDS_DIR = ["supervisor", "runners"] as const;
/** A dispatcher that exits is restarted after this long, doubling per exit. */
export const RUNNER_RESTART_BASE_MS = 60_000;
export const RUNNER_RESTART_MAX_MS = 15 * 60_000;
/**
 * A runner that misses its scheduled pass by this much is hung and restarted.
 * Passes run every 30 seconds, so this restarts a hung lane about four minutes
 * after its last pass. A stopping runner drains for at most two minutes, so its
 * replacement passes well inside this window.
 */
export const RUNNER_PASS_GRACE_MS = 3.5 * 60_000;
/** A longer gap between checks means this machine slept; passes restart from waking. */
const CHECK_GAP_MS = 90_000;
/** Exits older than this no longer lengthen the backoff. */
const EXIT_WINDOW_MS = 60 * 60_000;

const text = z.string().trim().min(1);
const runnerSchema = z.object({
	workspace: text,
	organization: text,
	executor: z.enum(["codex", "claude-code", "opencode", "devin", "any-local"]),
	max: z.number().int().min(1).max(100),
	rules: text,
	repo: text.refine(isAbsolute, "repo must be an absolute path"),
	project: text.optional(),
	routingConfig: text.optional(),
	idleTakeoverMinutes: z.number().int().min(1).max(1440).optional(),
	coordinated: z.boolean().default(false),
	acceptProposed: z.boolean().default(false),
	enabled: z.boolean().default(true),
});
const fileSchema = z.object({
	version: z.literal(1),
	runners: z.array(runnerSchema),
});
export type RunnerDuty = z.infer<typeof runnerSchema>;

/** The parsed `lane serve` options this module needs; `lane-serve.ts` owns the parser. */
export interface ServeLike {
	executor: RunnerDuty["executor"];
	coordinated: boolean;
	acceptProposed: boolean;
	max: number;
	project?: string;
	routingConfig?: string;
	idleTakeoverMinutes?: number;
	rules: string;
	repo: string;
	scope: string[];
}
export type ParseServe = (args: string[]) => ServeLike;
export type RunLaunchctl = (args: string[]) => { status: number };

/**
 * The dispatcher directory name and the former LaunchAgent label suffix. An
 * any-local runner limited to a project or a repo serves only that slice of
 * Work, so its key carries the scope and it conflicts only with runners
 * serving the same scope; an unscoped one replaces the per-executor runners
 * under their shared `org:any-local` lane.
 */
export function runnerKey(
	runner: Pick<RunnerDuty, "organization" | "executor"> &
		Partial<Pick<RunnerDuty, "project" | "repo">>,
) {
	const lane =
		runner.executor === "any-local" && (runner.project ?? runner.repo)
			? `${runner.executor}:${runner.project ?? "-"}:${runner.repo ?? "-"}`
			: runner.executor;
	return createHash("sha256")
		.update(`${runner.organization}:${lane}`)
		.digest("hex")
		.slice(0, 16);
}

export function runnerLogPath(
	env: NodeJS.ProcessEnv,
	runner: RunnerDuty,
): string {
	return join(configDir(env), `dev.tedix.lane-serve.${runnerKey(runner)}.log`);
}

/** A runner's log larger than this is cut back to its newest lines. */
export const RUNNER_LOG_CAP_BYTES = 8 * 1024 * 1024;
/** How much of an over-cap runner log is kept; the newest lines diagnose best. */
export const RUNNER_LOG_KEEP_BYTES = 2 * 1024 * 1024;

/**
 * Caps a runner's log in place. The dispatcher's inherited descriptor stays
 * open in append mode, so renaming only moves the growth to the rotated file;
 * rewriting the newest lines onto the same inode is what bounds it. A line
 * appended mid-rewrite can be lost, the same trade any rotation makes.
 */
export function capRunnerLog(path: string): void {
	try {
		const size = statSync(path).size;
		if (size <= RUNNER_LOG_CAP_BYTES) return;
		const fd = openSync(path, "r+");
		try {
			const kept = Math.min(RUNNER_LOG_KEEP_BYTES, size);
			const marker = Buffer.from(
				`${new Date().toISOString()} tedix supervisor capped this log past ${RUNNER_LOG_CAP_BYTES} bytes; older lines were dropped\n`,
			);
			const buffer = Buffer.alloc(kept - marker.length);
			readSync(fd, buffer, 0, buffer.length, size - buffer.length);
			const newline = buffer.indexOf(0x0a);
			const tail = newline >= 0 ? buffer.subarray(newline + 1) : buffer;
			ftruncateSync(fd, 0);
			writeSync(fd, tail, 0, tail.length, 0);
			writeSync(fd, marker, 0, marker.length, tail.length);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Log hygiene is best effort; the runner keeps serving.
	}
}

/** The `tedix` arguments that run this dispatcher in the foreground. */
export function runnerServeArgs(runner: RunnerDuty): string[] {
	return [
		"--organization",
		runner.organization,
		"--workspace",
		runner.workspace,
		"lane",
		"serve",
		"--executor",
		runner.executor,
		"--max",
		String(runner.max),
		"--rules",
		runner.rules,
		"--repo",
		runner.repo,
		...(runner.project ? ["--project", runner.project] : []),
		...(runner.routingConfig ? ["--routing-config", runner.routingConfig] : []),
		...(runner.idleTakeoverMinutes
			? ["--idle-takeover-minutes", String(runner.idleTakeoverMinutes)]
			: []),
		...(runner.coordinated ? ["--coordinated"] : []),
		...(runner.acceptProposed ? ["--accept-proposed"] : []),
	];
}

export function runnerDutyFromServeOptions(options: ServeLike): RunnerDuty {
	const selector = (name: string) => {
		const index = options.scope.indexOf(name);
		if (index < 0 || !options.scope[index + 1])
			throw new Error(`lane serve --install needs ${name}`);
		return options.scope[index + 1]!;
	};
	return runnerSchema.parse({
		workspace: selector("--workspace"),
		organization: selector("--organization"),
		executor: options.executor,
		max: options.max,
		rules: options.rules,
		repo: options.repo,
		...(options.project ? { project: options.project } : {}),
		...(options.routingConfig ? { routingConfig: options.routingConfig } : {}),
		...(options.idleTakeoverMinutes
			? { idleTakeoverMinutes: options.idleTakeoverMinutes }
			: {}),
		coordinated: options.coordinated,
		acceptProposed: options.acceptProposed,
		enabled: true,
	});
}

function runnersPath(env: NodeJS.ProcessEnv): string {
	return join(configDir(env), RUNNERS_FILE);
}

/** Throws when the file exists but does not parse: a typo must not silently stop every runner. */
export function readRunnerDuties(env: NodeJS.ProcessEnv): RunnerDuty[] {
	const path = runnersPath(env);
	if (!existsSync(path)) return [];
	return fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).runners;
}

function writeRunnerDuties(
	env: NodeJS.ProcessEnv,
	runners: RunnerDuty[],
): void {
	const path = runnersPath(env);
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	writeFileSync(
		`${path}.tmp`,
		`${JSON.stringify({ version: 1, runners }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	renameSync(`${path}.tmp`, path);
}

/** Adds or replaces the dispatcher for the duty's organization and executor. */
export function writeRunnerDuty(
	env: NodeJS.ProcessEnv,
	runner: RunnerDuty,
): { replaced: boolean } {
	const runners = readRunnerDuties(env);
	const key = runnerKey(runner);
	const index = runners.findIndex((entry) => runnerKey(entry) === key);
	if (index >= 0) runners[index] = runner;
	else runners.push(runner);
	writeRunnerDuties(env, runners);
	return { replaced: index >= 0 };
}

export function removeRunnerDuty(env: NodeJS.ProcessEnv, key: string): boolean {
	const runners = readRunnerDuties(env);
	const kept = runners.filter((entry) => runnerKey(entry) !== key);
	if (kept.length === runners.length) return false;
	writeRunnerDuties(env, kept);
	return true;
}

/**
 * Reads the dispatcher a former `lane serve --install` LaunchAgent ran, from
 * the `<string>` entries of its ProgramArguments. Returns undefined when the
 * file is not such an agent.
 */
export function runnerDutyFromPlist(
	xml: string,
	parse: ParseServe,
): RunnerDuty | undefined {
	const block =
		/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
	if (!block) return undefined;
	const args = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
		(match) =>
			match[1]!
				.replaceAll("&lt;", "<")
				.replaceAll("&gt;", ">")
				.replaceAll("&amp;", "&"),
	);
	const serve = args.findIndex(
		(arg, index) => arg === "lane" && args[index + 1] === "serve",
	);
	if (serve < 1) return undefined;
	const options = parse(
		[...args.slice(1, serve), ...args.slice(serve + 2)].filter(
			(arg) => arg !== "--install",
		),
	);
	return runnerDutyFromServeOptions(options);
}

export const RUNNER_AGENT_PREFIX = "dev.tedix.lane-serve.";

/**
 * Moves every `dev.tedix.lane-serve.*` LaunchAgent into the runners file,
 * unloads it and removes its plist. The supervisor starts the dispatcher
 * on its next tick, so the runner is back within a minute.
 */
export function adoptRunnerLaunchAgents(
	env: NodeJS.ProcessEnv,
	run: RunLaunchctl,
	parse: ParseServe,
	{
		home = homedir(),
		domain = `gui/${process.getuid?.() ?? 0}`,
	}: { home?: string; domain?: string } = {},
): { adopted: RunnerDuty[]; skipped: string[] } {
	const folder = join(home, "Library", "LaunchAgents");
	const adopted: RunnerDuty[] = [];
	const skipped: string[] = [];
	if (!existsSync(folder)) return { adopted, skipped };
	for (const name of readdirSync(folder).sort()) {
		if (!name.startsWith(RUNNER_AGENT_PREFIX) || !name.endsWith(".plist"))
			continue;
		const path = join(folder, name);
		let runner: RunnerDuty | undefined;
		try {
			runner = runnerDutyFromPlist(readFileSync(path, "utf8"), parse);
		} catch (error) {
			skipped.push(`${name}: ${(error as Error).message}`);
			continue;
		}
		if (!runner) {
			skipped.push(`${name}: not a lane serve agent`);
			continue;
		}
		writeRunnerDuty(env, runner);
		run(["bootout", `${domain}/${name.slice(0, -".plist".length)}`]);
		rmSync(path, { force: true });
		adopted.push(runner);
	}
	return { adopted, skipped };
}

export interface RunnerChild {
	pid: number;
	onExit(listener: (code: number | null) => void): void;
	stop(signal: NodeJS.Signals): void;
}
export type SpawnRunner = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; log: string },
) => RunnerChild;

export const spawnRunner: SpawnRunner = (command, args, { cwd, env, log }) => {
	mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
	const fd = openSync(log, "a", 0o600);
	let child;
	try {
		child = spawn(command, args, {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
	} finally {
		closeSync(fd);
	}
	child.unref();
	return {
		pid: child.pid ?? 0,
		onExit: (listener) => {
			child.once("error", () => listener(null));
			child.once("exit", (code) => listener(code));
		},
		stop: (signal) => {
			try {
				if (child.pid) process.kill(-child.pid, signal);
			} catch {
				/* Already gone. */
			}
		},
	};
};

interface Running {
	runner: RunnerDuty;
	pid: number;
	startedAt: number;
	identity?: string;
	/** Set for children this supervisor spawned; an adopted child is only watched by pid. */
	child?: RunnerChild;
}

export interface RunnerDutiesDeps {
	env: NodeJS.ProcessEnv;
	now?: () => number;
	log?: (line: string) => void;
	spawn?: SpawnRunner;
	identity?: typeof laneProcessIdentity;
	/** The `tedix` program; defaults to this CLI. */
	program?: () => [string, string[]];
}

/** Keeps the configured dispatchers running; one instance per supervisor. */
export class RunnerDuties {
	private readonly running = new Map<string, Running>();
	private readonly exits = new Map<string, number[]>();
	private readonly restartAt = new Map<string, number>();
	private configError: string | undefined;
	private checkedAt = 0;
	private awakeAt = 0;

	constructor(private readonly deps: RunnerDutiesDeps) {
		try {
			for (const row of readDutyStatuses(deps.env)) {
				if (row.kind !== "service") continue;
				this.exits.set(row.id, row.exits);
				if (row.retryAt) this.restartAt.set(row.id, Date.parse(row.retryAt));
			}
		} catch {
			this.log("saved duty status unavailable; restart history is unknown");
		}
	}

	private record(
		runner: RunnerDuty,
		update: Partial<SupervisorDutyStatus>,
		now = this.now(),
	) {
		try {
			recordDutyStatus(
				this.deps.env,
				{
					id: runnerKey(runner),
					kind: "service",
					workspace: runner.workspace,
					organization: runner.organization,
					executor: runner.executor,
				},
				update,
				now,
			);
		} catch {
			this.log(`${runner.executor} duty status could not be saved`);
		}
	}

	private identity(pid: number, runner: RunnerDuty) {
		return (this.deps.identity ?? laneProcessIdentity)(
			pid,
			runner.organization,
			homedir(),
		);
	}

	private log(line: string) {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(
			`runners: ${line}`,
		);
	}
	private now() {
		return (this.deps.now ?? Date.now)();
	}
	private childPath(runner: RunnerDuty) {
		return join(
			configDir(this.deps.env),
			...RUNNER_RECORDS_DIR,
			`${runnerKey(runner)}.json`,
		);
	}

	/** What the supervisor believes is running, for `tedix supervise runners`. */
	status(): { key: string; executor: string; pid: number | null }[] {
		return [...this.running].map(([key, entry]) => ({
			key,
			executor: entry.runner.executor,
			pid: entry.pid,
		}));
	}

	/** Starts missing dispatchers, notes exits, stops removed ones. */
	tick(): void {
		let runners: RunnerDuty[];
		try {
			runners = readRunnerDuties(this.deps.env);
			this.configError = undefined;
		} catch (error) {
			const message = (error as Error).message?.split("\n")[0] ?? "invalid";
			if (this.configError !== message)
				this.log(
					`${RUNNERS_FILE} not read, runners left as they are: ${message}`,
				);
			this.configError = message;
			return;
		}
		const wanted = new Map(
			runners
				.filter((runner) => runner.enabled)
				.map((runner) => [runnerKey(runner), runner]),
		);
		for (const runner of runners)
			capRunnerLog(runnerLogPath(this.deps.env, runner));
		for (const [key, entry] of this.running) {
			if (wanted.has(key)) continue;
			this.log(
				`${entry.runner.executor} removed from ${RUNNERS_FILE}; stopping`,
			);
			this.stopOne(key, entry);
		}
		const now = this.now();
		if (this.checkedAt && now - this.checkedAt > CHECK_GAP_MS)
			this.awakeAt = now;
		this.checkedAt = now;
		for (const runner of runners.filter((row) => !row.enabled))
			this.record(
				runner,
				{ state: "stopped", retryAt: null, lastProblem: "Runner disabled" },
				now,
			);
		for (const [key, runner] of wanted) {
			const entry = this.running.get(key);
			if (entry) {
				if (
					entry.child ||
					(entry.identity &&
						this.identity(entry.pid, runner) === entry.identity)
				) {
					if (this.restartIfHung(key, entry, now)) continue;
					this.record(
						runner,
						{
							state: "running",
							...(now - entry.startedAt >= RUNNER_RESTART_BASE_MS
								? { lastProblem: null }
								: {}),
						},
						now,
					);
					continue;
				}
				// An adopted child ended; nobody told us, so note it here.
				this.running.delete(key);
				this.noteExit(key, runner, null, now);
			}
			if (!this.running.has(key)) {
				const adopted = this.adopt(key, runner, now);
				if (adopted) continue;
				const due = this.restartAt.get(key) ?? 0;
				if (due > now) {
					this.record(
						runner,
						{ state: "waiting", retryAt: new Date(due).toISOString() },
						now,
					);
					continue;
				}
				this.start(key, runner, now);
			}
		}
	}

	private adopt(key: string, runner: RunnerDuty, now: number): boolean {
		try {
			const state = JSON.parse(readFileSync(this.childPath(runner), "utf8"));
			if (
				Number.isSafeInteger(state.pid) &&
				state.pid > 0 &&
				alive(state.pid)
			) {
				const identity = this.identity(state.pid, runner);
				if (
					!state.identity ||
					identity !== state.identity ||
					!Number.isFinite(state.startedAt) ||
					state.startedAt <= 0
				) {
					this.record(
						runner,
						{
							state: "unknown",
							lastProblem:
								"A retained process is alive but its identity could not be verified; waiting for it to exit",
						},
						now,
					);
					return true;
				}
				this.running.set(key, {
					runner,
					pid: state.pid,
					startedAt: state.startedAt,
					identity,
				});
				this.record(
					runner,
					{
						state: "running",
						lastRunAt: new Date(state.startedAt).toISOString(),
						lastExecutor: runner.executor,
						retryAt: null,
					},
					now,
				);
				this.log(`${runner.executor} adopted (pid ${state.pid})`);
				return true;
			}
		} catch {
			/* No child file. */
		}
		return false;
	}

	private start(key: string, runner: RunnerDuty, now: number): void {
		const [command, prefix] = (this.deps.program ?? selfCommand)();
		const log = runnerLogPath(this.deps.env, runner);
		let child: RunnerChild;
		try {
			child = (this.deps.spawn ?? spawnRunner)(
				command,
				[...prefix, ...runnerServeArgs(runner)],
				{
					cwd: homedir(),
					env: laneChildEnv(this.deps.env),
					log,
				},
			);
		} catch (error) {
			this.noteExit(key, runner, null, now);
			this.log(
				`${runner.executor} could not start: ${(error as Error).message?.slice(0, 200)}`,
			);
			return;
		}
		if (!child.pid) {
			this.noteExit(key, runner, null, now);
			this.log(`${runner.executor} could not start: no pid`);
			return;
		}
		const entry: Running = {
			runner,
			pid: child.pid,
			startedAt: now,
			child,
			identity: this.identity(child.pid, runner),
		};
		this.running.set(key, entry);
		try {
			mkdirSync(join(configDir(this.deps.env), ...RUNNER_RECORDS_DIR), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(
				this.childPath(runner),
				JSON.stringify({
					pid: child.pid,
					startedAt: now,
					identity: entry.identity,
				}),
				{ mode: 0o600 },
			);
		} catch {
			/* The child runs; the record only helps a later supervisor adopt it. */
		}
		this.log(
			`${runner.executor} started (pid ${child.pid}, ${runner.max} slots)`,
		);
		this.record(
			runner,
			{
				state: "running",
				lastRunAt: new Date(now).toISOString(),
				lastExecutor: runner.executor,
				retryAt: null,
			},
			now,
		);
		child.onExit((code) => {
			if (this.running.get(key) !== entry) return;
			this.running.delete(key);
			rmSync(this.childPath(runner), { force: true });
			this.noteExit(key, runner, code, this.now());
		});
	}

	/**
	 * Kills and restarts a runner that missed its scheduled pass. SIGKILL,
	 * because a hung pass never reaches the SIGTERM drain. Lane processes run
	 * in their own process groups, so the replacement recovers them as orphans.
	 */
	private restartIfHung(key: string, entry: Running, now: number): boolean {
		const directory = join(configDir(this.deps.env), "dispatchers", key);
		const due = Math.max(
			dispatcherNextCheckAt(directory, entry.pid) ?? entry.startedAt,
			this.awakeAt,
		);
		if (now - due <= RUNNER_PASS_GRACE_MS) return false;
		const reason = `${entry.runner.executor} missed its lane pass due ${new Date(due).toISOString()} by ${Math.round((now - due) / 1000)}s; killing pid ${entry.pid} and restarting`;
		this.log(reason);
		this.running.delete(key);
		if (entry.child) entry.child.stop("SIGKILL");
		else
			try {
				process.kill(-entry.pid, "SIGKILL");
			} catch {
				/* Already gone. */
			}
		rmSync(this.childPath(entry.runner), { force: true });
		this.record(entry.runner, { lastProblem: reason }, now);
		this.start(key, entry.runner, now);
		return true;
	}

	private noteExit(
		key: string,
		runner: RunnerDuty,
		code: number | null,
		now: number,
	) {
		const recent = (this.exits.get(key) ?? []).filter(
			(at) => now - at < EXIT_WINDOW_MS,
		);
		recent.push(now);
		this.exits.set(key, recent);
		const delay = Math.min(
			RUNNER_RESTART_BASE_MS * 2 ** (recent.length - 1),
			RUNNER_RESTART_MAX_MS,
		);
		this.restartAt.set(key, now + delay);
		this.record(
			runner,
			{
				state: "waiting",
				lastExitAt: new Date(now).toISOString(),
				lastExitCode: code,
				exits: recent,
				retryAt: new Date(now + delay).toISOString(),
				lastProblem:
					code === null
						? "Runner exited; exit code unavailable"
						: `Runner exited with code ${code}`,
			},
			now,
		);
		this.log(
			`${runner.executor} exited (${code === null ? "no exit code" : `code ${code}`}); restart in ${Math.round(delay / 1000)}s`,
		);
	}

	private stopOne(key: string, entry: Running) {
		this.running.delete(key);
		if (entry.child) entry.child.stop("SIGTERM");
		else if (
			entry.identity &&
			this.identity(entry.pid, entry.runner) === entry.identity
		) {
			try {
				process.kill(entry.pid, "SIGTERM");
			} catch {
				/* Already gone. */
			}
		}
		rmSync(this.childPath(entry.runner), { force: true });
		this.record(entry.runner, {
			state: "unknown",
			lastProblem: "Stop requested; active Work may still be draining",
		});
	}

	/** Stops every dispatcher this supervisor runs; called when the supervisor exits. */
	stop(): void {
		for (const [key, entry] of [...this.running]) {
			this.log(`${entry.runner.executor} stopping with the supervisor`);
			this.stopOne(key, entry);
		}
	}
}
