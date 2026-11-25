import {
	executionSettings,
	executionFlags,
	type LaneExecutionSettings,
} from "./lane-execution-settings";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { UUID } from "./hooks/hook-io";
import { laneChildEnv } from "./lane-child-env";

class CodexRequestRejected extends Error {}

const clientInfo = { name: "tedix-lane-dispatcher", version: "1" };
export const CODEX_LANE_CONFIG_ARG =
	'shell_environment_policy.set.TEDIX_LANE_LOG="1"';

function codexAppServer(
	executable: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	settings: LaneExecutionSettings,
) {
	const child = spawn(
		executable,
		[
			"app-server",
			"--stdio",
			"-c",
			CODEX_LANE_CONFIG_ARG,
			...executionFlags("codex", settings),
		],
		{
			cwd,
			env: { ...laneChildEnv(), ...env },
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	let closed: Error | undefined;
	let onExit: ((error: Error) => void) | undefined;
	let onNotification:
		| ((method: string, params: Record<string, unknown>) => void)
		| undefined;
	const disconnect = (error: Error) => {
		closed ??= error;
		for (const request of pending.values()) request.reject(error);
		onExit?.(error);
	};
	child.on("error", disconnect);
	child.on("close", () => disconnect(new Error("Codex app-server closed")));
	child.stdin.on("error", disconnect);
	const send = (message: object) =>
		child.stdin.write(`${JSON.stringify(message)}\n`);
	lines.on("line", (line) => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		if (typeof message.method === "string") {
			if (message.id !== undefined) {
				// This unattended client cannot answer interactive requests.
				send({
					id: message.id,
					error: {
						code: -32601,
						message: "Interactive requests are unavailable",
					},
				});
			} else if (isRecord(message.params)) {
				onNotification?.(message.method, message.params);
			}
			return;
		}
		if (typeof message.id !== "number") return;
		const request = pending.get(message.id);
		if (message.error)
			request?.reject(new CodexRequestRejected(JSON.stringify(message.error)));
		else request?.resolve(message.result);
	});
	let id = 0;
	const call = async (method: string, params: object) => {
		if (closed) throw closed;
		const key = ++id;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<unknown>((resolve, reject) => {
				pending.set(key, { resolve, reject });
				timer = setTimeout(
					() => reject(new Error(`Codex ${method} timed out`)),
					15_000,
				);
				send({ id: key, method, params });
			});
		} finally {
			clearTimeout(timer);
			pending.delete(key);
		}
	};
	return {
		child,
		call,
		get closed() {
			return !!closed;
		},
		listen(notification: typeof onNotification, exit?: typeof onExit) {
			onNotification = notification;
			onExit = exit;
		},
		async initialize() {
			await call("initialize", {
				clientInfo,
			});
			send({ method: "initialized" });
		},
		close() {
			disconnect(new Error("Codex app-server was closed"));
			lines.close();
			if (child.pid && child.exitCode === null && child.signalCode === null) {
				const group = -child.pid;
				try {
					process.kill(group, "SIGTERM");
				} catch {}
				// An app-server stuck in start-up can ignore SIGTERM; it must not
				// outlive the start that gave up on it.
				const kill = setTimeout(() => {
					try {
						process.kill(group, "SIGKILL");
					} catch {}
				}, 2000);
				kill.unref();
				child.once("exit", () => clearTimeout(kill));
			}
		},
	};
}

/** Allocate a native thread without running a model turn, before Work admission. */
export async function createCodexLaneThread(
	cwd: string,
	executable = "codex",
	model?: string,
	resume?: string,
	env: NodeJS.ProcessEnv = {},
	settings: LaneExecutionSettings = {},
) {
	const resolved = executionSettings("codex", settings);
	const server = codexAppServer(executable, cwd, env, resolved);
	server.child.stderr.resume();
	try {
		await server.initialize();
		const result = (await server.call(
			resume ? "thread/resume" : "thread/start",
			{
				cwd,
				approvalPolicy: resolved.permission!.approval,
				sandbox: resolved.permission!.sandbox,
				config: { model_reasoning_effort: resolved.effort },
				...(model ? { model } : {}),
				...(resume
					? { threadId: resume, excludeTurns: true }
					: { ephemeral: false }),
			},
		)) as {
			thread: { id: string; cliVersion: string; path: string };
			model: string;
			modelProvider: string;
		};
		if (
			!UUID.test(result.thread.id) ||
			(resume !== undefined && result.thread.id !== resume) ||
			!result.thread.path ||
			!result.thread.cliVersion ||
			!result.model ||
			!result.modelProvider
		)
			throw new Error(
				"Codex did not return a persistent native thread and model tuple",
			);
		// A new thread has no rollout until its first turn. Keep the same
		// connection through admission so the turn uses the allocated identity.
		return {
			...result,
			codexServer: bindCodexLaneThread(server, result.thread.id, resolved),
		};
	} catch (error) {
		server.close();
		throw error;
	}
}

const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

function bindCodexLaneThread(
	server: ReturnType<typeof codexAppServer>,
	threadId: string,
	settings: LaneExecutionSettings,
) {
	const { child } = server;
	let activeTurnId: string | undefined;
	return {
		child,
		close: server.close,
		steer(text: string) {
			const expectedTurnId = activeTurnId;
			if (!expectedTurnId) return;
			return server
				.call("turn/steer", {
					threadId,
					expectedTurnId,
					input: textInput(text),
				})
				.then(
					(result) => isRecord(result) && result.turnId === expectedTurnId,
					() => false,
				);
		},
		interrupt() {
			if (!activeTurnId) return;
			return server.call("turn/interrupt", { threadId, turnId: activeTurnId });
		},
		async turn(
			text: string,
			outputSchema: object,
			started: () => void,
			notify: (method: string, params: Record<string, unknown>) => void,
		) {
			if (server.closed) return;
			let turnId: string | undefined;
			let finalMessage: string | undefined;
			let complete!: (result: {
				status: unknown;
				message?: string;
				error?: unknown;
			}) => void;
			const completion = new Promise<Parameters<typeof complete>[0]>(
				(resolve) => {
					complete = resolve;
				},
			);
			server.listen(
				(method, params) => {
					if (params.threadId !== threadId) return;
					const turn = isRecord(params.turn) ? params.turn : undefined;
					if (
						!turnId &&
						method === "turn/started" &&
						typeof turn?.id === "string"
					) {
						turnId = activeTurnId = turn.id;
					}
					if (!turnId || (turn?.id ?? params.turnId) !== turnId) return;
					if (
						method === "item/completed" &&
						isRecord(params.item) &&
						params.item.type === "agentMessage" &&
						params.item.phase !== "commentary" &&
						typeof params.item.text === "string"
					)
						finalMessage = params.item.text;
					notify(method, params);
					if (method === "turn/completed" && turn) {
						activeTurnId = undefined;
						complete({
							status: turn.status,
							message: finalMessage,
							error: turn.error,
						});
					}
				},
				(error) =>
					complete({ status: "failed", error: { message: error.message } }),
			);
			try {
				let result: unknown;
				try {
					result = await server.call("turn/start", {
						threadId,
						input: textInput(text),
						outputSchema,
						effort: settings.effort,
						approvalPolicy: settings.permission!.approval,
					});
				} catch (error) {
					if (!turnId && error instanceof CodexRequestRejected) return;
					throw error;
				}
				if (
					!isRecord(result) ||
					!isRecord(result.turn) ||
					typeof result.turn.id !== "string" ||
					(turnId && turnId !== result.turn.id)
				)
					throw new Error("Codex did not return the active turn ID");
				if (!turnId) turnId = activeTurnId = result.turn.id;
				started();
				return await completion;
			} finally {
				activeTurnId = undefined;
				server.listen(undefined);
			}
		},
	};
}

export type CodexLaneServer = ReturnType<typeof bindCodexLaneThread>;
