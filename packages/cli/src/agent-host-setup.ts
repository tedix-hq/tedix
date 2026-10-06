import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

type AgentHost = "codex" | "claude";
type CommandResult = { status: number; stdout: string; stderr: string };
export type HostCommandRunner = (
	command: AgentHost,
	args: string[],
	interactive?: boolean,
) => CommandResult;

const HOSTS: readonly AgentHost[] = ["codex", "claude"];
const MARKETPLACE_REPO = "tedix-hq/tedix";
const PLUGIN_IDS: Record<AgentHost, string> = {
	codex: "tedix@tedix-repo",
	claude: "tedix@tedix",
};
const MARKETPLACE_NAMES: Record<AgentHost, string> = {
	codex: "tedix-repo",
	claude: "tedix",
};

export function agentHostSetupUsage(): string {
	return `Install Tedix for coding agents

Usage:
  tedix setup agents                 Detect Codex and Claude Code, then ask to install
  tedix setup agents --codex         Set up Codex only
  tedix setup agents --claude        Set up Claude Code only
  tedix setup agents --all --yes     Require both hosts; skip Tedix's prompt
  tedix setup agents --status        Report installed, login, hook, and read steps
  tedix setup agents --update        Preview and refresh installed host plugins
  tedix setup agents --dry-run       Show planned host commands without installing

The host plugin bundles Tedix skills, a remote MCP connection, and an optional
read-only SessionStart hook. Installation does not authorize MCP access or trust
Codex hooks. Review each host's OAuth consent and hook definition separately.
The Tedix repository must be accessible through Git while it is private.
`;
}

export function parseAgentHostSetupArgs(args: string[]): {
	dryRun: boolean;
	hosts: AgentHost[];
	status: boolean;
	update: boolean;
	yes: boolean;
} {
	let dryRun = false;
	let status = false;
	let update = false;
	let yes = false;
	const hosts: AgentHost[] = [];
	for (const arg of args) {
		if (arg === "--codex" && !hosts.includes("codex")) hosts.push("codex");
		else if (arg === "--claude" && !hosts.includes("claude"))
			hosts.push("claude");
		else if (arg === "--all" && hosts.length === 0) hosts.push(...HOSTS);
		else if (arg === "--yes" && !yes) yes = true;
		else if (arg === "--dry-run" && !dryRun) dryRun = true;
		else if (arg === "--status" && !status && !update) status = true;
		else if (arg === "--update" && !update && !status) update = true;
		else throw new Error(`Unknown or duplicate agent setup option: ${arg}`);
	}
	return { dryRun, hosts, status, update, yes };
}

export function runHostCommand(
	command: AgentHost,
	args: string[],
	interactive = false,
): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: interactive ? "inherit" : "pipe",
		timeout: interactive ? 180_000 : 20_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	return {
		status: result.error ? 127 : (result.status ?? 1),
		stdout: result.stdout ?? "",
		stderr: result.error?.message ?? result.stderr ?? "",
	};
}

function readJson(
	command: AgentHost,
	args: string[],
	run: HostCommandRunner,
): unknown {
	const result = run(command, args);
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
		);
	try {
		return JSON.parse(result.stdout) as unknown;
	} catch {
		throw new Error(`${command} ${args.join(" ")} did not return JSON`);
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function installedPlugin(
	host: AgentHost,
	value: unknown,
): {
	enabled: boolean;
	installed: boolean;
	version?: string;
} {
	const entries = host === "codex" ? asRecord(value)?.installed : value;
	if (!Array.isArray(entries))
		throw new Error(`${host} plugin list had an unexpected shape`);
	const plugin = entries
		.map(asRecord)
		.find((entry) =>
			host === "codex"
				? entry?.pluginId === PLUGIN_IDS[host]
				: entry?.id === PLUGIN_IDS[host],
		);
	return {
		installed: Boolean(plugin),
		enabled: plugin?.enabled === true,
		version: typeof plugin?.version === "string" ? plugin.version : undefined,
	};
}

function marketplaceSource(
	host: AgentHost,
	value: unknown,
): "absent" | "git" | "local" {
	const entries = host === "codex" ? asRecord(value)?.marketplaces : value;
	if (!Array.isArray(entries))
		throw new Error(`${host} marketplace list had an unexpected shape`);
	const marketplace = entries
		.map(asRecord)
		.find((entry) => entry?.name === MARKETPLACE_NAMES[host]);
	if (!marketplace) return "absent";
	const source =
		host === "codex"
			? asRecord(marketplace.marketplaceSource)?.source
			: marketplace.repo;
	if (
		source === MARKETPLACE_REPO ||
		source === `https://github.com/${MARKETPLACE_REPO}` ||
		source === `https://github.com/${MARKETPLACE_REPO}.git`
	)
		return "git";
	if (
		host === "codex" &&
		asRecord(marketplace.marketplaceSource)?.sourceType === "local" &&
		typeof source === "string"
	)
		return "local";
	if (
		host === "claude" &&
		marketplace.source === "directory" &&
		typeof marketplace.path === "string"
	)
		return "local";
	throw new Error(
		`${host} has a ${MARKETPLACE_NAMES[host]} marketplace from an unknown source; inspect it in ${host} before continuing`,
	);
}

function setupCommands(
	host: AgentHost,
	source: "absent" | "git" | "local",
	update: boolean,
): string[][] {
	if (update)
		return host === "codex"
			? [
					...(source === "git"
						? [["plugin", "marketplace", "upgrade", MARKETPLACE_NAMES[host]]]
						: []),
					["plugin", "add", PLUGIN_IDS[host]],
				]
			: [
					...(source === "git"
						? [["plugin", "marketplace", "update", MARKETPLACE_NAMES[host]]]
						: []),
					["plugin", "update", PLUGIN_IDS[host]],
				];
	return [
		...(source !== "absent"
			? []
			: [["plugin", "marketplace", "add", MARKETPLACE_REPO]]),
		[
			"plugin",
			host === "codex" ? "add" : "install",
			PLUGIN_IDS[host],
			...(host === "claude" ? ["--scope", "user"] : []),
		],
	];
}

export async function runAgentHostSetup(
	args: string[],
	run: HostCommandRunner = runHostCommand,
	confirm?: (prompt: string) => Promise<boolean>,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(agentHostSetupUsage());
		return 0;
	}
	const options = parseAgentHostSetupArgs(args);
	const selected = options.hosts.length ? options.hosts : [...HOSTS];
	const available = selected.filter(
		(host) => run(host, ["--version"]).status === 0,
	);
	if (available.length === 0) {
		console.error("Codex or Claude Code is not installed on this machine.");
		return 1;
	}
	for (const host of selected.filter((item) => !available.includes(item)))
		console.error(`${host} is unavailable on PATH; skipping it.`);

	const pending: Array<{
		host: AgentHost;
		commands: string[][];
		previousVersion?: string;
	}> = [];
	let failures = options.hosts.length ? selected.length - available.length : 0;
	for (const host of available) {
		try {
			const current = installedPlugin(
				host,
				readJson(host, ["plugin", "list", "--json"], run),
			);
			const source = marketplaceSource(
				host,
				readJson(host, ["plugin", "marketplace", "list", "--json"], run),
			);
			console.log(
				`${host}: plugin ${current.installed ? `${current.enabled ? "installed and enabled" : "installed but disabled"}${current.version ? ` (v${current.version})` : ""}` : "absent"}; marketplace ${source}; OAuth and read ${host === "codex" ? "checked below" : "unverified"}.`,
			);
			if (host === "codex") {
				const feature = run(host, ["features", "list"]);
				const modernProtocol =
					feature.status === 0
						? feature.stdout.match(
								/^mcp_2026_07_28\s+.*\s+(true|false)\s*$/m,
							)?.[1]
						: undefined;
				console.log(
					`codex: MCP 2026-07-28 ${modernProtocol === "true" ? "enabled" : modernProtocol === "false" ? "disabled; run codex features enable mcp_2026_07_28, then restart Codex" : "unverified; run codex features list"}. Tedix Connect requires this host protocol.`,
				);
				const mcp = run(host, ["mcp", "list"]);
				const row =
					mcp.status === 0
						? mcp.stdout
								.split("\n")
								.find((line) =>
									/^tedix\s+https:\/\/connect\.mcp\.tedix\.dev\/mcp\s/.test(
										line,
									),
								)
						: undefined;
				console.log(
					`codex: Connect OAuth ${row?.includes("Not logged in") ? "not logged in" : row ? "status requires an authorized read" : "unverified"}; hook trust: check /hooks; read: unverified until a host tool call succeeds.`,
				);
			} else
				console.log(
					"claude: Connect OAuth: check /mcp; hook trust: check /hooks; read: unverified until a host tool call succeeds.",
				);
			if (options.status || (current.installed && !options.update)) continue;
			if (options.update && !current.installed) {
				console.log(
					`${host}: no installed plugin to update; run tedix setup agents --${host} first.`,
				);
				continue;
			}
			if (source === "absent" && current.installed)
				throw new Error(
					`${host} plugin has no matching marketplace; inspect its source before updating`,
				);
			if (source === "local")
				console.log(
					`${host}: update uses your existing local checkout. Inspect and refresh that checkout first; Tedix will not change its Git state or switch marketplaces.`,
				);
			pending.push({
				host,
				commands: setupCommands(host, source, options.update),
				previousVersion: current.version,
			});
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			failures++;
		}
	}

	if (pending.length) {
		console.log("\nTedix agent setup will run:");
		for (const { host, commands } of pending)
			for (const command of commands)
				console.log(`  ${host} ${command.join(" ")}`);
		console.log(`The plugin includes skills, the https://connect.mcp.tedix.dev/mcp connection,
and an optional read-only SessionStart hook. Review its source before installing:
https://github.com/tedix-hq/tedix/tree/main/plugins/tedix`);
		if (!options.dryRun) {
			if (!options.yes) {
				if (!confirm && !process.stdin.isTTY)
					throw new Error("Run in a terminal to confirm setup, or pass --yes.");
				const approved = confirm
					? await confirm("Install these host plugins? [Y/n] ")
					: await promptForConsent("Install these host plugins? [Y/n] ");
				if (!approved) {
					console.log("Agent setup cancelled; no host plugins were installed.");
					return failures ? 1 : 0;
				}
			}
			for (const { host, commands, previousVersion } of pending) {
				try {
					for (const command of commands) {
						const result = run(host, command, true);
						if (result.status !== 0)
							throw new Error(
								`${host} ${command.join(" ")} failed (exit ${result.status})`,
							);
					}
					const verified = installedPlugin(
						host,
						readJson(host, ["plugin", "list", "--json"], run),
					);
					if (!verified.installed)
						throw new Error(
							`${host} did not report the Tedix plugin after installation`,
						);
					console.log(
						`${host}: Tedix plugin ${options.update ? (previousVersion && verified.version === previousVersion ? `still at v${previousVersion}; host reported no version change` : `updated${verified.version ? ` to v${verified.version}` : ""}`) : `installed${verified.version ? ` at v${verified.version}` : ""}`}${verified.enabled ? " and enabled" : "; enable it in the host"}. Restart the host or start a new chat, then review hook trust and verify one read.`,
					);
				} catch (error) {
					console.error(error instanceof Error ? error.message : String(error));
					failures++;
				}
			}
		}
	}
	if (!options.dryRun) {
		console.log(`\nNext: sign in to Tedix inside each host and review its organization and scopes.
Codex: enable MCP 2026-07-28 when status reports it disabled, restart Codex, then run codex mcp login tedix
connections.read permits reviewed connected-provider reads, subject to the provider grant; write and destructive operations remain excluded. Updating the plugin does not expand an existing grant: reconnect and review fresh consent.
Claude Code: open /mcp and connect Tedix. In a running session, use /reload-plugins.
Review the bundled SessionStart hook in each host. Codex skips it until you trust it.
To opt in to the read-only preflight, start the host with TEDIX_PLUGIN_PREFLIGHT=1.
The Tedix CLI login and each host's MCP login are separate.`);
	}
	return failures ? 1 : 0;
}

async function promptForConsent(message: string): Promise<boolean> {
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (await prompt.question(message)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		prompt.close();
	}
}
