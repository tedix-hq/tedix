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
	supervisorLoaded,
} from "./cli";
import { log } from "./log";
import { runnersPath } from "./runners-file";
import {
	findCommand,
	findTedix,
	lastLine,
	refreshShellPath,
	run,
	toolPath,
} from "./shell";

/**
 * One coding tool the checklist knows. Adding a tool is one entry here.
 * `status` is the name `tedix setup agents --status --json` reports it under;
 * `add` is the flag that adds Tedix to it; `signIn` is the tool's own command
 * that opens the browser to connect it to Tedix, or `signInSay` when that
 * only works on the tool's own screen.
 */
interface Tool {
	id: string;
	name: string;
	binary: string;
	folder: string;
	executor: string;
	status?: string;
	add?: string;
	signIn?: string[];
	signInSay?: string;
}
const home = homedir();
const TOOLS: Tool[] = [
	{
		id: "claude",
		name: "Claude Code",
		binary: "claude",
		folder: join(home, ".claude"),
		executor: "claude-code",
		status: "claude",
		add: "--claude",
		signInSay:
			"To connect it: open Claude Code, type /mcp, choose tedix, then Authenticate.",
	},
	{
		id: "codex",
		name: "Codex",
		binary: "codex",
		folder: process.env.CODEX_HOME || join(home, ".codex"),
		executor: "codex",
		status: "codex",
		add: "--codex",
		signIn: ["mcp", "login", "tedix"],
	},
	{
		id: "devin",
		name: "Devin",
		binary: "devin",
		folder: join(home, ".config", "devin"),
		executor: "devin",
		status: "devin",
		add: "--devin",
		signIn: ["mcp", "login", "tedix"],
	},
	{
		id: "opencode",
		name: "OpenCode",
		binary: "opencode",
		folder: join(home, ".config", "opencode"),
		executor: "opencode",
		signInSay: "Adding Tedix here is not available yet; running tasks works.",
	},
];

export interface ToolRow {
	id: string;
	name: string;
	executor: string;
	/** `found`: its command works. `no-command`: only its settings folder is there. */
	found: "found" | "no-command" | "absent";
	/** Whether Tedix is added to it; `unknown` carries the reason in `note`. */
	tedix: "added" | "missing" | "unknown" | "checking";
	note: string;
	canAdd: boolean;
	canSignIn: boolean;
	signInSay: string;
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
	signedIn: boolean;
	who: string;
	/** The result of the one live check that the tool reaches Tedix. */
	reach: "unchecked" | "checking" | "ok" | string;
	organization: string;
	tools: ToolRow[];
	repo: string;
	steps: Record<string, StepRun>;
	/** True while the command-line tool or the sign-in is still to do. */
	open: boolean;
	summary: string;
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

let cli: CliState = { kind: "missing", version: "", canRestore: false };
let signedIn = false;
let who = "";
let organizations: string[] = [];
let tenant = "";
let reach: SetupState["reach"] = "unchecked";
let agentStatus:
	| { hosts: Record<string, Record<string, unknown>> }
	| { problem: string }
	| undefined;
const steps: Record<string, StepRun> = {};
const stops: Record<string, () => void> = {};
let changed: () => void = () => {};
export function onSetupChange(listener: () => void): void {
	changed = listener;
}

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
		const reason = safe(error instanceof Error ? error.message : String(error));
		steps[key] = {
			error: reason,
			details: [`Step: ${key}`, ...lines.slice(-40), reason].join("\n"),
		};
		log(`setup: ${key} failed (${reason})`);
	}
	delete stops[key];
	changed();
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
	signedIn = false;
	who = "";
	organizations = [];
	tenant = "";
	const result = await tedix(["-w", "connect", "auth", "status", "--json"], {
		timeoutMs: 20_000,
	});
	try {
		// Only these fields are read; the output holds no tokens.
		const status = JSON.parse(result.output) as {
			wouldUse?: string;
			storedLogin?: {
				loginId?: string;
				refreshExpiresAt?: string;
				accessToken?: { dct?: string; selectedOrganizations?: string[] };
			} | null;
		};
		const login = status.storedLogin;
		const expired =
			login?.refreshExpiresAt !== undefined &&
			Date.parse(login.refreshExpiresAt) < Date.now();
		signedIn = status.wouldUse === "stored-login" && !expired;
		who = login?.loginId ?? "";
		tenant = login?.accessToken?.dct ?? "";
		organizations = login?.accessToken?.selectedOrganizations ?? [];
	} catch {
		/* Not signed in, or no command-line tool. */
	}
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
	const result = await tedix(["setup", "agents", "--status", "--json"], {
		timeoutMs: 150_000,
	});
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
			note: "",
			canAdd: false,
			canSignIn: false,
			signInSay: "",
		};
		if (found === "absent") return row;
		if (found === "no-command") {
			row.note = `Its settings folder is here, but the ${tool.binary} command was not found. Install ${tool.name} again, then choose Check again.`;
			return row;
		}
		if (!tool.status) {
			row.note = tool.signInSay ?? "";
			return row;
		}
		if (!agentStatus) row.tedix = "checking";
		else if ("problem" in agentStatus) row.note = agentStatus.problem;
		else {
			const host = agentStatus.hosts[tool.status];
			if (host?.problem) row.note = `Not responding: ${String(host.problem)}`;
			else row.tedix = host?.installed === true ? "added" : "missing";
			if (host?.installed === true && host.enabled === false)
				row.note = `Tedix is added but switched off in ${tool.name}.`;
			if (host?.signedIn === false) row.note = "Not connected to Tedix yet.";
		}
		row.canAdd = Boolean(tool.add) && row.tedix !== "added";
		row.canSignIn = Boolean(tool.signIn) && row.tedix === "added";
		row.signInSay = row.tedix === "added" ? (tool.signInSay ?? "") : "";
		return row;
	});
}

function summaryLine(rows: ToolRow[]): string {
	if (cli.kind === "missing" || !signedIn) return "";
	const ready = rows.filter((row) => row.tedix === "added");
	const not = rows.filter((row) => row.tedix !== "added");
	const why = (row: ToolRow) =>
		row.found === "absent"
			? "not found"
			: row.found === "no-command"
				? "command not found"
				: row.tedix === "missing"
					? "Tedix not added"
					: row.tedix === "checking"
						? "checking"
						: "not checked";
	return [
		"This Mac is ready.",
		ready.length
			? `Tedix is in ${ready.map((row) => row.name).join(", ")}.`
			: "",
		not.length
			? `Not set up: ${not.map((row) => `${row.name} (${why(row)})`).join(", ")}.`
			: "",
	]
		.filter(Boolean)
		.join(" ");
}

export function setupState(): SetupState {
	const tools = toolRows();
	return {
		cli,
		signedIn,
		who,
		reach,
		organization: organization(),
		tools,
		repo: settings().repo ?? "",
		steps,
		open: cli.kind === "missing" || !signedIn,
		summary: summaryLine(tools),
	};
}

/** The one live check: the command-line tool reaches Tedix with this sign-in. */
async function checkReach(): Promise<void> {
	if (!signedIn) {
		reach = "unchecked";
		return;
	}
	reach = "checking";
	changed();
	const result = await tedix(["-w", "connect", "status"], {
		timeoutMs: 60_000,
	});
	reach = result.ok ? "ok" : lastLine(safe(result.output)) || "no answer";
	log(`setup: live check ${reach === "ok" ? "passed" : `failed (${reach})`}`);
	changed();
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
	"cancel",
	"add",
	"connect",
	"run-tasks",
	"choose-folder",
] as const;
export type SetupAction = (typeof ACTIONS)[number];

/** Carries out one button of the checklist. `chooseFolder` asks the person for the repository folder. */
export async function setupAction(
	action: SetupAction,
	id: string,
	chooseFolder: () => Promise<string | undefined>,
): Promise<void> {
	if (!ACTIONS.includes(action)) return;
	const tool = TOOLS.find((item) => item.id === id);
	if (action === "check") return refreshSetup(true);
	if (action === "cancel") return stops[id]?.();
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
			return "Signed in.";
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
			return `Tedix was added to ${tool.name}. Start a new ${tool.name} session to see it.`;
		});
		return readAgentStatus();
	}
	if (action === "connect" && tool.signIn && command) {
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
			if (await supervisorLoaded()) {
				say("Restarting the background service…");
				await must(restartSupervisor());
			} else {
				say("Installing the background service…");
				// The service keeps the PATH it is installed with, so it gets the
				// person's shell PATH and finds their coding tools.
				await must(
					tedix(["supervise", "install"], {
						env: { PATH: toolPath() },
						onLine: say,
						timeoutMs: 120_000,
					}),
				);
			}
			return `Tedix can start ${tool.name} runs on this Mac for ${org}, in ${repo}. The first run starts within a minute of being assigned.`;
		});
	}
}
