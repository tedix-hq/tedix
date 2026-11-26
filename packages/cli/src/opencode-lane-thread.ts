import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { openCodeLaneEnv } from "./opencode-lane-env";

const MODEL = /^[^/\s]+\/[^\s]+$/;
export const opencodeSessionId = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/**
 * Allocate or recover native state using metadata requests, before any model
 * turn. Speaks the local API of OpenCode 2 (`/api/...`); OpenCode 1 answered
 * other addresses and is told to update.
 */
export async function createOpenCodeLaneThread(
	cwd: string,
	model: string,
	resume?: string,
	executable = "opencode",
	timeoutMs = 30_000,
) {
	if (resume && !opencodeSessionId.test(resume))
		throw new Error("Invalid OpenCode native session");
	const password = randomBytes(24).toString("hex");
	const child = spawn(
		executable,
		["serve", "--hostname", "127.0.0.1", "--port", "0"],
		{
			cwd,
			env: {
				...openCodeLaneEnv(),
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
				`${endpoint}${path}?location[directory]=${encodeURIComponent(cwd)}`,
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
		const info = (await request("/api/info").catch(() => undefined)) as
			| { version?: unknown }
			| undefined;
		if (typeof info?.version !== "string" || !info.version)
			throw new Error(
				"This OpenCode is too old for Tedix tasks: update OpenCode to version 2 or newer",
			);
		// No model from Tedix: use the one OpenCode itself is set to, else the
		// default of the first provider it is signed in to.
		if (!MODEL.test(model)) {
			// Config documents come lowest priority first, so the last one that
			// names a model is the one OpenCode uses.
			const chosen = (
				(await request("/api/config")) as {
					info?: { model?: { providerID?: unknown; model?: unknown } };
				}[]
			)
				.map((entry) => entry?.info?.model)
				.filter((entry) => entry?.providerID && entry.model)
				.at(-1);
			const fallback = chosen
				? undefined
				: (
						(await request("/api/model/default").catch(() => ({}))) as {
							data?: { providerID?: unknown; modelID?: unknown } | null;
						}
					).data;
			model = chosen
				? `${String(chosen.providerID)}/${String(chosen.model)}`
				: fallback?.providerID && fallback.modelID
					? `${String(fallback.providerID)}/${String(fallback.modelID)}`
					: "";
			if (!MODEL.test(model))
				throw new Error(
					"OpenCode has no model to use: open OpenCode, connect a provider and choose a model",
				);
		}
		const session = (
			(await request(
				resume ? `/api/session/${resume}` : "/api/session",
				resume ? "GET" : "POST",
				resume ? undefined : { location: { directory: cwd } },
			)) as { data?: { id?: unknown; location?: { directory?: unknown } } }
		).data;
		const directory = session?.location?.directory;
		if (
			typeof session?.id !== "string" ||
			typeof directory !== "string" ||
			!opencodeSessionId.test(session.id) ||
			(resume && session.id !== resume) ||
			realpathSync(directory) !== realpathSync(cwd)
		)
			throw new Error(
				"OpenCode did not return this worktree's persistent native session",
			);
		const slash = model.indexOf("/");
		return {
			thread: { id: session.id, cliVersion: info.version },
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
