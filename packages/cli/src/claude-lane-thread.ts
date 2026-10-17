import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { UUID, isObject } from "./hooks/hook-io";
import { laneChildEnv } from "./lane-child-env";

export function claudeConfigDirectory(env = process.env, cwd = process.cwd()) {
	return resolve(cwd, env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

/** Native metadata requests only: no user frame or model turn before admission. */
export async function createClaudeLaneThread(
	cwd: string,
	executable = "claude",
	env = process.env,
	timeoutMs = 30_000,
) {
	const began = Date.now();
	const child = spawn(
		executable,
		[
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
		],
		{
			cwd,
			env: laneChildEnv(env),
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<
		string,
		{
			resolve: (value: Record<string, unknown>) => void;
			reject: (error: Error) => void;
		}
	>();
	const rejectAll = (error: Error) => {
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	child.on("error", rejectAll);
	child.on("exit", () =>
		rejectAll(new Error("Claude metadata process exited before admission")),
	);
	child.stdin.on("error", rejectAll);
	lines.on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.type !== "control_response") return;
		const response = message.response;
		const request = pending.get(response?.request_id);
		if (!request) return;
		pending.delete(response.request_id);
		if (response.subtype === "error")
			request.reject(new Error(String(response.error)));
		else if (isObject(response.response)) request.resolve(response.response);
		else request.reject(new Error("Claude returned malformed metadata"));
	});
	let sequence = 0;
	const call = (request: Record<string, string>) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = String(++sequence);
			pending.set(id, { resolve, reject });
			child.stdin.write(
				JSON.stringify({ type: "control_request", request_id: id, request }) +
					"\n",
			);
		});
	const timer = setTimeout(() => {
		rejectAll(
			new Error(
				"Claude metadata initialization timed out; no model turn launched",
			),
		);
		child.kill("SIGTERM");
	}, timeoutMs);
	try {
		const initialized = await call({ subtype: "initialize" });
		const native = JSON.parse(
			readFileSync(
				join(claudeConfigDirectory(env, cwd), "sessions", `${child.pid}.json`),
				"utf8",
			),
		);
		if (
			initialized.pid !== child.pid ||
			native.pid !== child.pid ||
			typeof native.startedAt !== "number" ||
			native.startedAt < began ||
			typeof native.sessionId !== "string" ||
			!UUID.test(native.sessionId) ||
			typeof native.cwd !== "string" ||
			realpathSync(native.cwd) !== realpathSync(cwd) ||
			typeof native.version !== "string" ||
			!native.version ||
			initialized.claude_code_version !== native.version
		)
			throw new Error(
				"Claude did not expose a verified native PID/session record; no model turn launched",
			);
		// Summary uses local estimates; the full context request may call a token API.
		const context = await call({
			subtype: "get_context_usage",
			detail: "summary",
		});
		if (typeof context.model !== "string" || !context.model.trim())
			throw new Error(
				"Claude did not return its native model; no model turn launched",
			);
		return {
			thread: {
				id: native.sessionId as string,
				cliVersion: native.version as string,
			},
			model: context.model,
			modelProvider: "anthropic",
		};
	} finally {
		clearTimeout(timer);
		lines.close();
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((resolve) =>
				child.once("exit", () => resolve()),
			);
			child.kill("SIGTERM");
			const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
			await exited;
			clearTimeout(kill);
		}
	}
}

/** Locate only this native session's transcript, without reading other sessions. */
export function claudeTranscript(
	id: string,
	configDirectory = claudeConfigDirectory(),
) {
	if (!UUID.test(id)) return undefined;
	let directories;
	try {
		directories = readdirSync(join(configDirectory, "projects"), {
			withFileTypes: true,
		});
	} catch {
		return undefined;
	}
	const matches = directories
		.filter((dir) => dir.isDirectory())
		.map((dir) => join(configDirectory, "projects", dir.name, `${id}.jsonl`))
		.filter((path) => existsSync(path));
	return matches.length === 1 ? matches[0] : undefined;
}
