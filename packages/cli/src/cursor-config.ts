import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { withFileLockSync } from "./local-file-lock";

/** The Tedix MCP endpoint Cursor connects to, the same one every host uses. */
export const CURSOR_CONNECT_URL = "https://connect.mcp.tedix.dev/mcp";

/** Marker kept inside each hook command so removal can find only Tedix's. */
const CURSOR_HOOK_MARKER = "# tedix-managed-cursor-hook";

export function cursorConfigDirectory(env = process.env) {
	return env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
}

export function cursorMcpFile(env = process.env) {
	return join(cursorConfigDirectory(env), "mcp.json");
}

export function cursorHooksFile(env = process.env) {
	return join(cursorConfigDirectory(env), "hooks.json");
}

function parseJson(text: string, path: string): Record<string, unknown> {
	if (!text.trim()) return {};
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !isRecord(value))
		throw new Error(`Expected a JSON object in ${path}; file was not changed`);
	return value;
}

function writeMerged(
	path: string,
	next: string,
	text: string,
): { path: string; backup?: string } {
	if (next === text) return { path };
	let backup: string | undefined;
	if (text) {
		backup = `${path}.bak-tedix-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`;
		copyFileSync(path, backup);
	}
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, next, { mode: 0o600 });
	renameSync(temporary, path);
	return { path, ...(backup ? { backup } : {}) };
}

/**
 * Point `mcpServers.tedix` at the connect endpoint, keeping every other
 * server and comment as written.
 */
export function mergeCursorMcp(text: string, path = "mcp.json"): string {
	const config = parseJson(text, path);
	const servers = config.mcpServers;
	if (servers !== undefined && !isRecord(servers))
		throw new Error(
			`Expected "mcpServers" to be an object in ${path}; file was not changed`,
		);
	const current = isRecord(servers) ? servers.tedix : undefined;
	const desired = { url: CURSOR_CONNECT_URL };
	if (
		isRecord(current) &&
		Object.keys(current).length === 1 &&
		current.url === CURSOR_CONNECT_URL
	)
		return text.trim() ? text : `${JSON.stringify(config, null, "\t")}\n`;
	const base = text.trim() ? text : '{\n\t"mcpServers": {}\n}\n';
	return applyEdits(
		base,
		modify(base, ["mcpServers", "tedix"], desired, {
			formattingOptions: { insertSpaces: !base.includes("\n\t"), tabSize: 2 },
		}),
	);
}

interface CursorHookEntry {
	command?: unknown;
	[key: string]: unknown;
}

function cursorHookCommand(hook: string): string {
	return `command -v tedix >/dev/null 2>&1 || exit 0; tedix hooks ${hook} --host cursor || true ${CURSOR_HOOK_MARKER}`;
}

/** Cursor's documented hooks.json shape: {version:1, hooks:{<event>:[{command}]}}. */
const CURSOR_HOOKS: Record<string, string> = {
	sessionStart: "session-start",
	beforeSubmitPrompt: "status",
	postToolUse: "status",
	stop: "status",
	sessionEnd: "status",
};

/**
 * Add Tedix's turn-boundary hooks to Cursor's hooks.json, replacing entries
 * this setup wrote before and keeping every other hook as written.
 */
export function mergeCursorHooks(text: string, path = "hooks.json"): string {
	const config = parseJson(text, path);
	const hooks = config.hooks;
	if (hooks !== undefined && !isRecord(hooks))
		throw new Error(
			`Expected "hooks" to be an object in ${path}; file was not changed`,
		);
	const base = text.trim() ? text : '{\n\t"version": 1,\n\t"hooks": {}\n}\n';
	let out = base;
	if (config.version === undefined)
		out = applyEdits(
			out,
			modify(out, ["version"], 1, {
				formattingOptions: { insertSpaces: !out.includes("\n\t"), tabSize: 2 },
			}),
		);
	const merged: Record<string, unknown> = {};
	for (const [event, hook] of Object.entries(CURSOR_HOOKS)) {
		const existing = isRecord(hooks) ? hooks[event] : undefined;
		const kept = (Array.isArray(existing) ? existing : []).filter(
			(entry): entry is CursorHookEntry =>
				isRecord(entry) &&
				!(
					typeof entry.command === "string" &&
					entry.command.includes(CURSOR_HOOK_MARKER)
				),
		);
		merged[event] = [
			...kept,
			{ command: cursorHookCommand(hook), timeout: 30 },
		];
	}
	return applyEdits(
		out,
		modify(
			out,
			["hooks"],
			{ ...(isRecord(hooks) ? hooks : {}), ...merged },
			{
				formattingOptions: { insertSpaces: !out.includes("\n\t"), tabSize: 2 },
			},
		),
	);
}

/** Remove only the hook commands this setup wrote; other hooks stay. */
export function pruneCursorHooks(text: string, path = "hooks.json"): string {
	const config = parseJson(text, path);
	const hooks = config.hooks;
	if (!isRecord(hooks)) return text;
	const next: Record<string, unknown> = {};
	for (const [event, entries] of Object.entries(hooks)) {
		if (!Array.isArray(entries)) {
			next[event] = entries;
			continue;
		}
		const kept = entries.filter(
			(entry) =>
				!(
					isRecord(entry) &&
					typeof entry.command === "string" &&
					entry.command.includes(CURSOR_HOOK_MARKER)
				),
		);
		if (kept.length) next[event] = kept;
	}
	return applyEdits(
		text,
		modify(text, ["hooks"], next, {
			formattingOptions: { insertSpaces: !text.includes("\n\t"), tabSize: 2 },
		}),
	);
}

/** Whether Cursor's MCP config already points Tedix somewhere. */
export function cursorHasTedix(env = process.env): boolean {
	const path = cursorMcpFile(env);
	if (!existsSync(path)) return false;
	try {
		const config = parseJson(readFileSync(path, "utf8"), path);
		const servers = config.mcpServers;
		return isRecord(servers) && isRecord(servers.tedix);
	} catch {
		return false;
	}
}

/**
 * Install or refresh the Tedix MCP server and hooks in Cursor's config.
 * Cursor loads both files itself; there is no plugin manifest to fetch.
 */
export function setupCursor(env = process.env): {
	mcpPath: string;
	hooksPath?: string;
	backups: string[];
} {
	const directory = cursorConfigDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return withFileLockSync(join(directory, ".tedix-setup.lock"), () => {
		const backups: string[] = [];
		const mcpPath = cursorMcpFile(env);
		const mcpText = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : "";
		const mcp = writeMerged(mcpPath, mergeCursorMcp(mcpText, mcpPath), mcpText);
		if (mcp.backup) backups.push(mcp.backup);
		const hooksPath = cursorHooksFile(env);
		const hooksText = existsSync(hooksPath)
			? readFileSync(hooksPath, "utf8")
			: "";
		const hooks = writeMerged(
			hooksPath,
			mergeCursorHooks(hooksText, hooksPath),
			hooksText,
		);
		if (hooks.backup) backups.push(hooks.backup);
		return {
			mcpPath,
			hooksPath: hooks.path === hooksPath ? hooksPath : undefined,
			backups,
		};
	});
}

/** Remove the Tedix MCP server and hooks this setup wrote. */
export function removeCursor(env = process.env): string[] {
	const removed: string[] = [];
	const directory = cursorConfigDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return withFileLockSync(join(directory, ".tedix-setup.lock"), () => {
		const mcpPath = cursorMcpFile(env);
		if (existsSync(mcpPath)) {
			const text = readFileSync(mcpPath, "utf8");
			try {
				const config = parseJson(text, mcpPath);
				const servers = config.mcpServers;
				if (isRecord(servers) && isRecord(servers.tedix)) {
					const next = { ...servers };
					delete next.tedix;
					const merged = applyEdits(
						text,
						modify(text, ["mcpServers"], next, {
							formattingOptions: {
								insertSpaces: !text.includes("\n\t"),
								tabSize: 2,
							},
						}),
					);
					writeMerged(mcpPath, merged, text);
					removed.push(mcpPath);
				}
			} catch {
				/* A file we cannot parse is left alone rather than corrupted. */
			}
		}
		const hooksPath = cursorHooksFile(env);
		if (existsSync(hooksPath)) {
			const text = readFileSync(hooksPath, "utf8");
			try {
				const next = pruneCursorHooks(text, hooksPath);
				if (next !== text) {
					writeMerged(hooksPath, next, text);
					removed.push(hooksPath);
				}
			} catch {
				/* Same: unparseable files stay untouched. */
			}
		}
		return removed;
	});
}

export interface CursorStatus {
	host: "cursor";
	found: boolean;
	/** Cursor's MCP config names Tedix. */
	installed: boolean;
	version?: string;
	problem?: string;
}

/** The Cursor CLI is `agent` (with `cursor-agent` as an accepted alias). */
export function cursorCommand(): string | undefined {
	for (const name of ["cursor-agent", "agent"]) {
		const probe = spawnSync(name, ["--version"], {
			stdio: "ignore",
			timeout: 20_000,
		});
		if (probe.status === 0) return name;
	}
	return undefined;
}

export function cursorStatus(env = process.env): CursorStatus {
	const command = cursorCommand();
	const status: CursorStatus = {
		host: "cursor",
		found: Boolean(command) || existsSync(cursorConfigDirectory(env)),
		installed: false,
	};
	try {
		status.installed = cursorHasTedix(env);
	} catch (error) {
		status.problem = error instanceof Error ? error.message : String(error);
	}
	if (command) {
		const version = spawnSync(command, ["--version"], {
			encoding: "utf8",
			timeout: 20_000,
		});
		const text = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim();
		if (text) status.version = text.split(/\s+/)[0];
	}
	return status;
}
