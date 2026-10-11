import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { isObject } from "./hooks/hook-io";

/** Read the host's canonical path; filename scans can select an older fork. */
export async function codexThreadPath(
	thread: string,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const lines = createInterface({ input: child.stdout });
		const finish = (path?: string) => {
			clearTimeout(timer);
			lines.close();
			child.kill();
			resolve(path);
		};
		const timer = setTimeout(() => finish(), 5000);
		child.on("error", () => finish());
		child.on("exit", () => finish());
		child.stdin.on("error", () => finish());
		lines.on("line", (line) => {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				return;
			}
			if (!isObject(value)) return;
			if (value.id === 1) {
				if (value.error) return finish();
				child.stdin.write(
					JSON.stringify({ method: "initialized", params: {} }) + "\n",
				);
				child.stdin.write(
					JSON.stringify({
						id: 2,
						method: "thread/read",
						params: { threadId: thread, includeTurns: false },
					}) + "\n",
				);
			} else if (value.id === 2) {
				const result = isObject(value.result) ? value.result : undefined;
				const record = isObject(result?.thread) ? result.thread : undefined;
				if (
					!record ||
					record.id !== thread ||
					record.ephemeral === true ||
					typeof record.path !== "string"
				)
					return finish();
				const root = join(
					env.CODEX_HOME || join(homedir(), ".codex"),
					"sessions",
				);
				const path = record.path;
				const within = relative(root, path);
				// Archived or foreign files do not authorize a wake-up.
				if (
					!isAbsolute(path) ||
					within === ".." ||
					within.startsWith(`..${sep}`) ||
					isAbsolute(within) ||
					!path.endsWith(".jsonl") ||
					!existsSync(path)
				)
					return finish();
				finish(path);
			}
		});
		child.stdin.write(
			JSON.stringify({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "tedix_supervisor", version: "1" } },
			}) + "\n",
		);
	});
}
