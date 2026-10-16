/**
 * Deterministic facts from every local agent session, for `tedix learn
 * profile`: what the person asked, what ran (tools, commands, MCP and Code
 * Mode calls, skills), what was produced (files written, commits, artifacts,
 * Tedix outputs and Work), what failed, and when. Nothing here calls a model
 * or the network, and nothing here leaves the machine; only the summaries
 * built from these facts are uploaded (see learn-profile.ts).
 *
 * Unlike the decision import, every transcript is read: files are streamed
 * line by line with no size cap, supervisor runs of a Work Item are kept as
 * work runs, and a sub-agent transcript is folded into the session that
 * started it, so its files, commits and artifacts count where they belong.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { redact } from "./hooks/decision-capture";
import { commandHead, errorLine } from "./learn-analyze";
import { humanText, scrub, textParts } from "./learn-import";

type Json = Record<string, any>;

export type SessionKind =
	| "interactive"
	| "work-run"
	| "subagent"
	| "automation";

export interface TranscriptFile {
	harness: "claude-code" | "codex";
	path: string;
	/** A sub-agent transcript (`<session>/subagents/agent-*.jsonl`). */
	subagent: boolean;
	bytes: number;
	mtimeMs: number;
}

export interface SessionFacts {
	/** harness:sessionId, plus :agent for a sub-agent transcript. */
	key: string;
	harness: TranscriptFile["harness"];
	sessionId: string;
	kind: SessionKind;
	/** The session that started this sub-agent, when known. */
	parent: string | null;
	cwd: string | null;
	repository: string | null;
	/** Normalized web origin of the repository, for commit links. */
	repoUrl: string | null;
	branch: string | null;
	title: string | null;
	/** What a sub-agent or a work run was asked to do (not typed by the person). */
	brief: string | null;
	from: string;
	to: string;
	/** Minutes with activity, counting gaps under 15 minutes. */
	activeMinutes: number;
	/** What the person typed, bounded; first and last turns kept. */
	asks: Array<{ text: string; at: string }>;
	askCount: number;
	/** Local hour of day of each ask, for working-hours patterns. */
	hours: number[];
	/** The agent's last words, bounded: how the session ended. */
	lastAgent: string;
	tools: Record<string, number>;
	/** MCP tools as server.tool, and Tedix Code Mode callables as tedix:ns.tool. */
	mcp: Record<string, number>;
	skills: Record<string, number>;
	commands: Record<string, number>;
	filesWritten: string[];
	commits: Array<{ sha: string; subject: string }>;
	pushes: number;
	urls: string[];
	searches: string[];
	workItems: Record<string, number>;
	outputs: string[];
	artifacts: string[];
	cliWorkspaces: string[];
	delegated: string[];
	errors: Array<{ head: string; error: string }>;
	errorCount: number;
	toolCalls: number;
	/** Sub-agent transcripts folded into this session. */
	subagents: number;
}

const MAX_LINE = 4 * 1024 * 1024;
const ASK_CHARS = 400;
const KEEP_ASKS = 30;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WORK_ITEM = new RegExp(
	`(?:Work Items?|work[_ ]?item(?:Id|_id)?|work/items/|workItemId)["'\\s:=/]{0,4}(${UUID})`,
	"gi",
);
const OUTPUT = new RegExp(
	`(?:/outputs/|outputId["'\\s:=]{1,4})(${UUID})`,
	"gi",
);
const COMMIT = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;
/** `git commit -m "subject"`, `-m 'subject'` or a heredoc's first line. */
const COMMIT_MESSAGE =
	/\bgit commit\b[^\n]*?\s-m\s+(?:"\$\(cat <<-?'?EOF'?\n([^\n]+)|"((?:\\.|[^"\\\n])+)"|'([^'\n]+)')/;
const CALLABLE = /\b([a-z][a-z0-9]*)\.([a-z][a-z0-9]*_[a-z0-9_]+)\s*\(/g;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g;
const FILE_MARKER = /\*\*\* (?:Update|Add) File: ([^\n]+)/g;
const URL = /https?:\/\/[^\s"'`)<>\]]+/g;
const NOT_CALLABLE = new Set([
	"tools",
	"tool",
	"subprocess",
	"base64",
	"shutil",
	"pathlib",
	"datetime",
	"time",
	"sys",
	"re",
	"np",
	"target",
	"clock",
	"codemode",
	"console",
	"json",
	"math",
	"object",
	"array",
	"promise",
	"string",
	"number",
	"date",
	"process",
	"path",
	"fs",
	"r",
	"x",
	"s",
	"self",
	"this",
]);

const bump = (record: Record<string, number>, key: string, by = 1) => {
	record[key] = (record[key] ?? 0) + by;
};

const clean = (text: string, limit: number, keep: "head" | "tail" = "head") =>
	redact(scrub(text).replace(/\s+/g, " ").trim(), limit, keep)[0];

function walk(directory: string, depth: number, out: string[]) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && depth > 0) walk(path, depth - 1, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
	}
}

/** Every Claude Code and Codex transcript on this machine, sub-agents included. */
export function transcriptFiles(home = homedir()): TranscriptFile[] {
	const out: TranscriptFile[] = [];
	const add = (harness: TranscriptFile["harness"], paths: string[]) => {
		for (const path of paths) {
			try {
				const stat = statSync(path);
				out.push({
					harness,
					path,
					subagent: path.includes("/subagents/"),
					bytes: stat.size,
					mtimeMs: stat.mtimeMs,
				});
			} catch {
				/* Removed while listing. */
			}
		}
	};
	const claude: string[] = [];
	walk(join(home, ".claude", "projects"), 3, claude);
	add("claude-code", claude);
	const codex: string[] = [];
	walk(join(home, ".codex", "sessions"), 4, codex);
	walk(join(home, ".codex", "archived_sessions"), 0, codex);
	add("codex", codex);
	return out;
}

/** Rows of a transcript, streamed; a line too large to be a turn is skipped. */
export async function* streamRows(path: string): AsyncGenerator<Json> {
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		if (!line || line.length > MAX_LINE) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") yield value;
		} catch {
			/* A torn final line of a live session. */
		}
	}
}

/** `git@github.com:a/b.git` or `https://github.com/a/b.git` as `https://github.com/a/b`. */
export function repoWebUrl(origin: string | null): string | null {
	if (!origin) return null;
	const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(origin.trim());
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	const web = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
		origin.trim(),
	);
	return web ? `https://${web[1]}/${web[2]}` : null;
}

/** Where a session's checkout lives: a worktree path names its repository. */
export function repositoryOf(cwd: string | null): string | null {
	if (!cwd) return null;
	const worktree =
		/\/(?:\.claude|\.codex)\/worktrees\/[^/]+\/([^/]+)/.exec(cwd) ??
		/\/\.codex\/worktrees\/[^/]+\/([^/]+)/.exec(cwd);
	if (worktree) return worktree[1]!;
	const marker = cwd.indexOf("/.claude/worktrees/");
	const base = marker > 0 ? cwd.slice(0, marker) : cwd;
	const github = /\/GitHub\/([^/]+)/.exec(base);
	if (github) return github[1]!;
	return null;
}

function emptyFacts(file: TranscriptFile): SessionFacts {
	return {
		key: "",
		harness: file.harness,
		sessionId: "",
		kind: file.subagent ? "subagent" : "interactive",
		parent: null,
		cwd: null,
		repository: null,
		repoUrl: null,
		branch: null,
		title: null,
		brief: null,
		from: "",
		to: "",
		activeMinutes: 0,
		asks: [],
		askCount: 0,
		hours: [],
		lastAgent: "",
		tools: {},
		mcp: {},
		skills: {},
		commands: {},
		filesWritten: [],
		commits: [],
		pushes: 0,
		urls: [],
		searches: [],
		workItems: {},
		outputs: [],
		artifacts: [],
		cliWorkspaces: [],
		delegated: [],
		errors: [],
		errorCount: 0,
		toolCalls: 0,
		subagents: 0,
	};
}

/** Accumulates one session's facts row by row. */
class Collector {
	facts: SessionFacts;
	private last = 0;
	private active = 0;
	private files = new Set<string>();
	private outputs = new Set<string>();
	private artifacts = new Set<string>();
	private urls = new Set<string>();
	private commits = new Map<string, string>();
	private workspaces = new Set<string>();
	private asks: Array<{ text: string; at: string }> = [];
	/** Subjects of commits whose output did not show (Codex hides most). */
	private subjects = new Set<string>();

	constructor(file: TranscriptFile) {
		this.facts = emptyFacts(file);
	}

	time(at: unknown) {
		if (typeof at !== "string") return;
		const ms = Date.parse(at);
		if (Number.isNaN(ms)) return;
		if (!this.facts.from || at < this.facts.from) this.facts.from = at;
		if (!this.facts.to || at > this.facts.to) this.facts.to = at;
		if (this.last && ms > this.last && ms - this.last < 15 * 60_000)
			this.active += ms - this.last;
		if (ms > this.last) this.last = ms;
	}

	ask(raw: string, at: unknown) {
		const text = humanText(raw);
		if (!text || typeof at !== "string") return;
		this.facts.askCount++;
		this.asks.push({ text: clean(text, ASK_CHARS), at });
		this.facts.hours.push(new Date(at).getHours());
		this.ids(text);
	}

	/** The first message of a sub-agent or work run: its assignment. */
	briefFrom(raw: string) {
		if (this.facts.brief) return;
		const text = raw.trim();
		if (text) {
			this.facts.brief = clean(text, 700);
			this.ids(text);
		}
	}

	agent(text: string) {
		const value = text.trim();
		if (value) this.facts.lastAgent = value;
	}

	ids(text: string) {
		for (const match of text.matchAll(WORK_ITEM))
			bump(this.facts.workItems, match[1]!.toLowerCase());
		for (const match of text.matchAll(OUTPUT))
			this.outputs.add(match[1]!.toLowerCase());
	}

	file(path: unknown) {
		if (typeof path !== "string" || !path) return;
		const base = this.facts.cwd;
		let shown = path.trim();
		if (base && shown.startsWith(base)) shown = relative(base, shown);
		const marker = shown.indexOf("/.claude/worktrees/");
		if (marker >= 0)
			shown = shown
				.slice(marker)
				.replace(/^\/\.claude\/worktrees\/[^/]+\//, "");
		this.files.add(scrub(shown));
	}

	url(raw: unknown) {
		if (typeof raw !== "string") return;
		const value = scrub(raw.replace(/[),.;]+$/, ""));
		if (/^https?:\/\//.test(value) && !/localhost|127\.0\.0\.1/.test(value))
			this.urls.add(value.slice(0, 200));
	}

	command(command: string) {
		bump(this.facts.commands, commandHead(command));
		if (/\b(?:git push|bun run push)\b/.test(command)) this.facts.pushes++;
		const message = COMMIT_MESSAGE.exec(command);
		const subject = message?.[1] ?? message?.[2] ?? message?.[3];
		if (subject) this.subjects.add(clean(subject, 140));
		for (const match of command.matchAll(
			/\btedix\b[^\n|;&]*?\s(?:-w|--workspace|--organization)\s+([\w.-]+)/g,
		))
			this.workspaces.add(match[1]!);
		if (/\btedix\b[^\n]*\bcode\b/.test(command)) this.callables(command);
		if (/\b(?:curl|wget|xh|http)\b/.test(command))
			for (const match of command.matchAll(URL)) this.url(match[0]);
		this.ids(command);
		for (const match of command.matchAll(FILE_MARKER)) this.file(match[1]);
	}

	callables(source: string) {
		for (const match of source.matchAll(CALLABLE)) {
			if (match[1]!.length < 3 || NOT_CALLABLE.has(match[1]!)) continue;
			bump(this.facts.mcp, `tedix:${match[1]}.${match[2]}`);
		}
	}

	output(raw: string, failed: boolean, head: string) {
		// Codex exec results are JSON: their newlines arrive escaped.
		const text = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
		for (const match of text.matchAll(COMMIT))
			if (!this.commits.has(match[2]!))
				this.commits.set(match[2]!, clean(match[3]!, 140));
		for (const match of text.matchAll(ARTIFACT_URL))
			this.artifacts.add(match[0]);
		for (const match of text.matchAll(OUTPUT))
			this.outputs.add(match[1]!.toLowerCase());
		if (failed) {
			this.facts.errorCount++;
			const error = errorLine(text);
			if (error && this.facts.errors.length < 40)
				this.facts.errors.push({ head, error });
		}
	}

	tool(name: string, input: Json | string | undefined) {
		this.facts.toolCalls++;
		const value: Json = typeof input === "object" && input ? input : {};
		const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
		if (mcp) {
			const server = mcp[1]!
				.replace(/^plugin_[^_]+_/, "")
				.replace(/^claude_ai_/, "");
			if (mcp[2] === "code" && typeof value.code === "string") {
				bump(this.facts.mcp, `${server}.code`);
				this.callables(value.code);
				this.ids(value.code);
			} else bump(this.facts.mcp, `${server}.${mcp[2]}`);
			if (typeof value.url === "string") this.url(value.url);
			bump(this.facts.tools, "mcp");
			return;
		}
		bump(this.facts.tools, name);
		switch (name) {
			case "Bash":
			case "bash":
				if (typeof value.command === "string") this.command(value.command);
				break;
			case "Edit":
			case "Write":
			case "MultiEdit":
			case "NotebookEdit":
				this.file(value.file_path ?? value.notebook_path);
				break;
			case "WebFetch":
				this.url(value.url);
				break;
			case "WebSearch":
				if (typeof value.query === "string" && this.facts.searches.length < 12)
					this.facts.searches.push(clean(value.query, 120));
				break;
			case "Skill":
				if (typeof value.skill === "string")
					bump(this.facts.skills, value.skill);
				break;
			case "Agent":
			case "Task":
				if (
					typeof value.description === "string" &&
					this.facts.delegated.length < 40
				)
					this.facts.delegated.push(clean(value.description, 100));
				break;
			case "Artifact":
				if (typeof value.url === "string") this.artifacts.add(value.url);
				if (typeof value.title === "string")
					this.artifacts.add(`"${clean(value.title, 80)}"`);
				break;
			case "SendUserFile":
				if (typeof value.file_path === "string")
					this.artifacts.add(basename(value.file_path));
				break;
			default:
				break;
		}
	}

	/** A Codex call: exec scripts and shell commands carry their commands inline. */
	codexTool(name: string, input: unknown) {
		const text =
			typeof input === "string" ? input : JSON.stringify(input ?? "");
		this.facts.toolCalls++;
		bump(this.facts.tools, name);
		if (name === "exec_command" || name === "shell") {
			try {
				const args = JSON.parse(text);
				const cmd = args.cmd ?? args.command;
				this.command(
					Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd ?? ""),
				);
			} catch {
				this.command(text);
			}
			return;
		}
		if (name === "spawn_agent" || name === "followup_task") {
			try {
				const args = JSON.parse(text);
				const task =
					args.message ?? args.task ?? args.prompt ?? args.description;
				if (typeof task === "string" && this.facts.delegated.length < 40)
					this.facts.delegated.push(clean(task, 100));
			} catch {
				/* Not JSON. */
			}
			return;
		}
		for (const match of text.matchAll(
			/exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
		))
			this.command(match[2]!.replace(/\\(.)/g, "$1"));
		for (const match of text.matchAll(/\b(mcp__[\w-]+?)__([\w-]+)/g))
			bump(this.facts.mcp, `${match[1]!.replace(/^mcp__/, "")}.${match[2]}`);
		for (const match of text.matchAll(FILE_MARKER)) this.file(match[1]);
		this.callables(text);
		this.ids(text);
	}

	finish(): SessionFacts {
		const f = this.facts;
		const span = f.from && f.to ? Date.parse(f.to) - Date.parse(f.from) : 0;
		f.activeMinutes = Math.round(Math.min(this.active, span) / 60_000);
		f.asks =
			this.asks.length <= KEEP_ASKS
				? this.asks
				: [...this.asks.slice(0, KEEP_ASKS - 8), ...this.asks.slice(-8)];
		f.lastAgent = f.lastAgent ? clean(f.lastAgent, 600, "tail") : "";
		f.filesWritten = [...this.files].slice(0, 200);
		f.commits = [...this.commits].map(([sha, subject]) => ({ sha, subject }));
		const seen = new Set(f.commits.map((c) => c.subject));
		for (const subject of this.subjects)
			if (!seen.has(subject)) f.commits.push({ sha: "", subject });
		f.outputs = [...this.outputs];
		f.artifacts = [...this.artifacts].slice(0, 40);
		f.urls = [...this.urls].slice(0, 60);
		f.cliWorkspaces = [...this.workspaces];
		f.repository ??= repositoryOf(f.cwd);
		return f;
	}
}

const WORK_RUN = new RegExp(
	`^(?:Continue|Resume|Execute|Work on) Tedix Work Item (${UUID})`,
	"i",
);

/** One Claude Code transcript, streamed. */
export async function claudeFacts(
	file: TranscriptFile,
	rows: AsyncIterable<Json> | Iterable<Json> = streamRows(file.path),
): Promise<SessionFacts | null> {
	const c = new Collector(file);
	const f = c.facts;
	let entry: string | null = null;
	let agentId = "";
	let customTitle: string | null = null;
	let firstUser = true;
	const uses = new Map<string, string>();
	for await (const row of rows) {
		if (typeof row.sessionId === "string" && !f.sessionId)
			f.sessionId = row.sessionId;
		if (typeof row.agentId === "string" && !agentId) agentId = row.agentId;
		if (row.type === "ai-title" && typeof row.aiTitle === "string")
			f.title = row.aiTitle;
		if (row.type === "custom-title" && typeof row.customTitle === "string")
			customTitle = row.customTitle;
		if (typeof row.cwd === "string" && !f.cwd) f.cwd = row.cwd;
		if (
			typeof row.gitBranch === "string" &&
			row.gitBranch &&
			row.gitBranch !== "HEAD"
		)
			f.branch = row.gitBranch;
		if (typeof row.entrypoint === "string" && !entry) entry = row.entrypoint;
		c.time(row.timestamp);
		const message = row.message;
		if (row.type === "assistant" && Array.isArray(message?.content)) {
			for (const part of message.content) {
				if (part?.type === "text" && typeof part.text === "string")
					c.agent(part.text);
				if (part?.type !== "tool_use") continue;
				const name = String(part.name ?? "tool");
				uses.set(
					String(part.id),
					name === "Bash"
						? commandHead(String(part.input?.command ?? ""))
						: name,
				);
				c.tool(name, part.input);
			}
			continue;
		}
		if (row.type !== "user" || !message || row.isMeta || row.isCompactSummary)
			continue;
		const content = message.content;
		if (
			Array.isArray(content) &&
			content.some((p) => p?.type === "tool_result")
		) {
			for (const part of content) {
				if (part?.type !== "tool_result") continue;
				const head = uses.get(String(part.tool_use_id)) ?? "tool";
				c.output(textParts(part.content, "text"), part.is_error === true, head);
			}
			continue;
		}
		if (row.toolUseResult) continue;
		const text = textParts(content, "text");
		if (firstUser && (file.subagent || entry?.startsWith("sdk"))) {
			firstUser = false;
			c.briefFrom(text);
			continue;
		}
		firstUser = false;
		const kind = row.origin?.kind;
		if (kind !== undefined && kind !== "human") continue;
		c.ask(text, row.timestamp);
	}
	if (!f.sessionId) return null;
	f.title ??= customTitle;
	if (file.subagent) {
		f.kind = "subagent";
		f.parent = basename(join(file.path, "..", ".."));
	} else if (entry?.startsWith("sdk")) {
		const run = f.brief ? WORK_RUN.exec(f.brief) : null;
		f.kind = run ? "work-run" : "automation";
		if (run) bump(f.workItems, run[1]!.toLowerCase(), 3);
	}
	f.key = `claude-code:${f.sessionId}${file.subagent ? `:${agentId || basename(file.path, ".jsonl")}` : ""}`;
	return c.finish();
}

/** One Codex rollout, streamed. */
export async function codexFacts(
	file: TranscriptFile,
	rows: AsyncIterable<Json> | Iterable<Json> = streamRows(file.path),
	goals?: Map<string, string>,
	names?: Map<string, string>,
): Promise<SessionFacts | null> {
	const c = new Collector(file);
	const f = c.facts;
	const calls = new Map<string, string>();
	let meta: Json | null = null;
	let firstUser = true;
	for await (const row of rows) {
		const payload = row.payload;
		if (row.type === "session_meta" && payload && !meta) {
			meta = payload;
			f.sessionId = String(payload.session_id ?? payload.id ?? "");
			f.cwd = typeof payload.cwd === "string" ? payload.cwd : null;
			f.branch =
				typeof payload.git?.branch === "string" ? payload.git.branch : null;
			f.repoUrl = repoWebUrl(payload.git?.repository_url ?? null);
			f.repository = f.repoUrl ? basename(f.repoUrl) : null;
			const source = payload.thread_source;
			if (
				(typeof payload.source === "object" && payload.source?.subagent) ||
				source === "subagent" ||
				source === "guardian_review"
			) {
				f.kind = "subagent";
				const parent =
					payload.source?.subagent?.thread_spawn?.parent_thread_id ??
					payload.forked_from_id ??
					payload.parent_thread_id;
				f.parent = typeof parent === "string" ? parent : null;
			} else if (source !== undefined && source !== null && source !== "user")
				f.kind = "automation";
			continue;
		}
		c.time(row.timestamp);
		if (row.type === "event_msg" && payload?.type === "thread_goal_updated") {
			const objective = payload.goal?.objective ?? payload.objective;
			if (typeof objective === "string") f.title = clean(objective, 160);
		}
		if (row.type !== "response_item" || !payload) continue;
		if (payload.type === "message") {
			if (payload.role === "assistant")
				c.agent(textParts(payload.content, "output_text"));
			if (payload.role !== "user") continue;
			const text = textParts(payload.content, "input_text");
			if (firstUser && f.kind === "subagent") {
				firstUser = false;
				c.briefFrom(humanText(text) ?? text);
				continue;
			}
			firstUser = false;
			c.ask(text, row.timestamp);
			continue;
		}
		if (
			payload.type === "function_call" ||
			payload.type === "custom_tool_call"
		) {
			const name = String(payload.name ?? "tool");
			calls.set(String(payload.call_id), name);
			c.codexTool(name, payload.arguments ?? payload.input);
			continue;
		}
		if (
			payload.type === "function_call_output" ||
			payload.type === "custom_tool_call_output"
		) {
			const head = calls.get(String(payload.call_id)) ?? "tool";
			const output =
				typeof payload.output === "string"
					? payload.output
					: textParts(payload.output, "input_text");
			const exit = /^(?:Exit code:?|Process exited with code) (-?\d+)/m.exec(
				output,
			)?.[1];
			const failed =
				(exit !== undefined && exit !== "0" && exit !== "1") ||
				output.startsWith("Script failed");
			c.output(output, failed, head);
		}
	}
	if (!f.sessionId) return null;
	const goal = goals?.get(f.sessionId);
	if (goal) f.title = clean(goal, 160);
	f.title ??= names?.get(f.sessionId) ?? null;
	f.key = `codex:${f.sessionId}${f.kind === "subagent" ? ":sub" : ""}`;
	return c.finish();
}

/** Fold sub-agent transcripts into the session that started them. */
export function foldSubagents(all: SessionFacts[]): SessionFacts[] {
	const byId = new Map<string, SessionFacts>();
	for (const f of all) if (f.kind !== "subagent") byId.set(f.sessionId, f);
	const out: SessionFacts[] = [];
	for (const f of all) {
		const parent =
			f.kind === "subagent" && f.parent ? byId.get(f.parent) : undefined;
		if (!parent) {
			if (f.kind !== "subagent" || f.toolCalls || f.askCount) out.push(f);
			continue;
		}
		parent.subagents++;
		parent.toolCalls += f.toolCalls;
		parent.errorCount += f.errorCount;
		for (const [k, v] of Object.entries(f.tools)) bump(parent.tools, k, v);
		for (const [k, v] of Object.entries(f.mcp)) bump(parent.mcp, k, v);
		for (const [k, v] of Object.entries(f.skills)) bump(parent.skills, k, v);
		for (const [k, v] of Object.entries(f.commands))
			bump(parent.commands, k, v);
		for (const [k, v] of Object.entries(f.workItems))
			bump(parent.workItems, k, v);
		const merge = <T>(a: T[], b: T[], cap: number) =>
			[...new Set([...a, ...b])].slice(0, cap);
		parent.filesWritten = merge(parent.filesWritten, f.filesWritten, 300);
		parent.outputs = merge(parent.outputs, f.outputs, 60);
		parent.artifacts = merge(parent.artifacts, f.artifacts, 60);
		parent.urls = merge(parent.urls, f.urls, 80);
		parent.cliWorkspaces = merge(parent.cliWorkspaces, f.cliWorkspaces, 20);
		const shas = new Set(parent.commits.map((c) => c.sha));
		parent.commits.push(...f.commits.filter((c) => !shas.has(c.sha)));
		parent.pushes += f.pushes;
		parent.errors.push(
			...f.errors.slice(0, Math.max(0, 60 - parent.errors.length)),
		);
		if (f.to > parent.to) parent.to = f.to;
		if (f.from && f.from < parent.from) parent.from = f.from;
	}
	return out;
}

/** A session too small to say anything: a probe, a "Reply OK", an empty start. */
export function trivial(f: SessionFacts): boolean {
	const asked = f.asks.map((a) => a.text).join(" ");
	return (
		f.toolCalls < 3 &&
		f.askCount <= 1 &&
		asked.length < 120 &&
		!f.commits.length
	);
}
