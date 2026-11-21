import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
	type CliState,
	manageCli,
	readCli,
	restartSupervisor,
	restoreCli,
} from "./cli";
import { log } from "./log";
import { runnersPath } from "./runners-file";
import {
	findCommand,
	findTedix,
	lastLine,
	refreshShellPath,
	run,
} from "./shell";

const CONNECT_URL = "https://connect.mcp.tedix.dev/mcp";

type Connection = "signed-in" | "signed-out" | "unknown";

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
		say: "Devin does not say whether it is signed in to Tedix. Sign in once; if Tedix already answers in Devin, you are done.",
	},
	{
		id: "opencode",
		name: "OpenCode",
		binary: "opencode",
		folder: join(home, ".config", "opencode"),
		executor: "opencode",
		say: "Tedix can start OpenCode runs. Adding Tedix inside OpenCode is not available yet.",
	},
];

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
	/** Tedix can be added to this tool from here. */
	canAdd: boolean;
	/** The tool has a command that signs it in to Tedix through the browser. */
	canSignIn: boolean;
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
	repo: string;
	steps: Record<string, StepRun>;
	/** True while the command-line tool or the sign-in is still to do. */
	open: boolean;
}

interface Settings {
	host?: string;
	repo?: string;
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

async function readAgentStatus(): Promise<void> {
	const [result] = await Promise.all([
		tedix(["setup", "agents", "--status", "--json"], { timeoutMs: 150_000 }),
		readToolFacts(),
	]);
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
			const command = findCommand(tool.binary);
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
		const command = findCommand(tool.binary);
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
			canAdd: false,
			canSignIn: false,
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
		const facts = toolFacts[tool.id];
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
		row.connection = host?.signedIn === false ? "signed-out" : facts.connection;
		if (!row.enabled) {
			row.note = `Switch the Tedix plugin on in ${tool.name}, then choose Check again.`;
			return row;
		}
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
		repo: settings().repo ?? "",
		steps,
		open: cli.kind === "missing" || !signedIn,
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
	"run-tasks",
	"choose-folder",
] as const;
export type SetupAction = (typeof ACTIONS)[number];

/** What the checklist needs from the window: a folder chooser and the app's own sign-in. */
export interface SetupHost {
	chooseFolder: () => Promise<string | undefined>;
	appSignIn: () => Promise<void>;
}

/** Carries out one button of the checklist. */
export async function setupAction(
	action: SetupAction,
	id: string,
	{ chooseFolder, appSignIn: signInToApp }: SetupHost,
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
	if (!tool) return;
	const command = findCommand(tool.binary);
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
			await must(
				run(command, tool.signIn!, {
					onLine: say,
					onStart: (stop) => {
						stops[`connect:${tool.id}`] = stop;
					},
					timeoutMs: 15 * 60_000,
				}),
			);
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
			say("Restarting this Mac's runners…");
			await must(restartSupervisor());
			return `Tedix can start ${tool.name} runs on this Mac for ${org}, in ${repo}. The first run starts within a minute of being assigned.`;
		});
	}
}
