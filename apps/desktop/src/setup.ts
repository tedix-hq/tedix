import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { TEDIX_DEVIN_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { app, nativeImage } from "electron";
import {
	ListMcpAuthorizationsResultSchema,
	ListMcpSignInsResultSchema,
	type McpAuthorization,
} from "@tedix/api-contract/schemas/mcp-grant";
import { type CliState, manageCli, readCli, restoreCli } from "./cli";
import { codexAccount } from "./codex-account";
import { checkDevinConnection } from "./devin-connection";
import {
	desktopAppPath,
	desktopAppVersion,
	type DesktopApp,
	type Harness,
	harnessPath,
	harnessTarget,
	locateDesktopApps,
} from "./harness-target";
import type { LocalModelPreferences } from "./local-model-client";
import { log } from "./log";
import { readRunners, runnersPath, setRunnerField } from "./runners-file";
import {
	configDir,
	findTedix,
	lastLine,
	refreshShellPath,
	run,
	toolPath,
} from "./shell";
import {
	agentGrant,
	checkedTedixAccount,
	duplicateClaudeConnection,
	type AgentGrant,
	type Connection,
	tedixAccountSummary,
	cursorConnection,
	opencodeConnection,
	recentConnectionCheck,
	toolConnection,
	type VerificationTarget,
	type VerifiedConnection,
} from "./tool-connection";

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
	id: Harness;
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
	/**
	 * Its Mac app and its standalone command each keep their own Tedix
	 * sign-in. The other tools share one between both.
	 */
	separateSignIns?: boolean;
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
			"Update Claude Code to connect from Tedix, then choose Look again.",
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
		// Devin lists Tedix whether or not it is signed in; only starting its
		// connection says which. Without this the row trusted a day-old check.
		connection: (command) =>
			checkDevinConnection(command, CONNECT_URL, () => {}),
		signIn: ["mcp", "login", "tedix"],
		accountSignIn: ["auth", "login"],
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
			const result = await run(command, ["mcp", "list"], { timeoutMs: 10_000 });
			return result.ok ? opencodeConnection(result.output) : "unknown";
		},
		signIn: ["mcp", "auth", "tedix"],
		separateSignIns: true,
	},
	{
		id: "cursor",
		name: "Cursor",
		binary: "agent",
		folder: join(home, ".cursor"),
		executor: "cursor",
		status: "cursor",
		add: "--cursor",
		connection: async (command) => {
			const result = await run(command, ["mcp", "list"], { timeoutMs: 10_000 });
			return result.ok ? cursorConnection(result.output) : "unknown";
		},
		signIn: ["mcp", "login", "tedix"],
		accountSignIn: ["login"],
		signInWorks: async (command) =>
			(await run(command, ["mcp", "login", "--help"], { timeoutMs: 20_000 }))
				.ok,
	},
];

async function installDesktopPlugin(
	host: "claude" | "codex",
	command: string,
	options: Parameters<typeof run>[2],
): Promise<void> {
	const directory = app.isPackaged
		? join(process.resourcesPath, "tedix-plugin", host)
		: join(app.getAppPath(), "out", "tedix-plugin", host);
	const marketplace = host === "codex" ? "tedix-repo" : "tedix";
	const output = await must(
		run(command, ["plugin", "marketplace", "list", "--json"], {
			timeoutMs: 30_000,
		}),
	);
	const response = JSON.parse(output);
	const entries = host === "codex" ? response.marketplaces : response;
	const existing = entries.find(
		(entry: { name?: string }) => entry.name === marketplace,
	);
	if (existing) {
		const source =
			host === "codex"
				? existing.marketplaceSource?.sourceType === "local" &&
					existing.marketplaceSource.source
				: existing.source === "directory" && existing.path;
		if (typeof source !== "string" || resolve(source) !== directory)
			throw new Error(
				"A different Tedix plugin source is configured. Review it in the app before trying again.",
			);
	} else {
		await must(
			run(command, ["plugin", "marketplace", "add", directory], options),
		);
	}
	const plugin = `tedix@${marketplace}`;
	const install =
		host === "codex"
			? ["plugin", "add", plugin]
			: ["plugin", "install", plugin, "--scope", "user"];
	await must(run(command, install, options));
}

async function hasDevinConnection(command: string): Promise<boolean> {
	const output = await must(
		run(command, ["mcp", "list", "--json"], { timeoutMs: 45_000 }),
	);
	const servers = JSON.parse(output) as {
		name: string;
		enabled: boolean;
		url?: string;
	}[];
	const existing = servers.find((server) => server.name === "tedix");
	if (existing) {
		if (existing.url !== CONNECT_URL || !existing.enabled)
			throw new Error(
				"Devin already has a different or disabled Tedix connection. Review it in Devin.",
			);
		return true;
	}
	return false;
}

async function prepareDevinConnection(command: string): Promise<void> {
	if (await hasDevinConnection(command)) return;
	await must(
		run(
			command,
			[
				"mcp",
				"add",
				"--scope",
				"user",
				"--oauth-client-id",
				TEDIX_DEVIN_OAUTH_CLIENT_ID,
				"tedix",
				CONNECT_URL,
			],
			{ timeoutMs: 45_000 },
		),
	);
}

async function checkOpenCode(
	command: string,
	key: string,
): Promise<Connection> {
	// OpenCode 2 can answer before its background service has loaded plugins.
	for (let attempt = 0; attempt < 4 && !cancelled.has(key); attempt++) {
		const result = await run(command, ["mcp", "list"], {
			onStart: (stop) => {
				stops[key] = stop;
			},
			timeoutMs: 30_000,
		});
		if (!result.ok) return "unknown";
		if (result.output.trim() !== "No MCP servers configured")
			return opencodeConnection(result.output);
		if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return "unknown";
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
	/** Last profile read from this agent's Tedix connection, when available. */
	tedixAccount?: string;
	grant?: AgentGrant;
	grantUnavailable?: boolean;
	duplicateConnection?: boolean;
	desktop: boolean;
	/** Both versions can be installed, but setup uses the desktop app's executable. */
	bothInstalled: boolean;
	readVerified: boolean;
	/** "none": the installed Tedix plugin has no hooks (the published one). */
	hookTrust: "trusted" | "untrusted" | "unknown" | "none";
	/** Tedix's plugin came from the published marketplace, which ships no hooks. */
	publishedPlugin?: boolean;
	/** Tedix can be added to this tool from here. */
	canAdd: boolean;
	/** The tool has a command that signs it in to Tedix through the browser. */
	canSignIn: boolean;
	/** The app can sign the tool in to its own account. */
	canSignInAccount: boolean;
	/** One sentence on what is wrong or what happens next. */
	note: string;
	/** The tool's own words behind `note`, for the copied setup details only. */
	detail?: string;
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
export const SESSION_TOOLS = [
	"claude-code",
	"codex",
	"cursor",
	"devin",
	"opencode",
];

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
	/** What setup found on this Mac, in plain text, for "Copy setup details". */
	report: string;
	/** Tedix projects; `on` says, per coding tool, whether its sessions show there. */
	sessionProjects: SessionProject[];
	/** True once session reporting was ever chosen on this Mac. */
	sessionsChosen: boolean;
	repo: string;
	steps: Record<string, StepRun>;
	/** True while the command-line tool or the sign-in is still to do. */
	open: boolean;
	desktopApps: Record<DesktopApp, boolean>;
	/** Each installed app's own icon, as an image URL, read from the app. */
	appIcons: Partial<Record<DesktopApp, string>>;
	/** True while Tedix looks for apps and checks them. */
	looking: boolean;
	/** The chat apps whose own Tedix sign-in is active for this organization. */
	chatConnected: Partial<Record<"chatgpt" | "claude", boolean>>;
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
let loginIdentity = "";
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
	{
		command: string;
		version: string;
		hasTedix: boolean;
		connection: Connection;
		tedixAccount?: string;
		providerAccount?: Connection;
		duplicateConnection?: boolean;
		signInWorks: boolean;
		/** The standalone command, when Tedix uses the Mac app's own tool. */
		other?: { command: string; version: string; connection?: Connection };
	}
> = {};
/** A recent check for the selected executable and Tedix sign-in. */
const verifiedPath = () => join(configDir(), "desktop-verified.json");
type Verified = Partial<Record<Harness, VerifiedConnection>>;
let verified: Verified | undefined;
let serverGrants: McpAuthorization[] | undefined;
let grantIdentity = "";
/** When the server last answered; a failed read keeps that answer this long. */
let grantsReadAt = 0;
const GRANTS_KEPT_MS = 5 * 60_000;
/** This Mac's own sign-in claims per agent host, from `setup agents --sign-ins`. */
type LocalSignIn = { revision: string; clientId: string; consentId: string };
let localSignIns: Record<string, LocalSignIn[]> = {};
// The connection may change outside this app. Never persist its account identity.
const checkedAccounts: Partial<
	Record<Harness, VerifiedConnection & { account: string }>
> = {};
function readVerified(): Verified {
	if (!verified)
		try {
			const value: unknown = JSON.parse(readFileSync(verifiedPath(), "utf8"));
			verified =
				value && typeof value === "object" && !Array.isArray(value)
					? (value as Verified)
					: {};
		} catch {
			verified = {};
		}
	return verified;
}
function verificationTarget(
	id: Harness,
	command: string,
): VerificationTarget | undefined {
	const org = organization();
	if (!signedIn || !loginIdentity || !org) return;
	const fact = toolFacts[id];
	return {
		command,
		version: fact?.command === command ? fact.version : "",
		user: loginIdentity,
		org,
	};
}
function setVerified(id: Harness, target?: VerificationTarget): void {
	delete checkedAccounts[id];
	if (!target && toolFacts[id]) delete toolFacts[id]!.tedixAccount;
	const next = { ...readVerified() };
	if (target) next[id] = { ...target, at: Date.now() };
	else if (!next[id]) return;
	else delete next[id];
	verified = next;
	try {
		const path = verifiedPath();
		const pending = `${path}.${process.pid}.tmp`;
		writeFileSync(pending, JSON.stringify(next), { mode: 0o600 });
		renameSync(pending, path);
	} catch (error) {
		log(`setup: could not save the ${id} check: ${String(error)}`);
	}
}
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
	const path = args.includes("setup") ? harnessPath() : toolPath();
	return run(file, args, {
		...options,
		env: { PATH: path, ...options.env },
	});
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
		const detail = error instanceof StepFailure ? safe(error.detail) : reason;
		steps[key] = {
			error: reason,
			details: [`Step: ${key}`, ...lines.slice(-40), detail].join("\n"),
		};
		if (detail !== reason) log(`setup: ${key} said: ${detail}`);
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
	// Tedix's own messages are already one plain sentence with a next step:
	// show those as they are, and keep anything else behind Details.
	if (reason && plainSentence(reason)) throw new Error(reason);
	throw new StepFailure(
		reason?.slice(0, 400) ?? "The command failed without a message.",
	);
}

/** A short sentence for people, not a log line, stack frame, path or code. */
export function plainSentence(line: string): boolean {
	return (
		line.length <= 300 &&
		/^[A-Z][^{}<>[\]|`=\\]*[.!?]$/.test(line) &&
		!/^\w*Error\b|:\/\/|(?:^|\s)[~.]?\/\w/.test(line)
	);
}

/**
 * A step that failed inside a command. People see one plain sentence and a
 * next click; the command's own line stays in the step's details.
 */
class StepFailure extends Error {
	constructor(readonly detail: string) {
		super(
			"This did not finish. Try again; if it fails again, choose Get help in Settings.",
		);
	}
}

async function readSignIn(): Promise<void> {
	const result = await tedix(["-w", "connect", "auth", "status", "--json"], {
		timeoutMs: 20_000,
	});
	interface Login {
		loginId?: string;
		refreshExpiresAt?: string;
		accessToken?: {
			sub?: string;
			dct?: string;
			selectedOrganizations?: string[];
		};
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
	loginIdentity = now ? (login?.accessToken?.sub ?? login?.loginId ?? "") : "";
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
export function readAgentStatus(): Promise<void> {
	if (readingStatus) return readingStatus;
	readingStatus = readAgentStatusNow().finally(() => {
		readingStatus = undefined;
		changed();
	});
	changed();
	return readingStatus;
}

async function readAgentStatusNow(): Promise<void> {
	const from = Date.now();
	// A failed read of the facts or the routing must not keep every row on
	// "Checking…": the tools' own status still arrives.
	// Each part's time, so a slow check says which part was slow.
	const took: string[] = [];
	const timed = <T>(name: string, work: Promise<T>) =>
		work.finally(() =>
			took.push(`${name} ${Math.round((Date.now() - from) / 1000)} s`),
		);
	const [result] = await Promise.all([
		timed(
			"status",
			tedix(["setup", "agents", "--status", "--json"], { timeoutMs: 150_000 }),
		),
		timed(
			"tools",
			readToolFacts().catch((error: unknown) =>
				log(`setup: tool facts not read (${String(error)})`),
			),
		),
		timed("grants", readConnectionGrants()),
		timed(
			"routing",
			readRouting().catch((error: unknown) =>
				log(`setup: routing not read (${String(error)})`),
			),
		),
	]);
	log(
		`setup: agents checked in ${Math.round((Date.now() - from) / 1000)} s (${took.join(", ")})${result.ok ? "" : ` (${lastLine(safe(result.output)).slice(0, 160)})`}`,
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
				? "Tedix cannot check this app yet. It updates itself and checks again when you come back."
				: "Tedix is still setting up this Mac. If this stays, quit and open Tedix again.",
		};
	}
	changed();
}

/** This Mac's stored sign-in claims for one host, or every host when unset. */
async function readLocalSignIns(
	filesOnly: boolean,
	host?: string,
): Promise<Record<string, LocalSignIn[]>> {
	if (!findTedix()) return {};
	const result = await tedix(
		[
			"-w",
			"connect",
			"setup",
			"agents",
			"--sign-ins",
			"--json",
			...(filesOnly ? ["--files-only"] : []),
			...(host ? [`--${host}`] : []),
		],
		{ timeoutMs: 30_000 },
	);
	if (!result.ok) return {};
	try {
		const parsed = JSON.parse(result.output) as {
			hosts?: { host: string; signIns?: LocalSignIn[] }[];
		};
		return Object.fromEntries(
			(parsed.hosts ?? []).map((entry) => [entry.host, entry.signIns ?? []]),
		);
	} catch {
		return {};
	}
}

/** Finds the Connect code-mode callable for one reviewed endpoint. */
async function connectCallable(
	query: string,
	sourceRef: string,
): Promise<string | undefined> {
	const org = organization();
	if (!org) return;
	const discovery = await tedix(
		[
			"-w",
			"connect",
			"--organization",
			org,
			"code",
			`async () => await discover.search({query: ${JSON.stringify(query)}, limit: 5, includeMetadata: true})`,
			"--json",
		],
		{ timeoutMs: 30_000 },
	);
	if (!discovery.ok) return;
	const listed = JSON.parse(discovery.output);
	const rows = Array.isArray(listed) ? listed : listed.results;
	const tool = rows?.find(
		(row: { authorized?: boolean; schemaFreshness?: { sourceRef?: string } }) =>
			row.authorized === true && row.schemaFreshness?.sourceRef === sourceRef,
	);
	if (!tool || !/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(tool.callable))
		return;
	return tool.callable;
}

/**
 * A Code Mode result without the run's own fields, such as
 * completionEvidence, which the tool's strict result schema does not know.
 */
function codeResult(output: string): unknown {
	const parsed = JSON.parse(output) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return parsed;
	const { completionEvidence: _evidence, ...result } = parsed as Record<
		string,
		unknown
	>;
	return result;
}

async function callConnect(callable: string, input: unknown): Promise<unknown> {
	const org = organization();
	if (!org) return;
	const source = `async () => await ${callable}(${JSON.stringify(input)})`;
	const result = await tedix(
		["-w", "connect", "--organization", org, "code", source, "--json"],
		{ timeoutMs: 30_000 },
	);
	if (!result.ok) return;
	return codeResult(result.output);
}

/**
 * Ends the sign-ins a fresh Connect replaced: claims this host held before
 * sign-in whose revision the new token no longer carries.
 */
async function revokeReplacedSignIns(claims: LocalSignIn[]): Promise<number> {
	const [listCallable, revokeCallable] = await Promise.all([
		connectCallable("list_mcp_sign_ins", "organizations/listMcpSignIns"),
		connectCallable("revoke_mcp_sign_in", "organizations/revokeMcpSignIn"),
	]);
	if (!listCallable || !revokeCallable) return 0;
	const listed = ListMcpSignInsResultSchema.parse(
		await callConnect(listCallable, { limit: 100, offset: 0 }),
	);
	let revoked = 0;
	for (const claim of claims) {
		const item = listed.items.find(
			(row) =>
				row.clientId === claim.clientId && row.revision === claim.revision,
		);
		if (!item) continue;
		try {
			await callConnect(revokeCallable, {
				mcpServerId: item.mcpServerId,
				clientId: item.clientId,
				revision: item.revision,
			});
			revoked += 1;
		} catch {
			/* A failed revoke leaves the old sign-in to expire on its own. */
		}
	}
	return revoked;
}

/** Reads the person's grants through Connect; never starts an agent or a model. */
/**
 * Reads the server's sign-ins for this organization. The last answer stays
 * while the read runs (it can take 30 seconds) and through a failed read for
 * up to five minutes, so one brief outage does not flag every agent; after
 * that a stale grant is never reported as current.
 */
async function readConnectionGrants(): Promise<void> {
	let read = false;
	const org = organization();
	const identity = `${loginIdentity}:${org}`;
	try {
		if (!signedIn || !org) return;
		const local = await readLocalSignIns(true);
		const discovery = await tedix(
			[
				"-w",
				"connect",
				"--organization",
				org,
				"code",
				'async () => await discover.search({query: "list_mcp_authorizations", limit: 5, includeMetadata: true})',
				"--json",
			],
			{ timeoutMs: 30_000 },
		);
		if (!discovery.ok) return;
		const listed = JSON.parse(discovery.output);
		const rows = Array.isArray(listed) ? listed : listed.results;
		const tool = rows?.find(
			(row: {
				authorized?: boolean;
				schemaFreshness?: { sourceRef?: string };
			}) =>
				row.authorized === true &&
				row.schemaFreshness?.sourceRef ===
					"organizations/listMcpAuthorizations",
		);
		if (!tool || !/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(tool.callable))
			return;
		const source = `async () => await ${tool.callable}({resourceUrl: ${JSON.stringify(CONNECT_URL)}, limit: 50, offset: 0})`;
		const result = await tedix(
			["-w", "connect", "--organization", org, "code", source, "--json"],
			{ timeoutMs: 30_000 },
		);
		if (!result.ok) return;
		const data = ListMcpAuthorizationsResultSchema.parse(
			codeResult(result.output),
		);
		if (identity === `${loginIdentity}:${organization()}` && !data.hasMore) {
			serverGrants = data.items;
			grantIdentity = identity;
			localSignIns = local;
			grantsReadAt = Date.now();
			read = true;
		}
	} catch {
		// Cleared below.
	} finally {
		if (!read && Date.now() - grantsReadAt > GRANTS_KEPT_MS) {
			serverGrants = undefined;
			localSignIns = {};
		}
	}
}

/** Asks each tool that is here what it knows about its own Tedix connection. */
async function readToolFacts(): Promise<void> {
	const facts: typeof toolFacts = {};
	await locateDesktopApps();
	await readAppIcons();
	const versionOf = async (command: string) => {
		const version = await run(command, ["--version"], { timeoutMs: 10_000 });
		return version.ok
			? (version.output.match(/(?<![\d.])\d+\.\d+\.\d+(?:-[\w.]+)?\b/)?.[0] ??
					"")
			: "";
	};
	await Promise.all(
		TOOLS.map(async (tool) => {
			const { command, desktop, standalone } = harnessTarget(tool.id);
			if (!command) return;
			const other = desktop ? standalone : undefined;
			const [
				hasTedix,
				connection,
				signInWorks,
				version,
				providerAccount,
				otherVersion,
				otherConnection,
				connections,
			] = await Promise.all([
				tool.hasTedix?.(command) ?? false,
				tool.connection?.(command) ?? ("unknown" as const),
				tool.signInWorks?.(command) ?? true,
				versionOf(command),
				tool.id === "codex"
					? codexAccount(command, Boolean(desktop))
					: undefined,
				other ? versionOf(other) : "",
				other && tool.separateSignIns ? tool.connection?.(other) : undefined,
				tool.id === "claude"
					? run(command, ["mcp", "list"], { timeoutMs: 45_000 })
					: undefined,
			]);
			facts[tool.id] = {
				command,
				hasTedix,
				connection,
				signInWorks,
				providerAccount,
				duplicateConnection: connections?.ok
					? duplicateClaudeConnection(connections.output)
					: undefined,
				version,
				other: other
					? {
							command: other,
							version: otherVersion,
							connection: otherConnection,
						}
					: undefined,
			};
			if (
				(tool.id === "devin" || tool.id === "opencode") &&
				connection === "signed-in"
			) {
				const profile = await tedix(
					["-w", "connect", "setup", "agents", `--${tool.id}`, "--verify"],
					{
						env: { PATH: [dirname(command), harnessPath()].join(delimiter) },
						timeoutMs: 45_000,
					},
				);
				if (profile.ok)
					facts[tool.id]!.tedixAccount = checkedTedixAccount(profile.output);
			}
		}),
	);
	toolFacts = facts;
}

function toolRows(): ToolRow[] {
	return TOOLS.map((tool) => {
		const { command, desktop, app, standalone } = harnessTarget(tool.id);
		const found = command
			? "found"
			: app || existsSync(tool.folder)
				? "no-command"
				: "absent";
		const row: ToolRow = {
			id: tool.id,
			name: desktop ?? tool.name,
			executor: tool.executor,
			found,
			tedix: "unknown",
			version: "",
			enabled: true,
			connection: "unknown",
			account: "unknown",
			desktop: Boolean(desktop),
			bothInstalled: Boolean(desktop && standalone),
			readVerified: false,
			hookTrust: "unknown",
			canAdd: false,
			canSignIn: false,
			canSignInAccount: false,
			note: "",
		};
		if (found === "absent") return row;
		if (found === "no-command") {
			row.note = app
				? tool.id === "claude"
					? "Open the Code tab in Claude, then choose Look again."
					: `Open ${app} and check for updates, then choose Look again.`
				: `Install ${tool.name}, then choose Look again.`;
			return row;
		}
		if (!tool.status) {
			row.tedix = "unsupported";
			row.note = tool.say ?? "";
			return row;
		}
		const facts = toolFacts[tool.id];
		if (!agentStatus || !facts || facts.command !== command) {
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
			facts.providerAccount ??
			(host?.account === "signed-in" || host?.account === "signed-out"
				? host.account
				: "unknown");
		// Devin and OpenCode are checked by reading their own connection state,
		// which every look already does: a signed-in read is that check, so the
		// row needs no extra Check connection press after a sign-in.
		row.readVerified =
			((tool.id === "devin" || tool.id === "opencode") &&
				facts.connection === "signed-in") ||
			recentConnectionCheck(
				readVerified()[tool.id],
				verificationTarget(tool.id, command),
				Date.now(),
			);
		row.canSignInAccount = Boolean(tool.accountSignIn);
		row.hookTrust =
			host?.hookTrust === "trusted" ||
			host?.hookTrust === "untrusted" ||
			host?.hookTrust === "none"
				? host.hookTrust
				: "unknown";
		const source = host?.source;
		row.publishedPlugin =
			typeof source === "object" &&
			source !== null &&
			(source as { marketplace?: unknown }).marketplace === "tedix-plugins";
		if (host?.problem && !facts.hasTedix) {
			row.note = `${tool.name} did not answer when Tedix checked it. Open ${tool.name}, then choose Look again.`;
			row.detail = String(host.problem).split("\n")[0]!.slice(0, 200);
			return row;
		}
		row.tedix =
			host?.installed === true || facts.hasTedix ? "added" : "missing";
		row.canAdd = Boolean(tool.add) && row.tedix === "missing";
		row.canSignIn = Boolean(tool.signIn) && facts.signInWorks;
		row.note = row.canSignIn ? (tool.say ?? "") : (tool.signInSay ?? "");
		if (row.tedix !== "added") return row;
		row.version = typeof host?.version === "string" ? host.version : "";
		row.enabled = host?.enabled !== false;
		row.connection = toolConnection(
			tool.connection ? facts.connection : undefined,
			row.readVerified,
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
		// A sign-in made with the standalone command does not reach the Mac app.
		if (
			desktop &&
			row.connection !== "signed-in" &&
			facts.other?.connection === "signed-in"
		)
			row.note = `The ${tool.binary} command is signed in to Tedix, but ${desktop} keeps its own sign-in. Choose Connect to sign in ${desktop} too.`;
		const checked = checkedAccounts[tool.id];
		if (tool.id === "devin" || tool.id === "opencode")
			row.tedixAccount =
				row.enabled && row.connection === "signed-in"
					? facts.tedixAccount
					: undefined;
		if (
			tool.id !== "devin" &&
			tool.id !== "opencode" &&
			row.enabled &&
			row.connection === "signed-in" &&
			recentConnectionCheck(
				checked,
				verificationTarget(tool.id, command),
				Date.now(),
			)
		)
			row.tedixAccount = checked?.account;
		row.duplicateConnection =
			row.tedix === "added" && facts.duplicateConnection;
		row.grantUnavailable =
			signedIn &&
			(!serverGrants || grantIdentity !== `${loginIdentity}:${organization()}`);
		if (grantIdentity === `${loginIdentity}:${organization()}` && serverGrants)
			row.grant = agentGrant(
				tool.id,
				serverGrants.filter(
					(grant) =>
						grant.status === "revoked" ||
						grant.selectedTenantIds.includes(organization()),
				),
				(localSignIns[tool.id] ?? [])
					.map((claim) => claim.clientId)
					.filter(Boolean),
			);
		return row;
	});
}

/**
 * What setup found on this Mac, for "Copy setup details": every installation
 * of each agent, which one Tedix uses and what each check last said. Holds no
 * keys or sign-in links, and writes the home folder as `~`. The last checked
 * account is included for the person to review before sending the report.
 */
function setupReport(tools: ToolRow[]): string {
	const short = (path: string) =>
		path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	const clean = (text: string) =>
		safe(text)
			.replace(/\S+@\S+\.\S+/g, "(email)")
			.replaceAll(home, "~");
	const lines = [
		`Tedix ${app.getVersion()} on macOS ${process.getSystemVersion?.() ?? ""} (${process.arch})`,
		`Command-line tool: ${cli.version || "not found"} (${cli.kind}) · signed in: ${signedIn ? "yes" : "no"} · reaches Tedix: ${reach}`,
		`Signed in to Tedix in the app: ${appSignIn.state === "in" ? "yes" : "no"}${organization() ? ` · organization: ${organization()}` : ""}`,
	];
	for (const tool of TOOLS) {
		const row = tools.find((item) => item.id === tool.id);
		const target = harnessTarget(tool.id);
		const facts = toolFacts[tool.id];
		const usesApp = Boolean(target.desktop);
		const usedVersion =
			facts && facts.command === target.command ? facts.version : "";
		lines.push("", `${tool.name}${target.app ? ` (${target.app})` : ""}`);
		lines.push(
			target.appPath
				? `  Mac app: ${short(target.appPath)} ${desktopAppVersion(target.desktopApp)} · its own tool: ${target.bundled ? `${short(target.bundled)} ${usesApp ? usedVersion : ""}`.trim() : "not found"}`
				: "  Mac app: not found",
			target.standalone
				? `  Command: ${short(target.standalone)} ${usesApp ? (facts?.other?.version ?? "") : usedVersion}`.trimEnd()
				: "  Command: not found",
		);
		if (!row || row.found === "absent") continue;
		lines.push(
			`  Tedix uses: ${target.command ? (usesApp ? "the Mac app's own tool" : "the command") : "nothing yet"}`,
			`  Tedix plugin: ${row.tedix}${row.version ? ` ${row.version}` : ""}${row.enabled ? "" : " (switched off)"} · Tedix sign-in: ${row.connection} · ${tool.name} account: ${row.account} · checked in the last day: ${row.readVerified ? "yes" : "no"} · hooks: ${row.hookTrust}`,
			`  ${tedixAccountSummary(row.tedixAccount, appSignIn.state === "in" ? appSignIn.email : "").text}`,
		);
		if (facts?.other?.connection)
			lines.push(
				`  The command's own Tedix sign-in: ${facts.other.connection}`,
			);
		if (row.note) lines.push(`  Says: ${row.note}`);
		if (row.detail) lines.push(`  Its answer: ${row.detail}`);
		for (const kind of ["account", "connect", "verify"]) {
			const ran = steps[`${kind}:${tool.id}`];
			if (ran?.error) lines.push(`  Last ${kind} failed: ${clean(ran.error)}`);
			if (ran?.error && ran.details)
				lines.push(
					...clean(ran.details)
						.trim()
						.split(/\r?\n/)
						.slice(-8)
						.map((line) => `    ${line}`),
				);
		}
	}
	return lines.join("\n");
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
		report: setupReport(tools),
		sessionProjects,
		sessionsChosen,
		routing,
		repo: settings().repo ?? "",
		steps,
		open: appSignIn.state !== "in",
		desktopApps: {
			claude: Boolean(desktopAppPath("claude")),
			chatgpt: Boolean(desktopAppPath("chatgpt")),
			cursor: Boolean(desktopAppPath("cursor")),
			devin: Boolean(desktopAppPath("devin")),
			opencode: Boolean(desktopAppPath("opencode")),
		},
		appIcons,
		looking: readingStatus !== undefined,
		chatConnected: chatConnected(),
	};
}

/** ChatGPT chat and Claude chat sign in to Tedix under their app's own name. */
function chatConnected(): SetupState["chatConnected"] {
	if (grantIdentity !== `${loginIdentity}:${organization()}` || !serverGrants)
		return {};
	const active = (name: RegExp) =>
		serverGrants?.some(
			(grant) =>
				name.test(grant.clientName ?? "") &&
				grant.status === "active" &&
				grant.providerStatus !== "missing" &&
				grant.selectedTenantIds.includes(organization()),
		) ?? false;
	return { chatgpt: active(/^chatgpt$/i), claude: active(/^claude$/i) };
}

/** The apps' own icons, read once per app path so a moved or updated app shows its new one. */
const appIcons: Partial<Record<DesktopApp, string>> = {};
const iconPaths: Partial<Record<DesktopApp, string>> = {};
async function readAppIcons(): Promise<void> {
	for (const name of [
		"claude",
		"chatgpt",
		"cursor",
		"devin",
		"opencode",
	] as const) {
		const path = desktopAppPath(name);
		if (!path) {
			delete appIcons[name];
			delete iconPaths[name];
			continue;
		}
		if (iconPaths[name] === path) continue;
		try {
			const image = await nativeImage
				.createThumbnailFromPath(path, { width: 64, height: 64 })
				.catch(() => app.getFileIcon(path, { size: "normal" }));
			if (image.isEmpty()) continue;
			appIcons[name] = image.toDataURL();
			iconPaths[name] = path;
		} catch {
			// Without its icon the row shows a plain one.
		}
	}
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
	if (deep || !agentStatus || signedIn !== was) void readAgentStatus();
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
	"connect",
	"verify",
	"run-tasks",
	"choose-folder",
	"clear-folder",
	"remove",
	"replace-plugin",
	"sessions-on",
	"sessions-off",
	"account-sign-in",
	"open-sign-in",
] as const;
export type SetupAction = (typeof ACTIONS)[number];

/** A folder that holds a Git checkout: what code tasks work in. */
const isCodeProject = (folder: string) =>
	existsSync(join(folder, ".git")) || existsSync(join(folder, "HEAD"));

/** What the checklist needs from the window: a folder chooser and the app's own sign-in. */
export interface SetupHost {
	chooseFolder: () => Promise<string | undefined>;
	appSignIn: () => Promise<void>;
	openSignIn: (url: string) => Promise<void>;
	/** Starts this Mac's runners when none run; leaves running ones alone. */
	startRunnersIfStopped: () => Promise<void>;
	/** Asks the person before Tedix is taken out of an agent. */
	confirmRemove: (name: string) => Promise<boolean>;
	/** Which agents run tasks changed outside the task switches. */
	tasksChanged: () => void;
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
	{
		chooseFolder,
		appSignIn: signInToApp,
		openSignIn,
		startRunnersIfStopped,
		confirmRemove,
		tasksChanged,
	}: SetupHost,
): Promise<void> {
	if (!ACTIONS.includes(action)) return;
	const tool = TOOLS.find((item) => item.id === id);
	if (action === "check") return refreshSetup(true);
	if (action === "app-sign-in") return signInToApp();
	if (action === "open-sign-in") {
		const pending = /^(account|connect):/.test(id) ? steps[id] : undefined;
		const url = pending?.working && URL.parse(pending.address ?? "");
		if (url && url.protocol === "https:" && !url.username && !url.password)
			return openSignIn(url.href);
		return;
	}
	if (action === "cancel") {
		if (stops[id]) cancelled.add(id);
		return stops[id]?.();
	}
	if (action === "choose-folder") {
		const repo = await chooseFolder();
		if (!repo) return changed();
		if (!isCodeProject(repo))
			steps.folder = {
				error:
					"Code tasks need a project folder that holds code managed with Git, and this folder does not. Choose another folder, or choose Use without a folder: agents then run every task that needs no code.",
			};
		else {
			delete steps.folder;
			saveSettings({ repo });
		}
		return changed();
	}
	if (action === "clear-folder") {
		delete steps.folder;
		saveSettings({ repo: "" });
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
	const { command, desktop } = harnessTarget(tool.id);
	const toolName = desktop ?? tool.name;
	const probeEnv = command
		? { PATH: [dirname(command), harnessPath()].join(delimiter) }
		: undefined;
	if (action === "replace-plugin" && tool.id === "codex" && command) {
		// The published plugin ships no hooks; the one inside this app has
		// them. Swapping plugins keeps the Tedix sign-in, which belongs to the
		// connection, not the plugin.
		await step(`connect:${tool.id}`, async (say) => {
			say(`Replacing the Tedix plugin in ${toolName}…`);
			const options = { env: probeEnv, timeoutMs: 120_000 };
			await run(command, ["plugin", "remove", "tedix@tedix-plugins"], options);
			await run(
				command,
				["plugin", "marketplace", "remove", "tedix-plugins"],
				options,
			);
			await installDesktopPlugin("codex", command, options);
			return `${toolName} now has the Tedix plugin with hooks. Allow them in ${toolName} under Settings → Hooks.`;
		});
		return refreshSetup(true);
	}
	if (action === "remove") {
		if (!(await confirmRemove(toolName))) return;
		await step(`remove:${tool.id}`, async (say) => {
			say(`Removing Tedix from ${toolName}…`);
			await must(
				tedix(
					[
						"-w",
						"connect",
						"setup",
						"agents",
						"--remove",
						`--${tool.id}`,
						"--yes",
					],
					{ env: probeEnv, onLine: say, timeoutMs: 180_000 },
				),
			);
			// It no longer reaches Tedix, so it must not take tasks either.
			readRunners().forEach((runner) => {
				if (runner.executor === tool.executor && runner.enabled)
					setRunnerField(runner.index, "enabled", false);
			});
			tasksChanged();
			setVerified(tool.id);
			return `Tedix is removed from ${toolName}. Choose Connect to add it again.`;
		});
		return refreshSetup(true);
	}
	const verify = () =>
		step(`verify:${tool.id}`, async (say) => {
			setVerified(tool.id);
			if (!command) throw new Error(`Open ${toolName} once, then check again.`);
			const target = verificationTarget(tool.id, command);
			say(`Checking a read inside ${tool.name}…`);
			const output = await must(
				tedix(
					["-w", "connect", "setup", "agents", `--${tool.id}`, "--verify"],
					{
						env: probeEnv,
						onStart: (stop) => {
							stops[`verify:${tool.id}`] = stop;
						},
						timeoutMs: 150_000,
					},
				),
			);
			setVerified(tool.id, target);
			// Only the host's profile result is evidence; never substitute the app login.
			const account = checkedTedixAccount(output);
			if (account && target)
				checkedAccounts[tool.id] = { ...target, account, at: Date.now() };
			if (tool.id === "devin" || tool.id === "opencode") {
				const facts = toolFacts[tool.id];
				if (facts?.command === command) facts.tedixAccount = account;
			}
			return `A Tedix read succeeded inside ${toolName}${account ? `, as ${account}` : ""}.`;
		});
	// One Connect carries an app through sign-in and verification: it adds
	// Tedix when missing, reuses an authorization that still works instead of
	// asking for consent again, and ends with the host read — no second
	// click and no separate Check connection.
	const connectTool = async (): Promise<boolean> => {
		if (!tool.signIn || !command || toolFacts[tool.id]?.signInWorks === false)
			return false;
		const key = `connect:${tool.id}`;
		if (steps[key]?.working || steps[`verify:${tool.id}`]?.working)
			return false;
		await step(key, async (say) => {
			setVerified(tool.id);
			// A verify that just asked for sign-in must not be skipped by a
			// connection check that still trusts the old authorization.
			const verifyWantsSignIn = /sign in/i.test(
				steps[`verify:${tool.id}`]?.error ?? "",
			);
			delete steps[`verify:${tool.id}`];
			const row = toolRows().find((row) => row.id === tool.id);
			const version = toolFacts[tool.id]?.version;
			const source = `${toolName}${version ? ` ${version}` : ""} (${desktop ? "desktop app" : "standalone"})`;
			say(`Adding Tedix to ${source}…`);
			try {
				if (tool.id === "devin") await prepareDevinConnection(command);
				else if (row?.canAdd && tool.add) {
					const options = {
						env: probeEnv,
						onStart: (stop: () => void) => {
							stops[key] = stop;
						},
						timeoutMs: 120_000,
					};
					if (tool.id === "codex" || tool.id === "claude")
						await installDesktopPlugin(tool.id, command, options);
					else
						await must(
							tedix(
								["-w", "connect", "setup", "agents", tool.add, "--yes"],
								options,
							),
						);
				}
			} catch {
				throw new Error(
					`Couldn't add Tedix to ${source}. Open the app and check its plugin settings, then try again.`,
				);
			}
			const host =
				agentStatus && "hosts" in agentStatus
					? agentStatus.hosts[tool.status ?? ""]
					: undefined;
			// Codex needs this setting on before it can talk to Tedix.
			if (tool.id === "codex" && host?.protocolEnabled === false)
				if (
					!(
						await run(command, ["features", "enable", "mcp_2026_07_28"], {
							timeoutMs: 60_000,
						})
					).ok
				)
					throw new Error(
						`Couldn't enable Tedix connections in ${source}. Check for an app update, then try again.`,
					);
			if (tool.id === "opencode") {
				say(`Checking that ${source} can see Tedix…`);
				const state = await checkOpenCode(command, key);
				if (state === "unknown" && row?.tedix === "missing")
					throw new Error(
						`${source} could not confirm that Tedix is ready for sign-in. Open OpenCode, then try again.`,
					);
				if (state === "signed-in")
					return "OpenCode is already signed in to Tedix.";
			}
			// An authorization that still works needs no second consent:
			// verify what is there instead of signing in again.
			if (
				!verifyWantsSignIn &&
				tool.connection &&
				(await tool.connection(command)) === "signed-in"
			)
				return `Tedix is already signed in from ${toolName}.`;
			say("Finish signing in in your browser…");
			// Remember this install's sign-ins so a fresh one can replace them.
			const priorSignIns =
				(await readLocalSignIns(false, tool.id))[tool.id] ?? [];
			// Claude Code refuses to sign in without a terminal. On a Mac,
			// `script` gives it one; the sign-in itself happens in the browser.
			const [file, args] =
				tool.id === "claude" && process.platform === "darwin"
					? ["/usr/bin/script", ["-q", "/dev/null", command, ...tool.signIn!]]
					: [command, tool.signIn!];
			const login = await run(file, args, {
				onLine: (line) => {
					// OpenCode draws a border before the address.
					const address = line.match(/https:\/\/\S+/)?.[0];
					if (address) say(address);
				},
				onStart: (stop) => {
					stops[`connect:${tool.id}`] = stop;
				},
				timeoutMs: 15 * 60_000,
			});
			if (!login.ok)
				throw new Error(
					`Tedix sign-in did not finish in ${source}. Choose Connect to try again.`,
				);
			// Connect replaces this Mac's grant: end the revisions the new
			// token no longer carries and leave every other sign-in alone.
			const kept = new Set(
				((await readLocalSignIns(false, tool.id))[tool.id] ?? []).map(
					(claim) => claim.revision,
				),
			);
			const replaced = priorSignIns.filter(
				(claim) => claim.revision && !kept.has(claim.revision),
			);
			if (replaced.length) await revokeReplacedSignIns(replaced).catch(() => 0);
			return `Signed in to Tedix from ${toolName}.`;
		});
		if (steps[key]?.done) await verify();
		return true;
	};
	if (action === "verify") {
		await verify();
		void readAgentStatus();
		return;
	}
	if (action === "connect") {
		if (await connectTool()) return readAgentStatus();
		return;
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
		// The app's own sign-in is the first half of Connect: unless the app
		// is already connected, carry on through install, Tedix sign-in and
		// the verification read without another click.
		if (steps[`account:${tool.id}`]?.done) {
			await readAgentStatus();
			const row = toolRows().find((item) => item.id === tool.id);
			const linked =
				row?.tedix === "added" &&
				row.enabled &&
				row.connection === "signed-in" &&
				row.readVerified;
			if (!linked) await connectTool();
		}
		return readAgentStatus();
	}
	if (action === "run-tasks") {
		await step(`run:${tool.executor}`, async (say) => {
			if (!command) throw new Error(`Open ${toolName}, then check again.`);
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
			// A project folder is only for code. Without one the runner starts
			// from an empty folder of its own and gives each task an empty folder.
			const empty = join(configDir(), "no-project");
			const chosen =
				settings().repo || (earlier.repo === empty ? "" : earlier.repo);
			const repo = chosen || empty;
			if (chosen) {
				if (!isCodeProject(repo))
					throw new Error(
						"Code tasks need a project folder that holds code managed with Git, and the folder in Settings does not. Under Project folder, choose Use without a folder or another folder, then try again.",
					);
				saveSettings({ repo });
			} else mkdirSync(repo, { recursive: true });
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
					{ env: probeEnv, onLine: say, timeoutMs: 60_000 },
				),
			);
			// A running supervisor reads the new entry by itself and starts only
			// this tool's runner; the other tools keep their tasks.
			await startRunnersIfStopped();
			return `${tool.name} can run tasks on this Mac.`;
		});
	}
}
