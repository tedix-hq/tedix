/**
 * `tedix supervise`: a local loop that delivers a tedi auto reply to a Codex
 * session after its own Stop hook stopped waiting.
 *
 * `await-draft` holds a Codex turn for at most 5 minutes. A draft that lands
 * later reaches nobody, so the session sits idle while its owner is away.
 * Every 30 seconds this reads the decision-capture state each turn leaves in
 * `~/.tedix/decision-capture` and, for a Codex chat still waiting on a question
 * whose tedi draft the server marked `delivery: "auto"` (the same rule and
 * consecutive cap as the hooks), queues the framed draft with `codex queue`.
 * An open Codex window takes it at once, which its transcript confirms;
 * otherwise the queued copy is withdrawn and the session resumes headless with
 * `codex exec resume`, whose reported thread ID must match. The
 * delivery is recorded locally exactly as the hooks record it.
 *
 * It sends nothing but a tedi draft from Tedix, at most once per question.
 * Claude Code keeps its own `await-reply` wake; a draft that arrives after that
 * wait expired is only logged. Activity goes to `~/.tedix/supervisor.log`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AWAIT_DRAFT_MAX_MS } from "./hooks/await-draft";
import {
	AWAIT_MAX_MS,
	autoDeliverable,
	autoDraftMessage,
	deliverAutoDraft,
} from "./hooks/await-reply";
import {
	autoDeliveryPath,
	bindingFor,
	captureStatePath,
	draftStatusPath,
	interactionDetail,
	peek,
} from "./hooks/decision-capture";
import {
	AGENT_IDENTITY_ENV,
	cliRead,
	isoSeconds,
	type ReadJson,
	selfCommand,
	UUID,
} from "./hooks/hook-io";

export const SUPERVISE_INTERVAL_MS = 30_000;
/** After `await-draft` gave up, with a minute of grace for its last read. */
export const CODEX_IDLE_MS = AWAIT_DRAFT_MAX_MS + 60_000;
/** Questions expire after a day; nothing older is worth a read. */
const QUESTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long an open Codex window gets to take the queued message. */
export const QUEUE_PICKUP_MS = 45_000;
const QUEUE_POLL_MS = 3000;
const RESUME_CONFIRM_MS = 60_000;
const DETAIL_TIMEOUT_MS = 15_000;
/** Recheck a question without a deliverable draft at most this often. */
const RECHECK_MAX_MS = 10 * 60 * 1000;
const LOG_LIMIT = 1024 * 1024;
export const LAUNCH_AGENT_LABEL = "dev.tedix.supervisor";

/** The Codex operations the supervisor needs; tests replace them with fakes. */
export interface CodexDriver {
	/**
	 * Queue a message for a thread: the queued item ID and the transcript size
	 * before it, or undefined on failure.
	 */
	queue(
		thread: string,
		message: string,
	): Promise<{ id: string; offset: number } | undefined>;
	/** True once the thread's transcript after `offset` holds the message. */
	received(thread: string, message: string, offset: number): boolean;
	/** Remove a still-waiting queued item; true only when this call removed it. */
	withdraw(item: string): boolean;
	/** Resume the thread headless with the message; true once the thread ID is confirmed. */
	resume(thread: string, message: string, cwd: string): Promise<boolean>;
}

export interface SuperviseDeps {
	env: NodeJS.ProcessEnv;
	read: ReadJson;
	codex: CodexDriver;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function configDir(env: NodeJS.ProcessEnv): string {
	return env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

export function supervisorLog(env: NodeJS.ProcessEnv, line: string): void {
	try {
		const directory = configDir(env);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "supervisor.log");
		if (existsSync(path) && statSync(path).size > LOG_LIMIT)
			renameSync(path, `${path}.1`);
		appendFileSync(path, `${isoSeconds(new Date(), true)} ${line}\n`, {
			mode: 0o600,
		});
	} catch {
		// Logging is best effort.
	}
}

interface Candidate {
	session: string;
	host: string;
	requestId: string;
	token: string;
	state: string;
	ageMs: number;
	cwd: string;
}

/** Chats whose newest question still waits and had a tedi draft queued. */
export function waitingQuestions(
	env: NodeJS.ProcessEnv,
	now: number,
): Candidate[] {
	const directory = join(configDir(env), "decision-capture");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const found: Candidate[] = [];
	for (const name of names) {
		const session = name.endsWith(".question.json")
			? name.slice(0, -".question.json".length)
			: "";
		if (!UUID.test(session)) continue;
		const state = captureStatePath(env, session);
		const questionFile = join(directory, name);
		const question = peek(questionFile);
		const current = peek(state);
		const drafted = peek(draftStatusPath(state));
		if (
			!question ||
			typeof question.requestId !== "string" ||
			!UUID.test(question.requestId) ||
			typeof question.token !== "string" ||
			// A typed reply or a newer turn claimed the question.
			current?.token !== question.token ||
			current?.requestId !== question.requestId ||
			drafted?.requestId !== question.requestId ||
			drafted?.status !== "queued" ||
			// Already delivered once.
			peek(autoDeliveryPath(state))?.requestId === question.requestId
		)
			continue;
		let ageMs: number;
		try {
			ageMs = now - statSync(questionFile).mtimeMs;
		} catch {
			continue;
		}
		if (ageMs > QUESTION_MAX_AGE_MS) continue;
		const host = question.host === "codex" ? "codex" : "claude-code";
		const status = peek(
			join(configDir(env), "agent-status", `${host}-${session}.json`),
		);
		// The session is running again (typed reply not captured, or a tool call).
		if (status?.state === "working") continue;
		found.push({
			session,
			host,
			requestId: question.requestId,
			token: question.token,
			state,
			ageMs,
			cwd:
				typeof status?.cwd === "string" && status.cwd ? status.cwd : homedir(),
		});
	}
	return found;
}

/** One pass with per-question backoff; `supervise --once` runs a fresh one. */
export class Supervisor {
	private readonly recheck = new Map<string, { at: number; delay: number }>();
	private readonly logged = new Set<string>();

	constructor(private readonly deps: SuperviseDeps) {}

	private log(line: string): void {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(line);
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/** Questions read and failed reads in the last pass. */
	lastPass = { checked: 0, failed: 0 };

	/** Returns the number of drafts delivered in this pass. */
	async tick(): Promise<number> {
		let delivered = 0;
		this.lastPass = { checked: 0, failed: 0 };
		const now = this.now();
		for (const candidate of waitingQuestions(this.deps.env, now)) {
			const due =
				candidate.host === "codex"
					? candidate.ageMs >= CODEX_IDLE_MS
					: candidate.ageMs >= AWAIT_MAX_MS;
			if (!due || this.logged.has(candidate.requestId)) continue;
			const backoff = this.recheck.get(candidate.requestId);
			if (backoff && backoff.at > now) continue;
			let sent = false;
			// The chat's context resolves from its own checkout, as in its hooks.
			const home = process.cwd();
			this.lastPass.checked++;
			try {
				if (existsSync(candidate.cwd)) process.chdir(candidate.cwd);
				sent = await this.consider(candidate);
			} catch (error) {
				this.lastPass.failed++;
				if (!backoff)
					this.log(
						`${candidate.host} ${candidate.session}: check failed: ${(error as Error).message?.slice(0, 200)}`,
					);
			} finally {
				process.chdir(home);
			}
			if (sent) delivered++;
			else {
				const delay = Math.min(
					(backoff?.delay ?? SUPERVISE_INTERVAL_MS / 2) * 2,
					RECHECK_MAX_MS,
				);
				this.recheck.set(candidate.requestId, { at: now + delay, delay });
			}
		}
		return delivered;
	}

	private async consider(candidate: Candidate): Promise<boolean> {
		const env = this.deps.env;
		const hookDeps = {
			env,
			stdin: "",
			cwd: candidate.cwd,
			read: this.deps.read,
			write: () => {},
		};
		const binding = await bindingFor(hookDeps, candidate.session);
		if (!binding) return false;
		const detail = await interactionDetail(
			hookDeps,
			binding,
			candidate.requestId,
			DETAIL_TIMEOUT_MS,
		);
		if (!detail) return false;
		if (detail.state !== "open") {
			this.logged.add(candidate.requestId);
			return false;
		}
		if (detail.expiresAt && Date.parse(detail.expiresAt) <= Date.now())
			return false;
		if (!autoDeliverable(detail, candidate.state)) return false;
		this.logged.add(candidate.requestId);
		if (candidate.host !== "codex") {
			this.log(
				`claude-code ${candidate.session}: auto draft ${detail.draft.id} for question ${candidate.requestId} arrived after await-reply stopped waiting; not delivered (Claude Code delivery is not supported yet)`,
			);
			return false;
		}
		const current = peek(candidate.state);
		if (current?.token !== candidate.token) return false;
		const message = autoDraftMessage(detail.draft);
		const item = await this.deps.codex.queue(candidate.session, message);
		if (!item) {
			this.log(
				`codex ${candidate.session}: codex queue failed; draft ${detail.draft.id} not delivered`,
			);
			return false;
		}
		// Record before confirming, so a crash can never deliver it twice.
		const event = {
			hook_event_name: "Stop",
			session_id: candidate.session,
			turn_id: "tedix-supervisor",
			cwd: candidate.cwd,
		};
		deliverAutoDraft(
			{ ...env },
			{ ...hookDeps, stdin: JSON.stringify(event) },
			event,
			candidate.state,
			{ requestId: candidate.requestId },
			detail.draft,
		);
		const sleep = this.deps.sleep ?? pause;
		const until = this.now() + QUEUE_PICKUP_MS;
		for (;;) {
			// Only the session transcript proves a window took it: Codex can drop a
			// queued item for a thread nobody has open without running it.
			if (this.deps.codex.received(candidate.session, message, item.offset)) {
				this.log(
					`codex ${candidate.session}: delivered draft ${detail.draft.id} for question ${candidate.requestId} to the open session`,
				);
				return true;
			}
			if (this.now() + QUEUE_POLL_MS > until) break;
			await sleep(QUEUE_POLL_MS);
		}
		// No window took it: take any queued copy back, then resume headless.
		this.deps.codex.withdraw(item.id);
		if (this.deps.codex.received(candidate.session, message, item.offset)) {
			this.log(
				`codex ${candidate.session}: delivered draft ${detail.draft.id} for question ${candidate.requestId} to the open session`,
			);
			return true;
		}
		const resumed = await this.deps.codex.resume(
			candidate.session,
			message,
			candidate.cwd,
		);
		this.log(
			resumed
				? `codex ${candidate.session}: no open window; resumed headless with draft ${detail.draft.id} for question ${candidate.requestId}`
				: `codex ${candidate.session}: headless resume failed; draft ${detail.draft.id} not delivered`,
		);
		return resumed;
	}
}

/** Real Codex CLI and queue store. */
export function codexDriver(env: NodeJS.ProcessEnv): CodexDriver {
	const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
	const queueDb = join(codexHome, "queue_1.sqlite");
	const transcripts = new Map<string, string>();
	/** The thread's rollout under $CODEX_HOME/sessions/YYYY/MM/DD. */
	const transcript = (thread: string): string | undefined => {
		const known = transcripts.get(thread);
		if (known && existsSync(known)) return known;
		const root = join(codexHome, "sessions");
		try {
			for (const relative of readdirSync(root, { recursive: true }) as string[])
				if (relative.endsWith(`-${thread}.jsonl`)) {
					const path = join(root, relative);
					transcripts.set(thread, path);
					return path;
				}
		} catch {
			// No sessions directory.
		}
		return undefined;
	};
	const withDb = <T>(operation: (db: Database) => T): T | undefined => {
		if (!existsSync(queueDb)) return undefined;
		const db = new Database(queueDb);
		try {
			db.exec("PRAGMA busy_timeout = 3000");
			return operation(db);
		} catch {
			return undefined;
		} finally {
			db.close();
		}
	};
	return {
		async queue(thread, message) {
			const path = transcript(thread);
			if (!path) return undefined;
			const offset = statSync(path).size;
			const result = spawnSync(
				"codex",
				["queue", "--thread", thread, "--message", message],
				{
					encoding: "utf8",
					timeout: 60_000,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			if (result.status !== 0) return undefined;
			const match = /Queued message (\S+) for thread (\S+?)\.?\s*$/m.exec(
				result.stdout ?? "",
			);
			// A wrong thread must never receive the message.
			return match && match[2] === thread
				? { id: match[1]!, offset }
				: undefined;
		},
		received(thread, message, offset) {
			const path = transcript(thread);
			if (!path) return false;
			try {
				const fd = openSync(path, "r");
				try {
					const size = fstatSync(fd).size;
					const length = Math.min(size - offset, 8 * 1024 * 1024);
					if (length <= 0) return false;
					const buffer = Buffer.alloc(length);
					readSync(fd, buffer, 0, length, offset);
					// The transcript stores the text JSON-escaped, as JSON.stringify does.
					return buffer
						.toString("utf8")
						.includes(JSON.stringify(message).slice(1, 120));
				} finally {
					closeSync(fd);
				}
			} catch {
				return false;
			}
		},
		withdraw(item) {
			return (
				withDb(
					(db) =>
						db.query("DELETE FROM queued_items WHERE id = ?").run(item)
							.changes === 1,
				) ?? false
			);
		},
		async resume(thread, message, cwd) {
			const directory = join(configDir(env), "supervisor");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const output = join(directory, `resume-${thread}.jsonl`);
			const input = join(directory, `resume-${thread}.txt`);
			writeFileSync(input, message, { mode: 0o600 });
			writeFileSync(output, "", { mode: 0o600 });
			const stdio = [
				openSync(input, "r"),
				openSync(output, "a"),
				openSync(join(directory, "resume.err.log"), "a"),
			];
			const child = spawn(
				"codex",
				["exec", "--skip-git-repo-check", "--json", "resume", thread, "-"],
				{
					cwd: existsSync(cwd) ? cwd : homedir(),
					detached: true,
					stdio,
				},
			);
			child.unref();
			for (const fd of stdio) closeSync(fd);
			const deadline = Date.now() + RESUME_CONFIRM_MS;
			while (Date.now() < deadline) {
				const started = /"type":"thread\.started","thread_id":"([^"]+)"/.exec(
					readFileSync(output, "utf8"),
				);
				if (started) {
					if (started[1] === thread) return true;
					// `exec resume` with an unknown ID silently starts a new session.
					try {
						process.kill(-child.pid!, "SIGTERM");
					} catch {
						// Already gone.
					}
					return false;
				}
				if (child.exitCode !== null) return false;
				await pause(1000);
			}
			return false;
		},
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** One supervisor per user: a PID file, taken over when its owner is gone. */
function acquireLock(env: NodeJS.ProcessEnv): (() => void) | undefined {
	const path = join(configDir(env), "supervisor.pid");
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
			return () => rmSync(path, { force: true });
		} catch {
			const owner = Number(readFileSync(path, "utf8"));
			if (Number.isInteger(owner) && owner > 0 && alive(owner))
				return undefined;
			rmSync(path, { force: true });
		}
	}
	return undefined;
}

export const superviseUsage = `Deliver late tedi auto replies to idle Codex sessions (macOS and Linux)

  tedix supervise             Check every 30 seconds until stopped
  tedix supervise --once      Run one check and exit
  tedix supervise install     Run it at login as a user LaunchAgent (macOS)
  tedix supervise uninstall   Stop it and remove the LaunchAgent

A Codex session's await-draft hook waits 5 minutes for a tedi auto reply. When
one arrives later for a Codex chat still waiting on its question, the
supervisor queues it with codex queue (an open window acts on it) or, with no
window open, resumes the session headless with codex exec resume. It sends only
tedi drafts the server marked for automatic delivery, once per question and at
most three in a row, the same rules as the hooks. Claude Code sessions keep
their own await-reply wake; a draft that arrives after it stopped waiting is
only logged. Requires decision capture. Log: ~/.tedix/supervisor.log.`;

function launchAgentPath(): string {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${LAUNCH_AGENT_LABEL}.plist`,
	);
}

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

export function launchAgentPlist(
	program: string[],
	env: NodeJS.ProcessEnv,
): string {
	const logPath = join(configDir(env), "supervisor.launchd.log");
	const variables: Record<string, string> = {
		PATH: env.PATH || "/usr/bin:/bin",
		...(env.TEDIX_CONFIG_DIR ? { TEDIX_CONFIG_DIR: env.TEDIX_CONFIG_DIR } : {}),
		...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
	};
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program.map((arg) => `		<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(variables)
	.map(
		([key, value]) =>
			`		<key>${xml(key)}</key>\n		<string>${xml(value)}</string>`,
	)
	.join("\n")}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): number {
	return (
		spawnSync("launchctl", args, { stdio: ["ignore", "ignore", "ignore"] })
			.status ?? 1
	);
}

function install(env: NodeJS.ProcessEnv): number {
	if (process.platform !== "darwin") {
		console.error(
			"tedix supervise install writes a macOS LaunchAgent; elsewhere run tedix supervise under your own service manager.",
		);
		return 1;
	}
	const [command, prefix] = selfCommand();
	const path = launchAgentPath();
	mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(
		path,
		launchAgentPlist([command, ...prefix, "supervise"], env),
		{
			mode: 0o644,
		},
	);
	const domain = `gui/${process.getuid!()}`;
	launchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]);
	if (launchctl(["bootstrap", domain, path]) !== 0) {
		console.error(`Wrote ${path} but launchctl bootstrap failed.`);
		return 1;
	}
	console.log(
		`Installed ${path}; the supervisor runs now and at every login. Remove it with tedix supervise uninstall.`,
	);
	return 0;
}

function uninstall(): number {
	if (process.platform !== "darwin") return 0;
	launchctl(["bootout", `gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`]);
	rmSync(launchAgentPath(), { force: true });
	console.log("Removed the Tedix supervisor LaunchAgent.");
	return 0;
}

export async function runSuperviseCommand(args: string[]): Promise<number> {
	const [first] = args;
	if (first === "--help" || first === "-h") {
		console.log(superviseUsage);
		return 0;
	}
	const env = { ...process.env };
	if (first === "install" && args.length === 1) return install(env);
	if (first === "uninstall" && args.length === 1) return uninstall();
	const once = first === "--once" && args.length === 1;
	if (args.length && !once) {
		console.error(
			`Unknown supervise arguments "${args.join(" ")}". Run tedix supervise --help.`,
		);
		return 1;
	}
	// Questions belong to the signed-in user, never an exported agent identity.
	for (const key of AGENT_IDENTITY_ENV) delete env[key];
	const release = acquireLock(env);
	if (!release) {
		console.error("Another tedix supervise is already running.");
		return once ? 0 : 1;
	}
	const supervisor = new Supervisor({
		env,
		read: cliRead,
		codex: codexDriver(env),
	});
	try {
		if (once) {
			const delivered = await supervisor.tick();
			const { checked, failed } = supervisor.lastPass;
			console.log(
				`Checked ${checked} waiting question${checked === 1 ? "" : "s"} (${failed} failed); ${delivered} draft${delivered === 1 ? "" : "s"} delivered. Log: ${join(configDir(env), "supervisor.log")}`,
			);
			return 0;
		}
		supervisorLog(env, `supervisor started (pid ${process.pid})`);
		let stopped = false;
		const stop = () => {
			stopped = true;
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		while (!stopped) {
			await supervisor.tick();
			for (
				let waited = 0;
				waited < SUPERVISE_INTERVAL_MS && !stopped;
				waited += 1000
			)
				await pause(1000);
		}
		supervisorLog(env, "supervisor stopped");
		return 0;
	} finally {
		release();
	}
}
