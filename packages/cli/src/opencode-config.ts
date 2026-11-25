import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { withFileLockSync } from "./local-file-lock";

/** The published plugin repository, the same source Claude Code and Codex install from. */
const PLUGIN_ARCHIVE =
	"https://codeload.github.com/tedix-hq/tedix-plugins/tar.gz/refs/heads/main";

export function opencodeConfigDirectory(env = process.env) {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

/** A full copy of the plugin repository: the adapter reads its manifest, MCP file and skills. */
export function opencodePluginHome(env = process.env) {
	return join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"plugins",
		"opencode",
	);
}

/** OpenCode 2 loads only plugin directories; OpenCode 1 resolves its index.js. */
export function opencodePluginEntry(env = process.env) {
	return join(opencodePluginHome(env), ".opencode-plugin");
}

/** The settings file OpenCode reads; a new one is opencode.json. */
export function opencodeConfigFile(env = process.env) {
	const directory = opencodeConfigDirectory(env);
	const jsonc = join(directory, "opencode.jsonc");
	return existsSync(jsonc) ? jsonc : join(directory, "opencode.json");
}

/** Any earlier Tedix adapter: a checkout, a hand-copied release or this setup's copy. */
function isTedixPlugin(entry: unknown): boolean {
	const spec = Array.isArray(entry) ? entry[0] : entry;
	return (
		typeof spec === "string" &&
		/tedix/i.test(spec) &&
		/\.opencode-plugin(?:\/(?:index|tedix)\.js)?\/?$/.test(spec)
	);
}

function parseConfig(text: string, path: string): Record<string, unknown> {
	if (!text.trim()) return {};
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !isRecord(value))
		throw new Error(`Expected a JSON object in ${path}; file was not changed`);
	return value;
}

/**
 * Point the `plugin` list at `entry`, replacing earlier Tedix adapters and
 * keeping their options. Comments and every other setting stay as written.
 */
export function mergeOpencodeConfig(
	text: string,
	entry: string,
	path = "opencode.json",
): string {
	const config = parseConfig(text, path);
	const previous = config.plugin ?? [];
	if (!Array.isArray(previous))
		throw new Error(
			`Expected "plugin" to be a list in ${path}; file was not changed`,
		);
	const tedix = previous.find(isTedixPlugin);
	const replacement =
		Array.isArray(tedix) && tedix.length > 1
			? [entry, ...tedix.slice(1)]
			: entry;
	const next: unknown[] = [];
	for (const item of previous) {
		if (!isTedixPlugin(item)) next.push(item);
		else if (!next.includes(replacement)) next.push(replacement);
	}
	if (!tedix) next.push(entry);
	if (JSON.stringify(next) === JSON.stringify(previous) && text.trim())
		return text;
	const base = text.trim()
		? text
		: '{\n\t"$schema": "https://opencode.ai/config.json"\n}\n';
	return applyEdits(
		base,
		modify(base, ["plugin"], next, {
			formattingOptions: { insertSpaces: !base.includes("\n\t"), tabSize: 2 },
		}),
	);
}

/** Download the published plugin and swap it in whole, so a failed download changes nothing. */
async function installPlugin(
	home: string,
	download: (target: string) => Promise<void>,
) {
	const parent = dirname(home);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const fresh = `${home}.${process.pid}.new`;
	const old = `${home}.${process.pid}.old`;
	rmSync(fresh, { recursive: true, force: true });
	mkdirSync(fresh, { recursive: true });
	try {
		await download(fresh);
		for (const path of [
			".opencode-plugin/index.js",
			"plugin.json",
			"mcp.json",
			"skills",
		])
			if (!existsSync(join(fresh, path)))
				throw new Error(
					`The downloaded Tedix plugin has no ${path}; nothing was changed`,
				);
		if (existsSync(home)) renameSync(home, old);
		renameSync(fresh, home);
		rmSync(old, { recursive: true, force: true });
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
}

async function downloadPublishedPlugin(target: string) {
	const response = await fetch(PLUGIN_ARCHIVE, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok)
		throw new Error(
			`Could not download the Tedix plugin (HTTP ${response.status})`,
		);
	const archive = join(target, ".download.tar.gz");
	writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
	const tar = spawnSync(
		"tar",
		["-xzf", archive, "-C", target, "--strip-components=1"],
		{ encoding: "utf8", timeout: 120_000 },
	);
	rmSync(archive, { force: true });
	if (tar.status !== 0)
		throw new Error(
			`Could not unpack the Tedix plugin: ${(tar.stderr || tar.error?.message || "").trim()}`,
		);
}

/**
 * Install or refresh the plugin, then add it to OpenCode's settings.
 * Returns the backup of the settings file, when it changed one.
 */
export async function setupOpencode(
	env = process.env,
	download: (target: string) => Promise<void> = downloadPublishedPlugin,
): Promise<{ configPath: string; backup?: string }> {
	const directory = opencodeConfigDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	await installPlugin(opencodePluginHome(env), download);
	return withFileLockSync(join(directory, ".tedix-setup.lock"), () => {
		const configPath = opencodeConfigFile(env);
		const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
		const next = mergeOpencodeConfig(
			text,
			opencodePluginEntry(env),
			configPath,
		);
		if (next === text) return { configPath };
		let backup: string | undefined;
		if (text) {
			backup = `${configPath}.bak-tedix-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`;
			copyFileSync(configPath, backup);
		}
		const temporary = `${configPath}.${process.pid}.tmp`;
		writeFileSync(temporary, next, { mode: 0o600 });
		renameSync(temporary, configPath);
		return { configPath, ...(backup ? { backup } : {}) };
	});
}

export interface OpencodeStatus {
	host: "opencode";
	found: boolean;
	/** The settings name a Tedix plugin. */
	installed: boolean;
	/** It is the copy this setup keeps up to date, not an older one. */
	current: boolean;
	version?: string;
	problem?: string;
}

export function opencodeStatus(env = process.env): OpencodeStatus {
	const found =
		spawnSync("opencode", ["--version"], { stdio: "ignore", timeout: 20_000 })
			.status === 0;
	const status: OpencodeStatus = {
		host: "opencode",
		found: found || existsSync(opencodeConfigDirectory(env)),
		installed: false,
		current: false,
	};
	const configPath = opencodeConfigFile(env);
	try {
		const plugins = existsSync(configPath)
			? parseConfig(readFileSync(configPath, "utf8"), configPath).plugin
			: undefined;
		const tedix = Array.isArray(plugins)
			? plugins.find(isTedixPlugin)
			: undefined;
		status.installed = Boolean(tedix);
		const spec = Array.isArray(tedix) ? tedix[0] : tedix;
		status.current = spec === opencodePluginEntry(env);
	} catch (error) {
		status.problem = error instanceof Error ? error.message : String(error);
	}
	try {
		const manifest = JSON.parse(
			readFileSync(join(opencodePluginHome(env), "plugin.json"), "utf8"),
		) as { version?: unknown };
		if (status.current && typeof manifest.version === "string")
			status.version = manifest.version;
	} catch {
		/* Not installed by this setup yet. */
	}
	return status;
}
