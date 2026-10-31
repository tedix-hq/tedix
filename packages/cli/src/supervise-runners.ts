import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { laneChildEnv } from "./lane-child-env";
import { selfCommand } from "./shared";
import { alive, configDir, supervisorLog } from "./supervise-drivers";

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
const CHILD_FILE = "supervisor-child.json";
/** A dispatcher that exits is restarted after this long, doubling per exit. */
export const RUNNER_RESTART_BASE_MS = 60_000;
export const RUNNER_RESTART_MAX_MS = 15 * 60_000;
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
	rules: string;
	repo: string;
	scope: string[];
}
export type ParseServe = (args: string[]) => ServeLike;
export type RunLaunchctl = (args: string[]) => { status: number };

/** The dispatcher directory name and the former LaunchAgent label suffix. */
export function runnerKey(
	runner: Pick<RunnerDuty, "organization" | "executor">,
) {
	return createHash("sha256")
		.update(`${runner.organization}:${runner.executor}`)
		.digest("hex")
		.slice(0, 16);
}

export function runnerLogPath(
	env: NodeJS.ProcessEnv,
	runner: RunnerDuty,
): string {
	return join(configDir(env), `dev.tedix.lane-serve.${runnerKey(runner)}.log`);
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
	/** Set for children this supervisor spawned; an adopted child is only watched by pid. */
	child?: RunnerChild;
}

export interface RunnerDutiesDeps {
	env: NodeJS.ProcessEnv;
	now?: () => number;
	log?: (line: string) => void;
	spawn?: SpawnRunner;
	/** The `tedix` program; defaults to this CLI. */
	program?: () => [string, string[]];
}

/** Keeps the configured dispatchers running; one instance per supervisor. */
export class RunnerDuties {
	private readonly running = new Map<string, Running>();
	private readonly exits = new Map<string, number[]>();
	private readonly restartAt = new Map<string, number>();
	private configError: string | undefined;

	constructor(private readonly deps: RunnerDutiesDeps) {}

	private log(line: string) {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(
			`runners: ${line}`,
		);
	}
	private now() {
		return (this.deps.now ?? Date.now)();
	}
	private directory(runner: RunnerDuty) {
		return join(configDir(this.deps.env), "dispatchers", runnerKey(runner));
	}
	private childPath(runner: RunnerDuty) {
		return join(this.directory(runner), CHILD_FILE);
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
		for (const [key, entry] of this.running) {
			if (wanted.has(key)) continue;
			this.log(
				`${entry.runner.executor} removed from ${RUNNERS_FILE}; stopping`,
			);
			this.stopOne(key, entry);
		}
		const now = this.now();
		for (const [key, runner] of wanted) {
			const entry = this.running.get(key);
			if (entry) {
				if (entry.child || alive(entry.pid)) continue;
				// An adopted child ended; nobody told us, so note it here.
				this.running.delete(key);
				this.noteExit(key, runner, null, now);
			}
			if (!this.running.has(key)) {
				const adopted = this.adopt(key, runner, now);
				if (adopted) continue;
				const due = this.restartAt.get(key) ?? 0;
				if (due > now) continue;
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
				this.running.set(key, { runner, pid: state.pid, startedAt: now });
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
		const entry: Running = { runner, pid: child.pid, startedAt: now, child };
		this.running.set(key, entry);
		try {
			mkdirSync(this.directory(runner), { recursive: true, mode: 0o700 });
			writeFileSync(
				this.childPath(runner),
				JSON.stringify({ pid: child.pid, startedAt: now }),
				{ mode: 0o600 },
			);
		} catch {
			/* The child runs; the record only helps a later supervisor adopt it. */
		}
		this.log(
			`${runner.executor} started (pid ${child.pid}, ${runner.max} slots)`,
		);
		child.onExit((code) => {
			if (this.running.get(key) !== entry) return;
			this.running.delete(key);
			rmSync(this.childPath(runner), { force: true });
			this.noteExit(key, runner, code, this.now());
		});
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
		this.log(
			`${runner.executor} exited (${code === null ? "no exit code" : `code ${code}`}); restart in ${Math.round(delay / 1000)}s`,
		);
	}

	private stopOne(key: string, entry: Running) {
		this.running.delete(key);
		if (entry.child) entry.child.stop("SIGTERM");
		else {
			try {
				process.kill(entry.pid, "SIGTERM");
			} catch {
				/* Already gone. */
			}
		}
		rmSync(this.childPath(entry.runner), { force: true });
	}

	/** Stops every dispatcher this supervisor runs; called when the supervisor exits. */
	stop(): void {
		for (const [key, entry] of [...this.running]) {
			this.log(`${entry.runner.executor} stopping with the supervisor`);
			this.stopOne(key, entry);
		}
	}
}
