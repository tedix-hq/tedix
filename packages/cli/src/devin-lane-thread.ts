import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { isHostSessionId } from "@tedix/api-contract/utils/host-session-id";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import { laneChildEnv } from "./lane-child-env";

export function devinAvailable(executable = "devin") {
	const result = spawnSync(executable, ["auth", "status"], {
		env: laneChildEnv(),
		encoding: "utf8",
		timeout: 10_000,
	});
	return (
		result.status === 0 &&
		/\blogged in\b|\bauthenticated\b/i.test(result.stdout) &&
		!/not (?:logged|authenticated)|logged out/i.test(
			result.stdout + result.stderr,
		)
	);
}

export function devinSessionIds(cwd: string, executable = "devin"): string[] {
	const result = spawnSync(executable, ["list", "--format", "json"], {
		cwd,
		env: laneChildEnv(),
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) throw new Error("Devin session listing failed");
	const value = JSON.parse(result.stdout);
	const rows = Array.isArray(value) ? value : value.sessions;
	if (!Array.isArray(rows)) throw new Error("Unexpected Devin session listing");
	return rows.map((row) => {
		const id = row.id ?? row.sessionId ?? row.session_id;
		if (!isHostSessionId(id))
			throw new Error("Invalid Devin native session id");
		return id;
	});
}

/** ACP session/new allocates identity and resolves the model without session/prompt. */
export async function createDevinLaneThread(
	cwd: string,
	executable = "devin",
	model?: string,
	timeoutMs = 30_000,
) {
	const child = spawn(
		executable,
		["acp", ...(model ? ["--model", model] : [])],
		{
			cwd,
			env: laneChildEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<
		number,
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
		rejectAll(new Error("Devin metadata process exited before admission")),
	);
	child.stdin.on("error", rejectAll);
	child.stderr.resume();
	lines.on("line", (line) => {
		try {
			const message = JSON.parse(line);
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			if (message.error)
				request.reject(new Error(JSON.stringify(message.error)));
			else {
				const result = asRecord(message.result);
				if (result) request.resolve(result);
				else request.reject(new Error("Malformed Devin ACP response"));
			}
		} catch {
			/* ACP notifications are not responses. */
		}
	});
	let sequence = 0;
	const call = (method: string, params: unknown) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
			child.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
			);
		});
	const timer = setTimeout(() => {
		rejectAll(new Error("Devin metadata timed out; no model turn launched"));
		child.kill("SIGTERM");
	}, timeoutMs);
	try {
		const initialized = await call("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: "tedix-lane-dispatcher", version: "1" },
		});
		const session = await call("session/new", { cwd, mcpServers: [] });
		const modelOption = Array.isArray(session.configOptions)
			? session.configOptions
					.map(asRecord)
					.find((option) => option?.category === "model")
			: undefined;
		const nativeModel =
			asRecord(session.models)?.currentModelId ?? modelOption?.currentValue;
		const version = asRecord(initialized.agentInfo)?.version;
		if (
			!isHostSessionId(session.sessionId) ||
			typeof version !== "string" ||
			!version ||
			typeof nativeModel !== "string" ||
			!nativeModel ||
			["opus", "sonnet", "swe", "codex", "gemini"].includes(nativeModel)
		)
			throw new Error(
				"Devin did not expose a native session, CLI version and resolved model; no model turn launched",
			);
		if (!devinSessionIds(cwd, executable).includes(session.sessionId))
			throw new Error(
				"Devin ACP session is not persisted in this worktree; no model turn launched",
			);
		return {
			thread: { id: session.sessionId, cliVersion: version },
			model: nativeModel,
			modelProvider: "devin",
		};
	} finally {
		clearTimeout(timer);
		lines.close();
		child.kill("SIGTERM");
	}
}
