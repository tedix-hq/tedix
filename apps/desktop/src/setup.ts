import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { type CliState, manageCli, readCli, restoreCli } from "./cli";
import type { LocalModelPreferences } from "./local-model-client";
import { log } from "./log";
import { runnersPath } from "./runners-file";
import {
	configDir,
	findCommand,
	findTedix,
	lastLine,
	refreshShellPath,
	run,
} from "./shell";
import { type Connection, toolConnection } from "./tool-connection";

/**
 * Tools that cannot say whether they are signed in to Tedix (Devin) are
 * remembered as signed in once their own sign-in finished here.
 */
const signInsPath = () => join(configDir(), "desktop-sign-ins.json");
function signedInHere(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(signInsPath(), "utf8")) as Record<
			string,
			string
		>;
	} catch {
		return {};
	}
}
function rememberSignIn(toolId: string): void {
	try {
		writeFileSync(
			signInsPath(),
			JSON.stringify({ ...signedInHere(), [toolId]: new Date().toISOString() }),
		);
	} catch (error) {
		log(`setup: could not remember the ${toolId} sign-in: ${String(error)}`);
	}
}

const CONNECT_URL = "https://connect.mcp.tedix.dev/mcp";

/**
 * One coding tool the checklist knows. Adding a tool is one entry here.
 * `status` is the name `tedix setup agents --status --json` reports it under
 * and `add` the flag that adds Tedix to it. `connection` asks the tool itself
 * whether its Tedix connection is signed in, `signIn` is the tool's own
 * command that signs it in through the browser, and `signInSay` says what
 * happens instead when that only works on the tool's own screen.
 */
interface Tool {
	id: string;
	name: string;
	binary: string;
	folder: string;
	executor: string;
	status?: string;
	add?: string;
	/** Tedix can also be there from the tool's own plugin list; true when it is. */
	hasTedix?: (command: string) => Promise<boolean>;
	connection?: (command: string) => Promise<Connection>;
	signIn?: string[];
	/** True when this version of the tool has the `signIn` command. */
	signInWorks?: (command: string) => Promise<boolean>;
	signInSay?: string;
	say?: string;
	/** The tool's own sign-in to its account, through the browser. */
	accountSignIn?: string[];
}
const home = homedir();
/**
 * Codex lists and signs in only the servers in its own settings, not the one
 * the Tedix plugin brings. Naming the same server and address for one command
 * makes both work on the sign-in the plugin uses, and changes no settings.
 */
const CODEX_TEDIX = ["-c", `mcp_servers.tedix.url="${CONNECT_URL}"`];
const TOOLS: Tool[] = [
	{
		id: "claude",
		name: "Claude Code",
		binary: "claude",
		folder: join(home, ".claude"),
		executor: "claude-code",
		status: "claude",
		add: "--claude",
		// The plugin's server is called plugin:tedix:tedix; this checks only it.
		connection: async (command) => {
			const { output } = await run(
				command,
				["mcp", "get", "plugin:tedix:tedix"],
				{ timeoutMs: 45_000 },
			);
			if (/Needs authentication/i.test(output)) return "signed-out";
			return /Status:.*Connected/i.test(output) ? "signed-in" : "unknown";
		},
		signIn: ["mcp", "login", "plugin:tedix:tedix"],
		accountSignIn: ["auth", "login"],
		signInWorks: async (command) =>
			(await run(command, ["mcp", "login", "--help"], { timeoutMs: 20_000 }))
				.ok,
		signInSay:
			"Claude Code asks you to sign in to Tedix the first time you use it: type /mcp, choose tedix, then Authenticate.",
	},
	{
		id: "codex",
		name: "Codex",
		binary: "codex",
		folder: process.env.CODEX_HOME || join(home, ".codex"),
		executor: "codex",
		status: "codex",
		add: "--codex",
		connection: async (command) => {
			const { output } = await run(
				command,
				["mcp", "list", "--json", ...CODEX_TEDIX],
				{ timeoutMs: 45_000 },
			);
			try {
				const state = (
					JSON.parse(output) as { name?: string; auth_status?: string }[]
				).find((server) => server.name === "tedix")?.auth_status;
				if (state === "not_logged_in") return "signed-out";
				return state === "o_auth" || state === "bearer_token"
					? "signed-in"
					: "unknown";
			} catch {
				return "unknown";
			}
		},
		signIn: ["mcp", "login", "tedix", ...CODEX_TEDIX],
		accountSignIn: ["login"],
		signInSay: "Codex asks you to sign in to Tedix the first time you use it.",
	},
	{
		id: "devin",
		name: "Devin",
		binary: "devin",
		folder: join(home, ".config", "devin"),
		executor: "devin",
		status: "devin",
		add: "--devin",
		hasTedix: async (command) => {
			const { output } = await run(command, ["mcp", "list", "--json"], {
				timeoutMs: 45_000,
			});
			try {
				return (JSON.parse(output) as { name?: string }[]).some(
					(server) => server.name === "tedix",
				);
			} catch {
				return false;
			}
		},
		signIn: ["mcp", "login", "tedix"],
		accountSignIn: ["auth", "login"],
		say: "Devin does not say whether it is signed in to Tedix. Sign in once; if Tedix already answers in Devin, you are done.",
	},
	{
		id: "opencode",
		name: "OpenCode",
		binary: "opencode",
		folder: join(home, ".config", "opencode"),
		executor: "opencode",
		status: "opencode",
		add: "--opencode",
		connection: async (command) => {
			const { output } = await run(command, ["mcp", "list"], {
				timeoutMs: 45_000,
			});
			// One block per server: "●  ✓ tedix connected", or "✗ tedix failed" and its error.
			const block =
				output
					.replace(/\x1b\[[0-9;]*m/g, "")
					.split("●")
					.find((part) => /^\s*\S+\s+tedix\s/.test(part)) ?? "";
			if (/\bconnected\b/.test(block)) return "signed-in";
			// A refused sign-in (401/403) is fixed by signing in again.
			return /needs auth|\b40[13]\b/i.test(block) ? "signed-out" : "unknown";
		},
		signIn: ["mcp", "auth", "tedix"],
		say: "Signing in replaces the Tedix sign-in OpenCode saved before. Tedix cannot check a read inside OpenCode from here; ask OpenCode about your Tedix work to try it.",
	},
];

/**
 * The Claude desktop app brings its own Claude Code for its Code tab, in
 * ~/Library/Application Support/Claude/claude-code/<version>/<id>/claude.app.
 * The newest one counts as Claude Code when none is on the PATH.
 */
function bundledClaudeCode(): string | undefined {
	const root = join(
		home,
		"Library",
		"Application Support",
		"Claude",
		"claude-code",
	);
	try {
		const versions = readdirSync(root)
			.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.reverse();
		for (const version of versions)
			for (const id of readdirSync(join(root, version))) {
				const file = join(
					root,
					version,
					id,
					"claude.app",
					"Contents",
					"MacOS",
					"claude",
				);
				if (existsSync(file)) return file;
			}
	} catch {
		/* No Claude app, or no Code tab yet. */
	}
	return undefined;
}

/** The command that runs a tool: on the PATH, else one an app brings along. */
function commandFor(tool: Tool): string | undefined {
	return (
		findCommand(tool.binary) ??
		(tool.id === "claude" ? bundledClaudeCode() : undefined)
	);
}

/** The chat desktop apps on this Mac; they need no terminal. */
export interface ChatApps {
	claude: boolean;
	chatgpt: boolean;
}
function appInstalled(names: string[]): boolean {
	return names.some((name) =>
		[join("/Applications", name), join(home, "Applications", name)].some(
			(path) => existsSync(path),
		),
	);
}
export function chatApps(): ChatApps {
	return {
		claude: appInstalled(["Claude.app"]),
		chatgpt: appInstalled(["ChatGPT.app"]),
	};
}

export interface ToolRow {
	id: string;
	name: string;
	executor: string;
	/** `found`: its command works. `no-command`: only its settings folder is there. */
	found: "found" | "no-command" | "absent";
	/**
	 * Whether Tedix is added to it. `unknown`: it could not be checked and
	 * `note` says why. `unsupported`: Tedix cannot be added to this tool yet.
	 */
	tedix: "added" | "missing" | "unknown" | "unsupported" | "checking";
	/** The version of Tedix in the tool, when the tool reports one. */
	version: string;
	/** False when Tedix is added but switched off in the tool. */
	enabled: boolean;
	/** Whether the tool's own connection to Tedix is signed in. */
	connection: Connection | "checking";
	account: Connection;
	readVerified: boolean;
	hookTrust: "trusted" | "untrusted" | "unknown";
	/** Tedix can be added to this tool from here. */
	canAdd: boolean;
	/** The tool has a command that signs it in to Tedix through the browser. */
	canSignIn: boolean;
	/** The app can sign the tool in to its own account. */
	canSignInAccount: boolean;
	/** One sentence on what is wrong or what happens next. */
	note: string;
}

/** Who is signed in to Tedix in the app's own window. */
export interface AppSignIn {
	state: "in" | "out" | "unknown";
	name: string;
	email: string;
	/** A browser sign-in was started and is not finished yet. */
	waiting: boolean;
}

/** What a step is doing or how its last run ended. */
export interface StepRun {
	working?: string;
	error?: string;
	/** The lines the step printed, for "Copy details". Never holds addresses or keys. */
	details?: string;
	done?: string;
	/** The sign-in address, to copy when the browser did not open. */
	address?: string;
}

/**
 * Which coding tool takes which kind of task, in the order runners read the
 * rules. `tools` are executor ids, first choice first.
 */
export interface Routing {
	rules: { kind: string; tools: string[] }[];
	/** The file on this Mac the rules come from; null for Tedix's default. */
	file: string | null;
	/** When that file last changed, ISO time. */
	changedAt?: string;
	/**
	 * Tools held back by their own limit, by executor id: why, in plain
	 * words without the tool's name. Absent with older command-line tools.
	 */
	limits?: Record<string, string>;
	/**
	 * What each tool reports about its plan and limits, by executor id:
	 * the plain summary and whether a limit is nearly used up.
	 */
	usage?: Record<string, { text: string; near: boolean }>;
	/**
	 * When Clef picks the tool for each task: what each tool is good at, by
	 * executor id. Absent when the rules decide or no strengths are set.
	 */
	clef?: { tool: string; strengths: string }[];
}

export interface SessionProject {
	id: string;
	name: string;
	/** When the project last changed, for sorting; ISO time or empty. */
	updatedAt: string;
	on: Record<string, boolean>;
}

/** The coding tools whose sessions can show in Tedix, by executor id. */
export const SESSION_TOOLS = ["claude-code", "codex", "devin", "opencode"];

export interface SetupState {
	cli: CliState;
	/** Tedix in the app's window. */
	app: AppSignIn;
	/** The command-line tool on this Mac is signed in. */
	signedIn: boolean;
	/**
	 * The one live check that the command-line tool reaches Tedix with its
	 * sign-in. `unavailable`: Tedix was slow or busy, which says nothing about
	 * the sign-in.
	 */
	reach: Reach;
	/** What the live check printed when it did not pass, for "Copy details". */
	reachDetail: string;
	organization: string;
	tools: ToolRow[];
	/** Tedix projects; `on` says, per coding tool, whether its sessions show there. */
	sessionProjects: SessionProject[];
	/** True once session reporting was ever chosen on this Mac. */
	sessionsChosen: boolean;
	repo: string;
	steps: Record<string, StepRun>;
	/** True while the command-line tool or the sign-in is still to do. */
	open: boolean;
	chatApps: ChatApps;
	/**
	 * Which tool takes which tasks, one plain sentence per rule, and the file
	 * runners read it from. Undefined when the command-line tool cannot say.
	 */
	routing?: Routing;
}

interface Settings {
	host?: string;
	repo?: string;
	localModels?: LocalModelPreferences;
	appearance?: "system" | "light" | "dark";
}
const settingsFile = () => join(app.getPath("userData"), "settings.json");
export function settings(): Settings {
	try {
		return JSON.parse(readFileSync(settingsFile(), "utf8")) as Settings;
	} catch {
		return {};
	}
}
export function saveSettings(change: Settings): void {
	writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ...change }));
}

type Reach = "unchecked" | "checking" | "ok" | "signed-out" | "unavailable";

let cli: CliState = { kind: "missing", version: "", canRestore: false };
let appSignIn: AppSignIn = {
	state: "unknown",
	name: "",
	email: "",
	waiting: false,
};
let signedIn = false;
let organizations: string[] = [];
let tenant = "";
let sessionProjects: SetupState["sessionProjects"] = [];
let sessionsChosen = false;
let routing: SetupState["routing"];
let sessionOrganization = "";
let reach: Reach = "unchecked";
let reachDetail = "";
/** A live check was asked for while a step was running; it runs afterwards. */
let reachWanted = false;
let agentStatus:
	| { hosts: Record<string, Record<string, unknown>> }
	| { problem: string }
	| undefined;
/** What each tool itself said, by tool id. Absent while it is being asked. */
let toolFacts: Record<
	string,
	{ hasTedix: boolean; connection: Connection; signInWorks: boolean }
> = {};
const steps: Record<string, StepRun> = {};
const stops: Record<string, () => void> = {};
/** Steps the person stopped; they end without an error. */
const cancelled = new Set<string>();
let changed: () => void = () => {};
export function onSetupChange(listener: () => void): void {
	changed = listener;
}

/** The main window tells the checklist who is signed in to Tedix in the app. */
export function setAppSignIn(next: AppSignIn): void {
	if (JSON.stringify(next) === JSON.stringify(appSignIn)) return;
	appSignIn = next;
	changed();
}

const working = () => Object.values(steps).some((ran) => ran.working);

/** Output lines with addresses removed, so the log and copied details hold no sign-in links. */
const safe = (line: string) => line.replace(/https?:\/\/\S+/g, "(address)");

function tedix(args: string[], options: Parameters<typeof run>[2] = {}) {
	const file = findTedix();
	if (!file)
		return Promise.resolve({
			ok: false,
			output: "The Tedix command-line tool is not installed.",
		});
	return run(file, args, options);
}

/**
 * Runs one step: shows its latest output line while it works, then either
 * its result or the real reason it failed. Each step is logged.
 */
async function step(
	key: string,
	work: (say: (line: string) => void, lines: string[]) => Promise<string>,
): Promise<void> {
	if (steps[key]?.working) return;
	const lines: string[] = [];
	const say = (line: string) => {
		if (/^https?:\/\//.test(line) && !key.startsWith("add:")) {
			steps[key] = { ...steps[key], address: line };
			return changed();
		}
		lines.push(safe(line));
		steps[key] = { ...steps[key], working: safe(line).slice(0, 200) };
		changed();
	};
	steps[key] = { working: "Starting…" };
	changed();
	log(`setup: ${key} started`);
	try {
		const done = await work(say, lines);
		steps[key] = { done };
		log(`setup: ${key} done (${done})`);
	} catch (error) {
		if (cancelled.delete(key)) {
			delete steps[key];
			delete stops[key];
			log(`setup: ${key} cancelled`);
			return changed();
		}
		const reason = safe(error instanceof Error ? error.message : String(error));
		steps[key] = {
			error: reason,
			details: [`Step: ${key}`, ...lines.slice(-40), reason].join("\n"),
		};
		log(`setup: ${key} failed (${reason})`);
	}
	delete stops[key];
	changed();
	if (reachWanted && !working()) void checkReach();
}

/**
 * Waits for a command inside a step. When it fails, throws the line that
 * says why: the first one that reports a failure, else the last one.
 */
async function must(
	command: Promise<{ ok: boolean; output: string }>,
): Promise<string> {
	const result = await command;
	if (result.ok) return result.output;
	const lines = safe(result.output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const reason =
		lines.find((line) => /✘|failed|error|could not|timed out/i.test(line)) ??
		lines.at(-1);
	throw new Error(
		reason?.slice(0, 400) ?? "The command failed without a message.",
	);
}

async function readSignIn(): Promise<void> {
	const result = await tedix(["-w", "connect", "auth", "status", "--json"], {
		timeoutMs: 20_000,
	});
	interface Login {
		refreshExpiresAt?: string;
		accessToken?: { dct?: string; selectedOrganizations?: string[] };
	}
	let now = false;
	let login: Login | undefined;
	try {
		// Only these fields are read; the output holds no tokens.
		const status = JSON.parse(result.output) as {
			wouldUse?: string;
			storedLogin?: Login | null;
		};
		login = status.storedLogin ?? undefined;
		const expires = login?.refreshExpiresAt;
		const expired = expires !== undefined && Date.parse(expires) < Date.now();
		now = status.wouldUse === "stored-login" && !expired;
	} catch {
		/* Not signed in, or no command-line tool. */
	}
	signedIn = now;
	tenant = login?.accessToken?.dct ?? "";
	organizations = login?.accessToken?.selectedOrganizations ?? [];
}

/**
 * The organization new runners work for: the one the Tedix OS view is on
 * when the sign-in covers it, else the one the sign-in was made in.
 */
function organization(): string {
	const slug = /^([a-z0-9-]+)\.os\.tedix\.dev$/.exec(
		settings().host ?? "",
	)?.[1];
	const match = slug && organizations.find((id) => id === `org_${slug}`);
	return match || tenant || organizations[0] || "";
}

/** A kind of task in plain words, from what a routing rule matches. */
function taskKind(rule: {
	tags?: unknown;
	sizes?: unknown;
	risks?: unknown;
}): string {
	const list = (value: unknown) =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];
	const tags = list(rule.tags);
	const sizes = list(rule.sizes);
	const risks = list(rule.risks);
	if (!tags.length && !sizes.length && !risks.length) return "Everything else";
	if (risks.length || sizes.includes("large")) return "Large or risky tasks";
	if (
		sizes.includes("small") ||
		tags.some((tag) => ["mechanical", "formatting", "docs"].includes(tag))
	)
		return "Small routine tasks";
	return `Tasks about ${tags.slice(0, 2).join(" or ")}`;
}

/** Reads which tool takes which tasks; older command-line tools cannot say. */
async function readRouting(): Promise<void> {
	const result = await tedix(["lane", "routing", "--json"], {
		timeoutMs: 20_000,
	});
	try {
		const parsed = JSON.parse(result.output) as {
			path?: unknown;
			policy?: { rules?: unknown; decide?: unknown; tools?: unknown };
			tools?: unknown;
		};
		const parsedTools = Array.isArray(parsed.tools) ? parsed.tools : [];
		const limits = Object.fromEntries(
			parsedTools
				.filter(
					(tool: {
						available?: unknown;
						executor?: unknown;
						description?: unknown;
					}) =>
						tool?.available === false &&
						typeof tool.executor === "string" &&
						typeof tool.description === "string",
				)
				.map((tool: { executor: string; description: string }) => {
					// "Codex: out of credits…" → "Out of credits…"
					const why = tool.description.replace(/^[^:]+:\s*/, "");
					return [tool.executor, why.charAt(0).toUpperCase() + why.slice(1)];
				}),
		);
		const usage = Object.fromEntries(
			parsedTools
				.filter(
					(tool: { executor?: unknown; usage?: unknown }) =>
						typeof tool?.executor === "string" &&
						typeof tool.usage === "string" &&
						tool.usage.length > 0,
				)
				.map(
					(tool: { executor: string; usage: string; nearLimit?: unknown }) => [
						tool.executor,
						{ text: tool.usage, near: tool.nearLimit === true },
					],
				),
		);
		const rules = (
			Array.isArray(parsed.policy?.rules) ? parsed.policy.rules : []
		)
			.map((rule: Record<string, unknown>) => ({
				kind: taskKind(rule),
				tools: (Array.isArray(rule.routes) ? rule.routes : [])
					.map((route: { executor?: unknown }) => String(route?.executor ?? ""))
					.filter(Boolean),
			}))
			.filter((rule) => rule.tools.length);
		const file = typeof parsed.path === "string" ? parsed.path : null;
		let changedAt: string | undefined;
		try {
			if (file) changedAt = statSync(file).mtime.toISOString();
		} catch {
			/* Not there. */
		}
		const strengths = Object.entries(
			parsed.policy?.tools && typeof parsed.policy.tools === "object"
				? (parsed.policy.tools as Record<string, { strengths?: unknown }>)
				: {},
		)
			.map(([tool, value]) => ({
				tool,
				strengths: Array.isArray(value?.strengths)
					? value.strengths
							.filter((s): s is string => typeof s === "string")
							.join(", ")
					: typeof value?.strengths === "string"
						? value.strengths
						: "",
			}))
			.filter((entry) => entry.strengths);
		const clef =
			parsed.policy?.decide !== "rules" && strengths.length >= 2
				? strengths
				: undefined;
		routing = rules.length
			? {
					rules,
					file,
					changedAt,
					limits,
					usage: Object.keys(usage).length ? usage : undefined,
					clef,
				}
			: undefined;
	} catch {
		routing = undefined;
	}
}

/** The running read of the tools' status, so two refreshes share one. */
let readingStatus: Promise<void> | undefined;
function readAgentStatus(): Promise<void> {
	readingStatus ??= readAgentStatusNow().finally(() => {
		readingStatus = undefined;
	});
	return readingStatus;
}

async function readAgentStatusNow(): Promise<void> {
	const from = Date.now();
	// A failed read of the facts or the routing must not keep every row on
	// "Checking…": the tools' own status still arrives.
	const [result] = await Promise.all([
		tedix(["setup", "agents", "--status", "--json"], { timeoutMs: 150_000 }),
		readToolFacts().catch((error: unknown) =>
			log(`setup: tool facts not read (${String(error)})`),
		),
		readRouting().catch((error: unknown) =>
			log(`setup: routing not read (${String(error)})`),
		),
	]);
	log(
		`setup: coding tools checked in ${Math.round((Date.now() - from) / 1000)} s${result.ok ? "" : ` (${lastLine(safe(result.output)).slice(0, 160)})`}`,
	);
	try {
		const parsed = JSON.parse(result.output) as {
			hosts?: Record<string, unknown>[];
		};
		if (!Array.isArray(parsed.hosts)) throw new Error("no hosts");
		agentStatus = {
			hosts: Object.fromEntries(
				parsed.hosts.map((host) => [String(host.host), host]),
			),
		};
	} catch {
		agentStatus = {
			problem: findTedix()
				? "This version of the command-line tool cannot report it."
				: "Needs the command-line tool.",
		};
	}
	changed();
}

/** Asks each tool that is here what it knows about its own Tedix connection. */
async function readToolFacts(): Promise<void> {
	const facts: typeof toolFacts = {};
	await Promise.all(
		TOOLS.map(async (tool) => {
			const command = commandFor(tool);
			if (!command) return;
			const [hasTedix, connection, signInWorks] = await Promise.all([
				tool.hasTedix?.(command) ?? false,
				tool.connection?.(command) ?? ("unknown" as const),
				tool.signInWorks?.(command) ?? true,
			]);
			facts[tool.id] = { hasTedix, connection, signInWorks };
		}),
	);
	toolFacts = facts;
}

function toolRows(): ToolRow[] {
	return TOOLS.map((tool) => {
		const command = commandFor(tool);
		const found = command
			? "found"
			: existsSync(tool.folder)
				? "no-command"
				: "absent";
		const row: ToolRow = {
			id: tool.id,
			name: tool.name,
			executor: tool.executor,
			found,
			tedix: "unknown",
			version: "",
			enabled: true,
			connection: "unknown",
			account: "unknown",
			readVerified: false,
			hookTrust: "unknown",
			canAdd: false,
			canSignIn: false,
			canSignInAccount: false,
			note: "",
		};
		if (found === "absent") return row;
		if (found === "no-command") {
			row.note = `Its settings folder is here, but the ${tool.binary} command was not found. Install ${tool.name} again, then choose Check again.`;
			return row;
		}
		if (!tool.status) {
			row.tedix = "unsupported";
			row.note = tool.say ?? "";
			return row;
		}
		// A tool found after the last read of the facts still shows its status.
		const facts =
			toolFacts[tool.id] ??
			(agentStatus
				? { hasTedix: false, connection: "unknown" as const, signInWorks: true }
				: undefined);
		if (!agentStatus || !facts) {
			row.tedix = "checking";
			row.connection = "checking";
			return row;
		}
		if ("problem" in agentStatus) {
			row.note = agentStatus.problem;
			return row;
		}
		const host = agentStatus.hosts[tool.status];
		row.account =
			host?.account === "signed-in" || host?.account === "signed-out"
				? host.account
				: "unknown";
		const readAge =
			typeof host?.readVerifiedAt === "string"
				? Date.now() - Date.parse(host.readVerifiedAt)
				: NaN;
		row.readVerified = readAge >= 0 && readAge < 24 * 60 * 60_000;
		row.canSignInAccount = Boolean(tool.accountSignIn);
		row.hookTrust =
			host?.hookTrust === "trusted" || host?.hookTrust === "untrusted"
				? host.hookTrust
				: "unknown";
		if (host?.problem && !facts.hasTedix) {
			row.note = `${tool.name} did not answer: ${String(host.problem).split("\n")[0]!.slice(0, 200)}`;
			return row;
		}
		row.tedix =
			host?.installed === true || facts.hasTedix ? "added" : "missing";
		row.canAdd = Boolean(tool.add) && row.tedix === "missing";
		if (row.tedix !== "added") return row;
		row.version = typeof host?.version === "string" ? host.version : "";
		row.enabled = host?.enabled !== false;
		row.connection = toolConnection(
			tool.connection ? facts.connection : undefined,
			host?.signedIn,
			row.readVerified || Boolean(signedInHere()[tool.id]),
		);
		if (!row.enabled) {
			row.note = `Switch the Tedix plugin on in ${tool.name}, then choose Check again.`;
			return row;
		}
		// A tool can keep a stored sign-in that Tedix no longer accepts (Codex
		// lists it as signed in). When the read check says to sign in, the
		// sign-in it has does not work: offer Sign in again.
		if (/sign in/i.test(steps[`verify:${tool.id}`]?.error ?? ""))
			row.connection = "signed-out";
		if (row.account === "signed-out") return row;
		if (row.connection === "signed-in") return row;
		row.canSignIn = Boolean(tool.signIn) && facts.signInWorks;
		row.note = row.canSignIn ? (tool.say ?? "") : (tool.signInSay ?? "");
		return row;
	});
}

export function setupState(): SetupState {
	const tools = toolRows();
	return {
		cli,
		app: appSignIn,
		signedIn,
		reach,
		reachDetail,
		organization: organization(),
		tools,
		sessionProjects,
		sessionsChosen,
		routing,
		repo: settings().repo ?? "",
		steps,
		open: cli.kind === "missing" || !signedIn,
		chatApps: chatApps(),
	};
}

/**
 * The one live check: the command-line tool reaches Tedix with this sign-in.
 * It asks Tedix to describe itself, which Tedix refuses without a sign-in
 * and answers in about a second. A slow or busy Tedix is tried once more and
 * then reported as "could not check", never as a failed sign-in. It waits
 * while a step is running, because steps restart this Mac's runners.
 */
let checking: Promise<void> | undefined;
function checkReach(): Promise<void> {
	if (!signedIn) {
		reach = "unchecked";
		return Promise.resolve();
	}
	if (working()) {
		reachWanted = true;
		return Promise.resolve();
	}
	checking ??= (async () => {
		reachWanted = false;
		reach = "checking";
		changed();
		let output = "";
		for (let attempt = 0; attempt < 2 && reach === "checking"; attempt++) {
			if (attempt) await new Promise((resolve) => setTimeout(resolve, 3000));
			const result = await tedix(
				["-w", "connect", "mcp", "call", "server/discover"],
				{ timeoutMs: 20_000 },
			);
			output = safe(result.output);
			let answered = false;
			try {
				answered =
					result.ok &&
					Array.isArray(
						(JSON.parse(result.output) as { supportedVersions?: unknown })
							.supportedVersions,
					);
			} catch {
				/* Not the answer Tedix gives. */
			}
			if (answered) reach = "ok";
			else if (
				/\b401\b|not (logged|signed) in|tedix login|sign in again|invalid_grant|unauthori[sz]ed/i.test(
					output,
				)
			)
				reach = "signed-out";
		}
		if (reach === "checking") reach = "unavailable";
		reachDetail = reach === "ok" ? "" : output.trim().slice(-2000);
		log(
			`setup: live check ${
				reach === "ok"
					? "passed"
					: reach === "signed-out"
						? "says the command-line tool is not signed in"
						: `could not run (${lastLine(output) || "no answer"})`
			}`,
		);
		checking = undefined;
		changed();
	})();
	return checking;
}

/** Reads everything again. `deep` also asks the shell for its PATH and each tool for its state. */
export async function refreshSetup(deep: boolean): Promise<void> {
	if (deep) await refreshShellPath();
	cli = await readCli();
	const was = signedIn;
	await readSignIn();
	changed();
	if (deep || !agentStatus) void readAgentStatus();
	if (deep || (signedIn && !was) || sessionOrganization !== organization())
		void readSessionProjects();
	if (deep || (signedIn && !was)) void checkReach();
}

function classifySignIn(output: string): string {
	const reason = lastLine(safe(output));
	if (
		/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|offline/i.test(
			output,
		)
	)
		return `Tedix could not be reached. Check your internet connection. (${reason})`;
	if (/denied|refused|rejected|cancel/i.test(output))
		return `The sign-in was not approved in the browser. (${reason})`;
	return reason || "The sign-in did not finish.";
}

const ACTIONS = [
	"check",
	"manage-cli",
	"restore-cli",
	"sign-in",
	"app-sign-in",
	"cancel",
	"add",
	"connect",
	"verify",
	"trust-hooks",
	"run-tasks",
	"choose-folder",
	"sessions-on",
	"sessions-off",
	"account-sign-in",
] as const;
export type SetupAction = (typeof ACTIONS)[number];

/** What the checklist needs from the window: a folder chooser and the app's own sign-in. */
export interface SetupHost {
	chooseFolder: () => Promise<string | undefined>;
	appSignIn: () => Promise<void>;
	/** Starts this Mac's runners when none run; leaves running ones alone. */
	startRunnersIfStopped: () => Promise<void>;
}

async function readSessionProjects(): Promise<void> {
	if (
		Object.entries(steps).some(
			([key, ran]) => key.startsWith("sessions") && ran.working,
		)
	)
		return;
	const org = organization();
	sessionOrganization = org;
	sessionProjects = [];
	if (!signedIn || !org) return changed();
	await step("sessions", async () => {
		const selectors = ["--workspace", "connect", "--organization", org];
		const source = `async () => {
			const listed = [];
			for (let offset = 0; ; offset += 100) {
				const r = await projects.list_projects({limit: 100, offset});
				if (r?.ok === false || !Array.isArray(r?.data)) throw new Error("Could not list projects");
				listed.push(...r.data.filter(p => !p.archivedAt && p.status !== "archived" && p.status !== "done").map(p => ({id: p.id, name: p.name, updatedAt: String(p.updatedAt ?? p.createdAt ?? "")})));
				if (!r.pagination?.hasMore || !r.data.length) break;
			}
			return {projects: listed};
		}`;
		const [catalog, saved] = await Promise.all([
			must(
				tedix([...selectors, "code", source, "--json"], { timeoutMs: 60_000 }),
			),
			must(
				tedix(
					[
						...selectors,
						"setup",
						"agents",
						"context",
						"session-reporting",
						"--state",
						"show",
						"--json",
					],
					{ timeoutMs: 20_000 },
				),
			),
		]);
		const projects = (
			JSON.parse(catalog) as {
				projects: { id: string; name: string; updatedAt: string }[];
			}
		).projects;
		const choices = (
			JSON.parse(saved) as {
				projects: { projectId: string; enabled: boolean; harness?: string }[];
			}
		).projects;
		if (!Array.isArray(projects) || !Array.isArray(choices))
			throw new Error(
				"The command-line tool could not read session reporting. Update it and check again.",
			);
		// A tool's own choice wins over the choice for every tool (the CLI's rule).
		const on = (projectId: string, harness: string) => {
			const rows = choices.filter((choice) => choice.projectId === projectId);
			const own = rows.find((choice) => choice.harness === harness);
			return own
				? own.enabled
				: rows.some((choice) => !choice.harness && choice.enabled);
		};
		if (org === organization()) {
			sessionsChosen = choices.length > 0;
			sessionProjects = projects
				.map((project) => ({
					...project,
					on: Object.fromEntries(
						SESSION_TOOLS.map((harness) => [harness, on(project.id, harness)]),
					),
				}))
				.sort(
					(a, b) =>
						b.updatedAt.localeCompare(a.updatedAt) ||
						a.name.localeCompare(b.name),
				);
		}
		return "";
	});
}

/** Carries out one button of the checklist. */
export async function setupAction(
	action: SetupAction,
	id: string,
	{ chooseFolder, appSignIn: signInToApp, startRunnersIfStopped }: SetupHost,
): Promise<void> {
	if (!ACTIONS.includes(action)) return;
	const tool = TOOLS.find((item) => item.id === id);
	if (action === "check") return refreshSetup(true);
	if (action === "app-sign-in") return signInToApp();
	if (action === "cancel") {
		if (stops[id]) cancelled.add(id);
		return stops[id]?.();
	}
	if (action === "choose-folder") {
		const repo = await chooseFolder();
		if (repo) saveSettings({ repo });
		return changed();
	}
	if (action === "manage-cli" || action === "restore-cli") {
		await step("cli", (say) =>
			action === "manage-cli" ? manageCli(say) : restoreCli(say),
		);
		return refreshSetup(false);
	}
	if (action === "sign-in") {
		await step("sign-in", async (say) => {
			const result = await tedix(["-w", "connect", "login"], {
				env: { TEDIX_DESKTOP_APP: "1" },
				onLine: say,
				onStart: (stop) => {
					stops["sign-in"] = stop;
				},
				timeoutMs: 15 * 60_000,
			});
			if (!result.ok) throw new Error(classifySignIn(result.output));
			return "The command-line tool is signed in.";
		});
		return refreshSetup(false);
	}
	if (action === "sessions-on" || action === "sessions-off") {
		// `id` is "<tool or *>|<project ids>", and "|<project ids>" to first
		// switch those on for every tool (the default nobody chose yet).
		const [who = "", list = "", first = ""] = id.split("|");
		const defaults = sessionProjects.filter((project) =>
			first.split(",").includes(project.id),
		);
		const org = organization();
		const tools = who === "*" ? SESSION_TOOLS : [who];
		const projects = sessionProjects.filter((project) =>
			list.split(",").includes(project.id),
		);
		if (
			!projects.length ||
			!tools.every((tool) => SESSION_TOOLS.includes(tool)) ||
			!signedIn ||
			org !== sessionOrganization
		)
			return;
		const on = action === "sessions-on";
		await step(`sessions:${who}`, async () => {
			if (defaults.length)
				for (const tool of SESSION_TOOLS) {
					await must(
						tedix(
							[
								"--workspace",
								"connect",
								"--organization",
								org,
								"setup",
								"agents",
								"context",
								"session-reporting",
								"--state",
								"on",
								"--project",
								defaults.map((project) => project.id).join(","),
								"--harness",
								tool,
								"--json",
							],
							{ timeoutMs: 30_000 },
						),
					);
					for (const project of defaults) project.on[tool] = true;
				}
			for (const tool of tools)
				await must(
					tedix(
						[
							"--workspace",
							"connect",
							"--organization",
							org,
							"setup",
							"agents",
							"context",
							"session-reporting",
							"--state",
							on ? "on" : "off",
							"--project",
							projects.map((project) => project.id).join(","),
							"--harness",
							tool,
							"--json",
						],
						{ timeoutMs: 30_000 },
					),
				);
			if (org === organization()) {
				sessionsChosen = true;
				for (const project of projects)
					for (const tool of tools) project.on[tool] = on;
			}
			return "";
		});
		return;
	}
	if (!tool) return;
	const command = commandFor(tool);
	if (action === "trust-hooks" && tool.id === "codex" && command) {
		await step("hooks:codex", async (say) => {
			// Open the real TUI view; trust remains a click made by the person.
			const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
			const navigation =
				'set timeout 60\nspawn -noecho -- $env(TEDIX_SETUP_CODEX) -C $env(HOME) -a on-request -s read-only\nexpect {\n-re {state=idle:app=codex} {send -- "/hooks\\r"}\ntimeout {}\neof {exit}\n}\ninteract';
			const launch = `TEDIX_SETUP_CODEX=${quote(command)} /usr/bin/expect -c ${quote(navigation)}`;
			const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(launch)}\nend tell`;
			await must(
				run("/usr/bin/osascript", ["-e", script], { timeoutMs: 15_000 }),
			);
			say("In Codex /hooks, select each Tedix hook and choose Trust.");
			let stopped = false;
			stops["hooks:codex"] = () => {
				stopped = true;
			};
			const until = Date.now() + 15 * 60_000;
			while (!stopped && Date.now() < until) {
				await readAgentStatus();
				if (
					agentStatus &&
					"hosts" in agentStatus &&
					agentStatus.hosts.codex?.hookTrust === "trusted"
				)
					return "Codex reports the Tedix hooks are trusted; choose Check read next.";
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
			throw new Error(
				"Hook trust is still waiting; open /hooks in Codex and trust the Tedix hooks, then choose Check again.",
			);
		});
		return readAgentStatus();
	}
	if (action === "account-sign-in" && tool.accountSignIn && command) {
		await step(`account:${tool.id}`, async (say) => {
			// Claude Code wants a terminal for its sign-in; `script` gives it one.
			const [file, args] =
				process.platform === "darwin"
					? [
							"/usr/bin/script",
							["-q", "/dev/null", command, ...tool.accountSignIn!],
						]
					: [command, tool.accountSignIn!];
			await must(
				run(file, args, {
					onLine: say,
					onStart: (stop) => {
						stops[`account:${tool.id}`] = stop;
					},
					timeoutMs: 15 * 60_000,
				}),
			);
			return `Signed in to ${tool.name}.`;
		});
		return readAgentStatus();
	}
	if (action === "verify" && (tool.id === "codex" || tool.id === "claude")) {
		await step(`verify:${tool.id}`, async (say) => {
			say(`Checking a read inside ${tool.name}…`);
			await must(
				tedix(
					["-w", "connect", "setup", "agents", `--${tool.id}`, "--verify"],
					{
						onLine: say,
						onStart: (stop) => {
							stops[`verify:${tool.id}`] = stop;
						},
						timeoutMs: 150_000,
					},
				),
			);
			return `A Tedix read succeeded inside ${tool.name}.`;
		});
		return readAgentStatus();
	}
	if (action === "add" && tool.add) {
		await step(`add:${tool.id}`, async (say) => {
			await must(
				tedix(["setup", "agents", tool.add!, "--yes"], {
					onLine: say,
					timeoutMs: 20 * 60_000,
				}),
			);
			return `Start a new ${tool.name} session to see Tedix.`;
		});
		return readAgentStatus();
	}
	if (
		action === "connect" &&
		tool.signIn &&
		command &&
		toolFacts[tool.id]?.signInWorks !== false
	) {
		await step(`connect:${tool.id}`, async (say) => {
			const host =
				agentStatus && "hosts" in agentStatus
					? agentStatus.hosts[tool.status ?? ""]
					: undefined;
			// Codex needs this setting on before it can talk to Tedix.
			if (tool.id === "codex" && host?.protocolEnabled === false)
				await must(
					run(command, ["features", "enable", "mcp_2026_07_28"], {
						onLine: say,
						timeoutMs: 60_000,
					}),
				);
			// OpenCode asks in a terminal before replacing a saved sign-in; clear it first.
			if (tool.id === "opencode")
				await run(command, ["mcp", "logout", "tedix"], { timeoutMs: 30_000 });
			// Claude Code refuses to sign in without a terminal. On a Mac,
			// `script` gives it one; the sign-in itself happens in the browser.
			const [file, args] =
				tool.id === "claude" && process.platform === "darwin"
					? ["/usr/bin/script", ["-q", "/dev/null", command, ...tool.signIn!]]
					: [command, tool.signIn!];
			await must(
				run(file, args, {
					onLine: say,
					onStart: (stop) => {
						stops[`connect:${tool.id}`] = stop;
					},
					timeoutMs: 15 * 60_000,
				}),
			);
			rememberSignIn(tool.id);
			delete steps[`verify:${tool.id}`];
			return `${tool.name} is connected to Tedix.`;
		});
		return readAgentStatus();
	}
	if (action === "run-tasks") {
		await step(`run:${tool.executor}`, async (say) => {
			if (!signedIn) throw new Error("Sign in on this Mac first.");
			const org = organization();
			if (!org)
				throw new Error(
					"The sign-in names no organization. Sign in again and choose one.",
				);
			// An earlier runner on this Mac already says which folder and rules to use.
			let earlier: { repo?: string; rules?: string } = {};
			try {
				earlier =
					(
						JSON.parse(readFileSync(runnersPath(), "utf8")) as {
							runners?: { repo?: string; rules?: string }[];
						}
					).runners?.[0] ?? {};
			} catch {
				/* No runners yet. */
			}
			let repo = settings().repo || earlier.repo;
			if (!repo) {
				repo = await chooseFolder();
				if (!repo) throw new Error("No folder was chosen.");
			}
			if (!existsSync(join(repo, ".git")) && !existsSync(join(repo, "HEAD")))
				throw new Error(
					`${repo} is not a Git repository. Choose the folder of the project Tedix should work on.`,
				);
			saveSettings({ repo });
			await must(
				tedix(
					[
						"lane",
						"serve",
						"--executor",
						tool.executor,
						"--install",
						"-w",
						"connect",
						"--organization",
						org,
						"--repo",
						repo,
						...(earlier.rules ? ["--rules", earlier.rules] : []),
					],
					{ onLine: say, timeoutMs: 60_000 },
				),
			);
			// A running supervisor reads the new entry by itself and starts only
			// this tool's runner; the other tools keep their tasks.
			await startRunnersIfStopped();
			return `${tool.name} can run tasks on this Mac.`;
		});
	}
}
