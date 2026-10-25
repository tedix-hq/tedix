/**
 * Tedix for OpenCode: the remote MCP connection, the shared skills, the
 * session's Agent-Session identity and the Tedix lifecycle hooks.
 *
 * One default export serves both plugin APIs: OpenCode 1 (1.18.29 and newer)
 * calls `server()`, OpenCode 2 calls `setup()`. Configure this directory, not
 * the file: OpenCode 2 loads only directories, and both resolve `index.js`.
 * Both entrypoints share the state and hook calls in `createTedix`.
 *
 * Hook logic runs in the installed Tedix CLI
 * (`tedix hooks <name> --host opencode`); without the CLI, or with a CLI that
 * predates OpenCode support, each hook adds nothing and never blocks a turn.
 *
 * Options: `{ "hooks": false }` keeps only MCP, skills and identity;
 * `{ "mcp": false }` leaves the MCP entry to your own configuration.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_URL = "https://connect.mcp.tedix.dev/mcp";
const OAUTH_CLIENT_ID =
	"https://os.tedix.dev/.well-known/oauth-client/opencode.json";
/** The client's only registered redirect; OpenCode 2 otherwise picks a random port. */
const OAUTH_REDIRECT_URI = "http://127.0.0.1:19876/mcp/oauth/callback";
const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));
const CONTEXT_LIMIT = 10_100;
/** OpenCode tool (1 and 2) -> the host tool name `situational-recall` matches. */
const RECALL_TOOLS = {
	bash: "Bash",
	shell: "Bash",
	edit: "Edit",
	multiedit: "Edit",
	write: "Write",
	patch: "apply_patch",
	apply_patch: "apply_patch",
};
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function tedixInstalled(env) {
	return (env.PATH ?? "").split(delimiter).some((dir) => {
		try {
			return dir && statSync(join(dir, "tedix")).isFile();
		} catch {
			return false;
		}
	});
}

/** Returns context, or the framed await-reply wake message; empty on failure. */
function runHook(name, event, timeout, signal) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn("tedix", ["hooks", name, "--host", "opencode"], {
				cwd: event.cwd,
				env: { ...process.env, TEDIX_HOOK_CONTEXT_BYTES: "10000" },
				stdio: ["pipe", "pipe", "pipe"],
				signal,
			});
		} catch {
			resolve("");
			return;
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.on("error", () => {});
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (name === "await-reply") stderr = (stderr + chunk).slice(0, 100_000);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (name === "await-reply")
				return resolve(code === 2 && !signal?.aborted ? stderr.trim() : "");
			if (code !== 0) return resolve("");
			try {
				const line = stdout.trim().split("\n").pop() || "{}";
				const context = JSON.parse(line).hookSpecificOutput?.additionalContext;
				resolve(
					typeof context === "string" ? context.slice(0, CONTEXT_LIMIT) : "",
				);
			} catch {
				resolve("");
			}
		});
		child.stdin.end(JSON.stringify(event));
	});
}

/** An ascending part id in OpenCode's own `prt_` format. */
function partId() {
	const time = (BigInt(Date.now()) * 4096n).toString(16).padStart(12, "0");
	const random = [...randomBytes(14)].map((byte) => BASE62[byte % 62]).join("");
	return `prt_${time.slice(-12)}${random}`;
}

function recallInput(args) {
	if (!args || typeof args !== "object") return {};
	const input = { ...args };
	if (typeof args.filePath === "string") input.file_path = args.filePath;
	else if (typeof args.path === "string") input.file_path = args.path;
	if (typeof args.patchText === "string") input.patch = args.patchText;
	return input;
}

/** The shared skills as OpenCode 2 skill entries; OpenCode 1 reads the directory. */
function readSkills() {
	try {
		return readdirSync(SKILLS, { withFileTypes: true }).flatMap((entry) => {
			try {
				const path = join(SKILLS, entry.name, "SKILL.md");
				if (!entry.isDirectory() || !existsSync(path)) return [];
				const [, head = "", body] =
					readFileSync(path, "utf8").match(
						/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/,
					) ?? [];
				if (body === undefined) return [];
				const field = (key) => {
					const value = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1];
					return value?.startsWith('"') ? JSON.parse(value) : value;
				};
				const name = field("name") ?? entry.name;
				return [
					{
						id: name,
						name,
						description: field("description"),
						path,
						content: body,
					},
				];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

/** Session state and Tedix hook calls, independent of the OpenCode plugin API. */
/** `version` is the host version for sessions whose events carry none. */
function createTedix(directory, options, version) {
	/** id -> { parentID, version, created } of known sessions. */
	const sessions = new Map();
	/** id -> { providerID, modelID } of the latest model request. */
	const models = new Map();
	const started = new Set();
	const recalls = new Map();
	const waiting = new Map();
	const turns = new Map();
	const hooks = options.hooks !== false;
	const hostEvent = (id, name, fields = {}) => ({
		session_id: id,
		cwd: directory,
		hook_event_name: name,
		...fields,
	});
	const status = (id, name, fields = {}) =>
		runHook("status", hostEvent(id, name, fields), 12_000);
	const child = (id) => Boolean(sessions.get(id)?.parentID);
	const stopWaiting = (id) => {
		waiting.get(id)?.abort();
		waiting.delete(id);
	};
	const root = (id) => {
		const seen = new Set();
		while (sessions.get(id)?.parentID && !seen.has(id)) {
			seen.add(id);
			id = sessions.get(id).parentID;
		}
		return id;
	};

	return {
		sessions,
		hooks,
		child,
		stopWaiting,
		/** True when lifecycle events of this session are reported. */
		reporting: (id) =>
			hooks && Boolean(id) && !child(id) && tedixInstalled(process.env),
		remember(id, model) {
			if (model?.providerID && model?.modelID) models.set(id, model);
		},
		/** Shell commands identify this OpenCode session, as Claude Code and Codex do natively. */
		agentEnv(sessionID, env) {
			if (!sessionID) return;
			const id = root(sessionID);
			const model = models.get(sessionID) ?? models.get(id);
			const harness = sessions.get(id)?.version ?? version;
			env.TEDIX_AGENT_SESSION = `opencode:${id}`;
			env.OPENCODE_SESSION_ID = id;
			if (harness) env.TEDIX_AGENT_HARNESS_VERSION = harness;
			if (model?.providerID && model?.modelID) {
				env.TEDIX_AGENT_MODEL_PROVIDER = model.providerID;
				env.TEDIX_AGENT_MODEL_ID = model.modelID;
			}
		},
		/** SessionStart and UserPromptSubmit; returns the session-start and prompt contexts. */
		async prompt(id, prompt) {
			// Subagent prompts come from the agent, not the user.
			if (child(id) || !tedixInstalled(process.env)) return [];
			stopWaiting(id);
			let start = "";
			if (!started.has(id)) {
				started.add(id);
				const model = models.get(id);
				const harness = sessions.get(id)?.version ?? version;
				start = await runHook(
					"session-start",
					hostEvent(id, "SessionStart", {
						source: sessions.get(id)?.created ? "startup" : "resume",
						// Lets the hook open this chat's owner-host Agent-Session.
						...(model?.providerID && model?.modelID && harness
							? {
									model: model.modelID,
									model_provider: model.providerID,
									harness_version: harness,
								}
							: {}),
					}),
					30_000,
				);
			}
			if (!prompt.trim()) return [];
			const event = hostEvent(id, "UserPromptSubmit", { prompt });
			await Promise.all([
				runHook("capture-reply", event, 120_000),
				runHook("status", event, 12_000),
			]);
			return [start, await runHook("prompt-context", event, 30_000)];
		},
		/** PreToolUse: advisory lessons for edits and commands, kept for the tool result. */
		async recall(sessionID, callID, name, args) {
			const tool = RECALL_TOOLS[name];
			if (!tool || !tedixInstalled(process.env)) return;
			const context = await runHook(
				"situational-recall",
				hostEvent(root(sessionID), "PreToolUse", {
					tool_name: tool,
					tool_input: recallInput(args),
				}),
				12_000,
			);
			if (context) recalls.set(callID, context);
		},
		/** PostToolUse; returns the recall to append to the result. */
		async toolDone(sessionID, callID) {
			if (!child(sessionID) && tedixInstalled(process.env))
				await status(sessionID, "PostToolUse");
			const context = recalls.get(callID);
			recalls.delete(callID);
			return context;
		},
		permission: (id, tool, input) =>
			status(id, "PermissionRequest", { tool_name: tool, tool_input: input }),
		replied: (id) => status(id, "PostToolUse"),
		failed(id, error) {
			stopWaiting(id);
			return status(id, "StopFailure", { error });
		},
		async ended(id) {
			stopWaiting(id);
			turns.delete(id);
			if (hooks && !child(id) && tedixInstalled(process.env))
				await status(id, "SessionEnd");
			sessions.delete(id);
			models.delete(id);
			started.delete(id);
		},
		/**
		 * Stop: captures the turn `replies()` returns ({ id, text } since the
		 * latest user message), then waits for an answer and passes it to `wake`.
		 */
		async idle(id, replies, wake) {
			// A reply can arrive hours later; callers never await this.
			if (waiting.has(id)) return;
			const controller = new AbortController();
			waiting.set(id, controller);
			try {
				const turn = await replies();
				const last = turn.at(-1);
				if (!last || turns.get(id) === last.id || controller.signal.aborted)
					return;
				turns.set(id, last.id);
				const event = hostEvent(id, "Stop", {
					turn_id: last.id,
					last_assistant_message: last.text,
					opencode_turn_text: turn
						.map((reply) => reply.text)
						.filter(Boolean)
						.join("\n\n"),
				});
				await Promise.all([
					runHook("capture-stop", event, 120_000),
					runHook("status", event, 12_000),
				]);
				if (controller.signal.aborted || !wake) return;
				const reply = await runHook(
					"await-reply",
					event,
					4 * 60 * 60 * 1000 + 5000,
					controller.signal,
				);
				if (reply && !controller.signal.aborted) await wake(reply);
			} catch {
				// Host events remain advisory if the CLI or session API is unavailable.
			} finally {
				if (waiting.get(id) === controller) waiting.delete(id);
			}
		},
		close() {
			for (const id of [...waiting.keys()]) stopWaiting(id);
		},
	};
}

/** OpenCode 1: returns hooks by name. */
async function server({ directory, client }, options = {}) {
	const tedix = createTedix(directory, options);
	const textOf = (message) =>
		message.parts
			.filter((part) => part.type === "text" && !part.synthetic)
			.map((part) => part.text)
			.join("\n\n");
	const replies = (id) => async () => {
		const result = await client.session.messages({
			path: { id },
			query: { limit: 100 },
		});
		const messages = result.data ?? [];
		const lastUser = messages.findLastIndex(
			(message) => message.info.role === "user",
		);
		return messages
			.slice(lastUser + 1)
			.filter((message) => message.info.role === "assistant")
			.map((message) => ({ id: message.info.id, text: textOf(message) }));
	};
	const wake = (id) =>
		client?.session?.promptAsync
			? (reply) =>
					client.session.promptAsync({
						path: { id },
						body: { parts: [{ type: "text", text: reply, synthetic: true }] },
					})
			: undefined;

	const plugin = {
		config: async (config) => {
			if (options.mcp !== false) {
				config.mcp ??= {};
				config.mcp.tedix ??= {
					type: "remote",
					url: MCP_URL,
					oauth: { clientId: OAUTH_CLIENT_ID },
				};
			}
			if (existsSync(SKILLS)) {
				config.skills ??= {};
				const paths = config.skills.paths ?? [];
				if (!paths.includes(SKILLS)) config.skills.paths = [...paths, SKILLS];
			}
		},
		event: async ({ event }) => {
			const info = event.properties?.info;
			if (
				(event.type === "session.created" ||
					event.type === "session.updated") &&
				typeof info?.id === "string"
			)
				tedix.sessions.set(info.id, {
					parentID: info.parentID,
					version: info.version,
					created:
						event.type === "session.created" ||
						tedix.sessions.get(info.id)?.created,
				});
			if (event.type === "session.deleted" && typeof info?.id === "string")
				await tedix.ended(info.id);
			const props = event.properties;
			const id = props?.sessionID;
			if (!tedix.reporting(id)) return;
			if (event.type === "session.idle") {
				void tedix.idle(id, replies(id), wake(id));
			} else if (
				event.type === "permission.asked" ||
				event.type === "permission.updated"
			) {
				await tedix.permission(
					id,
					props.permission ?? props.type,
					props.metadata,
				);
			} else if (event.type === "permission.replied") {
				await tedix.replied(id);
			} else if (event.type === "session.error") {
				await tedix.failed(id, props.error);
			}
		},
		"shell.env": async ({ sessionID }, output) =>
			tedix.agentEnv(sessionID, output.env),
	};
	if (!tedix.hooks)
		return {
			...plugin,
			"chat.message": async (input) =>
				tedix.remember(input.sessionID, input.model),
		};

	return {
		...plugin,
		/** Context becomes a synthetic part of the prompt. */
		"chat.message": async (input, output) => {
			tedix.remember(input.sessionID, input.model);
			const prompt = output.parts
				.filter((part) => part.type === "text" && !part.synthetic)
				.map((part) => part.text)
				.join("\n");
			const text = (await tedix.prompt(input.sessionID, prompt))
				.filter(Boolean)
				.join("\n\n");
			if (!text) return;
			output.parts.push({
				id: partId(),
				sessionID: input.sessionID,
				messageID: output.message.id,
				type: "text",
				synthetic: true,
				text: `<tedix-context>\n${text}\n</tedix-context>`,
			});
		},
		"tool.execute.before": async (input, output) =>
			tedix.recall(input.sessionID, input.callID, input.tool, output.args),
		"tool.execute.after": async (input, output) => {
			const context = await tedix.toolDone(input.sessionID, input.callID);
			if (context && typeof output.output === "string")
				output.output += `\n\n<tedix-recall>\n${context}\n</tedix-recall>`;
		},
	};
}

/** OpenCode 2: registers transforms, hooks and an event subscription. */
async function setup(ctx) {
	const options = ctx.options ?? {};
	const tedix = createTedix(ctx.location.directory, options, ctx.app?.version);
	const loaded = Date.now();
	/** id -> [session-start, prompt] context, sent as system text on each model request. */
	const contexts = new Map();
	/** tool call id -> { sessionID, command } until its shell starts. */
	const shells = new Map();
	/** command -> tool call ids waiting for their shell, in creation order. */
	const shellCalls = new Map();
	const forgetShell = (id) => {
		const shell = shells.get(id);
		if (!shell) return;
		shells.delete(id);
		const calls = shellCalls.get(shell.command);
		if (!calls) return;
		const index = calls.indexOf(id);
		if (index >= 0) calls.splice(index, 1);
		if (!calls.length) shellCalls.delete(shell.command);
	};

	/** Learns a session this plugin has not seen created, such as a resumed one. */
	const known = async (id) => {
		if (!id || tedix.sessions.has(id)) return;
		try {
			const info = await ctx.session.get({ sessionID: id });
			const created = info.time?.created;
			tedix.sessions.set(id, {
				parentID: info.parentID,
				created: typeof created === "number" && created >= loaded,
			});
			if (info.model)
				tedix.remember(id, {
					providerID: info.model.providerID,
					modelID: info.model.id,
				});
		} catch {
			// An unknown session is treated as a root session.
		}
	};

	if (options.mcp !== false)
		await ctx.mcp.transform((editor) => {
			if (!editor.get("tedix"))
				editor.set("tedix", {
					type: "remote",
					url: MCP_URL,
					oauth: {
						client_id: OAUTH_CLIENT_ID,
						redirect_uri: OAUTH_REDIRECT_URI,
					},
				});
		});
	const skills = readSkills();
	if (skills.length)
		await ctx.skill.transform((editor) => {
			for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
		});

	await ctx.session.hook("context", (event) => {
		tedix.remember(event.sessionID, {
			providerID: event.model?.providerID,
			modelID: event.model?.id,
		});
		const text = (contexts.get(event.sessionID) ?? [])
			.filter(Boolean)
			.join("\n\n");
		if (text)
			event.system.push({
				type: "text",
				text: `<tedix-context>\n${text}\n</tedix-context>`,
			});
	});
	// The shell hook carries no session; the shell tool call that starts it does.
	await ctx.tool.hook("execute.before", async (event) => {
		if (typeof event.input?.command === "string" && event.tool === "shell") {
			shells.set(event.id, {
				sessionID: event.sessionID,
				command: event.input.command,
			});
			const calls = shellCalls.get(event.input.command) ?? [];
			calls.push(event.id);
			shellCalls.set(event.input.command, calls);
		}
		await known(event.sessionID);
		if (tedix.hooks)
			await tedix.recall(event.sessionID, event.id, event.tool, event.input);
	});
	await ctx.shell.hook("create.before", (event) => {
		const calls = shellCalls.get(event.command);
		const id = calls?.shift();
		if (!calls?.length) shellCalls.delete(event.command);
		const shell = id && shells.get(id);
		if (!shell) return;
		shells.delete(id);
		tedix.agentEnv(shell.sessionID, event.env);
	});
	await ctx.tool.hook("execute.after", async (event) => {
		forgetShell(event.id);
		if (!tedix.hooks) return;
		const context = await tedix.toolDone(event.sessionID, event.id);
		if (!context || event.status !== "completed") return;
		const recall = `<tedix-recall>\n${context}\n</tedix-recall>`;
		const content = event.result.content;
		if (typeof content === "string")
			event.result = { ...event.result, content: `${content}\n\n${recall}` };
		else if (Array.isArray(content))
			event.result = {
				...event.result,
				content: [...content, { type: "text", text: recall }],
			};
	});
	if (tedix.hooks)
		await ctx.session.hook("prompt", async (event) => {
			await known(event.sessionID);
			const [start, prompt] = await tedix.prompt(
				event.sessionID,
				event.prompt.text ?? "",
			);
			if (start === undefined) return;
			const previous = contexts.get(event.sessionID)?.[0];
			contexts.set(event.sessionID, [start || previous, prompt]);
		});

	const controller = new AbortController();
	const handle = async (event) => {
		const data = event.data ?? {};
		const id = data.sessionID;
		// Cancellation can skip both shell creation and execute.after.
		if (
			id &&
			(event.type === "session.idle" ||
				(event.type === "session.status" && data.status?.type === "idle") ||
				event.type === "session.execution.failed" ||
				event.type === "session.deleted")
		)
			for (const [callID, shell] of shells)
				if (shell.sessionID === id) forgetShell(callID);
		if (event.type === "session.created" && id) {
			tedix.sessions.set(id, { parentID: data.parentID, created: true });
			return;
		}
		if (event.type === "session.deleted" && id) {
			contexts.delete(id);
			await tedix.ended(id);
			return;
		}
		await known(id);
		if (!tedix.reporting(id)) return;
		if (
			event.type === "session.idle" ||
			(event.type === "session.status" && data.status?.type === "idle")
		) {
			void tedix.idle(
				id,
				async () => {
					const messages = (await ctx.session.context({ sessionID: id })).slice(
						-100,
					);
					const lastUser = messages.findLastIndex(
						(message) => message.type === "user",
					);
					return messages
						.slice(lastUser + 1)
						.filter((message) => message.type === "assistant")
						.map((message) => ({
							id: message.id,
							text: (message.content ?? [])
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n\n"),
						}));
				},
				(text) => ctx.session.synthetic({ sessionID: id, text }),
			);
		} else if (event.type === "permission.asked") {
			await tedix.permission(id, data.action, data.metadata);
		} else if (event.type === "permission.replied") {
			await tedix.replied(id);
		} else if (event.type === "session.execution.failed") {
			await tedix.failed(id, data.error);
		}
	};
	void (async () => {
		try {
			for await (const event of ctx.event.subscribe({
				signal: controller.signal,
			}))
				await handle(event).catch(() => {});
		} catch {
			// The stream ends when the plugin unloads.
		}
	})();
	return () => {
		controller.abort();
		shells.clear();
		shellCalls.clear();
		tedix.close();
	};
}

export default { id: "tedix", setup, server };
