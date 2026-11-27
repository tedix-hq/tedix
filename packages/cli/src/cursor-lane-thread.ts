import { spawnSync } from "node:child_process";

/** Cursor chat ids are opaque tokens; keep them to a safe argv shape. */
export const cursorSessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function run(
	executable: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(executable, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * Allocate or recover Cursor's native chat id before any model turn.
 * `agent create-chat` prints only the new id; `agent ls` lists known chats
 * so a resumed id can be checked without starting a turn.
 */
export async function createCursorLaneThread(
	cwd: string,
	model: string,
	resume?: string,
	executable = "agent",
	timeoutMs = 30_000,
) {
	if (resume && !cursorSessionId.test(resume))
		throw new Error("Invalid Cursor native session");
	const version = run(executable, ["--version"], cwd, timeoutMs);
	if (version.status !== 0)
		throw new Error(
			`Cursor is unavailable: ${(version.stderr || version.stdout).trim() || "agent --version failed"}`,
		);
	const cliVersion =
		(version.stdout || version.stderr).trim().split(/\s+/)[0] || "unknown";
	let id: string;
	if (resume) {
		const list = run(executable, ["ls"], cwd, timeoutMs);
		if (list.status === 0 && !list.stdout.includes(resume))
			throw new Error("Cursor session not found");
		id = resume;
	} else {
		const created = run(executable, ["create-chat"], cwd, timeoutMs);
		if (created.status !== 0)
			throw new Error(
				`Cursor could not create a chat: ${(created.stderr || created.stdout).trim()}`,
			);
		id = parseCursorChatId(created.stdout);
		if (!id) throw new Error("Cursor did not return a chat id");
	}
	return {
		thread: { id, cliVersion },
		model,
		modelProvider: "cursor",
	};
}

/** `create-chat` prints the bare id; accept a JSON object too, just in case. */
export function parseCursorChatId(output: string): string {
	const trimmed = output.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		for (const key of ["id", "chatId", "chat_id", "sessionId", "session_id"])
			if (typeof parsed[key] === "string" && cursorSessionId.test(parsed[key]))
				return parsed[key] as string;
	} catch {
		/* Not JSON: fall through to the plain-text forms. */
	}
	for (const line of trimmed.split("\n").reverse()) {
		const token = line.trim().split(/\s+/).pop() ?? "";
		if (cursorSessionId.test(token)) return token;
	}
	const bare = trimmed.split(/\s+/).pop() ?? "";
	return cursorSessionId.test(bare) ? bare : "";
}
