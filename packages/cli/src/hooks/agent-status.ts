/**
 * Opt-in turn-status reporter for local Claude Code and Codex sessions.
 *
 * Records one line of state per session at turn boundaries, raises a local
 * macOS notification when a session needs its owner or fails, and, with a
 * configured CLI profile, reports the change to Tedix through a detached
 * `tedix code` call. It never prints to stdout, prompts, or blocks the host turn.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";
import {
	captureOwnsStop,
	isObject,
	isoSeconds,
	type JsonObject,
	PROFILE,
	selfCommand,
} from "./hook-io";

export const REPORT_CALLABLE = "work.report_work_agent_session_status";
const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATES = new Set(["working", "needs_you", "done", "error", "ended"]);
const HARNESSES = new Set(["claude-code", "codex"]);
const TRUTHY = new Set(["1", "true", "yes"]);
const FALSY = new Set(["0", "false", "no"]);
const SUMMARY_LIMIT = 160;
const LABEL_LIMIT = 120;
export const STATUS_EVENT_LIMIT = 8 * 1024 * 1024;
const LOG_LIMIT = 1024 * 1024;
const QUESTION =
	/should i|do you want|would you like|want me to|which option|please (?:confirm|approve|choose)|let me know|need your|waiting for you/i;
const SUBTITLES: Record<string, string> = {
	needs_you: "Needs you",
	error: "Error",
};
const RULE = /^[-*_=|: ]+$/;

/**
 * Seam for a future session supervisor: when it auto-continues a Stop, it
 * writes `<harness>-<session>` + this suffix into the status directory before
 * the host's Stop hooks run. The reporter consumes the marker and records the
 * session as still working instead of waiting on its owner.
 */
export const SUPERVISOR_CONTINUED_SUFFIX = ".supervisor-continued";

/**
 * Written when a Tedix auto reply continues a session (`recordAutoContinued`).
 * The Stop that ends the continued turn consumes it and is classified even
 * though the host reports `stop_hook_active` (Codex does after a Stop hook
 * continues the turn), so the session does not stay `working`.
 */
export const AUTO_CONTINUED_SUFFIX = ".auto-continued";

/** Options for detached children: a new process group with no stdin. */
export const DETACHED = { detached: true, stdin: "ignore" } as const;

export interface StatusDeps {
	env: NodeJS.ProcessEnv;
	stdin: string;
	cwd: string;
	platform?: NodeJS.Platform;
	/** Resolve an executable on PATH, or undefined. */
	which?: (name: string) => string | undefined;
	/** Start a detached child; `tedix` means this CLI. */
	spawn?: (args: string[], options: typeof DETACHED) => void;
	label?: (cwd: unknown) => string;
	now?: () => Date;
	/**
	 * True when `tedix hooks capture-stop` owns this chat's Stop status, so this
	 * hook leaves it alone. Defaults to the local decision-capture opt-in check.
	 */
	captureOwnsStop?: (stdin: string, env: NodeJS.ProcessEnv) => boolean;
}

type Outcome = [state: string, summary: string];

/** Server urgency triage of one agent turn (`work.triage_agent_turn`). */
export interface TriageResult {
	status: "ok" | "unavailable";
	urgency: "now" | "later";
	labels: Record<string, number>;
	urgentLabels: string[];
	model: string;
	policyVersion: number;
	latencyMs: number;
}

function baseDir(env: NodeJS.ProcessEnv): string {
	return env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

export function statusDir(env: NodeJS.ProcessEnv): string {
	return join(baseDir(env), "agent-status");
}

export function statusLog(env: NodeJS.ProcessEnv, message: string): void {
	try {
		const directory = statusDir(env);
		if (!existsSync(directory)) return;
		const path = join(directory, "report.log");
		if (existsSync(path) && statSync(path).size > LOG_LIMIT)
			renameSync(path, join(directory, "report.log.1"));
		appendFileSync(path, `${isoSeconds(new Date(), true)} ${message}\n`);
	} catch {
		// Logging is best effort.
	}
}

function loadConfig(env: NodeJS.ProcessEnv): JsonObject {
	try {
		const value: unknown = JSON.parse(
			readFileSync(join(baseDir(env), "agent-status.json"), "utf8"),
		);
		return isObject(value) ? value : {};
	} catch {
		return {};
	}
}

/** Profile, organization and notify when the owner opted in, else undefined. */
export function statusSettings(
	env: NodeJS.ProcessEnv,
): { profile?: string; organization?: string; notify: boolean } | undefined {
	const config = loadConfig(env);
	const toggle = (env.TEDIX_AGENT_STATUS ?? "").trim().toLowerCase();
	if (FALSY.has(toggle)) return undefined;
	if (!TRUTHY.has(toggle) && config.enabled !== true) return undefined;
	const profile = env.TEDIX_AGENT_STATUS_PROFILE || config.profile;
	// A Connect profile spans organizations; without one it reports to its default.
	const organization =
		env.TEDIX_AGENT_STATUS_ORGANIZATION || config.organization;
	return {
		...(typeof profile === "string" && PROFILE.test(profile)
			? { profile }
			: {}),
		...(typeof organization === "string" && ORGANIZATION.test(organization)
			? { organization }
			: {}),
		notify: config.notify !== false,
	};
}

export function oneLine(value: unknown, limit: number): string {
	const text = String(value)
		.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function stripMarkdown(line: string): string {
	return line
		.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|\*|_|`+|~~)/g, "")
		.trim();
}

function paragraphs(message: string): string[] {
	const withoutCode = message.replace(
		/```.*?(?:```|$)|~~~.*?(?:~~~|$)/gs,
		"\n\n",
	);
	const blocks: string[] = [];
	for (const block of withoutCode.split(/\n\s*\n/)) {
		const text = block
			.split(/\r\n|\r|\n/)
			.map(stripMarkdown)
			.filter((line) => line && !RULE.test(line))
			.join(" ")
			.trim();
		if (text) blocks.push(text);
	}
	return blocks;
}

function firstMeaningfulLine(message: string): string {
	let inFence = false;
	for (const raw of message.split(/\r\n|\r|\n/)) {
		const stripped = raw.trim();
		if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !stripped || stripped.startsWith("#") || RULE.test(stripped))
			continue;
		const line = stripMarkdown(stripped);
		if (line) return line;
	}
	return "";
}

function doneSummary(message: string, last: string): string {
	return oneLine(
		firstMeaningfulLine(message) || last || "Turn complete",
		SUMMARY_LIMIT,
	);
}

export function classifyStop(message: unknown): Outcome {
	if (typeof message !== "string" || !message.trim())
		return ["done", "Turn complete"];
	const blocks = paragraphs(message);
	const last = blocks.at(-1) ?? "";
	if (last && (last.trimEnd().endsWith("?") || QUESTION.test(last)))
		return ["needs_you", oneLine(last, SUMMARY_LIMIT)];
	return ["done", doneSummary(message, last)];
}

/** Notification prefixes for urgent triage labels, most specific first. */
const URGENT: Array<[RegExp, string]> = [
	[/block|fail|error|stuck|broken/i, "Blocker"],
	[
		/login|consent|auth|mfa|credential|approv|permission|secret|access/i,
		"Needs you (login/consent)",
	],
	[
		/risk|deploy|delete|destruct|irreversib|prod|release|spend|payment/i,
		"Risky (deploy/delete)",
	],
];

/**
 * Map a Stop to [state, summary] from server triage. Without an `ok` triage the
 * regex classifier decides, so an unavailable triage never changes behavior.
 */
export function triagedOutcome(
	message: unknown,
	triage: TriageResult | undefined,
): Outcome {
	if (triage?.status !== "ok" || typeof message !== "string" || !message.trim())
		return classifyStop(message);
	const blocks = paragraphs(message);
	const last = blocks.at(-1) ?? "";
	if (triage.urgency !== "now") return ["done", doneSummary(message, last)];
	const line = firstMeaningfulLine(message) || last || "Agent turn ended";
	const prefix =
		URGENT.find(([pattern]) =>
			triage.urgentLabels.some((label) => pattern.test(label)),
		)?.[1] ?? "Needs you";
	const [state, summary] = classifyStop(message);
	return [
		"needs_you",
		oneLine(
			`${prefix}: ${prefix === "Needs you" && state === "needs_you" ? summary : line}`,
			SUMMARY_LIMIT,
		),
	];
}

function sortedJson(value: unknown): string {
	const sort = (item: unknown): unknown =>
		Array.isArray(item)
			? item.map(sort)
			: isObject(item)
				? Object.fromEntries(
						Object.keys(item)
							.sort()
							.map((key) => [key, sort(item[key])]),
					)
				: item;
	return JSON.stringify(sort(value)) ?? "";
}

function describeToolInput(input: unknown): string {
	if (isObject(input)) {
		for (const key of [
			"command",
			"description",
			"file_path",
			"path",
			"url",
			"pattern",
			"query",
			"prompt",
		]) {
			const value = input[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		return Object.keys(input).length ? sortedJson(input).slice(0, 200) : "";
	}
	return String(input || "");
}

function textOf(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (isObject(value))
		for (const key of ["message", "type", "error"])
			if (typeof value[key] === "string") return value[key];
	return sortedJson(value).slice(0, 200);
}

/**
 * Map a host event to [state, summary]; undefined means the event is ignored.
 * `supervisorContinued` marks a Stop the supervisor auto-continued: the session
 * keeps working and is never reported as waiting on its owner.
 */
export function transition(
	event: JsonObject,
	{ supervisorContinued = false }: { supervisorContinued?: boolean } = {},
): Outcome | undefined {
	const name = event.hook_event_name;
	if (name === "UserPromptSubmit" || name === "PostToolUse")
		return ["working", "Working"];
	if (name === "PermissionRequest") {
		const tool = oneLine(event.tool_name || "tool", 60);
		const detail = oneLine(describeToolInput(event.tool_input), SUMMARY_LIMIT);
		return [
			"needs_you",
			oneLine(
				detail ? `Approve ${tool}: ${detail}` : `Approve ${tool}`,
				SUMMARY_LIMIT,
			),
		];
	}
	if (name === "Notification") {
		if (
			["permission_prompt", "elicitation_dialog"].includes(
				event.notification_type,
			)
		)
			return [
				"needs_you",
				oneLine(event.message || "Waiting for your input", SUMMARY_LIMIT),
			];
		return undefined;
	}
	if (name === "StopFailure") {
		const error = textOf(event.error) || "Turn failed";
		const details = textOf(event.error_details || event.details);
		return [
			"error",
			oneLine(details ? `${error}: ${details}` : error, SUMMARY_LIMIT),
		];
	}
	if (name === "Stop") {
		if (event.stop_hook_active) return undefined;
		if (supervisorContinued) return ["working", "Continued by supervisor"];
		return classifyStop(event.last_assistant_message);
	}
	if (name === "SessionEnd")
		return [
			"ended",
			oneLine(
				typeof event.reason === "string"
					? `Session ended (${event.reason})`
					: "Session ended",
				SUMMARY_LIMIT,
			),
		];
	return undefined;
}

export function harnessOf(event: JsonObject, env: NodeJS.ProcessEnv): string {
	return (event.turn_id !== undefined && event.turn_id !== null) ||
		env.CODEX_THREAD_ID ||
		env.CODEX_SESSION_ID
		? "codex"
		: "claude-code";
}

function labelFor(cwd: unknown, fallback: string): string {
	const directory = typeof cwd === "string" && cwd ? cwd : fallback;
	let folder = basename(normalize(directory)) || directory;
	try {
		const lines = execFileSync(
			"git",
			["-C", directory, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
		)
			.split(/\r?\n/)
			.filter(Boolean);
		if (lines.length === 2) {
			folder = basename(lines[0]!) || folder;
			return oneLine(`${folder} · ${lines[1]}`, LABEL_LIMIT);
		}
	} catch {
		// Outside a repository: the folder name is the label.
	}
	return oneLine(folder, LABEL_LIMIT);
}

function readState(path: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeState(path: string, record: JsonObject): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
	renameSync(temporary, path);
}

/** Atomically consume a marker file; true when it existed. */
function consume(path: string): boolean {
	try {
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}

/** A JSON literal that is pure ASCII, safe inside generated source. */
export function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-￿]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function reportSource(payload: JsonObject): string {
	if (
		!HARNESSES.has(payload.harness) ||
		!STATES.has(payload.state) ||
		!SESSION_KEY.test(String(payload.sessionKey ?? ""))
	)
		throw new Error("invalid report payload");
	const fields = {
		harness: payload.harness,
		sessionKey: payload.sessionKey,
		state: payload.state,
		summary: oneLine(payload.summary || "", SUMMARY_LIMIT),
		label: oneLine(payload.label || "", LABEL_LIMIT),
	};
	return `async () => await ${REPORT_CALLABLE}(${asciiJson(fields)})`;
}

function detachedSpawner(env: NodeJS.ProcessEnv) {
	return (args: string[], options: typeof DETACHED): void => {
		const [command, prefix] =
			args[0] === "tedix" ? selfCommand() : [args[0]!, [] as string[]];
		const output = openSync(join(statusDir(env), "report.log"), "a");
		try {
			spawn(command, [...prefix, ...args.slice(1)], {
				env: { ...env },
				detached: options.detached,
				stdio: [options.stdin, output, output],
			}).unref();
		} finally {
			closeSync(output);
		}
	};
}

function supervisorMarker(
	directory: string,
	harness: string,
	sessionKey: string,
): string {
	return join(
		directory,
		`${harness}-${sessionKey}${SUPERVISOR_CONTINUED_SUFFIX}`,
	);
}

export async function runAgentStatus(deps: StatusDeps): Promise<void> {
	const { env } = deps;
	const configured = statusSettings(env);
	if (!configured) return;
	const raw = deps.stdin;
	if (!raw || raw.length > STATUS_EVENT_LIMIT) return;
	const event: unknown = JSON.parse(raw);
	if (!isObject(event)) return;
	const sessionKey = event.session_id;
	if (typeof sessionKey !== "string" || !SESSION_KEY.test(sessionKey)) return;
	// With decision capture on, capture-stop triages and owns Stop: one notification per Stop.
	if (
		event.hook_event_name === "Stop" &&
		(deps.captureOwnsStop ?? captureOwnsStop)(raw, env)
	)
		return;
	const harness = harnessOf(event, env);
	const directory = statusDir(env);
	const previous = readState(join(directory, `${harness}-${sessionKey}.json`));
	if (
		event.hook_event_name === "PostToolUse" &&
		previous?.state !== "needs_you"
	)
		return;
	const supervisorContinued =
		event.hook_event_name === "Stop" &&
		consume(supervisorMarker(directory, harness, sessionKey));
	const outcome = transition(event, { supervisorContinued });
	if (!outcome) return;
	recordStatus(deps, configured, event, harness, sessionKey, outcome);
}

/**
 * The Stop status for a chat whose decision capture owns Stop: the same local
 * state, notification and report as `runAgentStatus`, classified from server
 * triage when it is available and from the regex classifier otherwise.
 */
export async function applyTriagedStop(
	deps: StatusDeps,
	event: JsonObject,
	triage: TriageResult | undefined,
): Promise<void> {
	const configured = statusSettings(deps.env);
	if (!configured) return;
	const sessionKey = event.session_id;
	if (typeof sessionKey !== "string" || !SESSION_KEY.test(sessionKey)) return;
	const harness = harnessOf(event, deps.env);
	const supervisorContinued = consume(
		supervisorMarker(statusDir(deps.env), harness, sessionKey),
	);
	const autoContinued = consume(
		join(
			statusDir(deps.env),
			`${harness}-${sessionKey}${AUTO_CONTINUED_SUFFIX}`,
		),
	);
	if (event.stop_hook_active && !autoContinued) return;
	const outcome: Outcome = supervisorContinued
		? ["working", "Continued by supervisor"]
		: triagedOutcome(event.last_assistant_message, triage);
	recordStatus(deps, configured, event, harness, sessionKey, outcome);
}

/**
 * Record the session as working now because a Tedix auto reply continued it
 * after its Stop was already recorded. Unlike the supervisor marker, which the
 * next Stop consumes, this leaves the next Stop to be classified normally, so
 * an urgent turn after an auto reply still notifies. `working` never notifies.
 */
export function recordAutoContinued(deps: StatusDeps, event: JsonObject): void {
	const configured = statusSettings(deps.env);
	if (!configured) return;
	const sessionKey = event.session_id;
	if (typeof sessionKey !== "string" || !SESSION_KEY.test(sessionKey)) return;
	const harness = harnessOf(event, deps.env);
	recordStatus(deps, configured, event, harness, sessionKey, [
		"working",
		"Continued by Tedix auto reply",
	]);
	writeFileSync(
		join(
			statusDir(deps.env),
			`${harness}-${sessionKey}${AUTO_CONTINUED_SUFFIX}`,
		),
		"",
		{ mode: 0o600 },
	);
}

function recordStatus(
	deps: StatusDeps,
	configured: NonNullable<ReturnType<typeof statusSettings>>,
	event: JsonObject,
	harness: string,
	sessionKey: string,
	[state, summary]: Outcome,
): void {
	const { env } = deps;
	const directory = statusDir(env);
	const path = join(directory, `${harness}-${sessionKey}.json`);
	const previous = readState(path);
	const previousState = previous?.state;
	const changed =
		!previous ||
		previousState !== state ||
		(["done", "needs_you"].includes(state) && previous.summary !== summary);
	if (!changed) return;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const label = (deps.label ?? ((cwd) => labelFor(cwd, deps.cwd)))(event.cwd);
	const record = {
		harness,
		sessionKey,
		state,
		summary,
		label,
		cwd: typeof event.cwd === "string" ? event.cwd : "",
		updatedAt: isoSeconds((deps.now ?? (() => new Date()))(), true),
	};
	if (state === "ended") rmSync(path, { force: true });
	else writeState(path, record);
	const start = deps.spawn ?? detachedSpawner(env);
	const platform = deps.platform ?? process.platform;
	const which = deps.which ?? ((name: string) => Bun.which(name) ?? undefined);
	if (configured.notify && SUBTITLES[state] && previousState !== state) {
		try {
			if (platform === "darwin" && which("osascript"))
				// Values travel as argv, never interpolated into AppleScript source.
				start(
					[
						"osascript",
						"-e",
						"on run argv",
						"-e",
						"display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
						"-e",
						"end run",
						summary || SUBTITLES[state]!,
						oneLine(`Tedix · ${label}`, LABEL_LIMIT + 10),
						SUBTITLES[state]!,
					],
					DETACHED,
				);
		} catch (error) {
			statusLog(env, `notify failed: ${(error as Error).name}`);
		}
	}
	if (configured.profile)
		start(
			[
				"tedix",
				"-w",
				configured.profile,
				...(configured.organization
					? ["--organization", configured.organization]
					: []),
				"code",
				reportSource(record),
			],
			DETACHED,
		);
}
