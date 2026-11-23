import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialDirectory } from "./credential-store";
import { devinConfigDirectory, setupDevin } from "./devin-config";
import {
	opencodeConfigFile,
	opencodeStatus,
	setupOpencode,
} from "./opencode-config";

type AgentHost = "codex" | "claude";
type CommandResult = { status: number; stdout: string; stderr: string };
export type HostCommandRunner = (
	command: AgentHost,
	args: string[],
	interactive?: boolean,
) => CommandResult;

const HOSTS: readonly AgentHost[] = ["codex", "claude"];
interface PluginSource {
	repo: string;
	id: string;
	marketplace: string;
}
/** The published plugin repository; every new install comes from here. */
const PUBLISHED: PluginSource = {
	repo: "tedix-hq/tedix-plugins",
	id: "tedix@tedix-plugins",
	marketplace: "tedix-plugins",
};
/**
 * Installs made from the source repository before the plugin had its own.
 * They count as installed and update from where they came; setup never adds
 * a second copy beside one.
 */
const EARLIER: Record<AgentHost, PluginSource> = {
	codex: {
		repo: "tedix-hq/tedix",
		id: "tedix@tedix-repo",
		marketplace: "tedix-repo",
	},
	claude: { repo: "tedix-hq/tedix", id: "tedix@tedix", marketplace: "tedix" },
};

export function agentHostSetupUsage(): string {
	return `Install Tedix for coding agents

Usage:
  tedix setup agents                 Detect Codex and Claude Code, then ask to install
  tedix setup agents --codex         Set up Codex only
  tedix setup agents --claude        Set up Claude Code only
  tedix setup agents --devin --yes   Merge Devin hooks and MCP config (no login)
  tedix setup agents --opencode --yes Add the Tedix plugin to OpenCode (no login)
  tedix setup agents --all --yes     Require both hosts; skip Tedix's prompt
  tedix setup agents --status        Report installed, login, hook, and read steps
  tedix setup agents --status --json Print the same facts as JSON, Devin and OpenCode included
  tedix setup agents --codex --verify Verify a read inside Codex (no model call)
  tedix setup agents --claude --verify Verify a read inside Claude (uses its model)
  tedix setup agents --update        Preview and refresh installed host plugins
  tedix setup agents --dry-run       Show planned host commands without installing

The host plugin bundles Tedix skills, a remote MCP connection, and lifecycle
hooks that run "tedix hooks <name>" at session start, prompt submit, tool use,
stop and session end. Each hook exits silently when the tedix CLI is missing
and does nothing until you opt in: a repository binding or
TEDIX_PLUGIN_PREFLIGHT=1 for context reads, enable-decision-capture for turn
recording, ~/.tedix/agent-status.json for status reports. To turn the hooks
off entirely, disable or uninstall the Tedix plugin in the host.
Installation does not authorize MCP access or trust Codex hooks; Codex runs a
hook only after you trust it in /hooks. Review each host's OAuth consent and
hook definition separately.
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
		// A tool that refreshes its plugin sources first can take a minute to
		// answer, and fetching the plugin source takes minutes on a slow line:
		// Claude Code gives up after two minutes unless told otherwise.
		timeout: interactive ? 900_000 : 120_000,
		env: {
			CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: "840000",
			...process.env,
			TEDIX_AGENT_SESSION: undefined,
			TEDIX_EXTERNAL_AGENT: undefined,
		},
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
	source: PluginSource;
} {
	const entries = host === "codex" ? asRecord(value)?.installed : value;
	if (!Array.isArray(entries))
		throw new Error(`${host} plugin list had an unexpected shape`);
	const records = entries.map(asRecord);
	const from = (source: PluginSource) =>
		records.find(
			(entry) => (host === "codex" ? entry?.pluginId : entry?.id) === source.id,
		);
	const plugin = from(PUBLISHED) ?? from(EARLIER[host]);
	return {
		source: plugin && !from(PUBLISHED) ? EARLIER[host] : PUBLISHED,
		installed: Boolean(plugin),
		enabled: plugin?.enabled === true,
		version: typeof plugin?.version === "string" ? plugin.version : undefined,
	};
}

function marketplaceSource(
	host: AgentHost,
	value: unknown,
	from: PluginSource,
): "absent" | "git" | "local" {
	const entries = host === "codex" ? asRecord(value)?.marketplaces : value;
	if (!Array.isArray(entries))
		throw new Error(`${host} marketplace list had an unexpected shape`);
	const marketplace = entries
		.map(asRecord)
		.find((entry) => entry?.name === from.marketplace);
	if (!marketplace) return "absent";
	const source =
		host === "codex"
			? asRecord(marketplace.marketplaceSource)?.source
			: marketplace.repo;
	if (
		source === from.repo ||
		source === `https://github.com/${from.repo}` ||
		source === `https://github.com/${from.repo}.git`
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
		`${host} has a ${from.marketplace} marketplace from an unknown source; inspect it in ${host} before continuing`,
	);
}

function setupCommands(
	host: AgentHost,
	source: "absent" | "git" | "local",
	update: boolean,
	from: PluginSource,
): string[][] {
	if (update)
		return host === "codex"
			? [
					...(source === "git"
						? [["plugin", "marketplace", "upgrade", from.marketplace]]
						: []),
					["plugin", "add", from.id],
				]
			: [
					...(source === "git"
						? [["plugin", "marketplace", "update", from.marketplace]]
						: []),
					["plugin", "update", from.id],
				];
	return [
		...(source !== "absent"
			? []
			: [["plugin", "marketplace", "add", from.repo]]),
		[
			"plugin",
			host === "codex" ? "add" : "install",
			from.id,
			...(host === "claude" ? ["--scope", "user"] : []),
		],
	];
}

/**
 * What `--status --json` prints for one tool. `signedIn` is false only when
 * the tool itself reports that its Tedix connection is not signed in;
 * undefined means the tool gives no way to tell from outside.
 */
export interface AgentHostStatus {
	host: AgentHost | "devin";
	found: boolean;
	installed: boolean;
	enabled?: boolean;
	version?: string;
	signedIn?: boolean;
	/** The coding tool's own account, separate from its Tedix MCP sign-in. */
	account?: "signed-in" | "signed-out" | "unknown";
	hookTrust?: "trusted" | "untrusted" | "unknown";
	readVerifiedAt?: string;
	/** Codex only: whether the MCP protocol Tedix Connect needs is on. */
	protocolEnabled?: boolean;
	problem?: string;
}

const accountFingerprints = new WeakMap<AgentHostStatus, string>();

async function hostStatus(
	host: AgentHost,
	run: HostCommandRunner,
): Promise<AgentHostStatus> {
	if (run(host, ["--version"]).status !== 0)
		return { host, found: false, installed: false };
	try {
		const plugin = installedPlugin(
			host,
			readJson(host, ["plugin", "list", "--json"], run),
		);
		const status: AgentHostStatus = { host, found: true, ...plugin };
		const auth = run(
			host,
			host === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
		);
		const output = `${auth.stdout}\n${auth.stderr}`;
		accountFingerprints.set(
			status,
			createHash("sha256").update(output).digest("hex"),
		);
		status.account =
			host === "codex"
				? /not logged in/i.test(output)
					? "signed-out"
					: auth.status === 0 && /logged in/i.test(output)
						? "signed-in"
						: "unknown"
				: (() => {
						try {
							const loggedIn = JSON.parse(auth.stdout).loggedIn;
							return loggedIn === true
								? "signed-in"
								: loggedIn === false
									? "signed-out"
									: "unknown";
						} catch {
							return "unknown";
						}
					})();
		if (host === "codex") {
			const features = run(host, ["features", "list"]);
			const enabled =
				features.status === 0
					? features.stdout.match(
							/^mcp_2026_07_28\s+.*\s+(true|false)\s*$/m,
						)?.[1]
					: undefined;
			if (enabled) status.protocolEnabled = enabled === "true";
			const mcp = run(host, ["mcp", "list"]);
			if (
				mcp.status === 0 &&
				mcp.stdout
					.split("\n")
					.some(
						(line) => /^tedix\s/.test(line) && line.includes("Not logged in"),
					)
			)
				status.signedIn = false;
			if (plugin.installed && plugin.enabled && run === runHostCommand) {
				try {
					status.hookTrust = await codexSetup(false);
				} catch {
					status.hookTrust = "unknown";
				}
			}
		}
		try {
			const proof = JSON.parse(readFileSync(proofPath(host), "utf8"));
			const age = Date.now() - Date.parse(proof.at);
			if (
				plugin.installed &&
				plugin.enabled &&
				status.account === "signed-in" &&
				status.signedIn !== false &&
				status.protocolEnabled !== false &&
				age >= 0 &&
				age < 24 * 60 * 60_000 &&
				proof.fingerprint === proofFingerprint(host, status)
			) {
				status.readVerifiedAt = proof.at;
				status.signedIn = true;
			}
		} catch {
			/* No current successful host read. */
		}
		return status;
	} catch (error) {
		return {
			host,
			found: true,
			installed: false,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

const proofPath = (host: AgentHost) =>
	join(credentialDirectory(), `setup-read-${host}.json`);

/** Invalidate a read after account, plugin, configuration or credential changes. */
function proofFingerprint(host: AgentHost, status: AgentHostStatus): string {
	const directory =
		host === "codex"
			? process.env.CODEX_HOME || join(homedir(), ".codex")
			: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	const hash = createHash("sha256").update(
		JSON.stringify([
			status.version,
			status.account,
			accountFingerprints.get(status),
		]),
	);
	for (const name of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
	])
		hash.update(process.env[name] ?? "");
	for (const file of host === "codex"
		? ["config.toml", "auth.json", ".credentials.json", "hooks.json"]
		: ["settings.json", ".credentials.json"])
		try {
			hash.update(readFileSync(join(directory, file)));
		} catch {
			hash.update("missing");
		}
	return hash.digest("hex");
}

/** Read-only app-server requests. Never answer consent, trust or approval requests. */
async function codexSetup(
	verify: boolean,
): Promise<"trusted" | "untrusted" | "unknown"> {
	const child = spawn(
		"codex",
		[
			"app-server",
			"-c",
			'mcp_servers.tedix.url="https://connect.mcp.tedix.dev/mcp"',
		],
		{
			stdio: ["pipe", "pipe", "ignore"],
			cwd: homedir(),
			env: {
				...process.env,
				TEDIX_AGENT_SESSION: undefined,
				TEDIX_EXTERNAL_AGENT: undefined,
			},
		},
	);
	const lines = createInterface({ input: child.stdout });
	let next = 0;
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const fail = () => {
		for (const item of pending.values())
			item.reject(new Error("Codex did not finish the setup check."));
		pending.clear();
	};
	child.on("error", fail);
	child.on("exit", fail);
	child.stdin.on("error", fail);
	lines.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			if (event.method && event.id !== undefined) {
				child.stdin.write(
					`${JSON.stringify({ id: event.id, error: { code: -32601, message: "Finish this request inside Codex." } })}\n`,
				);
				return;
			}
			const item = pending.get(event.id);
			if (!item) return;
			pending.delete(event.id);
			if (event.error)
				item.reject(
					new Error(
						"Codex could not check the connection. Try signing in to Tedix from Codex again.",
					),
				);
			else item.resolve(event.result);
		} catch {
			/* Ignore non-protocol output. */
		}
	});
	const timer = setTimeout(() => {
		fail();
		child.kill();
	}, 90_000);
	const request = (method: string, params: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = ++next;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	try {
		await request("initialize", {
			clientInfo: { name: "tedix_setup", title: "Tedix setup", version: "1" },
			capabilities: { experimentalApi: true, explicitGatewayOauth: true },
		});
		child.stdin.write('{"method":"initialized"}\n');
		if (!verify) {
			const listed = asRecord(
				await request("hooks/list", { cwds: [homedir()] }),
			);
			const entries = records(listed?.data);
			const hooks = entries
				.flatMap((entry) => records(entry.hooks))
				.filter(
					(hook) =>
						(typeof hook.pluginId === "string" &&
							/^tedix@/.test(hook.pluginId)) ||
						(typeof hook.command === "string" &&
							/(?:^|[\s/])tedix['"]?\s+hooks\s/.test(hook.command)),
				);
			return !hooks.length ||
				entries.some(
					(entry) =>
						(Array.isArray(entry.errors) && entry.errors.length) ||
						(Array.isArray(entry.warnings) && entry.warnings.length),
				)
				? "unknown"
				: hooks.every(
							(hook) =>
								hook.enabled === true &&
								(hook.trustStatus === "trusted" ||
									hook.trustStatus === "managed"),
					  )
					? "trusted"
					: "untrusted";
		}
		const started = asRecord(
			await request("thread/start", {
				cwd: homedir(),
				ephemeral: true,
				approvalPolicy: "untrusted",
				sandbox: "read-only",
			}),
		);
		const threadId = asRecord(started?.thread)?.id;
		if (typeof threadId !== "string")
			throw new Error("Codex did not start the setup check.");
		let cursor: string | null = null;
		let server: Record<string, unknown> | undefined;
		do {
			const page = asRecord(
				await request("mcpServerStatus/list", { threadId, cursor }),
			);
			server = records(page?.data).find(
				(item) =>
					item.httpOrigin === "https://connect.mcp.tedix.dev" &&
					(item.name === "tedix" ||
						(typeof item.pluginId === "string" &&
							/^tedix@/.test(item.pluginId))) &&
					asRecord(item.tools)?.get_profile,
			);
			cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
		} while (!server && cursor);
		if (!server)
			throw new Error(
				"Codex is not signed in to Tedix any more. Choose Sign in.",
			);
		const result = asRecord(
			await request("mcpServer/tool/call", {
				threadId,
				server: server.name,
				environmentId: server.environmentId,
				tool: "get_profile",
				arguments: {},
			}),
		);
		if (
			!result ||
			result.isError === true ||
			(!profileRead(result.structuredContent) && !profileRead(result.content))
		)
			throw new Error(
				"Tedix did not return a successful profile read inside Codex.",
			);
		return "unknown";
	} finally {
		clearTimeout(timer);
		lines.close();
		child.stdin.end();
		child.kill();
	}
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value
				.map(asRecord)
				.filter((item): item is Record<string, unknown> => item !== undefined)
		: [];
}

function profileRead(value: unknown): boolean {
	if (typeof asRecord(value)?.id === "string" && asRecord(value)?.id)
		return true;
	if (Array.isArray(value))
		return records(value).some(
			(item) => item.type === "text" && profileRead(item.text),
		);
	if (typeof value === "string") {
		try {
			return profileRead(JSON.parse(value));
		} catch {
			return false;
		}
	}
	return false;
}

/** Accept host tool results, never the model's claim that a read worked. */
function claudeSetupReadSucceeded(output: string): boolean {
	const calls = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		try {
			const event = asRecord(JSON.parse(line));
			for (const block of records(asRecord(event?.message)?.content)) {
				if (
					event?.type === "assistant" &&
					block.type === "tool_use" &&
					block.name === "mcp__plugin_tedix_tedix__get_profile" &&
					typeof block.id === "string"
				)
					calls.add(block.id);
				if (
					event?.type === "user" &&
					block.type === "tool_result" &&
					typeof block.tool_use_id === "string" &&
					calls.has(block.tool_use_id) &&
					block.is_error !== true &&
					profileRead(block.content)
				)
					return true;
			}
		} catch {
			/* Not a host event. */
		}
	}
	return false;
}

async function verifyHost(
	host: AgentHost,
	run: HostCommandRunner,
): Promise<void> {
	rmSync(proofPath(host), { force: true });
	const status = await hostStatus(host, run);
	if (!status.installed || !status.enabled)
		throw new Error(`Enable the Tedix plugin in ${host}, then check again.`);
	if (status.account !== "signed-in")
		throw new Error(
			`Sign in to your ${host === "codex" ? "Codex" : "Claude Code"} account, then check again.`,
		);
	if (host === "codex") await codexSetup(true);
	else {
		const result = run(host, [
			"-p",
			"Call only mcp__plugin_tedix_tedix__get_profile with {} once to check the Tedix sign-in. Do not use other tools, change anything, or request consent. Stop after that read.",
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-turns",
			"2",
			"--tools",
			"",
			"--allowedTools",
			"mcp__plugin_tedix_tedix__get_profile",
		]);
		if (result.status !== 0 || !claudeSetupReadSucceeded(result.stdout))
			throw new Error(
				"Claude Code could not read your Tedix profile. Sign in to Tedix in Claude Code and try again.",
			);
	}
	const at = new Date().toISOString();
	mkdirSync(credentialDirectory(), { recursive: true, mode: 0o700 });
	writeFileSync(
		proofPath(host),
		JSON.stringify({ at, fingerprint: proofFingerprint(host, status) }),
		{ mode: 0o600 },
	);
}

function devinStatus(): AgentHostStatus {
	const directory = devinConfigDirectory();
	const found =
		existsSync(directory) ||
		spawnSync("devin", ["--version"], { stdio: "ignore", timeout: 20_000 })
			.status === 0;
	let installed = false;
	try {
		const config = JSON.parse(
			readFileSync(join(directory, "mcp_config.json"), "utf8"),
		) as { mcpServers?: Record<string, unknown> };
		installed = Boolean(config.mcpServers?.tedix);
	} catch {
		/* No settings file yet, or one this command cannot read. */
	}
	const auth = found
		? spawnSync("devin", ["auth", "status"], {
				encoding: "utf8",
				timeout: 20_000,
			})
		: undefined;
	const output = `${auth?.stdout ?? ""}\n${auth?.stderr ?? ""}`;
	const account = /not (?:logged|signed) in/i.test(output)
		? "signed-out"
		: auth?.status === 0 && /logged in/i.test(output)
			? "signed-in"
			: "unknown";
	return { host: "devin", found, installed, account };
}

export async function runAgentHostSetup(
	args: string[],
	run: HostCommandRunner = runHostCommand,
	confirm?: (prompt: string) => Promise<boolean>,
): Promise<number> {
	if (args.includes("--verify")) {
		const host = args.includes("--codex")
			? "codex"
			: args.includes("--claude")
				? "claude"
				: undefined;
		if (!host || args.length !== 2 || new Set(args).size !== 2)
			throw new Error("Use --verify with exactly one of --codex or --claude.");
		await verifyHost(host, run);
		console.log(`${host}: a Tedix profile read succeeded inside the tool.`);
		return 0;
	}
	if (
		args.includes("--status") &&
		!args.includes("--devin") &&
		!args.includes("--opencode")
	) {
		const json = args.includes("--json");
		const options = parseAgentHostSetupArgs(
			args.filter((arg) => arg !== "--json"),
		);
		if (
			args.filter((arg) => arg === "--json").length > 1 ||
			options.dryRun ||
			options.yes
		)
			throw new Error("Use --status with optional host selectors and --json.");
		const selected = options.hosts.length ? options.hosts : [...HOSTS];
		const hosts = await Promise.all(
			selected.map((host) => hostStatus(host, run)),
		);
		if (json)
			console.log(
				JSON.stringify(
					{
						hosts: [
							...hosts,
							...(!options.hosts.length
								? [devinStatus(), opencodeStatus()]
								: []),
						],
					},
					null,
					2,
				),
			);
		else
			for (const status of hosts) {
				console.log(
					`${status.host}: plugin ${status.installed ? (status.enabled ? "installed and enabled" : "disabled") : "absent"}; account ${status.account ?? "unknown"}.`,
				);
				if (status.host === "codex")
					console.log(
						`codex: MCP 2026-07-28 ${status.protocolEnabled === true ? "enabled" : status.protocolEnabled === false ? "disabled; run codex features enable mcp_2026_07_28, then restart Codex" : "unverified; run codex features list"}.`,
					);
				console.log(
					`${status.host}: Connect OAuth ${status.readVerifiedAt ? "verified" : status.signedIn === false ? "not logged in" : "unverified"}; hook trust: ${status.hookTrust ?? "check /hooks"}; read: ${status.readVerifiedAt ? `verified at ${status.readVerifiedAt}` : `unverified; run tedix setup agents --${status.host} --verify`}.`,
				);
				if (status.problem) console.error(status.problem);
			}
		if (!json && !options.hosts.length) {
			const opencode = opencodeStatus();
			if (opencode.found)
				console.log(
					`opencode: plugin ${opencode.current ? `installed${opencode.version ? ` (v${opencode.version})` : ""}` : opencode.installed ? "installed from an older copy; run tedix setup agents --opencode --yes" : "absent; run tedix setup agents --opencode --yes"}; Connect OAuth: check opencode mcp list.`,
				);
			if (opencode.problem) console.error(opencode.problem);
		}
		return 0;
	}
	if (args.includes("--json"))
		throw new Error("Use --json only with --status.");
	if (args.includes("--opencode")) {
		if (
			new Set(args).size !== args.length ||
			args.some(
				(arg) =>
					!["--opencode", "--yes", "--dry-run", "--status"].includes(arg),
			) ||
			(args.includes("--status") && args.includes("--yes"))
		)
			throw new Error("Use --opencode with --yes, --dry-run or --status only");
		if (args.includes("--status")) {
			const status = opencodeStatus();
			console.log(
				`opencode: ${status.found ? "found" : "not found"}; Tedix plugin ${status.current ? `installed${status.version ? ` (v${status.version})` : ""}` : status.installed ? "installed from an older copy" : "absent"}.`,
			);
			if (status.problem) console.error(status.problem);
			return 0;
		}
		console.log(
			`OpenCode: download the Tedix plugin from tedix-hq/tedix-plugins and add it to ${opencodeConfigFile()}, replacing any earlier Tedix plugin entry; the old file is backed up first.`,
		);
		if (args.includes("--dry-run")) return 0;
		if (
			!args.includes("--yes") &&
			!(await (confirm ?? promptForConsent)("Add Tedix to OpenCode? [Y/n] "))
		)
			return 0;
		const { configPath, backup } = await setupOpencode();
		console.log(
			`OpenCode configured in ${configPath}${backup ? `; previous settings saved as ${backup}` : ""}. Sign in with opencode mcp auth tedix, then start a new OpenCode session.`,
		);
		return 0;
	}
	if (args.includes("--devin")) {
		if (
			new Set(args).size !== args.length ||
			(args.includes("--status") && args.includes("--update"))
		)
			throw new Error("Duplicate or conflicting Devin setup options");
		if (
			args.some(
				(arg) =>
					!["--devin", "--yes", "--dry-run", "--status", "--update"].includes(
						arg,
					),
			)
		)
			throw new Error("Use --devin separately from other host targets");
		console.log(
			`Devin: merge Tedix hooks and MCP in ${devinConfigDirectory()}; disable Claude config imports to avoid duplicate and incompatible hooks; disable automatic attribution.`,
		);
		if (args.includes("--dry-run") || args.includes("--status")) {
			console.log(
				"OAuth, hook dispatch and authorized reads are unverified. Run devin mcp login tedix after setup.",
			);
			return 0;
		}
		if (
			!args.includes("--yes") &&
			!(await (confirm ?? promptForConsent)(
				"Merge Devin configuration? [Y/n] ",
			))
		)
			return 0;
		setupDevin();
		console.log(
			"Devin configured. Run devin mcp login tedix, then start a new Devin session and verify one read. Repository AGENTS.md loads natively. Claude config imports are disabled for Devin; existing Claude files are untouched.",
		);
		return 0;
	}
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
				current.source,
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
				commands: setupCommands(host, source, options.update, current.source),
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
		console.log(`The plugin includes skills and the https://connect.mcp.tedix.dev/mcp connection.
Review its source before installing:
https://github.com/tedix-hq/tedix-plugins`);
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
Review the bundled hooks in each host's /hooks view. Codex skips them until you trust them.
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
