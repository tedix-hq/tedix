import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { laneChildEnv } from "./lane-child-env";

export const opencodeSessionId = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/** Allocate or recover native state using metadata requests, before any model turn. */
export async function createOpenCodeLaneThread(
	cwd: string,
	model: string,
	resume?: string,
	executable = "opencode",
	timeoutMs = 30_000,
) {
	if (!/^[^/\s]+\/[^\s]+$/.test(model))
		throw new Error("OpenCode requires a configured provider/model");
	if (resume && !opencodeSessionId.test(resume))
		throw new Error("Invalid OpenCode native session");
	const password = randomBytes(24).toString("hex");
	const child = spawn(
		executable,
		["serve", "--hostname", "127.0.0.1", "--port", "0"],
		{
			cwd,
			env: {
				...laneChildEnv(),
				OPENCODE_DISABLE_AUTOUPDATE: "true",
				OPENCODE_SERVER_USERNAME: "opencode",
				OPENCODE_SERVER_PASSWORD: password,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		const endpoint = await new Promise<string>((resolve, reject) => {
			let output = "";
			const timer = setTimeout(
				() => reject(new Error("OpenCode backend startup timed out")),
				timeoutMs,
			);
			const finish = (error?: Error, url?: string) => {
				clearTimeout(timer);
				error ? reject(error) : resolve(url!);
			};
			child.once("error", (error) => finish(error));
			child.once("exit", () =>
				finish(new Error("OpenCode backend stopped before admission")),
			);
			const read = (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-8192);
				const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
				if (url) finish(undefined, url);
			};
			child.stdout.on("data", read);
			child.stderr.on("data", read);
		});
		const request = async (path: string, method = "GET", body?: object) => {
			const response = await fetch(
				`${endpoint}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(cwd)}`,
				{
					method,
					headers: {
						authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
						"content-type": "application/json",
					},
					body: body ? JSON.stringify(body) : undefined,
					signal: AbortSignal.timeout(timeoutMs),
				},
			);
			if (!response.ok)
				throw new Error(
					response.status === 404 && resume
						? "OpenCode session not found"
						: `OpenCode metadata request failed (${response.status})`,
				);
			return response.json();
		};
		const health = (await request("/global/health")) as {
			healthy?: boolean;
			version?: string;
		};
		if (!health.healthy || !health.version)
			throw new Error("OpenCode backend unavailable");
		const session = (await request(
			resume ? `/session/${resume}` : "/session",
			resume ? "GET" : "POST",
			resume ? undefined : {},
		)) as { id: string; directory: string };
		if (
			!opencodeSessionId.test(session.id) ||
			(resume && session.id !== resume) ||
			realpathSync(session.directory) !== realpathSync(cwd)
		)
			throw new Error(
				"OpenCode did not return this worktree's persistent native session",
			);
		const slash = model.indexOf("/");
		return {
			thread: { id: session.id, cliVersion: health.version },
			model: model.slice(slash + 1),
			modelProvider: model.slice(0, slash),
		};
	} finally {
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
