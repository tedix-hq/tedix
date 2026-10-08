/**
 * `tedix learn import-sessions`: teach Tedix from a person's own past local
 * agent sessions (Claude Code transcripts under ~/.claude/projects, Codex
 * rollouts under ~/.codex/sessions and ~/.codex/archived_sessions).
 *
 * Only decision pairs leave the machine: the redacted tail of the agent's last
 * message before a genuine user reply, and that redacted reply. Tool output,
 * host and hook injections, pasted logs and code, slash commands, sub-agent
 * and automation threads are dropped; whole transcripts are never uploaded.
 *
 * Each session goes to the organization its repository is bound to
 * (`tedix setup agents context`); a session outside any repository goes to the
 * default organization (the one hooks use outside a repository). A repository
 * session with no unambiguous binding is skipped and counted, never guessed.
 * After the upload the caller's own decisions are mined into personal lessons.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	AGENT_SESSION_DECISION_LIMITS,
	type AgentSessionDecision,
} from "@tedix/api-contract/schemas/agent-session-decisions";
import {
	defaultOrganizationTarget,
	normalizeGitOrigin,
	repositoryTargetsByOrigin,
	type OrganizationTarget,
} from "./agent-context";
import { asciiJson } from "./hooks/agent-status";
import { classify, redact } from "./hooks/decision-capture";
import { cliRead, type ReadJson } from "./hooks/hook-io";

type Harness = AgentSessionDecision["harness"];
type Json = Record<string, any>;

/** One extracted pair before routing. */
export interface SessionDecision extends AgentSessionDecision {
	/** Normalized Git origin, or null outside a repository. */
	origin: string | null;
}

export interface SessionFile {
	harness: Harness;
	path: string;
}

/** Replies shorter than this ("yes", "continue") teach nothing on their own. */
const MIN_REPLY_CHARS = 24;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const AGENT_CHARS = AGENT_SESSION_DECISION_LIMITS.agentMessageChars - 40;
const REPLY_CHARS = AGENT_SESSION_DECISION_LIMITS.replyChars - 40;

/** Text that reached the user turn but was not typed by the person. */
const INJECTED =
	/^\s*(?:<|\{|\[|>>>|# AGENTS\.md|#+ Files (?:mentioned|pasted) by the user|Base directory for this skill|This session is being continued|Caveat:|Another (?:Claude|Codex) session sent|The following is the Codex|Reviewed Codex session|The Codex agent has|Assess the exact|Planned action JSON|Some conversation entries|Continue working toward|Tedix [^\n]{1,120}? replied for the user|No response requested|Reply OK\b)/i;
/** Test and harness prompts about the agent setup itself, not the person's work. */
const META_PROMPT =
	/\b(without (?:using )?tools|use no tools|report only|reply (?:only )?with|respond only|say only|tedix context received)\b/i;
const LOG_LINE =
	/^\s*(?:at\s+\S+|\d{4}-\d{2}-\d{2}[T ]\d|\[[A-Za-z0-9:._ -]{1,40}\]|[{}[\],]|"[^"]+":|\$\s|>\s|[\w./-]+:\d+(?::\d+)?\b|(?:error|warn(?:ing)?|info|debug|trace)\b[:\]]|[│├└─┌┐┘┬┴┼|+-]{3,}|\d+\s+(?:passed|failed)|✓|✗|×)/i;

const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Extra scrubbing on top of the hooks' secret patterns. */
export function scrub(text: string, home = homedir()): string {
	return (
		text
			.replace(/pass:\/\/\S+/g, "[secret ref]")
			.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
			.replace(/(https?:\/\/[^\s?#)\]]+)[?#][^\s)\]]*/g, "$1")
			.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]")
			.replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
			// Random-looking mixed-case-and-digit runs are treated as credentials.
			.replace(
				/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{24,}\b/g,
				"[redacted]",
			)
			.split(home)
			.join("~")
	);
}

function bounded(text: string, limit: number, keep: "head" | "tail"): string {
	const [value] = redact(scrub(text), limit, keep);
	return value;
}

/**
 * The person's own words in a user turn, of any length, or null when the turn
 * is host or hook injection, a slash command, an interruption or a pasted log.
 */
export function humanText(raw: string): string | null {
	let text = raw;
	const request = text.lastIndexOf("## My request");
	if (request >= 0) text = text.slice(text.indexOf("\n", request) + 1);
	text = text
		// Claude Code does not always close a paste block: drop it to the end.
		.replace(/<pasted_content[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g, "")
		.replace(/<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "")
		.replace(/<image [^>]*>/g, "")
		.replace(/```[\s\S]*?(?:```|$)/g, "")
		.split("\n")
		.filter(
			(line) =>
				!/^#+ Files (?:mentioned|pasted) by the user/i.test(line) &&
				!/^## .{1,200}: (?:\/|~)/.test(line) &&
				!/^Image attachment:/i.test(line),
		)
		.join("\n")
		.trim();
	if (
		!text ||
		INJECTED.test(text) ||
		META_PROMPT.test(text) ||
		/^\[Request interrupted/.test(text)
	)
		return null;
	const lines = text.split("\n").filter((line) => line.trim());
	if (
		lines.length >= 6 &&
		lines.filter((line) => LOG_LINE.test(line)).length * 2 >= lines.length
	)
		return null;
	return text;
}

/** A reply long enough to teach something on its own. */
export function humanReply(raw: string): string | null {
	const text = humanText(raw);
	return text && text.length >= MIN_REPLY_CHARS ? text : null;
}

function agentText(raw: string): string {
	return raw
		.replace(/<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "")
		.replace(/```[\s\S]*?(?:```|$)/g, "[code]")
		.replace(/\s+/g, " ")
		.trim();
}

export function textParts(content: unknown, type: string): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part) => part && part.type === type && typeof part.text === "string",
		)
		.map((part) => part.text as string)
		.join("\n");
}

export function parseLines(path: string): Json[] {
	if (statSync(path).size > MAX_FILE_BYTES) return [];
	const rows: Json[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") rows.push(value);
		} catch {
			/* A torn final line of a live session. */
		}
	}
	return rows;
}

export interface ParsedSession {
	harness: Harness;
	sessionId: string;
	cwd: string | null;
	/** Git origin the host recorded, when it did. */
	origin: string | null;
	branch: string | null;
	pairs: Array<{
		turnId: string;
		occurredAt: string;
		agentMessage: string;
		reply: string;
	}>;
	/** Why the whole session was skipped, if it was. */
	skipped?: "subagent" | "automation" | "empty";
}

function pair(
	agent: string,
	reply: string,
	turnId: string,
	occurredAt: string,
): ParsedSession["pairs"][number] {
	return {
		turnId,
		occurredAt,
		agentMessage: bounded(agentText(agent), AGENT_CHARS, "tail"),
		reply: bounded(reply, REPLY_CHARS, "head"),
	};
}

/** One Claude Code transcript (`~/.claude/projects/<dir>/<session>.jsonl`). */
export function parseClaudeSession(rows: Json[]): ParsedSession {
	const session: ParsedSession = {
		harness: "claude-code",
		sessionId: "",
		cwd: null,
		origin: null,
		branch: null,
		pairs: [],
	};
	let agent = "";
	let agentId: unknown;
	for (const row of rows) {
		if (typeof row.sessionId === "string" && !session.sessionId)
			session.sessionId = row.sessionId;
		if (typeof row.cwd === "string") session.cwd = row.cwd;
		if (typeof row.gitBranch === "string" && row.gitBranch)
			session.branch = row.gitBranch;
		if (row.isSidechain) continue;
		if (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk"))
			return { ...session, pairs: [], skipped: "automation" };
		const message = row.message;
		if (row.type === "assistant" && message) {
			const text = textParts(message.content, "text").trim();
			if (!text) continue;
			agent = message.id && message.id === agentId ? `${agent}\n${text}` : text;
			agentId = message.id;
			continue;
		}
		if (row.type !== "user" || !message || row.isMeta || row.isCompactSummary)
			continue;
		if (row.toolUseResult) continue;
		const content = message.content;
		if (
			Array.isArray(content) &&
			content.some((part) => part?.type === "tool_result")
		)
			continue;
		const kind = row.origin?.kind;
		if (kind !== undefined && kind !== "human") continue;
		const reply = humanReply(textParts(content, "text"));
		if (!reply || !agent || typeof row.timestamp !== "string") continue;
		session.pairs.push(
			pair(agent, reply, String(row.uuid ?? row.timestamp), row.timestamp),
		);
		agent = "";
	}
	if (!session.sessionId) return { ...session, skipped: "empty" };
	return session;
}

/** One Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). */
export function parseCodexSession(rows: Json[]): ParsedSession {
	const session: ParsedSession = {
		harness: "codex",
		sessionId: "",
		cwd: null,
		origin: null,
		branch: null,
		pairs: [],
	};
	const meta = rows.find((row) => row.type === "session_meta")?.payload;
	if (!meta) return { ...session, skipped: "empty" };
	// A fork replays its parent's turns: key them by the root session so a
	// re-import is idempotent across both files.
	session.sessionId = String(meta.session_id ?? meta.id ?? "");
	session.cwd = typeof meta.cwd === "string" ? meta.cwd : null;
	session.origin =
		typeof meta.git?.repository_url === "string"
			? meta.git.repository_url
			: null;
	session.branch =
		typeof meta.git?.branch === "string" ? meta.git.branch : null;
	const source = meta.thread_source;
	if (
		(typeof meta.source === "object" && meta.source?.subagent) ||
		source === "subagent" ||
		source === "guardian_review"
	)
		return { ...session, skipped: "subagent" };
	if (source !== undefined && source !== null && source !== "user")
		return { ...session, skipped: "automation" };
	let agent = "";
	for (const row of rows) {
		const payload = row.payload;
		if (row.type !== "response_item" || payload?.type !== "message") continue;
		if (payload.role === "assistant") {
			const text = textParts(payload.content, "output_text").trim();
			if (text) agent = text;
			continue;
		}
		if (payload.role !== "user" || typeof row.timestamp !== "string") continue;
		const reply = humanReply(textParts(payload.content, "input_text"));
		if (!reply || !agent) continue;
		session.pairs.push(
			pair(agent, reply, `${row.timestamp}#${sha(reply)}`, row.timestamp),
		);
		agent = "";
	}
	if (!session.sessionId) return { ...session, skipped: "empty" };
	return session;
}

function jsonlFiles(directory: string, depth: number): string[] {
	if (!existsSync(directory)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && depth > 0)
			out.push(...jsonlFiles(path, depth - 1));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

/** Top-level transcripts only: sub-agent transcripts live in subdirectories. */
export function sessionFiles(home = homedir()): SessionFile[] {
	const claude = join(home, ".claude", "projects");
	const codex = join(home, ".codex");
	return [
		...(existsSync(claude)
			? readdirSync(claude, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.flatMap((entry) => jsonlFiles(join(claude, entry.name), 0))
			: []
		).map((path) => ({ harness: "claude-code" as const, path })),
		...[
			...jsonlFiles(join(codex, "sessions"), 4),
			...jsonlFiles(join(codex, "archived_sessions"), 0),
		].map((path) => ({ harness: "codex" as const, path })),
	];
}

export type Location =
	| { kind: "repo"; origin: string; repository: string }
	| { kind: "none" }
	| { kind: "unknown" };

function gitOrigin(directory: string): string | null | undefined {
	try {
		execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: directory,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
	} catch {
		return null;
	}
	try {
		return execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
	} catch {
		return undefined;
	}
}

/** Where a session ran: a repository (by origin), no repository, or unknown. */
export function locate(
	session: Pick<ParsedSession, "cwd" | "origin">,
	originOf: (directory: string) => string | null | undefined = gitOrigin,
): Location {
	const repo = (origin: string): Location => {
		const normalized = normalizeGitOrigin(origin);
		return {
			kind: "repo",
			origin: normalized,
			repository: basename(normalized) || normalized,
		};
	};
	if (session.origin) return repo(session.origin);
	if (!session.cwd) return { kind: "unknown" };
	// A removed Claude Code worktree still names its checkout.
	const marker = session.cwd.indexOf("/.claude/worktrees/");
	const directory =
		!existsSync(session.cwd) && marker > 0
			? session.cwd.slice(0, marker)
			: session.cwd;
	if (!existsSync(directory)) return { kind: "unknown" };
	const origin = originOf(directory);
	if (origin === null) return { kind: "none" };
	if (!origin) return { kind: "unknown" };
	return repo(origin);
}

export interface ImportPlan {
	files: number;
	sessions: Record<Harness, number>;
	skippedSessions: Record<string, number>;
	pairs: number;
	byTarget: Map<
		string,
		{ target: OrganizationTarget; decisions: AgentSessionDecision[] }
	>;
	unrouted: {
		unboundRepository: Record<string, number>;
		unknownLocation: number;
		noDefaultOrganization: number;
	};
}

export function targetKey(target: OrganizationTarget): string {
	return `${target.workspace}/${target.organization ?? target.org}`;
}

export type Unrouted = ImportPlan["unrouted"];

export function emptyUnrouted(): Unrouted {
	return {
		unboundRepository: {},
		unknownLocation: 0,
		noDefaultOrganization: 0,
	};
}

/** `locate`, cached per (origin, cwd) so each checkout is asked once. */
export function sessionLocator(
	originOf?: (directory: string) => string | null | undefined,
): (session: Pick<ParsedSession, "cwd" | "origin">) => Location {
	const cache = new Map<string, Location>();
	return (session) => {
		const key = `${session.origin ?? ""}\n${session.cwd ?? ""}`;
		const location = cache.get(key) ?? locate(session, originOf);
		cache.set(key, location);
		return location;
	};
}

/**
 * The organization a located session belongs to: its repository's binding, or
 * the default organization outside a repository. Anything else is counted in
 * `unrouted` (by `weight`) and gets no target; an organization is never guessed.
 */
export function routedTarget(
	location: Location,
	input: {
		targets: Map<string, OrganizationTarget>;
		defaultTarget: OrganizationTarget | undefined;
	},
	unrouted: Unrouted,
	weight: number,
): OrganizationTarget | undefined {
	if (location.kind === "repo") {
		const target = input.targets.get(location.origin);
		if (!target)
			unrouted.unboundRepository[location.repository] =
				(unrouted.unboundRepository[location.repository] ?? 0) + weight;
		return target;
	}
	if (location.kind === "none") {
		if (!input.defaultTarget) unrouted.noDefaultOrganization += weight;
		return input.defaultTarget;
	}
	unrouted.unknownLocation += weight;
	return undefined;
}

/** Extract, route and dedupe every pair; reads local files only. */
export function planImport(input: {
	files: SessionFile[];
	since?: string;
	limit?: number;
	targets: Map<string, OrganizationTarget>;
	defaultTarget: OrganizationTarget | undefined;
	originOf?: (directory: string) => string | null | undefined;
	read?: (path: string) => Json[];
}): ImportPlan {
	const plan: ImportPlan = {
		files: input.files.length,
		sessions: { "claude-code": 0, codex: 0 },
		skippedSessions: {},
		pairs: 0,
		byTarget: new Map(),
		unrouted: emptyUnrouted(),
	};
	const seen = new Set<string>();
	const locateSession = sessionLocator(input.originOf);
	const read = input.read ?? parseLines;
	for (const file of input.files) {
		let rows: Json[];
		try {
			rows = read(file.path);
		} catch {
			continue;
		}
		const session =
			file.harness === "codex"
				? parseCodexSession(rows)
				: parseClaudeSession(rows);
		if (session.skipped) {
			plan.skippedSessions[session.skipped] =
				(plan.skippedSessions[session.skipped] ?? 0) + 1;
			continue;
		}
		const pairs = session.pairs.filter(
			(p) => !input.since || p.occurredAt >= input.since,
		);
		if (pairs.length === 0) continue;
		plan.sessions[session.harness]++;
		const location = locateSession(session);
		const target = routedTarget(location, input, plan.unrouted, pairs.length);
		if (!target) continue;
		const key = targetKey(target);
		const bucket = plan.byTarget.get(key) ?? { target, decisions: [] };
		plan.byTarget.set(key, bucket);
		for (const p of pairs) {
			// Forks and resumed sessions replay turns: one pair per reply moment.
			const identity = `${session.harness}\n${p.occurredAt}\n${sha(p.reply)}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			if (input.limit !== undefined && plan.pairs >= input.limit) break;
			bucket.decisions.push({
				harness: session.harness,
				sessionId: session.sessionId,
				turnId: p.turnId,
				repository: location.kind === "repo" ? location.repository : null,
				...(session.branch ? { branch: session.branch.slice(0, 200) } : {}),
				topic: classify(p.reply),
				occurredAt: new Date(p.occurredAt).toISOString(),
				agentMessage: p.agentMessage,
				reply: p.reply,
			});
			plan.pairs++;
		}
	}
	return plan;
}

export const learnUsage = `Teach Tedix from your past local agent sessions

  tedix learn import-sessions [--dry-run] [--since <YYYY-MM-DD>] [--limit <n>] [--no-mine] [--json]

Reads your Claude Code transcripts (~/.claude/projects) and Codex sessions
(~/.codex/sessions, ~/.codex/archived_sessions) on this machine and sends only
decision pairs: the redacted tail of the agent's last message before each of
your replies, and your redacted reply. Tool output, injected context, pasted
logs, slash commands and sub-agent threads stay local; no transcript is uploaded.

A session in a repository goes to the organization that repository is bound
to (tedix setup agents context bind); a session outside any repository goes to
your default organization. Anything else is skipped and counted.
Re-running is safe: imported turns are recognized and not recorded twice.
After the upload your decisions are mined into personal lessons (--no-mine
skips that; the nightly reflection also mines them).

--dry-run prints counts and five samples and sends nothing.

  tedix learn analyze-sessions [--dry-run] [--since <YYYY-MM-DD>]
      [--project [<workspace>/<organization>=]<project-id>] [--no-model] [--json]

Reads the same sessions whole and keeps, per organization, one Work Item for
each of: repeated requests (skill or command candidates), friction hotspots
(repeated tool errors, retry loops, denials, stalls) and a decision log. Only
counts and short redacted paraphrases are sent; a re-run updates the same three
items. Decisions are extracted by your local claude CLI (--no-model skips them).
--project files new items under that project; existing items are found and
updated in place.`;

export interface LearnDeps {
	home?: string;
	read?: ReadJson;
	write?: (line: string) => void;
	targets?: Map<string, OrganizationTarget>;
	defaultTarget?: OrganizationTarget | undefined;
	/** Retry pause (tests). */
	sleep?: (ms: number) => Promise<void>;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} needs a value`);
	return value;
}

function summary(plan: ImportPlan) {
	return {
		files: plan.files,
		sessions: plan.sessions,
		skippedSessions: plan.skippedSessions,
		pairs: plan.pairs,
		targets: Object.fromEntries(
			[...plan.byTarget].map(([key, bucket]) => [
				key,
				{
					pairs: bucket.decisions.length,
					repositories: bucket.decisions.reduce<Record<string, number>>(
						(acc, d) => {
							const repo = d.repository ?? "(no repository)";
							acc[repo] = (acc[repo] ?? 0) + 1;
							return acc;
						},
						{},
					),
				},
			]),
		),
		unrouted: plan.unrouted,
	};
}

function samples(plan: ImportPlan, count: number): AgentSessionDecision[] {
	const all = [...plan.byTarget.values()].flatMap((b) => b.decisions);
	if (all.length <= count) return all;
	const step = all.length / count;
	return Array.from({ length: count }, (_, i) => all[Math.floor(i * step)]!);
}

const CALL_TIMEOUT_MS = 120_000;
const MAX_MINE_PASSES = 8;
/** A mining pass outlives the gateway wait and keeps running server-side; give
 * it time to finish before asking again, so passes do not overlap. */
const MINE_TIMEOUT_PAUSE_MS = 60_000;
const IMPORT_ATTEMPTS = 3;
/** Pause before a retry; the gateway rate-limits bursts of writes. */
const RETRY_PAUSE_MS = 5_000;

export async function runLearnCommand(
	argv: string[],
	deps: LearnDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const [action, ...args] = argv;
	if (!action || action === "--help" || action === "-h" || action === "help") {
		write(learnUsage);
		return 0;
	}
	if (action === "analyze-sessions") {
		const { runAnalyzeSessions } = await import("./learn-analyze");
		return runAnalyzeSessions(args, deps);
	}
	if (action !== "import-sessions") {
		write(learnUsage);
		return 2;
	}
	const known = new Set([
		"--dry-run",
		"--since",
		"--limit",
		"--no-mine",
		"--json",
	]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!known.has(arg)) throw new Error(`Unknown option ${arg}`);
		if (arg === "--since" || arg === "--limit") i++;
	}
	const sinceArg = option(args, "--since");
	const since = sinceArg ? new Date(sinceArg) : undefined;
	if (since && Number.isNaN(since.getTime()))
		throw new Error("--since must be a date, e.g. 2026-01-01");
	const limitArg = option(args, "--limit");
	const limit = limitArg ? Number(limitArg) : undefined;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
		throw new Error("--limit must be a positive integer");
	const dryRun = args.includes("--dry-run");
	const json = args.includes("--json");

	const plan = planImport({
		files: sessionFiles(deps.home),
		since: since?.toISOString(),
		limit,
		targets: deps.targets ?? repositoryTargetsByOrigin(),
		defaultTarget:
			"defaultTarget" in deps
				? deps.defaultTarget
				: defaultOrganizationTarget(),
	});
	const report: Json = { ...summary(plan) };
	if (dryRun) {
		report.samples = samples(plan, 5);
		write(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
		return 0;
	}
	const read = deps.read ?? cliRead;
	const pause =
		deps.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	let failed = false;
	const results: Json = {};
	for (const [key, { target, decisions }] of plan.byTarget) {
		const command = [
			"-w",
			target.workspace,
			...(target.organization ? ["--organization", target.organization] : []),
			"code",
		];
		const call = async (source: string): Promise<Json> => {
			const result = await read(command, CALL_TIMEOUT_MS, source);
			// Code Mode reports a failed tool call as a value, not an exit code.
			if (result.ok === false)
				throw new Error(String(result.error ?? "tool call failed"));
			return result;
		};
		const outcome = {
			recorded: 0,
			duplicates: 0,
			failedBatches: 0,
			errors: [] as string[],
			mining: null as Json | null,
		};
		const note = (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (outcome.errors.length < 3 && !outcome.errors.includes(message))
				outcome.errors.push(message.slice(0, 200));
		};
		for (
			let i = 0;
			i < decisions.length;
			i += AGENT_SESSION_DECISION_LIMITS.perCall
		) {
			const batch = decisions.slice(
				i,
				i + AGENT_SESSION_DECISION_LIMITS.perCall,
			);
			const source = `async () => await agent.import_agent_session_decisions(${asciiJson({ decisions: batch })})`;
			let done = false;
			// Idempotent per turn, so a retry after a lost response is safe.
			for (let attempt = 0; attempt < IMPORT_ATTEMPTS && !done; attempt++) {
				try {
					const result = await call(source);
					outcome.recorded += Number(result.recorded ?? 0);
					outcome.duplicates += Number(result.duplicates ?? 0);
					done = true;
				} catch (error) {
					note(error);
					await pause(RETRY_PAUSE_MS * (attempt + 1));
				}
			}
			if (!done) {
				outcome.failedBatches++;
				failed = true;
			}
		}
		if (!args.includes("--no-mine")) {
			const mining = {
				passes: 0,
				factsWritten: 0,
				factsSuperseded: 0,
				timedOut: 0,
				done: false,
			};
			while (mining.passes + mining.timedOut < MAX_MINE_PASSES) {
				let result: Json;
				try {
					result = await call(
						"async () => await agent.mine_agent_session_lessons({})",
					);
				} catch (error) {
					// The gateway stops waiting before a large pass ends; the pass
					// itself keeps writing, so ask again to continue it.
					mining.timedOut++;
					note(error);
					await pause(MINE_TIMEOUT_PAUSE_MS);
					continue;
				}
				// The run continues server-side; let it finish before asking again.
				if (result.inProgress === true) {
					mining.timedOut++;
					await pause(MINE_TIMEOUT_PAUSE_MS);
					continue;
				}
				mining.passes++;
				const changed =
					Number(result.factsWritten ?? 0) +
					Number(result.factsSuperseded ?? 0);
				mining.factsWritten += Number(result.factsWritten ?? 0);
				mining.factsSuperseded += Number(result.factsSuperseded ?? 0);
				// Another cap (proposals) may stay hit; stop once lessons stop changing.
				if (!result.budgetHit || changed === 0) {
					mining.done = true;
					break;
				}
			}
			if (!mining.done) failed = true;
			outcome.mining = mining;
		}
		results[key] = outcome;
		if (!json) write(`${key}: ${JSON.stringify(outcome)}`);
	}
	report.results = results;
	write(json ? JSON.stringify(report) : JSON.stringify(summary(plan), null, 2));
	return failed ? 2 : 0;
}
