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
 * Lane dispatchers as duties of the one supervisor.
 *
 * `tedix lane serve --install` used to write one macOS LaunchAgent per
 * executor. Each ran on its own clock with its own restart policy and nothing
 * noticed when one dropped out. Now `~/.tedix/supervisor-lanes.json` lists the
 * dispatchers, and the supervisor starts each as a child, restarts it with a
 * backoff when it exits, stops it when it leaves the list, and adopts a child
 * that outlived a crashed supervisor instead of starting a second one. The
 * dispatcher keeps its directory, log and health source, so dispatcher health
 * reads the same way as before.
 */

export const LANES_FILE = "supervisor-lanes.json";
const CHILD_FILE = "supervisor-child.json";
/** A dispatcher that exits is restarted after this long, doubling per exit. */
export const LANE_RESTART_BASE_MS = 60_000;
export const LANE_RESTART_MAX_MS = 15 * 60_000;
/** Exits older than this no longer lengthen the backoff. */
const EXIT_WINDOW_MS = 60 * 60_000;

const text = z.string().trim().min(1);
const laneSchema = z.object({
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
	lanes: z.array(laneSchema),
});
export type LaneDuty = z.infer<typeof laneSchema>;

/** The parsed `lane serve` options this module needs; `lane-serve.ts` owns the parser. */
export interface ServeLike {
	executor: LaneDuty["executor"];
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
export function laneKey(lane: Pick<LaneDuty, "organization" | "executor">) {
	return createHash("sha256")
		.update(`${lane.organization}:${lane.executor}`)
		.digest("hex")
		.slice(0, 16);
}

export function laneLogPath(env: NodeJS.ProcessEnv, lane: LaneDuty): string {
	return join(configDir(env), `dev.tedix.lane-serve.${laneKey(lane)}.log`);
}

/** The `tedix` arguments that run this dispatcher in the foreground. */
export function laneServeArgs(lane: LaneDuty): string[] {
	return [
		"--organization",
		lane.organization,
		"--workspace",
		lane.workspace,
		"lane",
		"serve",
		"--executor",
		lane.executor,
		"--max",
		String(lane.max),
		"--rules",
		lane.rules,
		"--repo",
		lane.repo,
		...(lane.project ? ["--project", lane.project] : []),
		...(lane.routingConfig ? ["--routing-config", lane.routingConfig] : []),
		...(lane.coordinated ? ["--coordinated"] : []),
		...(lane.acceptProposed ? ["--accept-proposed"] : []),
	];
}

export function laneDutyFromServeOptions(options: ServeLike): LaneDuty {
	const selector = (name: string) => {
		const index = options.scope.indexOf(name);
		if (index < 0 || !options.scope[index + 1])
			throw new Error(`lane serve --install needs ${name}`);
		return options.scope[index + 1]!;
	};
	return laneSchema.parse({
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

function lanesPath(env: NodeJS.ProcessEnv): string {
	return join(configDir(env), LANES_FILE);
}

/** Throws when the file exists but does not parse: a typo must not silently stop every lane. */
export function readLaneDuties(env: NodeJS.ProcessEnv): LaneDuty[] {
	const path = lanesPath(env);
	if (!existsSync(path)) return [];
	return fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).lanes;
}

function writeLaneDuties(env: NodeJS.ProcessEnv, lanes: LaneDuty[]): void {
	const path = lanesPath(env);
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	writeFileSync(
		`${path}.tmp`,
		`${JSON.stringify({ version: 1, lanes }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	renameSync(`${path}.tmp`, path);
}

/** Adds or replaces the dispatcher for the duty's organization and executor. */
export function writeLaneDuty(
	env: NodeJS.ProcessEnv,
	lane: LaneDuty,
): { replaced: boolean } {
	const lanes = readLaneDuties(env);
	const key = laneKey(lane);
	const index = lanes.findIndex((entry) => laneKey(entry) === key);
	if (index >= 0) lanes[index] = lane;
	else lanes.push(lane);
	writeLaneDuties(env, lanes);
	return { replaced: index >= 0 };
}

export function removeLaneDuty(env: NodeJS.ProcessEnv, key: string): boolean {
	const lanes = readLaneDuties(env);
	const kept = lanes.filter((entry) => laneKey(entry) !== key);
	if (kept.length === lanes.length) return false;
	writeLaneDuties(env, kept);
	return true;
}

/**
 * Reads the dispatcher a former `lane serve --install` LaunchAgent ran, from
 * the `<string>` entries of its ProgramArguments. Returns undefined when the
 * file is not such an agent.
 */
export function laneDutyFromPlist(
	xml: string,
	parse: ParseServe,
): LaneDuty | undefined {
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
	return laneDutyFromServeOptions(options);
}

export const LANE_AGENT_PREFIX = "dev.tedix.lane-serve.";

/**
 * Moves every `dev.tedix.lane-serve.*` LaunchAgent into the lanes file,
 * unloads it and removes its plist. The supervisor starts the dispatcher
 * on its next tick, so the lane is back within a minute.
 */
export function adoptLaneLaunchAgents(
	env: NodeJS.ProcessEnv,
	run: RunLaunchctl,
	parse: ParseServe,
	{
		home = homedir(),
		domain = `gui/${process.getuid?.() ?? 0}`,
	}: { home?: string; domain?: string } = {},
): { adopted: LaneDuty[]; skipped: string[] } {
	const folder = join(home, "Library", "LaunchAgents");
	const adopted: LaneDuty[] = [];
	const skipped: string[] = [];
	if (!existsSync(folder)) return { adopted, skipped };
	for (const name of readdirSync(folder).sort()) {
		if (!name.startsWith(LANE_AGENT_PREFIX) || !name.endsWith(".plist"))
			continue;
		const path = join(folder, name);
		let lane: LaneDuty | undefined;
		try {
			lane = laneDutyFromPlist(readFileSync(path, "utf8"), parse);
		} catch (error) {
			skipped.push(`${name}: ${(error as Error).message}`);
			continue;
		}
		if (!lane) {
			skipped.push(`${name}: not a lane serve agent`);
			continue;
		}
		writeLaneDuty(env, lane);
		run(["bootout", `${domain}/${name.slice(0, -".plist".length)}`]);
		rmSync(path, { force: true });
		adopted.push(lane);
	}
	return { adopted, skipped };
}

export interface LaneChild {
	pid: number;
	onExit(listener: (code: number | null) => void): void;
	stop(signal: NodeJS.Signals): void;
}
export type SpawnLane = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; log: string },
) => LaneChild;

export const spawnLane: SpawnLane = (command, args, { cwd, env, log }) => {
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
	lane: LaneDuty;
	pid: number;
	startedAt: number;
	/** Set for children this supervisor spawned; an adopted child is only watched by pid. */
	child?: LaneChild;
}

export interface LaneDutiesDeps {
	env: NodeJS.ProcessEnv;
	now?: () => number;
	log?: (line: string) => void;
	spawn?: SpawnLane;
	/** The `tedix` program; defaults to this CLI. */
	program?: () => [string, string[]];
}

/** Keeps the configured dispatchers running; one instance per supervisor. */
export class LaneDuties {
	private readonly running = new Map<string, Running>();
	private readonly exits = new Map<string, number[]>();
	private readonly restartAt = new Map<string, number>();
	private configError: string | undefined;

	constructor(private readonly deps: LaneDutiesDeps) {}

	private log(line: string) {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(
			`lanes: ${line}`,
		);
	}
	private now() {
		return (this.deps.now ?? Date.now)();
	}
	private directory(lane: LaneDuty) {
		return join(configDir(this.deps.env), "dispatchers", laneKey(lane));
	}
	private childPath(lane: LaneDuty) {
		return join(this.directory(lane), CHILD_FILE);
	}

	/** What the supervisor believes is running, for `tedix supervise lanes`. */
	status(): { key: string; executor: string; pid: number | null }[] {
		return [...this.running].map(([key, entry]) => ({
			key,
			executor: entry.lane.executor,
			pid: entry.pid,
		}));
	}

	/** Starts missing dispatchers, notes exits, stops removed ones. */
	tick(): void {
		let lanes: LaneDuty[];
		try {
			lanes = readLaneDuties(this.deps.env);
			this.configError = undefined;
		} catch (error) {
			const message = (error as Error).message?.split("\n")[0] ?? "invalid";
			if (this.configError !== message)
				this.log(`${LANES_FILE} not read, lanes left as they are: ${message}`);
			this.configError = message;
			return;
		}
		const wanted = new Map(
			lanes.filter((lane) => lane.enabled).map((lane) => [laneKey(lane), lane]),
		);
		for (const [key, entry] of this.running) {
			if (wanted.has(key)) continue;
			this.log(`${entry.lane.executor} removed from ${LANES_FILE}; stopping`);
			this.stopOne(key, entry);
		}
		const now = this.now();
		for (const [key, lane] of wanted) {
			const entry = this.running.get(key);
			if (entry) {
				if (entry.child || alive(entry.pid)) continue;
				// An adopted child ended; nobody told us, so note it here.
				this.running.delete(key);
				this.noteExit(key, lane, null, now);
			}
			if (!this.running.has(key)) {
				const adopted = this.adopt(key, lane, now);
				if (adopted) continue;
				const due = this.restartAt.get(key) ?? 0;
				if (due > now) continue;
				this.start(key, lane, now);
			}
		}
	}

	private adopt(key: string, lane: LaneDuty, now: number): boolean {
		try {
			const state = JSON.parse(readFileSync(this.childPath(lane), "utf8"));
			if (
				Number.isSafeInteger(state.pid) &&
				state.pid > 0 &&
				alive(state.pid)
			) {
				this.running.set(key, { lane, pid: state.pid, startedAt: now });
				this.log(`${lane.executor} adopted (pid ${state.pid})`);
				return true;
			}
		} catch {
			/* No child file. */
		}
		return false;
	}

	private start(key: string, lane: LaneDuty, now: number): void {
		const [command, prefix] = (this.deps.program ?? selfCommand)();
		const log = laneLogPath(this.deps.env, lane);
		let child: LaneChild;
		try {
			child = (this.deps.spawn ?? spawnLane)(
				command,
				[...prefix, ...laneServeArgs(lane)],
				{
					cwd: homedir(),
					env: laneChildEnv(this.deps.env),
					log,
				},
			);
		} catch (error) {
			this.noteExit(key, lane, null, now);
			this.log(
				`${lane.executor} could not start: ${(error as Error).message?.slice(0, 200)}`,
			);
			return;
		}
		if (!child.pid) {
			this.noteExit(key, lane, null, now);
			this.log(`${lane.executor} could not start: no pid`);
			return;
		}
		const entry: Running = { lane, pid: child.pid, startedAt: now, child };
		this.running.set(key, entry);
		try {
			mkdirSync(this.directory(lane), { recursive: true, mode: 0o700 });
			writeFileSync(
				this.childPath(lane),
				JSON.stringify({ pid: child.pid, startedAt: now }),
				{ mode: 0o600 },
			);
		} catch {
			/* The child runs; the record only helps a later supervisor adopt it. */
		}
		this.log(`${lane.executor} started (pid ${child.pid}, ${lane.max} slots)`);
		child.onExit((code) => {
			if (this.running.get(key) !== entry) return;
			this.running.delete(key);
			rmSync(this.childPath(lane), { force: true });
			this.noteExit(key, lane, code, this.now());
		});
	}

	private noteExit(
		key: string,
		lane: LaneDuty,
		code: number | null,
		now: number,
	) {
		const recent = (this.exits.get(key) ?? []).filter(
			(at) => now - at < EXIT_WINDOW_MS,
		);
		recent.push(now);
		this.exits.set(key, recent);
		const delay = Math.min(
			LANE_RESTART_BASE_MS * 2 ** (recent.length - 1),
			LANE_RESTART_MAX_MS,
		);
		this.restartAt.set(key, now + delay);
		this.log(
			`${lane.executor} exited (${code === null ? "no exit code" : `code ${code}`}); restart in ${Math.round(delay / 1000)}s`,
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
		rmSync(this.childPath(entry.lane), { force: true });
	}

	/** Stops every dispatcher this supervisor runs; called when the supervisor exits. */
	stop(): void {
		for (const [key, entry] of [...this.running]) {
			this.log(`${entry.lane.executor} stopping with the supervisor`);
			this.stopOne(key, entry);
		}
	}
}
