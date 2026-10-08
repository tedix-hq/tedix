/**
 * Shared plumbing for `tedix hooks`: bounded host-event parsing, chat identity
 * checks and the CLI read seam. Hooks read host metadata only; prompt text is
 * never placed in a command argument, uploaded by the read hooks, logged or saved.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentContext } from "../agent-context";
import { IS_STANDALONE_BUILD } from "../shared";

export const PROFILE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
export const ORGANIZATION_PROBE =
	"async () => { const r = await codemode.__runtime(); return {organizationId:r.organizationId}; }";

export type JsonObject = Record<string, any>;

/** Credentials an exported agent identity would use instead of the signed-in user. */
export const AGENT_IDENTITY_ENV = [
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_AGENT_SESSION",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
] as const;

/**
 * One `tedix <args>` read that must return a JSON object; throws otherwise.
 * `input` goes to the child's stdin, so text never appears in its arguments.
 */
export type ReadJson = (
	args: string[],
	timeoutMs: number,
	input?: string,
) => Promise<JsonObject>;

export interface HookDeps {
	env: NodeJS.ProcessEnv;
	/** Raw host event text (already bounded by the caller). */
	stdin: string;
	cwd: string;
	read: ReadJson;
	write: (line: string) => void;
	now?: () => Date;
	/** Current Git branch of a directory, or "" when unknown. */
	branch?: (cwd: string) => string;
}

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the host event and its single, normalized chat identity. */
export function hostEvent(
	raw: string,
	env: NodeJS.ProcessEnv,
	limit: number,
	options: { requireIdentity?: boolean } = {},
): { event: JsonObject; session: string | undefined } {
	if (raw.length > limit) throw new Error("host event too large");
	const event: unknown = raw ? JSON.parse(raw) : {};
	if (!isObject(event)) throw new Error("unexpected host event");
	const identities = [
		event.session_id,
		env.CODEX_SESSION_ID,
		env.CODEX_THREAD_ID,
	].filter((value) => value !== undefined && value !== null);
	if (
		(options.requireIdentity && !identities.length) ||
		identities.some(
			(value) => typeof value !== "string" || !UUID.test(value),
		) ||
		new Set(identities.map((value) => String(value).toLowerCase())).size > 1
	)
		throw new Error("missing, invalid or conflicting chat identity");
	return {
		event,
		session: identities.length
			? String(identities[0]).toLowerCase()
			: undefined,
	};
}

/**
 * True for a run nobody is attending, so no question can be put to a person:
 * `claude -p` and the Agent SDK (CLAUDE_CODE_SESSION_ATTENDED=0), and
 * `codex exec`, whose rollout transcript opens with session_meta
 * `"source":"exec"` (Codex hooks carry no environment or payload flag for it).
 */
export function unattendedRun(
	event: JsonObject,
	env: NodeJS.ProcessEnv,
): boolean {
	if (env.CLAUDE_CODE_SESSION_ATTENDED === "0") return true;
	const transcript = event.transcript_path;
	if (
		event.turn_id === undefined ||
		typeof transcript !== "string" ||
		!isAbsolute(transcript) ||
		!transcript.endsWith(".jsonl")
	)
		return false;
	let head = "";
	try {
		const fd = openSync(transcript, "r");
		try {
			const buffer = Buffer.alloc(8192);
			head = buffer
				.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
				.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
	const first = head.split("\n", 1)[0] ?? "";
	return (
		first.includes('"type":"session_meta"') && /"source":"exec"/.test(first)
	);
}

/** Largest host event decision capture accepts. */
export const CAPTURE_EVENT_LIMIT = 4_194_304;

/**
 * True when `tedix hooks capture-stop` owns this chat's Stop status. Both Stop
 * hooks start together, so neither waits on a marker from the other: each
 * evaluates this same local opt-in (decision capture enabled for the bound
 * chat), and capture-stop claims Stop on exactly the condition below.
 */
export function captureOwnsStop(raw: string, env: NodeJS.ProcessEnv): boolean {
	try {
		const { event, session } = hostEvent(raw, env, CAPTURE_EVENT_LIMIT, {
			requireIdentity: true,
		});
		// Capture skips an unattended run, so the status hook keeps its Stop.
		if (unattendedRun(event, env)) return false;
		const binding = resolveAgentContext({
			sessionId: session!,
			allowDefault: true,
		});
		return binding.status === "bound" && binding.decisionCapture === true;
	} catch {
		return false;
	}
}

/** ISO-8601 UTC with second precision and an explicit offset. */
export function isoSeconds(date: Date, zulu = false): string {
	return date.toISOString().replace(/\.\d{3}Z$/, zulu ? "Z" : "+00:00");
}

/** True when `cwd` is the bound checkout root or inside it, after resolving symlinks. */
export function insideRoot(root: unknown, cwd: string): boolean {
	if (typeof root !== "string") throw new Error("missing checkout root");
	const resolved = realpathSync(root);
	const current = realpathSync(cwd);
	return (
		current === resolved ||
		current.startsWith(resolved.endsWith("/") ? resolved : `${resolved}/`)
	);
}

/** Read stdin, stopping once it exceeds `limit` characters' worth of bytes. */
export async function readBoundedStdin(limit: number): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	// UTF-8 needs at most four bytes per character; the character check follows.
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		chunks.push(buffer);
		size += buffer.length;
		if (size > limit * 4) break;
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** This CLI as an executable plus leading arguments (source checkouts run through Bun). */
export function selfCommand(): [string, string[]] {
	if (IS_STANDALONE_BUILD) return [process.execPath, []];
	return [
		process.execPath,
		[fileURLToPath(new URL("../index.ts", import.meta.url))],
	];
}

export const HOOK_READ_STDOUT_LIMIT = 4_194_304;

/** The production child collector, also exercised with real fictional child streams. */
export function readJsonChild(
	command: string,
	args: string[],
	timeoutMs: number,
	input?: string,
): Promise<JsonObject> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		return Promise.reject(new Error("Invalid CLI read timeout"));
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env },
			detached: process.platform !== "win32",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
		});
		let terminal = false,
			bytes = 0;
		const chunks: Buffer[] = [];
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {}
		};
		const fail = (error: Error) => {
			if (terminal) return;
			terminal = true;
			clearTimeout(timer);
			child.stdout?.destroy();
			child.stdin?.destroy();
			kill("SIGTERM");
			// Keep the bounded escalation alive even if the immediate child
			// closes while an inherited group member remains.
			setTimeout(() => kill("SIGKILL"), 100);
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new Error("Tedix CLI read deadline elapsed")),
			timeoutMs,
		);
		if (input !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		}
		child.stdout!.on("data", (chunk: Buffer) => {
			if (terminal) return;
			const n = chunk.byteLength;
			if (!Number.isSafeInteger(n) || n > HOOK_READ_STDOUT_LIMIT - bytes) {
				fail(new Error("Tedix CLI read output exceeds byte limit"));
				return;
			}
			bytes += n;
			chunks.push(chunk);
		});
		child.stdout!.on("error", () =>
			fail(new Error("Tedix CLI read stream failed")),
		);
		child.on("error", () => fail(new Error("Tedix CLI read failed")));
		child.on("close", (code, signal) => {
			if (terminal) return;
			if (code !== 0 || signal !== null) {
				fail(new Error("Tedix CLI read failed"));
				return;
			}
			try {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.concat(chunks, bytes),
				);
				const value: unknown = JSON.parse(text);
				if (!isObject(value))
					throw new Error("Tedix CLI returned an unexpected shape");
				terminal = true;
				clearTimeout(timer);
				resolve(value);
			} catch {
				fail(new Error("Tedix CLI returned invalid JSON"));
			}
		});
	});
}

function spawnJson(
	args: string[],
	timeoutMs: number,
	input?: string,
): Promise<JsonObject> {
	const [command, prefix] = selfCommand();
	return readJsonChild(command, [...prefix, ...args], timeoutMs, input);
}

function plain(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Run one CLI read. Local context resolution runs in-process with the same
 * result as its `--json` command; every other read runs this CLI as a child so
 * it keeps its complete auth, profile and organization routing.
 */
export const cliRead: ReadJson = async (args, timeoutMs, input) => {
	if (
		args.slice(0, 5).join(" ") === "setup agents context show --json" &&
		(args.length === 5 || (args.length === 7 && args[5] === "--session"))
	)
		return plain(
			resolveAgentContext(args[6] ? { sessionId: args[6] } : undefined),
		);
	return spawnJson(args, timeoutMs, input);
};
