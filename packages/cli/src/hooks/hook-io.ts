/**
 * Shared plumbing for `tedix hooks`: bounded host-event parsing, chat identity
 * checks and the CLI read seam. Hooks read host metadata only; prompt text is
 * never placed in a command argument, uploaded by the read hooks, logged or saved.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgentContext } from "../agent-context";
import { IS_STANDALONE_BUILD } from "../shared";

export const PROFILE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
export const ORGANIZATION_PROBE =
	"async () => { const r = await codemode.__runtime(); return {organizationId:r.organizationId}; }";

export type JsonObject = Record<string, any>;

/** One `tedix <args>` read that must return a JSON object; throws otherwise. */
export type ReadJson = (
	args: string[],
	timeoutMs: number,
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

function spawnJson(args: string[], timeoutMs: number): Promise<JsonObject> {
	const [command, prefix] = selfCommand();
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...prefix, ...args], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			stdout += data;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error("Tedix CLI read failed"));
			try {
				const value: unknown = JSON.parse(stdout);
				if (!isObject(value))
					throw new Error("Tedix CLI returned an unexpected shape");
				resolve(value);
			} catch (error) {
				reject(error);
			}
		});
	});
}

function plain(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Run one CLI read. Local context resolution runs in-process with the same
 * result as its `--json` command; every other read runs this CLI as a child so
 * it keeps its complete auth, profile and organization routing.
 */
export const cliRead: ReadJson = async (args, timeoutMs) => {
	if (
		args.slice(0, 5).join(" ") === "setup agents context show --json" &&
		(args.length === 5 || (args.length === 7 && args[5] === "--session"))
	)
		return plain(
			resolveAgentContext(args[6] ? { sessionId: args[6] } : undefined),
		);
	return spawnJson(args, timeoutMs);
};
