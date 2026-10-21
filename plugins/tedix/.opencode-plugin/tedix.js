/**
 * Tedix for OpenCode: the remote MCP connection, the shared skills, the
 * session's Agent-Session identity and the Tedix lifecycle hooks.
 *
 * OpenCode loads every function this module exports as a plugin, so it exports
 * exactly one. Hook logic runs in the installed Tedix CLI
 * (`tedix hooks <name> --host opencode`); without the CLI, or with a CLI that
 * predates OpenCode support, each hook adds nothing and never blocks a turn.
 *
 * Options: `{ "hooks": false }` keeps only MCP, skills and identity;
 * `{ "mcp": false }` leaves the MCP entry to your own configuration.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_URL = "https://connect.mcp.tedix.dev/mcp";
const OAUTH_CLIENT_ID =
	"https://os.tedix.dev/.well-known/oauth-client/opencode.json";
const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));
const CONTEXT_LIMIT = 10_100;
/** OpenCode tool -> the host tool name `situational-recall` matches. */
const RECALL_TOOLS = {
	bash: "Bash",
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
	if (typeof args.patchText === "string") input.patch = args.patchText;
	return input;
}

export const TedixPlugin = async ({ directory, client }, options = {}) => {
	/** id -> { parentID, version, created } from OpenCode session events. */
	const sessions = new Map();
	/** id -> { providerID, modelID } of the latest user message. */
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
	const stopWaiting = (id) => {
		waiting.get(id)?.abort();
		waiting.delete(id);
	};
	const idle = async (id) => {
		const controller = new AbortController();
		stopWaiting(id);
		waiting.set(id, controller);
		try {
			const result = await client.session.messages({
				path: { id },
				query: { limit: 100 },
			});
			const messages = result.data ?? [];
			const lastUser = messages.findLastIndex(
				(message) => message.info.role === "user",
			);
			const replies = messages
				.slice(lastUser + 1)
				.filter((message) => message.info.role === "assistant");
			const last = replies.at(-1);
			if (!last || turns.get(id) === last.info.id || controller.signal.aborted)
				return;
			turns.set(id, last.info.id);
			const textOf = (message) =>
				message.parts
					.filter((part) => part.type === "text" && !part.synthetic)
					.map((part) => part.text)
					.join("\n\n");
			const event = hostEvent(id, "Stop", {
				turn_id: last.info.id,
				last_assistant_message: textOf(last),
				opencode_turn_text: replies.map(textOf).filter(Boolean).join("\n\n"),
			});
			await Promise.all([
				runHook("capture-stop", event, 120_000),
				runHook("status", event, 12_000),
			]);
			if (controller.signal.aborted || !client.session.promptAsync) return;
			const reply = await runHook(
				"await-reply",
				event,
				4 * 60 * 60 * 1000 + 5000,
				controller.signal,
			);
			if (reply && !controller.signal.aborted)
				await client.session.promptAsync({
					path: { id },
					body: { parts: [{ type: "text", text: reply, synthetic: true }] },
				});
		} catch {
			// Host events remain advisory if the CLI or session API is unavailable.
		} finally {
			if (waiting.get(id) === controller) waiting.delete(id);
		}
	};

	const root = (id) => {
		const seen = new Set();
		while (sessions.get(id)?.parentID && !seen.has(id)) {
			seen.add(id);
			id = sessions.get(id).parentID;
		}
		return id;
	};

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
				sessions.set(info.id, {
					parentID: info.parentID,
					version: info.version,
					created:
						event.type === "session.created" || sessions.get(info.id)?.created,
				});
			if (event.type === "session.deleted" && typeof info?.id === "string") {
				stopWaiting(info.id);
				turns.delete(info.id);
				if (
					hooks &&
					!sessions.get(info.id)?.parentID &&
					tedixInstalled(process.env)
				)
					await status(info.id, "SessionEnd");
				sessions.delete(info.id);
				models.delete(info.id);
				started.delete(info.id);
			}
			const props = event.properties;
			const id = props?.sessionID;
			if (
				!hooks ||
				!id ||
				sessions.get(id)?.parentID ||
				!tedixInstalled(process.env)
			)
				return;
			if (event.type === "session.idle") {
				// A reply can arrive hours later; never hold OpenCode's event dispatch open.
				if (!waiting.has(id)) void idle(id);
			} else if (
				event.type === "permission.asked" ||
				event.type === "permission.updated"
			) {
				await status(id, "PermissionRequest", {
					tool_name: props.permission ?? props.type,
					tool_input: props.metadata,
				});
			} else if (event.type === "permission.replied") {
				await status(id, "PostToolUse");
			} else if (event.type === "session.error") {
				stopWaiting(id);
				await status(id, "StopFailure", { error: props.error });
			}
		},
		/** Shell commands identify this OpenCode session, as Claude Code and Codex do natively. */
		"shell.env": async ({ sessionID }, output) => {
			if (!sessionID) return;
			const id = root(sessionID);
			const model = models.get(sessionID) ?? models.get(id);
			const version = sessions.get(id)?.version;
			output.env.TEDIX_AGENT_SESSION = `opencode:${id}`;
			output.env.OPENCODE_SESSION_ID = id;
			if (version) output.env.TEDIX_AGENT_HARNESS_VERSION = version;
			if (model?.providerID && model?.modelID) {
				output.env.TEDIX_AGENT_MODEL_PROVIDER = model.providerID;
				output.env.TEDIX_AGENT_MODEL_ID = model.modelID;
			}
		},
	};
	const remember = (input) => {
		if (input.model?.providerID && input.model?.modelID)
			models.set(input.sessionID, input.model);
	};
	if (!hooks)
		return {
			...plugin,
			"chat.message": async (input) => remember(input),
		};

	return {
		...plugin,
		/** SessionStart and UserPromptSubmit: context becomes a synthetic part of the prompt. */
		"chat.message": async (input, output) => {
			remember(input);
			// Subagent prompts come from the agent, not the user.
			if (sessions.get(input.sessionID)?.parentID) return;
			if (!tedixInstalled(process.env)) return;
			const id = input.sessionID;
			stopWaiting(id);
			const cwd = directory;
			const contexts = [];
			if (!started.has(id)) {
				started.add(id);
				contexts.push(
					await runHook(
						"session-start",
						{
							session_id: id,
							cwd,
							hook_event_name: "SessionStart",
							source: sessions.get(id)?.created ? "startup" : "resume",
						},
						30_000,
					),
				);
			}
			const prompt = output.parts
				.filter((part) => part.type === "text" && !part.synthetic)
				.map((part) => part.text)
				.join("\n");
			if (!prompt.trim()) return;
			const event = hostEvent(id, "UserPromptSubmit", { prompt });
			await Promise.all([
				runHook("capture-reply", event, 120_000),
				runHook("status", event, 12_000),
			]);
			contexts.push(
				await runHook(
					"prompt-context",
					{ session_id: id, cwd, hook_event_name: "UserPromptSubmit", prompt },
					30_000,
				),
			);
			const text = contexts.filter(Boolean).join("\n\n");
			if (!text) return;
			output.parts.push({
				id: partId(),
				sessionID: id,
				messageID: output.message.id,
				type: "text",
				synthetic: true,
				text: `<tedix-context>\n${text}\n</tedix-context>`,
			});
		},
		/** PreToolUse: advisory lessons for edits and commands, returned with the tool result. */
		"tool.execute.before": async (input, output) => {
			const tool = RECALL_TOOLS[input.tool];
			if (!tool || !tedixInstalled(process.env)) return;
			const context = await runHook(
				"situational-recall",
				{
					session_id: root(input.sessionID),
					cwd: directory,
					hook_event_name: "PreToolUse",
					tool_name: tool,
					tool_input: recallInput(output.args),
				},
				12_000,
			);
			if (context) recalls.set(input.callID, context);
		},
		"tool.execute.after": async (input, output) => {
			if (
				!sessions.get(input.sessionID)?.parentID &&
				tedixInstalled(process.env)
			)
				await status(input.sessionID, "PostToolUse");
			const context = recalls.get(input.callID);
			if (!context) return;
			recalls.delete(input.callID);
			if (typeof output.output === "string")
				output.output += `\n\n<tedix-recall>\n${context}\n</tedix-recall>`;
		},
	};
};
