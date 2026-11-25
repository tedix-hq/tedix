import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyEdits, modify, parse } from "jsonc-parser";
import { devinConfigDirectory } from "./devin-config";
import {
	isTedixPlugin,
	opencodeConfigDirectory,
	opencodePluginHome,
} from "./opencode-config";

/**
 * Takes Tedix out of one agent so it can be connected fresh: its Tedix
 * sign-in, the Tedix plugin and the marketplace it came from, the Tedix hooks
 * and the Tedix connection. The agent itself, its own account and every
 * setting that is not Tedix's stay as they are. Plugins an agent syncs from
 * its account in the cloud are left to that agent.
 */
export type RemovableHost = "codex" | "claude" | "devin" | "opencode";
export const REMOVABLE_HOSTS: readonly RemovableHost[] = [
	"codex",
	"claude",
	"devin",
	"opencode",
];

export type RemoveRunner = (
	command: "codex" | "claude",
	args: string[],
) => { status: number; stdout: string; stderr: string };

const CONNECT_URL = "https://connect.mcp.tedix.dev/mcp";
/** Every marketplace a Tedix plugin was ever installed from. */
const MARKETPLACES = {
	codex: ["tedix-plugins", "tedix-repo"],
	claude: ["tedix-plugins", "tedix"],
} as const;

/** A hook Tedix wrote: it runs `tedix hooks <name>`. */
const TEDIX_HOOK = /(?:^|[\s;/'"])tedix hooks [a-z-]+/;

/**
 * Removes Tedix's hooks from a hooks file shaped `{ hooks: { Event: [{ hooks:
 * [{ command }] }] } }` and keeps everything else. True when it changed.
 */
export function pruneTedixHooks(path: string): boolean {
	if (!existsSync(path)) return false;
	const file: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(file) || !isRecord(file.hooks)) return false;
	let changed = false;
	const hooks: Record<string, unknown[]> = {};
	for (const [event, groups] of Object.entries(file.hooks)) {
		if (!Array.isArray(groups)) {
			hooks[event] = groups as unknown[];
			continue;
		}
		const kept = groups.flatMap((group) => {
			if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
			const handlers = group.hooks.filter(
				(handler) =>
					!(
						isRecord(handler) &&
						typeof handler.command === "string" &&
						TEDIX_HOOK.test(handler.command)
					),
			);
			if (handlers.length === group.hooks.length) return [group];
			changed = true;
			return handlers.length ? [{ ...group, hooks: handlers }] : [];
		});
		if (kept.length) hooks[event] = kept;
		else changed = true;
	}
	if (!changed) return false;
	write(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`);
	return true;
}

function write(path: string, text: string) {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Removes the Tedix server and Tedix-managed hooks from Devin's settings. */
export function removeFromDevin(directory = devinConfigDirectory()): string[] {
	const done: string[] = [];
	const mcpPath = join(directory, "mcp_config.json");
	if (existsSync(mcpPath)) {
		const mcp: unknown = JSON.parse(readFileSync(mcpPath, "utf8"));
		if (
			isRecord(mcp) &&
			isRecord(mcp.mcpServers) &&
			"tedix" in mcp.mcpServers
		) {
			const { tedix: _removed, ...servers } = mcp.mcpServers;
			write(
				mcpPath,
				`${JSON.stringify({ ...mcp, mcpServers: servers }, null, 2)}\n`,
			);
			done.push("removed the Tedix connection");
		}
	}
	if (pruneTedixHooks(join(directory, "config.json")))
		done.push("removed the Tedix hooks");
	return done;
}

/** Removes Tedix from OpenCode's plugin list and deletes its plugin copy. */
export function removeFromOpencode(env = process.env): string[] {
	const done: string[] = [];
	for (const name of ["opencode.jsonc", "opencode.json"]) {
		const path = join(opencodeConfigDirectory(env), name);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		const config: unknown = parse(text);
		if (!isRecord(config) || !Array.isArray(config.plugin)) continue;
		const plugins = config.plugin.filter((entry) => !isTedixPlugin(entry));
		if (plugins.length === config.plugin.length) continue;
		const edits = modify(text, ["plugin"], plugins, {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		});
		write(path, applyEdits(text, edits));
		done.push(`removed the Tedix plugin from ${name}`);
	}
	const home = opencodePluginHome(env);
	if (existsSync(home)) {
		rmSync(home, { recursive: true, force: true });
		done.push("deleted the Tedix plugin copy");
	}
	return done;
}

/** Runs a host command and says whether it worked, without failing the removal. */
function attempt(
	run: RemoveRunner,
	command: "codex" | "claude",
	args: string[],
): boolean {
	return run(command, args).status === 0;
}

function installedClaudePlugins(run: RemoveRunner): string[] {
	const result = run("claude", ["plugin", "list", "--json"]);
	if (result.status !== 0) return [];
	try {
		const list: unknown = JSON.parse(result.stdout);
		return Array.isArray(list)
			? list
					.map((entry) => (isRecord(entry) ? String(entry.id ?? "") : ""))
					.filter((id) =>
						(MARKETPLACES.claude as readonly string[]).includes(
							id.split("@")[1] ?? "",
						),
					)
					.filter((id) => id.startsWith("tedix@"))
			: [];
	} catch {
		return [];
	}
}

/**
 * Takes Tedix out of `host`. Returns one plain line per thing it removed;
 * steps with nothing to remove say nothing.
 */
export function removeTedix(
	host: RemovableHost,
	run: RemoveRunner,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (host === "devin") return removeFromDevin();
	if (host === "opencode") return removeFromOpencode(env);
	const done: string[] = [];
	if (host === "codex") {
		const home = env.CODEX_HOME || join(homedir(), ".codex");
		// Codex answers success for a plugin or marketplace it does not have,
		// so its settings file says what is really there.
		const settings = existsSync(join(home, "config.toml"))
			? readFileSync(join(home, "config.toml"), "utf8")
			: "";
		if (
			attempt(run, "codex", [
				"mcp",
				"logout",
				"tedix",
				"-c",
				`mcp_servers.tedix.url="${CONNECT_URL}"`,
			])
		)
			done.push("signed Codex out of Tedix");
		for (const marketplace of MARKETPLACES.codex) {
			const plugin = `tedix@${marketplace}`;
			if (
				settings.includes(`[plugins."${plugin}"]`) &&
				attempt(run, "codex", ["plugin", "remove", plugin])
			)
				done.push(`removed the Tedix plugin (${plugin})`);
		}
		for (const marketplace of MARKETPLACES.codex) {
			if (
				settings.includes(`[marketplaces.${marketplace}]`) &&
				attempt(run, "codex", ["plugin", "marketplace", "remove", marketplace])
			)
				done.push(`removed the ${marketplace} marketplace`);
			// Codex leaves the emptied cache folder behind.
			const cache = join(home, "plugins", "cache", marketplace);
			if (existsSync(cache) && !readdirSync(cache).length) rmdirSync(cache);
		}
		if (pruneTedixHooks(join(home, "hooks.json")))
			done.push("removed the Tedix hooks from hooks.json");
		return done;
	}
	for (const plugin of installedClaudePlugins(run))
		if (attempt(run, "claude", ["plugin", "uninstall", plugin]))
			done.push(`removed the Tedix plugin (${plugin})`);
	for (const marketplace of MARKETPLACES.claude)
		if (
			attempt(run, "claude", ["plugin", "marketplace", "remove", marketplace])
		)
			done.push(`removed the ${marketplace} marketplace`);
	return done;
}
