/**
 * Tedix for OpenCode: the remote MCP connection, the shared skills, the
 * session's Agent-Session identity and the read-only Tedix context hooks.
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

/** One `tedix hooks <name> --host opencode` run; its context, or "" on any fault. */
function runHook(name, event, timeout) {
	return new Promise((resolve) => {
		let stdout = "";
		let child;
		try {
			child = spawn("tedix", ["hooks", name, "--host", "opencode"], {
				cwd: event.cwd,
				env: { ...process.env, TEDIX_HOOK_CONTEXT_BYTES: "10000" },
				stdio: ["pipe", "pipe", "ignore"],
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
		child.on("close", (code) => {
			clearTimeout(timer);
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

export const TedixPlugin = async ({ directory }, options = {}) => {
	/** id -> { parentID, version, created } from OpenCode session events. */
	const sessions = new Map();
	/** id -> { providerID, modelID } of the latest user message. */
	const models = new Map();
	const started = new Set();
	const recalls = new Map();
	const hooks = options.hooks !== false;

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
				sessions.delete(info.id);
				models.delete(info.id);
				started.delete(info.id);
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
			const context = recalls.get(input.callID);
			if (!context) return;
			recalls.delete(input.callID);
			if (typeof output.output === "string")
				output.output += `\n\n<tedix-recall>\n${context}\n</tedix-recall>`;
		},
	};
};
