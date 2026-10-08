/**
 * `tedix learn analyze-sessions`: the whole-session pass next to
 * `import-sessions`. Where the importer keeps (agent message, reply) pairs,
 * this reads each local Claude Code and Codex session end to end and keeps
 * three signals that only show across sessions:
 *
 * 1. repeated requests: near-identical asks typed again and again, which are
 *    candidates for a skill or a command;
 * 2. friction hotspots: tool errors, retry loops, permission denials and long
 *    stalls that recur, which are candidates for automation or a hook. These
 *    are deterministic counts; no model is involved;
 * 3. decisions: "we go with X because Y" statements, extracted by the
 *    person's own local `claude` CLI from redacted candidates and deduplicated.
 *
 * Each organization (routed exactly as the importer routes, never guessed)
 * gets one Work Item per signal whose description is the ranked top ten.
 * Only counts and short redacted paraphrases leave the machine, and a re-run
 * updates the same three items.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
	defaultOrganizationTarget,
	repositoryTargetsByOrigin,
	type OrganizationTarget,
} from "./agent-context";
import { asciiJson } from "./hooks/agent-status";
import { redact } from "./hooks/decision-capture";
import { cliRead } from "./hooks/hook-io";
import {
	emptyUnrouted,
	humanReply,
	humanText,
	type LearnDeps,
	parseClaudeSession,
	parseCodexSession,
	parseLines,
	routedTarget,
	scrub,
	type SessionFile,
	sessionFiles,
	sessionLocator,
	targetKey,
	textParts,
	type Unrouted,
} from "./learn-import";

type Json = Record<string, any>;
type Harness = SessionFile["harness"];

export interface ToolEvent {
	/** Short, redacted name of what ran: a command head or a tool name. */
	head: string;
	failed: boolean;
	denied: boolean;
	/** Normalized, redacted first error line; empty when it succeeded. */
	error: string;
	at: string;
	/** Call-to-result time, when both timestamps are known. */
	ms: number | null;
}

export interface SessionSignals {
	harness: Harness;
	sessionId: string;
	cwd: string | null;
	origin: string | null;
	/** Everything the person typed, of any length. */
	asks: Array<{ text: string; at: string }>;
	tools: ToolEvent[];
}

const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

const short = (text: string, limit: number) =>
	redact(scrub(text).replace(/\s+/g, " "), limit)[0];

const DENIED =
	/permission|denied|doesn'?t want to proceed|tool use was rejected|\bRejected\(|Blocked:|requires? approval|Refusing to/i;
/** Tools whose duration is someone waiting on purpose, not a stall. */
const WAITS =
	/^(?:sleep|wait|wait_agent|wait_threads|write_stdin|Monitor|TaskOutput|ScheduleWakeup|AskUserQuestion|request_user_input\w*|spawn_agent|Agent|Task|mcp__\w*wait\w*)$/i;
const STALL_MS = 5 * 60_000;
/** Flags whose next word is their value, not a subcommand. */
const VALUE_FLAGS = new Set([
	"-w",
	"-C",
	"-R",
	"-c",
	"-o",
	"--cwd",
	"--organization",
	"--workspace",
	"--filter",
	"--repo",
	"--prefix",
]);

/** The first three meaningful words of a shell command, e.g. "git push origin". */
export function commandHead(command: string): string {
	const segments = command
		.split(/&&|\|\||;|\n|\|/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	const segment =
		segments.find(
			(s) => !/^(?:cd|export|set|source|sleep|echo|printf|true|:)\b/.test(s),
		) ??
		segments[0] ??
		"";
	const out: string[] = [];
	const words = segment.split(/\s+/);
	for (let i = 0; i < words.length && out.length < 3; i++) {
		const word = words[i]!;
		if (!out.length && /^\w+=/.test(word)) continue;
		if (word.startsWith("-")) {
			if (VALUE_FLAGS.has(word)) i++;
			continue;
		}
		if (/^["'$`(<>{\\]/.test(word)) break;
		if (word.includes("://")) {
			out.push(word.replace(/^\w+:\/\/([^/\s]+).*$/, "$1"));
			continue;
		}
		out.push(word.includes("/") ? basename(word) || word : word);
	}
	return short(out.join(" "), 60) || "shell";
}

const BOILERPLATE =
	/^(?:Exit code:? -?\d+|Script (?:failed|completed)|Wall time|Output:|Script error:|Chunk ID|Original token count|Process exited|Command:|Warning: truncated output|Total output lines)/i;
const ERRORISH =
	/error|fail|denied|not found|no such|refus|cannot|can't|unable|invalid|fatal|reject|blocked|timed? ?out|permission/i;

/** One stable, redacted line that names what went wrong. */
export function errorLine(output: string): string {
	const lines = output
		.replace(/<\/?tool_use_error>/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !BOILERPLATE.test(line));
	const line = lines.find((l) => ERRORISH.test(l)) ?? lines[0] ?? "";
	return short(
		scrub(line)
			.replace(/https?:\/\/([^/\s]+)\S*/g, "$1")
			.replace(/(?:~|\.{1,2}|[\w.@-]+)?(?:\/[^\s'"`:,)/]+)+\/?/g, "<path>")
			.replace(/\b[0-9a-f]{7,}\b/gi, "<id>")
			.replace(/\d+/g, "N"),
		90,
	);
}

/** Exit 1 from a search or comparison means "no match", not an error. */
const NO_MATCH = /^(?:rg|grep|egrep|fgrep|test|diff|cmp|\[)\b/;

function toolEvent(
	name: string,
	head: string,
	failed: boolean,
	output: string,
	start: unknown,
	end: unknown,
	exit?: number,
): ToolEvent {
	const begun = typeof start === "string" ? Date.parse(start) : Number.NaN;
	const ended = typeof end === "string" ? Date.parse(end) : Number.NaN;
	const real = failed && !(exit === 1 && NO_MATCH.test(head));
	const error = real ? errorLine(output) : "";
	return {
		head,
		failed: real,
		// Only the error itself decides: command output may mention "permission".
		denied: real && DENIED.test(error),
		error,
		at: typeof end === "string" ? end : String(start ?? ""),
		ms:
			WAITS.test(name) || Number.isNaN(begun) || Number.isNaN(ended)
				? null
				: Math.max(0, ended - begun),
	};
}

function toolName(name: unknown): string {
	return short(String(name ?? "tool"), 60);
}

/** Signals from one Claude Code transcript, or null when it is skipped. */
export function claudeSignals(rows: Json[]): SessionSignals | null {
	const base = parseClaudeSession(rows);
	if (base.skipped) return null;
	const signals: SessionSignals = {
		harness: "claude-code",
		sessionId: base.sessionId,
		cwd: base.cwd,
		origin: base.origin,
		asks: [],
		tools: [],
	};
	const uses = new Map<string, { name: string; head: string; at: unknown }>();
	for (const row of rows) {
		if (row.isSidechain) continue;
		const message = row.message;
		if (row.type === "assistant" && Array.isArray(message?.content)) {
			for (const part of message.content) {
				if (part?.type !== "tool_use" || typeof part.id !== "string") continue;
				const name = String(part.name ?? "tool");
				const command = part.input?.command;
				uses.set(part.id, {
					name,
					head:
						name === "Bash" && typeof command === "string"
							? commandHead(command)
							: toolName(name),
					at: row.timestamp,
				});
			}
			continue;
		}
		if (row.type !== "user" || !message || row.isMeta || row.isCompactSummary)
			continue;
		const content = message.content;
		if (
			Array.isArray(content) &&
			content.some((part) => part?.type === "tool_result")
		) {
			for (const part of content) {
				if (part?.type !== "tool_result") continue;
				const use = uses.get(part.tool_use_id);
				if (!use) continue;
				uses.delete(part.tool_use_id);
				const output = textParts(part.content, "text");
				const exit = /^Exit code (\d+)/.exec(output)?.[1];
				signals.tools.push(
					toolEvent(
						use.name,
						use.head,
						part.is_error === true,
						output,
						use.at,
						row.timestamp,
						exit === undefined ? undefined : Number(exit),
					),
				);
			}
			continue;
		}
		if (row.toolUseResult) continue;
		const kind = row.origin?.kind;
		if (kind !== undefined && kind !== "human") continue;
		const text = humanText(textParts(content, "text"));
		if (text && typeof row.timestamp === "string")
			signals.asks.push({ text, at: row.timestamp });
	}
	return signals;
}

/** Shell commands a Codex call ran: `exec_command` directly or inside an exec script. */
export function codexCommands(name: string, input: unknown): string[] {
	if (typeof input !== "string") return [];
	if (name === "exec_command" || name === "shell") {
		try {
			const args = JSON.parse(input);
			const cmd = args.cmd ?? args.command;
			if (typeof cmd === "string") return [cmd];
			if (Array.isArray(cmd)) return [cmd.map(String).join(" ")];
		} catch {
			return [];
		}
		return [];
	}
	const out: string[] = [];
	for (const match of input.matchAll(
		/exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
	))
		out.push(match[2]!.replace(/\\(.)/g, "$1"));
	return out;
}

export interface ExecResult {
	exit: number;
	output: string;
}

/** The `{exit_code, output}` results an exec script printed, in order. */
export function execResults(output: string): ExecResult[] {
	const out: ExecResult[] = [];
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || depth > 3) return;
		const record = value as Json;
		if (typeof record.exit_code === "number") {
			out.push({
				exit: record.exit_code,
				output: typeof record.output === "string" ? record.output : "",
			});
			return;
		}
		for (const child of Object.values(record)) visit(child, depth + 1);
	};
	for (const line of output.split("\n")) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			visit(JSON.parse(text), 0);
		} catch {
			/* Not a result line. */
		}
	}
	return out;
}

/**
 * Tool events from one Codex call. An exec script can run several commands;
 * each printed result becomes an event, named by its command when the
 * results line up with the commands, else by the script.
 */
export function codexEvents(
	name: string,
	input: unknown,
	output: string,
	start: unknown,
	end: unknown,
): ToolEvent[] {
	const commands = codexCommands(name, input).map(commandHead);
	const fallback =
		commands.length === 1
			? commands[0]!
			: name === "exec"
				? "exec script"
				: toolName(name);
	const event = (
		head: string,
		failed: boolean,
		text: string,
		exit?: number,
		timed = true,
	) => toolEvent(timed ? name : "wait", head, failed, text, start, end, exit);
	if (name === "exec" && output.startsWith("Script failed")) {
		const marker = output.indexOf("Script error:");
		const error = marker < 0 ? output : output.slice(marker + 13);
		const tool = /^\s*(\w+) (?:verification )?failed/m.exec(error)?.[1];
		return [event(tool ? toolName(tool) : fallback, true, error)];
	}
	const direct = /^(?:Exit code:?|Process exited with code) (-?\d+)/m.exec(
		output,
	);
	if (direct) {
		const exit = Number(direct[1]);
		return [event(fallback, exit !== 0, output, exit)];
	}
	const results = execResults(output);
	if (!results.length)
		return [event(fallback, /^collab \w+ failed/.test(output), output)];
	return results.map((result, i) =>
		event(
			results.length === commands.length ? commands[i]! : fallback,
			result.exit !== 0,
			result.output,
			result.exit,
			i === 0,
		),
	);
}

/** Signals from one Codex rollout, or null when it is skipped. */
export function codexSignals(rows: Json[]): SessionSignals | null {
	const base = parseCodexSession(rows);
	if (base.skipped) return null;
	const signals: SessionSignals = {
		harness: "codex",
		sessionId: base.sessionId,
		cwd: base.cwd,
		origin: base.origin,
		asks: [],
		tools: [],
	};
	const calls = new Map<
		string,
		{ name: string; input: unknown; at: unknown }
	>();
	for (const row of rows) {
		const payload = row.payload;
		if (row.type !== "response_item" || !payload) continue;
		if (payload.type === "message" && payload.role === "user") {
			const text = humanText(textParts(payload.content, "input_text"));
			if (text && typeof row.timestamp === "string")
				signals.asks.push({ text, at: row.timestamp });
			continue;
		}
		if (
			payload.type === "function_call" ||
			payload.type === "custom_tool_call"
		) {
			calls.set(String(payload.call_id), {
				name: String(payload.name ?? "tool"),
				input: payload.arguments ?? payload.input,
				at: row.timestamp,
			});
			continue;
		}
		if (
			payload.type === "function_call_output" ||
			payload.type === "custom_tool_call_output"
		) {
			const call = calls.get(String(payload.call_id));
			if (!call) continue;
			calls.delete(String(payload.call_id));
			const output =
				typeof payload.output === "string"
					? payload.output
					: textParts(payload.output, "input_text");
			signals.tools.push(
				...codexEvents(call.name, call.input, output, call.at, row.timestamp),
			);
		}
	}
	return signals;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Ranked {
	label: string;
	count: number;
	sessions: number;
	last: string;
	/** Extra short evidence, e.g. a reason or a citation. */
	note?: string;
}

const STOP = new Set(
	"a an the to and or of for in on at is are be it this that these those please pls plz can could would will you we i me my our us now then just ok okay so do it's its with from what whats what's how hey also again all any".split(
		" ",
	),
);
const ACK =
	/^(?:y|n|yes|no|yep|nope|ok|okay|k|sure|go|go ahead|go on|continue|proceed|do it|thanks|thank you|ty|next|done|stop|wait|great|good|perfect|nice|cool|right|correct|agreed|confirm|confirmed|approved|lgtm|yes please|ok continue|keep going|carry on|(?:ok |yes |ok yes )?lets (?:do it|go))$/;

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((word) => word && !STOP.has(word))
		.map((word) => (word.length > 3 ? word.replace(/s$/, "") : word));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared || 1);
}

interface Cluster<T> {
	words: Set<string>;
	items: T[];
}

/** Greedy near-duplicate clustering over word sets, via a word index. */
function clusterBy<T>(
	items: T[],
	wordsOf: (item: T) => string[],
	threshold: number,
): Array<Cluster<T>> {
	const clusters: Array<Cluster<T>> = [];
	const exact = new Map<string, Cluster<T>>();
	const index = new Map<string, Array<Cluster<T>>>();
	for (const item of items) {
		const list = [...new Set(wordsOf(item))].sort();
		if (!list.length) continue;
		const key = list.join(" ");
		let cluster = exact.get(key);
		if (!cluster) {
			const words = new Set(list);
			const candidates = new Set(list.flatMap((w) => index.get(w) ?? []));
			cluster = [...candidates].find(
				(c) => jaccard(c.words, words) >= threshold,
			);
			if (!cluster) {
				cluster = { words, items: [] };
				clusters.push(cluster);
				for (const word of list)
					index.set(word, [...(index.get(word) ?? []), cluster]);
			}
			exact.set(key, cluster);
		}
		cluster.items.push(item);
	}
	return clusters;
}

const latest = (values: string[]) => values.reduce((a, b) => (a > b ? a : b));
const day = (iso: string) => iso.slice(0, 10);

type Ask = { text: string; at: string; session: string };

/** Asks typed at least `minCount` times across at least `minSessions` sessions. */
export function repeatedRequests(
	asks: Ask[],
	options = { minCount: 5, minSessions: 3, top: 10 },
): Ranked[] {
	const short_ = asks.filter((ask) => {
		if (ask.text.length > 200) return false;
		const phrase = ask.text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, "")
			.trim();
		return !ACK.test(phrase);
	});
	return clusterBy(short_, (ask) => tokens(ask.text), 0.5)
		.map((cluster) => {
			const phrasings = new Map<string, number>();
			for (const ask of cluster.items) {
				const phrase = short(ask.text, 90);
				phrasings.set(phrase, (phrasings.get(phrase) ?? 0) + 1);
			}
			const [label] = [...phrasings].sort((a, b) => b[1] - a[1])[0]!;
			return {
				label,
				count: cluster.items.length,
				sessions: new Set(cluster.items.map((ask) => ask.session)).size,
				last: day(latest(cluster.items.map((ask) => ask.at))),
			};
		})
		.filter(
			(r) => r.count >= options.minCount && r.sessions >= options.minSessions,
		)
		.sort((a, b) => b.count - a.count || b.sessions - a.sessions)
		.slice(0, options.top);
}

/** Deterministic friction counts across sessions. */
export function frictionHotspots(
	sessions: Array<{ sessionId: string; tools: ToolEvent[] }>,
	options = { minSessions: 2, top: 10, perKind: 4 },
): Ranked[] {
	const spots = new Map<
		string,
		{
			label: string;
			count: number;
			sessions: Set<string>;
			last: string;
			minutes: number[];
		}
	>();
	const add = (
		key: string,
		label: string,
		session: string,
		at: string,
		ms?: number,
	) => {
		const spot = spots.get(key) ?? {
			label,
			count: 0,
			sessions: new Set<string>(),
			last: "",
			minutes: [],
		};
		spot.count++;
		spot.sessions.add(session);
		if (at > spot.last) spot.last = at;
		if (ms !== undefined) spot.minutes.push(Math.round(ms / 60_000));
		spots.set(key, spot);
	};
	for (const { sessionId, tools } of sessions) {
		let runHead = "";
		let run = 0;
		for (const tool of tools) {
			if (tool.denied)
				add(
					`deny\n${tool.head}`,
					`Permission denied or blocked: ${tool.head} (${tool.error})`,
					sessionId,
					tool.at,
				);
			else if (tool.failed)
				add(
					`fail\n${tool.head}\n${tool.error}`,
					`Failing: ${tool.head} (${tool.error || "non-zero exit"})`,
					sessionId,
					tool.at,
				);
			if (tool.failed && tool.head === runHead) run++;
			else run = tool.failed ? 1 : 0;
			runHead = tool.failed ? tool.head : "";
			if (run === 3)
				add(
					`loop\n${tool.head}`,
					`Retry loop: ${tool.head} failed 3+ times in a row`,
					sessionId,
					tool.at,
				);
			if (tool.ms !== null && tool.ms >= STALL_MS)
				add(
					`stall\n${tool.head}`,
					`Long stall: ${tool.head} took over 5 minutes`,
					sessionId,
					tool.at,
					tool.ms,
				);
		}
	}
	const ranked = [...spots.entries()]
		.filter(
			([key, s]) =>
				s.sessions.size >= options.minSessions &&
				s.count >= (key.startsWith("fail") ? 3 : 2),
		)
		.map(([key, s]) => {
			const minutes = s.minutes.sort((a, b) => a - b);
			return {
				kind: key.slice(0, key.indexOf("\n")),
				label: s.label,
				count: s.count,
				sessions: s.sessions.size,
				last: day(s.last),
				...(minutes.length
					? { note: `median ${minutes[Math.floor(minutes.length / 2)]} min` }
					: {}),
			};
		})
		.sort((a, b) => b.sessions - a.sessions || b.count - a.count);
	// Keep every kind visible: at most a few of one kind unless others run out.
	const picked = new Set<(typeof ranked)[number]>();
	const perKind = new Map<string, number>();
	for (const spot of ranked) {
		if (picked.size >= options.top) break;
		const used = perKind.get(spot.kind) ?? 0;
		if (used >= options.perKind) continue;
		perKind.set(spot.kind, used + 1);
		picked.add(spot);
	}
	for (const spot of ranked) if (picked.size < options.top) picked.add(spot);
	return ranked
		.filter((spot) => picked.has(spot))
		.map(({ kind: _kind, ...spot }) => spot);
}

// ---------------------------------------------------------------------------
// Decisions (model-assisted)
// ---------------------------------------------------------------------------

const DECISION_CUE =
	/\b(?:let'?s (?:go with|use|keep|stick|switch|drop|move|stay)|we(?:'ll| will| should| go)? (?:go with|use|keep|stick with|switch to|drop|stay with)|go with|decided|decision|instead of|rather than|prefer|stick with|from now on|always|never|don'?t use|stop using|no more)\b/i;
const MAX_CANDIDATES = 400;
const CHUNK = 40;

export interface DecisionCandidate {
	text: string;
	session: string;
	at: string;
}

export function decisionCandidates(asks: Ask[]): DecisionCandidate[] {
	const seen = new Set<string>();
	const out: DecisionCandidate[] = [];
	for (const ask of asks) {
		if (ask.text.length > 1500 || !humanReply(ask.text)) continue;
		if (!DECISION_CUE.test(ask.text)) continue;
		const text = short(ask.text, 600);
		if (seen.has(text)) continue;
		seen.add(text);
		out.push({ text, session: ask.session, at: ask.at });
	}
	return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_CANDIDATES);
}

export type RunModel = (prompt: string) => Promise<string>;

export const DECISION_PROMPT = `Below are numbered messages one person typed to a coding agent.
Find only durable decisions the person made about how the product or the work is done:
a choice of X (often over an alternative), ideally with the reason. Skip one-off task
instructions, questions, status checks and complaints that choose nothing.
Return ONLY a JSON array, no prose: [{"i": <message number>, "decision": "<at most 14 words, e.g. Use D1 batch instead of transactions>", "because": "<at most 14 words, or empty>"}].
Paraphrase. Never include people's names, email addresses, secrets, tokens, URLs or customer data.
Return [] if none qualify.

`;

/** Ask the model for decisions in each chunk; malformed answers are dropped. */
export async function extractDecisions(
	candidates: DecisionCandidate[],
	runModel: RunModel,
	concurrency = 4,
): Promise<Array<DecisionCandidate & { decision: string; because: string }>> {
	const chunks: DecisionCandidate[][] = [];
	for (let i = 0; i < candidates.length; i += CHUNK)
		chunks.push(candidates.slice(i, i + CHUNK));
	const out: Array<DecisionCandidate & { decision: string; because: string }> =
		[];
	let next = 0;
	const worker = async () => {
		while (next < chunks.length) {
			const chunk = chunks[next++]!;
			const prompt =
				DECISION_PROMPT +
				chunk
					.map((c, i) => `${i + 1}. ${c.text.replace(/\n+/g, " ")}`)
					.join("\n");
			let raw: string;
			try {
				raw = await runModel(prompt);
			} catch {
				continue;
			}
			const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
			let parsed: unknown;
			try {
				parsed = JSON.parse(json);
			} catch {
				continue;
			}
			if (!Array.isArray(parsed)) continue;
			for (const entry of parsed) {
				const source = Number.isInteger(entry?.i)
					? chunk[entry.i - 1]
					: undefined;
				if (!source || typeof entry.decision !== "string") continue;
				const decision = short(entry.decision, 140);
				if (decision.length < 6) continue;
				out.push({
					...source,
					decision,
					because:
						typeof entry.because === "string" ? short(entry.because, 140) : "",
				});
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return out;
}

const cite = (d: { session: string; at: string }) =>
	`session ${d.session.slice(0, 8)}, ${d.at.slice(0, 16).replace("T", " ")} UTC`;

export function decisionLog(
	decisions: Array<DecisionCandidate & { decision: string; because: string }>,
	top = 10,
): Ranked[] {
	return clusterBy(decisions, (d) => tokens(d.decision), 0.5)
		.map((cluster) => {
			const items = [...cluster.items].sort((a, b) => (a.at < b.at ? -1 : 1));
			const newest = items[items.length - 1]!;
			const because = items.find((d) => d.because)?.because;
			return {
				label: because
					? `${newest.decision}, because ${because}`
					: newest.decision,
				count: items.length,
				sessions: new Set(items.map((d) => d.session)).size,
				last: day(newest.at),
				note:
					items.length > 1
						? `first ${cite(items[0]!)}; latest ${cite(newest)}`
						: cite(newest),
			};
		})
		.sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
		.slice(0, top);
}

/** The person's own `claude` CLI, headless, without saving a session. */
export const claudeModel: RunModel = (prompt) =>
	new Promise((resolve, reject) => {
		const child = spawn(
			"claude",
			[
				"-p",
				"--model",
				"haiku",
				"--no-session-persistence",
				"--output-format",
				"text",
			],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		let out = "";
		const timer = setTimeout(() => child.kill(), 180_000);
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`claude exited ${code}`));
		});
		child.stdin.end(prompt);
	});

// ---------------------------------------------------------------------------
// Plan, render and sync
// ---------------------------------------------------------------------------

export const CATEGORIES = {
	requests: {
		title:
			"Session analysis: repeated requests to turn into skills or commands",
		intent: "session-analysis:repeated-requests:v1",
		intro:
			"Requests typed again and again in local agent sessions. Each is a candidate for a skill or a slash command.",
	},
	friction: {
		title: "Session analysis: friction hotspots to automate or hook",
		intent: "session-analysis:friction-hotspots:v1",
		intro:
			"Tool errors, retry loops, permission denials and long stalls that recur across local agent sessions. Each is a candidate for automation, a hook or a permission rule.",
	},
	decisions: {
		title: "Session analysis: decision log",
		intent: "session-analysis:decision-log:v1",
		intro:
			"Decisions stated in local agent sessions (we go with X because Y), deduplicated, with the session and time they were said.",
	},
} as const;
export type Category = keyof typeof CATEGORIES;

export interface TargetAnalysis {
	target: OrganizationTarget;
	sessions: Record<Harness, number>;
	from: string;
	to: string;
	asks: Ask[];
	tools: Array<{ sessionId: string; tools: ToolEvent[] }>;
}

export interface AnalyzePlan {
	files: number;
	skippedSessions: number;
	byTarget: Map<string, TargetAnalysis>;
	unrouted: Unrouted;
}

export function planAnalysis(input: {
	files: SessionFile[];
	since?: string;
	targets: Map<string, OrganizationTarget>;
	defaultTarget: OrganizationTarget | undefined;
	originOf?: (directory: string) => string | null | undefined;
	read?: (path: string) => Json[];
}): AnalyzePlan {
	const plan: AnalyzePlan = {
		files: input.files.length,
		skippedSessions: 0,
		byTarget: new Map(),
		unrouted: emptyUnrouted(),
	};
	const read = input.read ?? parseLines;
	const locate = sessionLocator(input.originOf);
	const seenAsks = new Set<string>();
	const seenTools = new Set<string>();
	const since = input.since ?? "";
	for (const file of input.files) {
		let rows: Json[];
		try {
			rows = read(file.path);
		} catch {
			continue;
		}
		const signals =
			file.harness === "codex" ? codexSignals(rows) : claudeSignals(rows);
		if (!signals) {
			plan.skippedSessions++;
			continue;
		}
		// Forks and resumed sessions replay turns: count each moment once.
		const asks = signals.asks.filter((ask) => {
			const key = `${signals.harness}\n${ask.at}\n${sha(ask.text)}`;
			if (ask.at < since || seenAsks.has(key)) return false;
			seenAsks.add(key);
			return true;
		});
		const tools = signals.tools.filter((tool) => {
			const key = `${signals.harness}\n${tool.at}\n${tool.head}`;
			if (tool.at < since || seenTools.has(key)) return false;
			seenTools.add(key);
			return true;
		});
		if (!asks.length && !tools.length) continue;
		const target = routedTarget(locate(signals), input, plan.unrouted, 1);
		if (!target) continue;
		const key = targetKey(target);
		const bucket = plan.byTarget.get(key) ?? {
			target,
			sessions: { "claude-code": 0, codex: 0 },
			from: "",
			to: "",
			asks: [],
			tools: [],
		};
		plan.byTarget.set(key, bucket);
		bucket.sessions[signals.harness]++;
		for (const at of [...asks, ...tools].map((e) => e.at)) {
			if (!bucket.from || at < bucket.from) bucket.from = at;
			if (at > bucket.to) bucket.to = at;
		}
		bucket.asks.push(
			...asks.map((ask) => ({ ...ask, session: signals.sessionId })),
		);
		bucket.tools.push({ sessionId: signals.sessionId, tools });
	}
	return plan;
}

const DESCRIPTION_LIMIT = 9500;

export function renderDescription(
	category: Category,
	analysis: Pick<TargetAnalysis, "sessions" | "from" | "to">,
	entries: Ranked[],
): string {
	const { intro } = CATEGORIES[category];
	const total = analysis.sessions["claude-code"] + analysis.sessions.codex;
	const header = [
		intro,
		"",
		`Source: ${total} local sessions (${analysis.sessions["claude-code"]} Claude Code, ${analysis.sessions.codex} Codex), ${day(analysis.from)} to ${day(analysis.to)}. Counts and short redacted paraphrases only; no transcript leaves the machine.`,
		"Maintained by tedix learn analyze-sessions: a re-run replaces this list.",
		"",
	];
	if (!entries.length)
		return [...header, "Nothing met the threshold yet."].join("\n");
	const lines: string[] = [];
	let size = header.join("\n").length;
	entries.forEach((entry, i) => {
		const line = `${i + 1}. ${entry.label} (${entry.count} times in ${entry.sessions} sessions, last ${entry.last}${entry.note ? `; ${entry.note}` : ""})`;
		if (size + line.length + 1 > DESCRIPTION_LIMIT) return;
		size += line.length + 1;
		lines.push(line);
	});
	return [...header, ...lines].join("\n");
}

export function rankAll(
	analysis: TargetAnalysis,
	decisions: Ranked[] | null,
): Partial<Record<Category, Ranked[]>> {
	return {
		requests: repeatedRequests(analysis.asks),
		friction: frictionHotspots(analysis.tools),
		...(decisions ? { decisions } : {}),
	};
}

/** Every category title starts with this; it stays under D1's 50-byte LIKE limit. */
const TITLE_PREFIX = "Session analysis";

/** Code Mode program: find the item by intent or title, then update or create it. */
export function syncSource(want: {
	title: string;
	intent: string;
	description: string;
	projectId: string | null;
	create: boolean;
}): string {
	return `async () => {
	const want = ${asciiJson(want)};
	const page = await work.list_work_items({ titleContains: ${JSON.stringify(TITLE_PREFIX)}, limit: 100 });
	// A failed read must never fall through to a create.
	if (page?.ok === false || !Array.isArray(page?.data)) return { ok: false, error: "listing Work Items failed: " + String(page?.error ?? "no data") };
	const rows = page.data.filter((r) => r.sourceIntentId === want.intent || r.title === want.title);
	const row = rows.find((r) => r.disposition !== "cancelled");
	if (row) {
		if (row.description === want.description) return { id: row.id, action: "unchanged" };
		await work.update_work_item_specification({ id: row.id, description: want.description });
		return { id: row.id, action: "updated" };
	}
	if (rows.length) return { id: rows[0].id, action: "cancelled; left alone" };
	if (!want.create) return { id: null, action: "nothing to report" };
	if (!want.projectId) return { id: null, action: "needs --project" };
	const made = await work.create_work_items({ title: want.title, description: want.description, workKind: "research", priority: "medium", projectId: want.projectId, sourceIntentId: want.intent });
	return { id: made.id, action: "created" };
}`;
}

function parseOptions(args: string[]) {
	const options = {
		dryRun: false,
		json: false,
		noModel: false,
		since: undefined as string | undefined,
		projects: [] as string[],
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const value = () => {
			const next = args[++i];
			if (!next || next.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--no-model") options.noModel = true;
		else if (arg === "--since") {
			const since = new Date(value());
			if (Number.isNaN(since.getTime()))
				throw new Error("--since must be a date, e.g. 2026-01-01");
			options.since = since.toISOString();
		} else if (arg === "--project") options.projects.push(value());
		else throw new Error(`Unknown option ${arg}`);
	}
	return options;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** `--project <target>=<id>` per organization, or a bare id for the only one. */
export function projectFor(
	key: string,
	projects: string[],
	targetCount: number,
): string | null {
	for (const entry of projects) {
		const at = entry.lastIndexOf("=");
		const [scope, id] =
			at < 0 ? [null, entry] : [entry.slice(0, at), entry.slice(at + 1)];
		if (!UUID.test(id))
			throw new Error(`--project needs a project id, got ${id}`);
		if (scope === key || (scope === null && targetCount === 1)) return id;
	}
	return null;
}

export interface AnalyzeDeps extends LearnDeps {
	runModel?: RunModel;
	files?: SessionFile[];
	readFile?: (path: string) => Json[];
	originOf?: (directory: string) => string | null | undefined;
}

export async function runAnalyzeSessions(
	args: string[],
	deps: AnalyzeDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = parseOptions(args);
	const plan = planAnalysis({
		files: deps.files ?? sessionFiles(deps.home),
		since: options.since,
		targets: deps.targets ?? repositoryTargetsByOrigin(),
		defaultTarget:
			"defaultTarget" in deps
				? deps.defaultTarget
				: defaultOrganizationTarget(),
		read: deps.readFile,
		originOf: deps.originOf,
	});
	const runModel = deps.runModel ?? claudeModel;
	const read = deps.read ?? cliRead;
	const report: Json = {
		files: plan.files,
		skippedSessions: plan.skippedSessions,
		unrouted: plan.unrouted,
		targets: {},
	};
	let failed = false;
	for (const [key, analysis] of plan.byTarget) {
		let decisions: Ranked[] | null = null;
		let candidates = 0;
		if (!options.noModel) {
			const found = decisionCandidates(analysis.asks);
			candidates = found.length;
			decisions = decisionLog(await extractDecisions(found, runModel));
		}
		const ranked = rankAll(analysis, decisions);
		const entry: Json = {
			sessions: analysis.sessions,
			from: day(analysis.from),
			to: day(analysis.to),
			decisionCandidates: candidates,
			...ranked,
		};
		report.targets[key] = entry;
		if (options.dryRun) continue;
		const projectId = projectFor(key, options.projects, plan.byTarget.size);
		const command = [
			"-w",
			analysis.target.workspace,
			...(analysis.target.organization
				? ["--organization", analysis.target.organization]
				: []),
			"code",
		];
		entry.workItems = {};
		for (const category of Object.keys(ranked) as Category[]) {
			const entries = ranked[category]!;
			const source = syncSource({
				title: CATEGORIES[category].title,
				intent: CATEGORIES[category].intent,
				description: renderDescription(category, analysis, entries),
				projectId,
				create: entries.length > 0,
			});
			try {
				const result = await read(command, 120_000, source);
				if (result.ok === false)
					throw new Error(String(result.error ?? "tool call failed"));
				entry.workItems[category] = result;
			} catch (error) {
				failed = true;
				entry.workItems[category] = {
					error: (error instanceof Error ? error.message : String(error)).slice(
						0,
						200,
					),
				};
			}
		}
	}
	write(
		options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2),
	);
	return failed ? 2 : 0;
}
