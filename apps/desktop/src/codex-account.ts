import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { personEnv, toolPath } from "./shell";
import type { Connection } from "./tool-connection";

export function codexAccount(
	command: string,
	desktop: boolean,
): Promise<Connection> {
	return new Promise((resolve) => {
		const child = spawn(command, ["app-server"], {
			cwd: homedir(),
			env: { ...personEnv(), PATH: toolPath() },
			stdio: ["pipe", "pipe", "ignore"],
		});
		const lines = createInterface({ input: child.stdout });
		let finished = false;
		const finish = (result: Connection) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve(result);
			lines.close();
			child.kill();
		};
		const send = (message: object) =>
			child.stdin.write(JSON.stringify(message) + "\n");
		const timer = setTimeout(() => finish("unknown"), 10_000);
		child.on("error", () => finish("unknown"));
		child.on("close", () => finish("unknown"));
		child.stdin.on("error", () => finish("unknown"));
		lines.on("line", (line) => {
			let reply: {
				id?: number;
				error?: unknown;
				result?: { account?: { type?: string } | null };
			};
			try {
				reply = JSON.parse(line);
			} catch {
				return;
			}
			if (!reply || typeof reply !== "object") return;
			if (reply.id === 1) {
				if (reply.error) return finish("unknown");
				send({ method: "initialized" });
				send({
					id: 2,
					method: "account/read",
					params: { refreshToken: false },
				});
			} else if (reply.id === 2) {
				const account = reply.result?.account;
				if (account === null) finish("signed-out");
				else if (account?.type === "chatgpt") finish("signed-in");
				else if (account?.type === "apiKey")
					finish(desktop ? "signed-out" : "signed-in");
				else finish("unknown");
			}
		});
		send({
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "tedix_setup", version: "1" } },
		});
	});
}
