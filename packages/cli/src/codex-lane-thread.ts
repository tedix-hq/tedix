import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { UUID } from "./hooks/hook-io";
import { laneChildEnv } from "./lane-child-env";

/** Allocate a native thread without running a model turn, before Work admission. */
export async function createCodexLaneThread(cwd: string, executable = "codex") {
	const child = spawn(executable, ["app-server", "--stdio"], {
		cwd,
		env: laneChildEnv(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const rejectAll = (error: Error) => {
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	child.on("error", rejectAll);
	child.on("exit", () => rejectAll(new Error("Codex thread allocator exited")));
	child.stderr.resume();
	child.stdin.on("error", rejectAll);
	lines.on("line", (line) => {
		try {
			const message = JSON.parse(line);
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			if (message.error)
				request.reject(new Error(JSON.stringify(message.error)));
			else request.resolve(message.result);
		} catch {
			/* Notifications are not RPC responses. */
		}
	});
	let id = 0;
	const call = (method: string, params: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			const key = ++id;
			pending.set(key, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
		});
	const timer = setTimeout(() => {
		rejectAll(new Error("Codex thread allocation timed out"));
		child.kill("SIGTERM");
	}, 30_000);
	try {
		await call("initialize", {
			clientInfo: { name: "tedix-lane-dispatcher", version: "1" },
		});
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		const result = (await call("thread/start", { cwd, ephemeral: false })) as {
			thread: { id: string; cliVersion: string; path: string };
			model: string;
			modelProvider: string;
		};
		if (
			!UUID.test(result.thread.id) ||
			!result.thread.path ||
			!result.thread.cliVersion ||
			!result.model ||
			!result.modelProvider
		)
			throw new Error(
				"Codex did not return a persistent native thread and model tuple",
			);
		return result;
	} finally {
		clearTimeout(timer);
		lines.close();
		child.kill("SIGTERM");
	}
}
