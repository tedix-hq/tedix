/**
 * Package one Tedix agent-plugin identity for cloud or an explicitly trusted
 * local host. Local artifacts ship only `hooks/hooks.json`; the hook logic runs
 * in the installed Tedix CLI (`tedix hooks ...`). Every hook command first
 * checks for the CLI, so a host without it runs each hook as a silent no-op.
 *
 *   bun packages/cli/scripts/package-plugin.ts [options] <new.zip>
 */
import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { hostManifest } from "./plugin-manifest";

export const ROOT = resolve(import.meta.dir, "../../../plugins/tedix");
const ASSETS = ["icon.png", "icon-dark.png", "logo.png", "logo-dark.png"];
/** A missing Tedix CLI makes every hook exit 0 with no output. */
export const HOOK_GUARD = "command -v tedix >/dev/null 2>&1 || exit 0; ";
/** The oldest Tedix CLI the hooks support (README states the same version). */
export const MIN_CLI = "0.8.17";
/** SessionStart preflight names an older CLI and stops instead of running it. */
export const CLI_GATE = `v=$(tedix --version 2>/dev/null); [ "$(printf '%s\\n' ${MIN_CLI} "$v" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = ${MIN_CLI} ] || { echo "Tedix preflight: CLI \${v:-unknown} is older than ${MIN_CLI}, which this plugin needs; run tedix update."; exit 0; }; `;
const HOOK_NAME =
	/^tedix hooks (session-start|prompt-context|capture-stop|capture-reply|await-reply|await-draft|situational-recall|status)$/;

// Source manifests may still use GNU version sort; packages need POSIX options.
function portableHookCommand(command: string): string {
	return command.replace(
		" | sort -V | ",
		" | sort -t. -k1,1n -k2,2n -k3,3n | ",
	);
}

/** The hook a guarded command runs; only session-start carries the CLI gate. */
export function hookName(command: string): string | undefined {
	if (!command.startsWith(HOOK_GUARD)) return undefined;
	let rest = portableHookCommand(command).slice(HOOK_GUARD.length);
	const gated = rest.startsWith(CLI_GATE);
	if (gated) rest = rest.slice(CLI_GATE.length);
	if (
		!gated &&
		rest === "TEDIX_HOOK_CONTEXT_BYTES=10000 tedix hooks prompt-context"
	)
		return "prompt-context";
	const name = HOOK_NAME.exec(rest)?.[1];
	return name && gated === (name === "session-start") ? name : undefined;
}
/** Hooks only Codex runs; Claude Code packages omit them. */
const CODEX_ONLY_HOOKS = new Set(["await-draft"]);
type Host = "openai" | "claude";

export interface PackageOptions {
	root?: string;
	local?: boolean;
	host?: string;
	mcpUrl?: string;
	mcpBearerEnv?: string;
	appId?: string;
}

function isLoopbackAddress(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "::1") return true;
	const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	return Boolean(
		octets &&
		octets[1] === "127" &&
		octets.slice(1).every((octet) => Number(octet) <= 255),
	);
}

/** Never embed credentials or downgrade a remote connection to plain HTTP. */
export function validateMcpUrl(
	url: string,
	{ local }: { local: boolean },
): void {
	const error = new Error(
		"MCP URL must be HTTPS without credentials, query or fragment; explicit local packages also allow loopback HTTP",
	);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw error;
	}
	const hostname = parsed.hostname;
	const loopback =
		hostname === "localhost" ||
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/.test(hostname) ||
		isLoopbackAddress(hostname);
	if (
		!hostname ||
		parsed.username ||
		parsed.password ||
		url.includes("@") ||
		parsed.search ||
		parsed.hash ||
		url.includes("\\") ||
		/\s/.test(url) ||
		!(
			parsed.protocol === "https:" ||
			(local && loopback && parsed.protocol === "http:")
		)
	)
		throw error;
}

function json(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value, null, "\t")}\n`);
}

function readJson(root: string, path: string): any {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function skillPaths(root: string): string[] {
	const paths: string[] = [];
	const realRoot = realpathSync(root);
	const visit = (path: string): void => {
		const absolute = join(root, path);
		const stat = lstatSync(absolute);
		const real = realpathSync(absolute);
		if (
			stat.isSymbolicLink() ||
			!real.startsWith(realRoot + sep) ||
			!(stat.isDirectory() || stat.isFile())
		)
			throw new Error(
				`Package source must be a regular in-tree file or directory: ${absolute}`,
			);
		if (stat.isDirectory()) {
			for (const name of readdirSync(absolute).sort()) visit(join(path, name));
		} else paths.push(path);
	};
	visit("skills");
	return paths;
}

function addFiles(
	root: string,
	files: Map<string, Uint8Array>,
	paths: string[],
): void {
	const realRoot = realpathSync(root);
	for (const path of [...paths].sort()) {
		const absolute = join(root, path);
		const real = realpathSync(absolute);
		if (
			lstatSync(absolute).isSymbolicLink() ||
			!(real === realRoot || real.startsWith(realRoot + sep))
		)
			throw new Error(
				`Package source must be a regular in-tree file: ${absolute}`,
			);
		files.set(
			relative(root, absolute).split(sep).join("/"),
			readFileSync(absolute),
		);
	}
}

/** The local hooks, in the host's native form; the logic lives in the Tedix CLI. */
function localHooks(root: string, host: Host): any {
	const hooks = readJson(root, "config/host-hooks.json");
	// Only Claude Code can wake a session from a background hook (asyncRewake);
	// elsewhere such a hook would hold the turn open, so it is not shipped.
	// Codex instead continues from a synchronous Stop hook (await-draft), which
	// Claude Code does not need: await-reply delivers the same replies there.
	const shipped = (handler: any): boolean =>
		host === "claude"
			? !CODEX_ONLY_HOOKS.has(hookName(handler.command) ?? "")
			: handler.asyncRewake !== true;
	for (const [event, definitions] of Object.entries<any[]>(hooks.hooks)) {
		for (const definition of definitions)
			definition.hooks = definition.hooks.filter(shipped);
		hooks.hooks[event] = definitions.filter(
			(definition) => definition.hooks.length,
		);
	}
	for (const definitions of Object.values<any[]>(hooks.hooks))
		for (const definition of definitions)
			for (const handler of definition.hooks) {
				handler.command = portableHookCommand(handler.command);
				if (!hookName(handler.command))
					throw new Error(
						"Unsupported hook command; review the host adapter before packaging",
					);
				// Shell form: the guard needs a shell to test for the CLI.
				if (host === "claude") delete handler.additionalContextLimit;
			}
	return hooks;
}

export function packageFiles(
	options: PackageOptions = {},
): Map<string, Uint8Array> {
	const {
		root = ROOT,
		local = false,
		host = "openai",
		mcpUrl,
		mcpBearerEnv,
		appId,
	} = options;
	if (!["openai", "claude", "devin", "opencode", "chatgpt-dev"].includes(host))
		throw new Error(
			"Host must be openai, claude, devin, opencode or chatgpt-dev",
		);
	if (host === "chatgpt-dev") {
		if (!appId || !/^asdk_app_[a-f0-9]{32}$/.test(appId) || local)
			throw new Error(
				"--app-id requires an existing app ID and cannot combine with --local",
			);
	} else if (appId !== undefined)
		throw new Error("--app-id requires --host chatgpt-dev");
	if (mcpUrl !== undefined) validateMcpUrl(mcpUrl, { local });
	if (
		mcpBearerEnv !== undefined &&
		(host !== "claude" ||
			!local ||
			mcpUrl === undefined ||
			!/^[A-Z_][A-Z0-9_]*$/.test(mcpBearerEnv))
	)
		throw new Error(
			"Bearer environment reference requires --host claude --local --mcp-url and an uppercase environment variable name",
		);
	const files = new Map<string, Uint8Array>();
	const assets = ASSETS.map((name) => join("assets", name));
	if (host === "claude") {
		// Use automatic discovery, avoiding duplicate hooks or MCP definitions.
		const mcp = readJson(root, "mcp.json");
		const server = mcp.mcpServers.tedix;
		server.type = "http";
		delete server.extensions;
		if (mcpUrl !== undefined) server.url = mcpUrl;
		if (mcpBearerEnv !== undefined)
			server.headers = { Authorization: `Bearer \${${mcpBearerEnv}}` };
		const manifest = hostManifest(root, "claude");
		delete manifest.hooks;
		files.set(".claude-plugin/plugin.json", json(manifest));
		files.set(".mcp.json", json({ mcpServers: mcp.mcpServers }));
		if (local) files.set("hooks/hooks.json", json(localHooks(root, "claude")));
		addFiles(root, files, [...skillPaths(root), ...assets]);
		return files;
	}
	if (mcpUrl !== undefined)
		throw new Error("MCP URL overrides currently apply only to --host claude");
	if (host === "devin" || host === "opencode") {
		addFiles(root, files, [
			"plugin.json",
			"mcp.json",
			...skillPaths(root),
			...assets,
		]);
		if (host === "devin") {
			files.set(".devin-plugin/plugin.json", json(hostManifest(root, "devin")));
			if (local) addFiles(root, files, ["hooks.json"]);
		} else addFiles(root, files, [".opencode-plugin/index.js"]);
		return files;
	}
	const manifest = readJson(root, "plugin.json");
	const extension = manifest.extensions["com.openai"];
	// Host packages use hooks/hooks.json discovery; cloud packages omit hooks.
	delete extension.hooks;
	delete extension.apps;
	extension.review.test_cases = readJson(root, "review/cases.json");
	extension.publication.release_notes = readFileSync(
		join(root, "review/release-notes.md"),
		"utf8",
	).trim();
	const paths = ["mcp.json", ...skillPaths(root), ...assets];
	if (host === "chatgpt-dev") {
		// Reuse the installed app's OAuth grant; never create a second connector.
		extension.apps = "./.app.json";
		paths.splice(0, 1);
		files.set(".app.json", json({ apps: { [manifest.name]: { id: appId } } }));
		const compatibility = hostManifest(root, "codex");
		delete compatibility.hooks;
		delete compatibility.mcpServers;
		compatibility.apps = extension.apps;
		files.set(".codex-plugin/plugin.json", json(compatibility));
	}
	if (local) {
		extension.publication.release_notes =
			extension.publication.release_notes.replace(
				"It contains no local lifecycle hooks, credentials or\ncopied tokens.",
				"This local artifact includes opt-in context hooks, opt-in decision capture and an opt-in turn-status reporter, run by the installed Tedix CLI, and contains no credentials or copied tokens.",
			);
		paths.push(".mcp.json");
		const claude = hostManifest(root, "claude");
		delete claude.hooks;
		files.set(".claude-plugin/plugin.json", json(claude));
		files.set("hooks/hooks.json", json(localHooks(root, "openai")));
		// The portable extension is authoritative. Mirror its complete overlay,
		// rather than rely on an older compatibility manifest being merged.
		const compatibility: Record<string, unknown> = Object.fromEntries(
			Object.entries(structuredClone(manifest)).filter(
				([key]) => key !== "$schema" && key !== "extensions",
			),
		);
		Object.assign(compatibility, structuredClone(extension), {
			skills: "./skills/",
			mcpServers: "./.mcp.json",
		});
		files.set(".codex-plugin/plugin.json", json(compatibility));
	}
	files.set("plugin.json", json(manifest));
	addFiles(root, files, paths);
	return files;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A stored (uncompressed) ZIP with fixed timestamps, ordering and Unix
 * permissions, so the digest is reproducible across hosts.
 */
export function zipStored(files: Map<string, Uint8Array>): Uint8Array {
	const DOS_TIME = 0;
	const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const name of [...files.keys()].sort()) {
		const data = Buffer.from(files.get(name)!);
		const encodedName = Buffer.from(name, "utf8");
		const flags = /^[\x00-\x7f]*$/.test(name) ? 0 : 0x800;
		const crc = crc32(data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(flags, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(DOS_TIME, 10);
		header.writeUInt16LE(DOS_DATE, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(encodedName.length, 26);
		header.writeUInt16LE(0, 28);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE((3 << 8) | 20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(flags, 8);
		record.writeUInt16LE(0, 10);
		record.writeUInt16LE(DOS_TIME, 12);
		record.writeUInt16LE(DOS_DATE, 14);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(data.length, 24);
		record.writeUInt16LE(encodedName.length, 28);
		record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
		record.writeUInt32LE(offset, 42);
		local.push(header, encodedName, data);
		central.push(record, encodedName);
		offset += header.length + encodedName.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.size, 8);
	end.writeUInt16LE(files.size, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

/** Write a new archive; an existing destination is never overwritten. */
export function build(destination: string, options: PackageOptions = {}): void {
	const archive = zipStored(packageFiles(options));
	const descriptor = openSync(destination, "wx");
	try {
		writeSync(descriptor, archive);
	} finally {
		closeSync(descriptor);
	}
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			local: { type: "boolean", default: false },
			host: { type: "string", default: "openai" },
			"mcp-url": { type: "string" },
			"mcp-bearer-env": { type: "string" },
			"app-id": { type: "string" },
		},
	});
	if (positionals.length !== 1) {
		console.error(
			"Usage: bun packages/cli/scripts/package-plugin.ts [--local] [--host openai|claude|devin|opencode|chatgpt-dev] [--app-id <existing app>] [--mcp-url <url>] [--mcp-bearer-env <NAME>] <new.zip>",
		);
		process.exit(2);
	}
	build(positionals[0]!, {
		local: values.local,
		host: values.host,
		mcpUrl: values["mcp-url"],
		mcpBearerEnv: values["mcp-bearer-env"],
		appId: values["app-id"],
	});
	console.log(positionals[0]);
}
