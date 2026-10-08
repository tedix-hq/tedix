import { COMMANDS, interactiveSlashCommands } from "./commands";
import { agentContextUsage } from "./agent-context";
import { HUMAN_CONNECT_CONSENT_SCOPES } from "@tedix/mcp-shared/auth/consent-scopes";
import { flowUsage } from "./flow";
import { hooksUsage } from "./hooks/command";
import { learnUsage } from "./learn-import";
import { skillUsage } from "./skill";
import { localInstallationUsage } from "./local-installation";
import { CLI_VERSION } from "./shared";
import { tediUsage } from "./tedi";
import {
	agentUsage,
	authUsage,
	chatUsage,
	codeUsage,
	loginUsage,
	updateUsage,
} from "./usage";
import { workUsage } from "./work";
import { workflowUsage } from "./workflow";

export type CliCommandSurface =
	| "gateway-direct"
	| "gateway-recipe"
	| "home"
	| "local"
	| "mixed";
export type CliMutability = "read" | "write" | "mixed";
export type CliApproval = "none" | "explicit";
export type CliOutput = "human" | "json" | "ndjson";
export type CliAvailability = "shell" | "interactive";

export interface CliExitCode {
	code: number;
	meaning: string;
}

export interface TopLevelCommandSpec {
	aliases?: readonly string[];
	approval?: CliApproval;
	argHint?: string;
	help?: () => string;
	mutability: CliMutability;
	name: string;
	output: readonly CliOutput[];
	summary: string;
	surface: CliCommandSurface;
}

const HUMAN_JSON = ["human", "json"] as const;

/** Canonical shell command inventory. Aliases resolve to, but never duplicate, a row. */
export const TOP_LEVEL_COMMANDS: readonly TopLevelCommandSpec[] = [
	{
		name: "setup",
		surface: "local",
		summary: "Set up a local installation or coding agent hosts",
		mutability: "write",
		output: ["human"],
		help: () => `${localInstallationUsage()}\n${agentContextUsage}`,
	},
	{
		name: "dev",
		argHint: "[--inference --account-id <id>]",
		surface: "local",
		summary: "Run a checkout or resume the saved local installation",
		mutability: "write",
		output: ["human"],
		help: localInstallationUsage,
	},
	{
		name: "hooks",
		argHint: "<session-start|prompt-context|capture-stop|capture-reply|status>",
		surface: "mixed",
		summary: "Run a Tedix plugin hook for Claude Code or Codex",
		mutability: "mixed",
		output: ["json"],
		help: () => hooksUsage,
	},
	{
		name: "learn",
		argHint: "import-sessions|analyze-sessions [--dry-run]",
		surface: "mixed",
		summary: "Teach Tedix from your past local agent sessions",
		mutability: "write",
		output: HUMAN_JSON,
		help: () => learnUsage,
	},
	{
		name: "chat",
		aliases: ["start", "ask"],
		argHint: "[message]",
		surface: "home",
		summary: "Open Home or send one durable Home turn",
		mutability: "write",
		output: HUMAN_JSON,
		help: chatUsage,
	},
	{
		name: "login",
		argHint: "[org]",
		surface: "local",
		summary: "Sign in and save a workspace login",
		mutability: "write",
		output: ["human"],
		help: loginUsage,
	},
	{
		name: "logout",
		surface: "local",
		summary: "Remove one or all saved workspace logins",
		mutability: "write",
		output: ["human"],
	},
	{
		name: "auth",
		argHint: "status",
		surface: "local",
		summary: "Inspect the selected auth source and target",
		mutability: "read",
		output: HUMAN_JSON,
		help: authUsage,
	},
	{
		name: "agent",
		argHint: "<start|status|checkpoint|finish|reconcile>",
		surface: "mixed",
		summary: "Manage a governed external Agent-Session",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: agentUsage,
	},
	{
		name: "tedi",
		argHint: "<target> <verb>",
		surface: "mixed",
		summary: "Delegate to or inspect one durable digital worker",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: tediUsage,
	},
	{
		name: "code",
		argHint: '"<js>"',
		surface: "gateway-direct",
		summary: "Run stateless JavaScript on the org MCP gateway",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: codeUsage,
	},
	{
		name: "work",
		argHint: "<verb>",
		surface: "gateway-recipe",
		summary: "Coordinate governed Work Items",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: workUsage,
	},
	{
		name: "flow",
		argHint: "<verb>",
		surface: "gateway-recipe",
		summary: "Run a one-off multi-step plan against the MCP Gateway",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: flowUsage,
	},
	{
		name: "skill",
		argHint: "<verb>",
		surface: "gateway-recipe",
		summary: "List, inspect, or run organization skills",
		mutability: "mixed",
		approval: "explicit",
		output: HUMAN_JSON,
		help: skillUsage,
	},
	{
		name: "workflow",
		argHint: "<verb>",
		surface: "gateway-recipe",
		summary: "Inspect the execution engine behind automations and skill runs",
		mutability: "read",
		output: HUMAN_JSON,
		help: workflowUsage,
	},
	{
		name: "status",
		surface: "home",
		summary: "Show active runs, approvals, and delegations",
		mutability: "read",
		output: HUMAN_JSON,
	},
	{
		name: "orgs",
		surface: "gateway-recipe",
		summary: "List organizations for the current login",
		mutability: "read",
		output: HUMAN_JSON,
	},
	{
		name: "threads",
		surface: "local",
		summary: "List saved conversation threads",
		mutability: "read",
		output: ["human"],
	},
	{
		name: "workspaces",
		aliases: ["workspace"],
		surface: "local",
		summary: "List saved workspace logins",
		mutability: "read",
		output: HUMAN_JSON,
	},
	{
		name: "use",
		argHint: "<workspace>",
		surface: "local",
		summary: "Select the default workspace",
		mutability: "write",
		output: ["human"],
	},
	{
		// `surface: "local"` is the load-bearing part: this reads the git history
		// already on the caller's disk and calls no gateway, which is why it is
		// the one command with something true to say before an account has an
		// organization or a single Work Item in it.
		name: "who",
		argHint: "[--paths a,b] [--hours N]",
		surface: "local",
		summary: "Show which agents recently touched files in this repository",
		mutability: "read",
		output: HUMAN_JSON,
	},
	{
		name: "update",
		argHint: "[version]",
		surface: "local",
		summary: "Install or check a standalone CLI release",
		mutability: "mixed",
		output: HUMAN_JSON,
		help: updateUsage,
	},
	{
		name: "rollback",
		surface: "local",
		summary: "Restore the retained previous standalone CLI",
		mutability: "write",
		output: HUMAN_JSON,
		help: updateUsage,
	},
	{
		name: "help",
		argHint: "[command]",
		surface: "local",
		summary: "Show the human map or versioned machine help",
		mutability: "read",
		output: HUMAN_JSON,
	},
] as const;

const TOP_LEVEL_BY_NAME = new Map<string, TopLevelCommandSpec>(
	TOP_LEVEL_COMMANDS.flatMap((spec) =>
		[spec.name, ...(spec.aliases ?? [])].map(
			(name) => [name, spec] as [string, TopLevelCommandSpec],
		),
	),
);

export function findTopLevelCommand(
	name: string,
): TopLevelCommandSpec | undefined {
	return TOP_LEVEL_BY_NAME.get(name);
}

const DIRECT_WRITE_COMMANDS = new Set([
	"rename",
	"pin",
	"unpin",
	"delete",
	"approve",
	"reject",
	"cancel",
	"retry",
	"steer",
	"goal",
]);
const INTERACTIVE_OVERRIDES = new Set(["runs", "rename"]);
const INTERACTIVE_READ_COMMANDS = new Set([
	"help",
	"runs",
	"wait",
	"workspaces",
	"sessions",
]);

export type CliTargeting =
	| "local"
	| "account"
	| "organization"
	| "aggregate-or-organization"
	| "worker";

export interface CliHelpCommand {
	targeting: CliTargeting;
	/** Authored CLI syntax from the command's existing usage, not MCP capabilities. */
	usage: string | null;
	invocations: string[];
	aliases: string[];
	approval: CliApproval;
	availability: CliAvailability[];
	interactiveOnly: boolean;
	invocation: string;
	exitCodes: CliExitCode[];
	mutability: CliMutability;
	name: string;
	output: CliOutput[];
	summary: string;
	surface: CliCommandSurface;
}

function commandDetails(
	name: string,
	surface: CliCommandSurface,
): Pick<CliHelpCommand, "targeting" | "usage" | "invocations"> {
	const usage = findTopLevelCommand(name)?.help?.() ?? null;
	const invocations =
		usage
			?.split("\n")
			.map((line) => line.trim())
			.filter(
				(line) => line.startsWith(`tedix ${name} `) || line === `tedix ${name}`,
			) ?? [];
	const targeting: CliTargeting =
		name === "orgs"
			? "account"
			: name === "code"
				? "aggregate-or-organization"
				: name === "tedi"
					? "worker"
					: name === "threads" || surface !== "local"
						? "organization"
						: "local";
	return { targeting, usage, invocations: [...new Set(invocations)] };
}

/** One complete inventory powers human and machine help. */
export function commandInventory(): CliHelpCommand[] {
	const generalExitCodes: CliExitCode[] = [
		{ code: 0, meaning: "Command completed successfully" },
		{ code: 1, meaning: "CLI usage, authentication, or network error" },
	];
	const homeTurnExitCodes: CliExitCode[] = [
		...generalExitCodes,
		{ code: 2, meaning: "Run failed or canceled, or a write was declined" },
		{
			code: 3,
			meaning: "Poll budget expired while the server run remained active",
		},
	];
	const shell = [
		...TOP_LEVEL_COMMANDS.map((spec): CliHelpCommand => ({
			...commandDetails(spec.name, spec.surface),
			name: spec.name,
			aliases: [...(spec.aliases ?? [])],
			invocation: `tedix ${spec.name}${spec.argHint ? ` ${spec.argHint}` : ""}`,
			summary: spec.summary,
			surface: spec.surface,
			availability: ["shell"],
			interactiveOnly: false,
			exitCodes: spec.name === "chat" ? homeTurnExitCodes : generalExitCodes,
			mutability: spec.mutability,
			approval: spec.approval ?? "none",
			output: [...spec.output],
		})),
		...COMMANDS.map((spec): CliHelpCommand => ({
			...commandDetails(spec.name, "home"),
			name: spec.name,
			aliases: [...(spec.aliases ?? [])],
			invocation: `tedix ${spec.name}${spec.argHint ? ` ${spec.argHint}` : ""}`,
			summary: spec.summary,
			surface: "home",
			availability: INTERACTIVE_OVERRIDES.has(spec.name)
				? ["shell"]
				: ["shell", "interactive"],
			interactiveOnly: false,
			exitCodes:
				spec.name === "tail"
					? [
							...generalExitCodes,
							{ code: 130, meaning: "Event stream interrupted by SIGINT" },
						]
					: generalExitCodes,
			mutability: DIRECT_WRITE_COMMANDS.has(spec.name) ? "write" : "read",
			approval:
				spec.name === "approve" || spec.name === "reject" ? "explicit" : "none",
			output: spec.name === "tail" ? ["human", "ndjson"] : ["human", "json"],
		})),
	];
	const interactiveOnly = interactiveSlashCommands()
		.filter((row) => row.source === "interactive")
		.map((row): CliHelpCommand => ({
			targeting: "organization",
			usage: null,
			invocations: [],
			name: row.name,
			aliases: [],
			invocation: `/${row.name}${row.argHint ? ` ${row.argHint}` : ""}`,
			summary: row.description,
			surface: "home",
			availability: ["interactive"],
			interactiveOnly: true,
			exitCodes: generalExitCodes,
			mutability: INTERACTIVE_READ_COMMANDS.has(row.name) ? "read" : "write",
			approval: "none",
			output: ["human"],
		}));
	return [...shell, ...interactiveOnly];
}

export const CLI_HELP_SCHEMA_VERSION = "tedix.cli.help.v1";

export interface CliHelpDocument {
	cliVersion: string;
	commands: CliHelpCommand[];
	targeting: {
		workspaceOption: string;
		organizationOption: string;
		organizationEnvironment: string;
		precedence: string;
		enforcement: string;
	};
	permissions: {
		availableConnectScopes: readonly string[];
		selection: string;
		enforcement: string;
	};
	dynamicAuthority: { description: string; discovery: string };
	program: "tedix";
	query: { command: string | null };
	schemaVersion: typeof CLI_HELP_SCHEMA_VERSION;
}

export function machineHelp(command?: string): CliHelpDocument {
	const inventory = commandInventory();
	let commands = inventory;
	let canonical: string | null = null;
	if (command) {
		const match = inventory.find(
			(row) =>
				!row.interactiveOnly &&
				(row.name === command || row.aliases.includes(command)),
		);
		if (!match) {
			throw new Error(
				`Unknown help topic "${command}". Run \`tedix help --json\` for the command inventory.`,
			);
		}
		commands = [match];
		canonical = match.name;
	}
	return {
		schemaVersion: CLI_HELP_SCHEMA_VERSION,
		cliVersion: CLI_VERSION,
		program: "tedix",
		query: { command: canonical },
		targeting: {
			workspaceOption: "-w, --workspace <profile>",
			organizationOption: "--organization <target>",
			organizationEnvironment: "TEDIX_ORGANIZATION",
			precedence:
				"Explicit organization option overrides the terminal environment; otherwise one selected organization resolves automatically. Context bind/connect pin an exact selected organization ID independently.",
			enforcement:
				"A target selects where a command runs. The gateway checks live consent, membership and permissions; targeting grants no access.",
		},
		permissions: {
			availableConnectScopes: HUMAN_CONNECT_CONSENT_SCOPES,
			selection:
				"Ordinary Connect login offers these permissions and initially selects reads. Explicit profiles restrict the request; auth status reports the actual grant.",
			enforcement:
				"Reads inspect data; writes change it; administration manages it. Connected-app permissions govern linked providers. Runtime discovery and authorization remain authoritative for each tool.",
		},
		dynamicAuthority: {
			discovery:
				"discover.search({ query, limit: 1, includeParameters: true })",
			description:
				"Runtime MCP capabilities are dynamic; discover.search is authoritative, not this CLI command inventory.",
		},
		commands,
	};
}

function rows(commands: CliHelpCommand[]): string[] {
	return commands.flatMap((command) => {
		const aliases = command.aliases.length
			? ` (aliases: ${command.aliases.join(", ")})`
			: "";
		const invocation = `${command.invocation}${aliases}`;
		return invocation.length <= 34
			? [`  ${invocation.padEnd(36)}${command.summary}`]
			: [`  ${invocation}`, `      ${command.summary}`];
	});
}

/** Compact root help: orientation first, with details progressively disclosed. */
export function rootHelp(): string {
	return [
		"Tedix CLI — work with your digital workers",
		"A small program on your machine (public beta). Tedix Cloud is an invited beta.",
		"",
		"Get started:",
		"  tedix login                          Choose organizations and permissions",
		"  tedix                                Open a conversation",
		'  tedix ask "<message>"                Send a message and wait for the result',
		"  tedix status                         Check active work and approvals",
		"",
		"Work and automate:",
		"  tedix work <verb>                    Coordinate Work Items",
		"  tedix tedi <target> <verb>           Work with a specific digital worker",
		'  tedix code "<js>"                    Run a direct MCP Gateway operation',
		"  tedix flow run --file <plan.ts>      Run a one-off sequence of operations",
		"  tedix skill <verb>                   Find or run a reusable organization skill",
		"  tedix workflow <verb>                Inspect the execution engine behind automations",
		"",
		"Follow up:",
		"  tedix run <id>                       Read a run result",
		"  tedix approve <id>                   Approve a pending action",
		"  tedix cancel <id>                    Cancel a run",
		"  tedix auth status                    Check your workspace and connection",
		"",
		"Common options:",
		"  -w, --workspace <name>               Choose a saved connection profile",
		"  --organization <target>             Choose an authorized organization",
		"  --json                               Print machine-readable output",
		"  --no-color                           Disable colors",
		"  -h, --help                           Show help",
		"  -v, --version                        Print the CLI version",
		"",
		"More help:",
		"  tedix <command> --help               Options and examples for one command",
		"  tedix help --all                     All commands, including setup and dev",
		"  tedix help --json [command]          Machine-readable command inventory",
		"  tedix help exit-codes                Exit status for scripts",
		"",
		"Use --no-poll with ask to return after dispatch; the run continues on the server.",
		"Set TEDIX_ORGANIZATION for this terminal; --organization overrides it.",
		"Global options may appear before or after the command.",
	].join("\n");
}

/** Complete human command map, including interactive-only slash commands. */
export function commandMap(): string {
	const inventory = commandInventory();
	const shell = inventory.filter((row) => !row.interactiveOnly);
	const interactive = inventory.filter((row) => row.interactiveOnly);
	return [
		"Tedix CLI command map",
		"",
		"Execution: Home preserves conversations; code calls the gateway directly.",
		"Recipes reuse gateway calls; tedi targets one worker. Local commands manage this machine.",
		"Discover dynamic gateway tools through code: discover.search({ query, limit }).",
		"Add includeParameters: true when you need their exact input schema.",
		"",
		"Shell commands:",
		...rows(shell),
		"",
		"Interactive-only slash commands (may override a same-named shell verb):",
		...rows(interactive),
		"",
		"Use `tedix <command> --help` for focused details.",
		"Use `tedix help --json [command]` for the versioned machine schema.",
		"Dynamic MCP tools are discovered at runtime with discover.search().",
	].join("\n");
}

export function exitCodeHelp(): string {
	return `Tedix CLI exit codes

General:
  0  Command completed successfully
  1  CLI usage, authentication, or network error

Home turns (tedix, chat, ask, and chat -p):
  2  Run failed/canceled, or a requested write was declined
  3  Poll budget expired while the server run remained active; this is not a failure

Streaming:
  130  A tail event stream was interrupted with SIGINT

With exit 3, follow up with \`tedix run <homeRunId>\`.
Use \`tedix help --json [command]\` for command-scoped exit-code metadata.
`;
}

export function topLevelHelp(name: string): string {
	const topLevel = findTopLevelCommand(name);
	if (topLevel?.help) return topLevel.help();
	const direct = COMMANDS.find(
		(command) => command.name === name || command.aliases?.includes(name),
	);
	const command = topLevel
		? commandInventory().find(
				(row) => !row.interactiveOnly && row.name === topLevel.name,
			)
		: direct
			? commandInventory().find(
					(row) => !row.interactiveOnly && row.name === direct.name,
				)
			: undefined;
	if (!command) return rootHelp();
	return [
		command.invocation,
		"",
		command.summary,
		"",
		`Surface: ${command.surface}`,
		`Output: ${command.output.join(", ")}`,
		`Mutability: ${command.mutability}`,
		"",
		"Options:",
		"  -w, --workspace <name>  Use a saved workspace",
		"  --json                  Print machine-readable output when supported",
		"  -h, --help              Show this help",
		"",
		"Run `tedix help --json " + command.name + "` for machine metadata.",
	].join("\n");
}
