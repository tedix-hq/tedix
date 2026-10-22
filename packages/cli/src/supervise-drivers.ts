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
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";
import { codexThreadPath } from "./codex-thread";
import { peek } from "./hooks/decision-capture";
import { isoSeconds, type JsonObject } from "./hooks/hook-io";
import { LOCAL_SIGNING_GUIDE } from "./local-signing";

/**
 * True for a path in a folder macOS privacy protection (TCC) guards. The
 * launchd supervisor has no access there: listing such a folder fails with
 * EINTR, which Bun retries until the read's deadline, so every delivery check
 * for a session checked out there timed out. Started elsewhere, the same read
 * resolves the session's default binding in well under a second.
 */
export function privacyProtected(
	path: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "darwin") return false;
	return [
		"Desktop",
		"Documents",
		"Downloads",
		join("Library", "Mobile Documents"),
	]
		.map((folder) => join(home, folder))
		.some((folder) => path === folder || path.startsWith(folder + sep));
}

/**
 * Why a headless resume in `cwd` cannot run, or undefined when it can. Codex
 * and Claude Code started there by the launchd supervisor fail with EINTR
 * ("Interrupted system call"), and no route around macOS privacy protection
 * reaches the checkout, so the resume is skipped with the grant that fixes it.
 */
export function protectedResumeReason(
	cwd: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!privacyProtected(cwd, env.HOME || homedir(), platform)) return undefined;
	return `not resumed headless: ${cwd} is in a macOS privacy-protected folder the background supervisor cannot open; grant it in System Settings > Privacy & Security > Full Disk Access (add ${process.execPath}; ${LOCAL_SIGNING_GUIDE}), or keep the checkout outside Documents, Desktop and Downloads`;
}

const RESUME_CONFIRM_MS = 60_000;

const LOG_LIMIT = 1024 * 1024;

/** The Codex operations the supervisor needs; tests replace them with fakes. */
export interface CodexDriver {
	/** Refresh the canonical transcript before a delivery or retained-queue retry. */
	resolveTranscript?(thread: string): Promise<boolean>;
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

/** The Claude Code operations the supervisor needs; tests replace them with fakes. */
export interface ClaudeDriver {
	/**
	 * True when a Claude Code process has this session open (a terminal
	 * window), false when none does, undefined when it cannot tell.
	 */
	open(session: string): boolean | undefined;
	/**
	 * Resume the session headless with the message in `cwd`. `started` is true
	 * once Claude reports this same session ID; `done` settles with whether the
	 * turn finished successfully.
	 */
	resume(
		session: string,
		message: string,
		cwd: string,
	): Promise<{ started: boolean; done: Promise<boolean> }>;
}

export const pause = (ms: number) =>
	new Promise<void>((done) => setTimeout(done, ms));

export function configDir(env: NodeJS.ProcessEnv): string {
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

/** Real Codex CLI and queue store. */
export function codexMessageReceived(
	transcript: string,
	message: string,
): boolean {
	for (const line of transcript.split("\n")) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const payload = row?.payload;
		if (row?.type === "event_msg" && payload?.type === "user_message") {
			if (
				typeof payload.message === "string" &&
				payload.message.includes(message)
			)
				return true;
		}
		if (
			row?.type === "response_item" &&
			payload?.type === "message" &&
			payload.role === "user" &&
			Array.isArray(payload.content)
		) {
			if (
				payload.content.some(
					(part: unknown) =>
						typeof part === "object" &&
						part !== null &&
						"type" in part &&
						part.type === "input_text" &&
						"text" in part &&
						typeof part.text === "string" &&
						part.text.includes(message),
				)
			)
				return true;
		}
	}
	return false;
}

export function codexDriver(env: NodeJS.ProcessEnv): CodexDriver {
	const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
	const queueDb = join(codexHome, "queue_1.sqlite");
	const transcripts = new Map<string, string>();
	const resolveTranscript = async (thread: string): Promise<boolean> => {
		const path = await codexThreadPath(thread, env);
		if (!path) {
			transcripts.delete(thread);
			return false;
		}
		transcripts.set(thread, path);
		return true;
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
		resolveTranscript,
		async queue(thread, message) {
			if (!transcripts.has(thread) && !(await resolveTranscript(thread)))
				return undefined;
			const path = transcripts.get(thread);
			if (!path) return undefined;
			const offset = statSync(path).size;
			const result = spawnSync(
				"codex",
				["queue", "--thread", thread, "--message", message],
				{
					env,
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
			const path = transcripts.get(thread);
			if (!path) return false;
			try {
				const fd = openSync(path, "r");
				try {
					const size = fstatSync(fd).size;
					const length = Math.min(size - offset, 8 * 1024 * 1024);
					if (length <= 0) return false;
					const buffer = Buffer.alloc(length);
					readSync(fd, buffer, 0, length, offset);
					return codexMessageReceived(buffer.toString("utf8"), message);
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
			const blocked = protectedResumeReason(cwd, env);
			if (blocked) {
				supervisorLog(env, `codex ${thread}: ${blocked}`);
				return false;
			}
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
					env,
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

/**
 * Real Claude Code CLI. A running session is found in Claude Code's session
 * registry (`~/.claude/sessions/<pid>.json`, live pid) or in a process's
 * arguments (`claude --resume <id>`); without the registry a plain `claude`
 * cannot be told apart, so `open` is then undefined.
 */
export function claudeDriver(env: NodeJS.ProcessEnv): ClaudeDriver {
	const registry = join(
		env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
		"sessions",
	);
	const running = (session: string): JsonObject | undefined => {
		let names: string[];
		try {
			names = readdirSync(registry);
		} catch {
			return undefined;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const entry = peek(join(registry, name));
			if (
				typeof entry?.sessionId === "string" &&
				entry.sessionId.toLowerCase() === session &&
				Number.isInteger(entry.pid) &&
				alive(entry.pid)
			)
				return entry;
		}
		return undefined;
	};
	return {
		open(session) {
			if (running(session)) return true;
			const ps = spawnSync("ps", ["-axo", "command="], {
				encoding: "utf8",
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (ps.status !== 0) return undefined;
			if ((ps.stdout ?? "").toLowerCase().includes(session)) return true;
			return existsSync(registry) ? false : undefined;
		},
		async resume(session, message, cwd) {
			const blocked = protectedResumeReason(cwd, env);
			if (blocked) {
				supervisorLog(env, `claude-code ${session}: ${blocked}`);
				return { started: false, done: Promise.resolve(false) };
			}
			const directory = join(configDir(env), "supervisor");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const output = join(directory, `claude-resume-${session}.jsonl`);
			const input = join(directory, `claude-resume-${session}.txt`);
			writeFileSync(input, message, { mode: 0o600 });
			writeFileSync(output, "", { mode: 0o600 });
			const stdio = [
				openSync(input, "r"),
				openSync(output, "a"),
				openSync(join(directory, "resume.err.log"), "a"),
			];
			// The documented headless resume; the message arrives on stdin.
			const child = spawn(
				"claude",
				[
					"-p",
					"--resume",
					session,
					"--output-format",
					"stream-json",
					"--verbose",
				],
				{
					cwd: existsSync(cwd) ? cwd : homedir(),
					detached: true,
					stdio,
					env: { ...env },
				},
			);
			child.unref();
			for (const fd of stdio) closeSync(fd);
			const done = new Promise<boolean>((resolve) => {
				child.once("exit", (code) => resolve(code === 0));
				child.once("error", () => resolve(false));
			});
			const stop = () => {
				try {
					process.kill(-child.pid!, "SIGTERM");
				} catch {
					// Already gone.
				}
			};
			const deadline = Date.now() + RESUME_CONFIRM_MS;
			while (Date.now() < deadline) {
				for (const line of readFileSync(output, "utf8").split("\n")) {
					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					const init = event as JsonObject;
					if (init?.type !== "system" || init.subtype !== "init") continue;
					if (init.session_id === session) return { started: true, done };
					// Never let a run continue in another session.
					stop();
					return { started: false, done };
				}
				if (child.exitCode !== null) return { started: false, done };
				await pause(1000);
			}
			stop();
			return { started: false, done };
		},
	};
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
