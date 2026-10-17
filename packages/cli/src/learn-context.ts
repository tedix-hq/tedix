/**
 * `tedix learn context` and `tedix learn review`: turn a person's local Claude
 * Code and Codex sessions into proposals for the shared Work board, without
 * creating duplicates.
 *
 * 1. Extract (local). Each session becomes a short digest: the host's own
 *    session title (Claude Code ai-title, Codex thread name or Codex goal) and
 *    the first few things the person typed, scrubbed and bounded. The
 *    person's own `claude` CLI (else their `codex`) groups the digests into
 *    typed candidates (task, goal, project) with a confidence and the
 *    sessions that cite them, and names the people it saw, whose names are
 *    then taken out of every session title; without a model each titled
 *    session is a candidate. A candidate survives when two or more sessions
 *    share it, it carries a Codex goal, or the model is confident.
 * 2. Match (read-only). Code Mode programs read the organization's projects
 *    and its proposed, accepted, completed and cancelled Work (the last two
 *    since the earliest session) and return, per candidate, the closest items
 *    by IDF-weighted word overlap, plus every open project for the model.
 *    Only candidate and session titles go up; nothing is stored.
 * 3. Judge (local). Two model votes decide per candidate whether an existing
 *    item already covers it, and otherwise which project (and open parent
 *    item) it belongs under. A close call gets one focused second look that
 *    tells the same work from a broader item it belongs under; without a
 *    model, score thresholds decide.
 * 4. Propose. Covered candidates are reported, never written. A candidate
 *    with a project becomes a proposal in the person's Tedix inbox (a Work
 *    interaction, see learn-proposals.ts); a project or goal with three or
 *    more of its own tasks and no item on the board becomes one epic proposal
 *    with those tasks under it. The rest is listed and never filed. Nothing
 *    reaches the shared board until the person accepts, in Tedix OS, in chat
 *    or with `tedix learn review`; the inbox is checked first, so a re-run
 *    never asks or creates twice.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSessionDecision } from "@tedix/api-contract/schemas/agent-session-decisions";
import {
	defaultOrganizationTarget,
	type OrganizationTarget,
	repositoryTargetsByOrigin,
} from "./agent-context";
import { asciiJson } from "./hooks/agent-status";
import { redact } from "./hooks/decision-capture";
import { AGENT_IDENTITY_ENV, cliRead, type ReadJson } from "./hooks/hook-io";
import {
	claudeSignals,
	codexSignals,
	localModel,
	runAnalyzeSessions,
	type RunModel,
	type SessionSignals,
} from "./learn-analyze";
import {
	type LearnDeps,
	type Location,
	parseLines,
	runLearnCommand,
	sessionFiles,
	routedTarget,
	scrub,
	type SessionFile,
	sessionLocator,
	targetKey,
	type Unrouted,
} from "./learn-import";
import {
	type AskedProposal,
	type Citation,
	listProposalsSource,
	proposalRequest,
	publishSource,
	respondSource,
} from "./learn-proposals";
import { selfCommand } from "./shared";

type Json = Record<string, any>;

const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

export const short = (text: string, limit: number) =>
	redact(scrub(text).replace(/\s+/g, " "), limit)[0];

// ---------------------------------------------------------------------------
// Local sources beside the transcripts
// ---------------------------------------------------------------------------

/** Codex thread names (`~/.codex/session_index.jsonl`), newest name wins. */
export function codexThreadNames(home = homedir()): Map<string, string> {
	const names = new Map<string, string>();
	const path = join(home, ".codex", "session_index.jsonl");
	if (!existsSync(path)) return names;
	for (const row of parseLines(path))
		if (typeof row.id === "string" && typeof row.thread_name === "string")
			names.set(row.id, row.thread_name);
	return names;
}

/** Codex thread goals (`~/.codex/goals_1.sqlite`), read-only; empty when absent. */
export async function codexGoals(
	home = homedir(),
): Promise<Map<string, string>> {
	const goals = new Map<string, string>();
	const path = join(home, ".codex", "goals_1.sqlite");
	if (!existsSync(path)) return goals;
	try {
		const { Database } = await import("bun:sqlite");
		const db = new Database(path, { readonly: true });
		try {
			for (const row of db
				.query("select thread_id, objective from thread_goals")
				.all() as Array<{ thread_id: string; objective: string }>)
				goals.set(row.thread_id, row.objective);
		} finally {
			db.close();
		}
	} catch {
		/* Another Codex version, or locked: goals are optional. */
	}
	return goals;
}

/** The first sentence of a goal, which is its point. */
export function goalTitle(objective: string): string {
	const first = objective.split(/(?<=[.!?:;])\s|\n/)[0] ?? objective;
	return short(first, 140);
}

// ---------------------------------------------------------------------------
// Preference notes in local memory files (personal, never shared)
// ---------------------------------------------------------------------------

export interface MemoryNote {
	harness: AgentSessionDecision["harness"];
	path: string;
	text: string;
	at: string;
	/** A transcript directory whose sessions locate the note, if any. */
	sessionDirectory: string | null;
}

function frontmatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	const out: Record<string, string> = {};
	if (!match) return out;
	for (const line of match[1]!.split("\n")) {
		const field = /^\s*([\w-]+):\s*(.*)$/.exec(line);
		if (field)
			out[field[1]!] = field[2]!
				.replace(/^["']|["']$/g, "")
				.replace(/\\"/g, '"');
	}
	return out;
}

/** Bullets under a heading whose name says it is about the person. */
function preferenceBullets(markdown: string): string[] {
	const out: string[] = [];
	let inSection = false;
	for (const line of markdown.split("\n")) {
		const heading = /^#{1,4}\s+(.*)$/.exec(line);
		if (heading) {
			inSection =
				/prefer|style|how (?:i|the user|we) work|about me|working/i.test(
					heading[1]!,
				);
			continue;
		}
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		if (inSection && bullet) out.push(bullet[1]!);
	}
	return out;
}

const MIN_NOTE_CHARS = 24;
const NOTE_CHARS = 900;

/**
 * Preference notes the person's agents already keep: Claude Code memories of
 * type `user` or `feedback` (their one-line description), and the preference
 * sections of Codex's memory summary. Project and reference memories stay on
 * the machine.
 */
export function memoryNotes(home = homedir()): MemoryNote[] {
	const notes: MemoryNote[] = [];
	const add = (
		harness: MemoryNote["harness"],
		path: string,
		text: string,
		sessionDirectory: string | null,
	) => {
		const clean = text.replace(/\s+/g, " ").trim();
		if (clean.length < MIN_NOTE_CHARS) return;
		let at: string;
		try {
			at = statSync(path).mtime.toISOString();
		} catch {
			return;
		}
		notes.push({ harness, path, text: clean, at, sessionDirectory });
	};
	const projects = join(home, ".claude", "projects");
	if (existsSync(projects))
		for (const entry of readdirSync(projects, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(projects, entry.name);
			const memory = join(directory, "memory");
			if (!existsSync(memory)) continue;
			for (const file of readdirSync(memory)) {
				if (!file.endsWith(".md") || file === "MEMORY.md") continue;
				const path = join(memory, file);
				let text: string;
				try {
					text = readFileSync(path, "utf8");
				} catch {
					continue;
				}
				const meta = frontmatter(text);
				if (meta.type !== "user" && meta.type !== "feedback") continue;
				if (meta.description)
					add("claude-code", path, meta.description, directory);
			}
		}
	const summary = join(home, ".codex", "memories", "memory_summary.md");
	if (existsSync(summary))
		for (const bullet of preferenceBullets(readFileSync(summary, "utf8")))
			add("codex", summary, bullet, null);
	return notes;
}

/** A transcript directory's checkout, from the first session that names one. */
export function directoryCwd(
	directory: string,
	read: (path: string) => Json[] = parseLines,
): string | null {
	let files: string[];
	try {
		files = readdirSync(directory).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	for (const file of files.slice(0, 5)) {
		try {
			const row = read(join(directory, file)).find(
				(r) => typeof r.cwd === "string",
			);
			if (row) return row.cwd as string;
		} catch {
			/* Next one. */
		}
	}
	return null;
}

/** Notes as personal decision events, routed like the sessions they sit beside. */
export function planNotes(input: {
	notes: MemoryNote[];
	targets: Map<string, OrganizationTarget>;
	defaultTarget: OrganizationTarget | undefined;
	locate: (session: { cwd: string | null; origin: string | null }) => Location;
	cwdOf?: (directory: string) => string | null;
	unrouted: Unrouted;
	limitPerTarget?: number;
}): Map<
	string,
	{ target: OrganizationTarget; decisions: AgentSessionDecision[] }
> {
	const out = new Map<
		string,
		{ target: OrganizationTarget; decisions: AgentSessionDecision[] }
	>();
	const cwdOf = input.cwdOf ?? ((directory: string) => directoryCwd(directory));
	const cwds = new Map<string, string | null>();
	const limit = input.limitPerTarget ?? 300;
	for (const note of input.notes) {
		let location: Location = { kind: "none" };
		if (note.sessionDirectory) {
			if (!cwds.has(note.sessionDirectory))
				cwds.set(note.sessionDirectory, cwdOf(note.sessionDirectory));
			const cwd = cwds.get(note.sessionDirectory);
			// A note whose checkout is gone is still the person's own: it goes
			// where notes outside a repository go.
			if (cwd) location = input.locate({ cwd, origin: null });
			if (location.kind === "unknown") location = { kind: "none" };
		}
		const target = routedTarget(location, input, input.unrouted, 1);
		if (!target) continue;
		const key = targetKey(target);
		const bucket = out.get(key) ?? { target, decisions: [] };
		out.set(key, bucket);
		if (bucket.decisions.length >= limit) continue;
		const reply = short(note.text, NOTE_CHARS);
		bucket.decisions.push({
			harness: note.harness,
			sessionId: `memory:${sha(note.path)}`,
			turnId: sha(reply),
			repository: location.kind === "repo" ? location.repository : null,
			topic: "preference",
			occurredAt: note.at,
			agentMessage: "",
			reply,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Session digests and candidates
// ---------------------------------------------------------------------------

export interface SessionDigest {
	harness: SessionFile["harness"];
	sessionId: string;
	title: string | null;
	goal: boolean;
	asks: string[];
	repository: string | null;
	from: string;
	to: string;
}

/** Asks that say what a session is about, not "status?" or "go on". */
const FILLER =
	/^(?:status( now)?\??|what'?s next\??|whats next\??|next\??|continue\b.*|go on|go ahead|proceed|make it happen|ok\b.*|yes\b.*|no\b.*|thanks?\b.*|done\??|any (?:pending|updates?)\b.*)$/i;

function substantive(text: string): boolean {
	const clean = text.trim();
	return clean.length >= 16 && !FILLER.test(clean);
}

export interface ContextPlan {
	files: number;
	byTarget: Map<
		string,
		{ target: OrganizationTarget; sessions: SessionDigest[] }
	>;
	unrouted: Unrouted;
}

export function planContext(input: {
	files: SessionFile[];
	since?: string;
	targets: Map<string, OrganizationTarget>;
	defaultTarget: OrganizationTarget | undefined;
	titles?: Map<string, string>;
	goals?: Map<string, string>;
	originOf?: (directory: string) => string | null | undefined;
	read?: (path: string) => Json[];
}): ContextPlan {
	const plan: ContextPlan = {
		files: input.files.length,
		byTarget: new Map(),
		unrouted: {
			unboundRepository: {},
			unknownLocation: 0,
			noDefaultOrganization: 0,
		},
	};
	const read = input.read ?? parseLines;
	const locate = sessionLocator(input.originOf);
	const seen = new Set<string>();
	const since = input.since ?? "";
	for (const file of input.files) {
		let signals: SessionSignals | null;
		try {
			const rows = read(file.path);
			signals =
				file.harness === "codex" ? codexSignals(rows) : claudeSignals(rows);
		} catch {
			continue;
		}
		if (!signals || seen.has(signals.sessionId)) continue;
		const asks = signals.asks.filter((ask) => ask.at >= since);
		if (!asks.length) continue;
		seen.add(signals.sessionId);
		const goal = input.goals?.get(signals.sessionId);
		const title = goal
			? goalTitle(goal)
			: (signals.title ?? input.titles?.get(signals.sessionId) ?? null);
		const said = asks.map((ask) => ask.text).filter(substantive);
		if (!title && !said.length) continue;
		// The last thing typed, however short ("merged, done"), tells whether
		// the work finished.
		const last = asks[asks.length - 1]!.text;
		const firsts = [
			...said.slice(0, 2),
			...(said.slice(0, 2).includes(last) ? [] : [last]),
		].map((text) => short(text, 200));
		const location = locate(signals);
		const target = routedTarget(location, input, plan.unrouted, 1);
		if (!target) continue;
		const key = targetKey(target);
		const bucket = plan.byTarget.get(key) ?? { target, sessions: [] };
		plan.byTarget.set(key, bucket);
		const times = asks.map((ask) => ask.at).sort();
		bucket.sessions.push({
			harness: signals.harness,
			sessionId: signals.sessionId,
			title: title ? short(title, 140) : null,
			goal: Boolean(goal),
			asks: firsts,
			repository: location.kind === "repo" ? location.repository : null,
			from: times[0]!,
			to: times[times.length - 1]!,
		});
	}
	// Oldest first: sessions still being written land in the last model
	// chunk, so the earlier chunks keep their cached answers on a re-run.
	for (const bucket of plan.byTarget.values())
		bucket.sessions.sort((a, b) =>
			a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
		);
	return plan;
}

export type CandidateKind = "task" | "goal" | "project";

export interface Candidate {
	key: string;
	kind: CandidateKind;
	title: string;
	confidence: number;
	sessions: string[];
	from: string;
	to: string;
	goal: boolean;
	/** The sessions show it finished: context only, never a new item. */
	done?: boolean;
	/** The cited sessions' own titles, which widen the board search. */
	context?: string;
	/** The first thing asked in one of its sessions: for the local model only, never sent. */
	ask?: string;
}

const STOP = new Set(
	"a an the to and or of for in on at is are be it this that these those please can could would will you we i me my our us now then just ok so do its with from what how also all any into by as about via per new make get set use using".split(
		" ",
	),
);

/** Crude suffix folding so "adopt", "adoption" and "adopting" meet. */
const SUFFIX =
	/(?:abilities|ability|ations|ation|ings|ing|ions|ion|able|ers|er|ed|es|s|ly|e)$/;

export function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length > 1 && !STOP.has(word))
		.map((word) => {
			if (word.length <= 4) return word;
			const stem = word.replace(SUFFIX, "");
			return stem.length >= 3 ? stem : word;
		});
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared || 1);
}

export const EXTRACT_PROMPT = `Below are numbered summaries of one person's coding-agent sessions: the session title, then the first things they typed.
List the durable work these sessions show:
- "task": one concrete deliverable (fix, build, write, ship, research something specific);
- "goal": an outcome pursued across several sessions;
- "project": a named product area, client or body of work; when three or more tasks belong to the same one, list it as well, citing all their sessions. Name the narrowest body of work that groups them (a feature or initiative such as "billing exports", not the whole product).
Merge sessions only when they work on the same deliverable or outcome; related but different deliverables stay separate entries. Skip status checks, one-off questions, small talk, personal errands unrelated to their work, and tests or demos of the agent itself.
Each summary ends with the last thing typed. Mark "done" true only when the person explicitly confirms completion in the cited sessions (shipped, merged, closed, answered). A request to build, write, review or finish something is not confirmation that it happened. Without explicit completion evidence, "done" is false.
Return ONLY a JSON array, no prose: [{"kind":"task|goal|project","title":"<at most 12 words; a task starts with a verb>","sessions":[<numbers>],"confidence":<0 to 1>,"done":<true|false>}].
Paraphrase. Keep product, client and project names; never include people's names, email addresses, secrets, tokens or URLs.
End the array with one more entry, {"kind":"people","names":[...]}: every first or last name of a person that appears anywhere below (not companies, products, places or programs).
Return [{"kind":"people","names":[]}] if nothing qualifies.

`;

const EXTRACT_CHUNK = 30;
const KINDS = new Set(["task", "goal", "project"]);

function parseArray(raw: string): unknown[] {
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start < 0 || end < start) return [];
	try {
		const parsed = JSON.parse(raw.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function inPool<T>(
	items: T[],
	concurrency: number,
	work: (item: T) => Promise<void>,
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) await work(items[next++]!);
		}),
	);
}

type RawCandidate = Omit<Candidate, "key" | "from" | "to" | "goal">;

/**
 * Raw candidates per session group, from the model or from titles alone, and
 * the names of people the model saw in the sessions.
 */
async function rawCandidates(
	sessions: SessionDigest[],
	runModel: RunModel | null,
): Promise<{ items: RawCandidate[]; people: Set<string> }> {
	const people = new Set<string>();
	if (!runModel)
		return {
			people,
			items: sessions
				.filter((s) => s.title || s.asks[0])
				.map((s) => ({
					kind: s.goal ? "goal" : "task",
					title: s.title ?? s.asks[0]!,
					confidence: s.goal ? 0.9 : 0.5,
					sessions: [s.sessionId],
				})),
		};
	const chunks: SessionDigest[][] = [];
	for (let i = 0; i < sessions.length; i += EXTRACT_CHUNK)
		chunks.push(sessions.slice(i, i + EXTRACT_CHUNK));
	const out: RawCandidate[] = [];
	await inPool(chunks, 4, async (chunk) => {
		const prompt =
			EXTRACT_PROMPT +
			chunk
				.map((s, i) =>
					`${i + 1}. [${s.repository ?? "no repository"}] ${s.goal ? "GOAL: " : ""}${s.title ?? "(untitled)"} | ${s.asks.join(" / ")}`.slice(
						0,
						700,
					),
				)
				.join("\n");
		let raw: string;
		try {
			raw = await runModel(prompt);
		} catch {
			return;
		}
		for (const entry of parseArray(raw) as Json[]) {
			if (entry?.kind === "people" && Array.isArray(entry.names)) {
				for (const name of entry.names)
					if (typeof name === "string")
						for (const part of name.split(/\s+/))
							if (part.length >= 3) people.add(part.toLowerCase());
				continue;
			}
			if (!entry || !KINDS.has(entry.kind) || typeof entry.title !== "string")
				continue;
			const cited = (Array.isArray(entry.sessions) ? entry.sessions : [])
				.map((n: unknown) =>
					Number.isInteger(n) ? chunk[(n as number) - 1] : undefined,
				)
				.filter(Boolean) as SessionDigest[];
			if (!cited.length) continue;
			const title = short(entry.title, 120);
			if (words(title).length < 2) continue;
			const confidence = Number(entry.confidence);
			out.push({
				kind: entry.kind,
				title,
				confidence: Number.isFinite(confidence)
					? Math.min(1, Math.max(0, confidence))
					: 0.5,
				sessions: cited.map((s) => s.sessionId),
				...(entry.done === true ? { done: true } : {}),
			});
		}
	});
	return { items: out, people };
}

/** Each of these names, as a whole word, replaced by "[name]". */
export function withoutNames(text: string, names: Set<string>): string {
	if (!names.size) return text;
	return text.replace(/[\p{L}][\p{L}'-]*/gu, (word) => {
		const possessive = /'s$/i.test(word) ? word.slice(-2) : "";
		const bare = possessive ? word.slice(0, -2) : word;
		return names.has(bare.toLowerCase()) ? `[name]${possessive}` : word;
	});
}

/**
 * Merge near-identical candidates and keep the ones with real support.
 *
 * Session titles come from the host and can name people. Every name the
 * model saw is taken out of the digests' titles here, in place, so the board
 * search, the proposals and their citations, all built from these digests
 * later, carry none.
 */
export async function extractCandidates(
	sessions: SessionDigest[],
	runModel: RunModel | null,
	options = { threshold: 0.5, minSessions: 2, confident: 0.8 },
): Promise<Candidate[]> {
	const byId = new Map(sessions.map((s) => [s.sessionId, s]));
	const { items, people } = await rawCandidates(sessions, runModel);
	for (const s of sessions)
		if (s.title) s.title = withoutNames(s.title, people);
	const raw = items.map((item) => ({
		...item,
		title: withoutNames(item.title, people),
	}));
	const clusters: Array<{ words: Set<string>; items: typeof raw }> = [];
	for (const item of raw) {
		const set = new Set(words(item.title));
		if (!set.size) continue;
		const cluster = clusters.find(
			(c) => jaccard(c.words, set) >= options.threshold,
		);
		if (cluster) {
			cluster.items.push(item);
			for (const word of set) cluster.words.add(word);
		} else clusters.push({ words: set, items: [item] });
	}
	const out: Candidate[] = [];
	for (const cluster of clusters) {
		const ids = [...new Set(cluster.items.flatMap((i) => i.sessions))];
		const cited = ids
			.map((id) => byId.get(id))
			.filter(Boolean) as SessionDigest[];
		const goal = cited.some((s) => s.goal);
		const best = [...cluster.items].sort(
			(a, b) =>
				b.confidence - a.confidence || b.sessions.length - a.sessions.length,
		)[0]!;
		// Without a model, support across sessions is the only confidence.
		const confidence = runModel
			? Math.max(...cluster.items.map((i) => i.confidence))
			: Math.min(0.8, 0.5 + 0.1 * ids.length);
		if (
			ids.length < options.minSessions &&
			!goal &&
			confidence < options.confident
		)
			continue;
		const times = cited.flatMap((s) => [s.from, s.to]).sort();
		const context = [...new Set(cited.map((s) => s.title).filter(Boolean))]
			.join("; ")
			.slice(0, 300);
		out.push({
			key: sha(words(best.title).sort().join(" ")),
			// A Codex goal makes its sessions a goal; the model's own task of
			// that goal stays a task.
			kind: goal && (!runModel || best.kind !== "task") ? "goal" : best.kind,
			title: best.title,
			confidence,
			sessions: ids,
			from: times[0] ?? "",
			to: times[times.length - 1] ?? "",
			goal,
			// Finished only when every entry merged here says so.
			...(cluster.items.every((i) => i.done) ? { done: true } : {}),
			...(context ? { context } : {}),
			...(cited[0]?.asks[0] ? { ask: cited[0].asks[0].slice(0, 160) } : {}),
		});
	}
	return withFoldedTasks(withoutUmbrellas(out), byId).sort(
		(a, b) => b.sessions.length - a.sessions.length,
	);
}

/**
 * A project or goal can cite sessions no task of its own explains: the model
 * folded those deliverables into the body of work instead of listing them.
 * Each such session (titled, with something the person actually asked) is a
 * task of that body of work under its own title, so the body of work still
 * reaches the {@link EPIC_MIN_TASKS} it needs to become an epic.
 */
function withFoldedTasks(
	candidates: Candidate[],
	byId: Map<string, SessionDigest>,
): Candidate[] {
	const out = [...candidates];
	const covered = new Set(
		candidates.filter((c) => c.kind === "task").flatMap((c) => c.sessions),
	);
	for (const head of candidates) {
		if (head.kind === "task" || head.done) continue;
		if (head.sessions.length < EPIC_MIN_TASKS) continue;
		for (const id of head.sessions) {
			const s = byId.get(id);
			if (covered.has(id) || !s?.title || s.goal) continue;
			if (!s.asks.some(substantive)) continue;
			if (words(s.title).length < 2) continue;
			covered.add(id);
			out.push({
				key: sha(words(s.title).sort().join(" ")),
				kind: "task",
				title: s.title,
				confidence: head.confidence,
				sessions: [id],
				from: s.from,
				to: s.to,
				goal: false,
				context: s.title,
				...(s.asks[0] ? { ask: s.asks[0].slice(0, 160) } : {}),
			});
		}
	}
	return out;
}

/**
 * A broad entry whose sessions are mostly explained by narrower ones ("the
 * open-source project" over its three concrete tasks) would only restate them
 * as a Work Item of its own, so it is kept as a project: context for placement
 * and, when the board has nothing for it, the epic its tasks go under.
 */
function withoutUmbrellas(candidates: Candidate[]): Candidate[] {
	return candidates.map((c) => {
		if (c.kind === "project" || c.sessions.length < 3) return c;
		const covered = new Set(
			candidates
				.filter(
					(o) =>
						o !== c &&
						o.kind !== "project" &&
						o.sessions.length < c.sessions.length,
				)
				.flatMap((o) => o.sessions),
		);
		return c.sessions.filter((id) => covered.has(id)).length * 3 <
			c.sessions.length * 2
			? c
			: { ...c, kind: "project" };
	});
}

// ---------------------------------------------------------------------------
// Board match (read-only Code Mode)
// ---------------------------------------------------------------------------

/** [id, title, projectId, disposition, parentId, score] */
export type WorkMatch = [
	string,
	string,
	string | null,
	string,
	string | null,
	number,
];
/** [id, key, name, score] */
export type ProjectMatch = [string, string, string, number];

/** [id, key, name, description] */
export type ProjectInfo = [string, string, string, string];

export interface BoardMatches {
	me: { id: string; name: string } | null;
	scanned: Record<string, number>;
	matches: Record<string, { w: WorkMatch[]; p: ProjectMatch[] }>;
	/**
	 * Every open project, so the model places work by what a project is for,
	 * not by the words it happens to share with the closest few.
	 */
	projects?: ProjectInfo[];
}

/** Projects per catalog program, well under the gateway's result cap. */
const CATALOG_PAGE = 40;

/** Code Mode program: one page of open projects, key, name and description. */
export function projectCatalogSource(offset: number): string {
	return `async () => {
	const r = await projects.list_projects({ limit: ${CATALOG_PAGE}, offset: ${offset} });
	if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "listing projects failed: " + String(r?.error ?? "no data") };
	const clean = (text) => String(text || "").replace(/\\s+/g, " ").replace(/^BRIEF \\([^)]*\\)\\s*/, "").trim();
	return {
		projects: r.data.filter((p) => p.status !== "archived" && p.status !== "done" && !p.archivedAt).map((p) => [p.id, p.key, clean(p.name).slice(0, 80), clean(p.description).slice(0, 140)]),
		more: Boolean(r.pagination?.hasMore) && r.data.length > 0,
	};
}`;
}

const CATALOG_MAX = 400;

/** Every open project, page by page; empty when the listing fails. */
export async function projectCatalog(
	call: (source: string) => Promise<Json>,
): Promise<ProjectInfo[]> {
	const out: ProjectInfo[] = [];
	try {
		for (let offset = 0; offset < CATALOG_MAX; offset += CATALOG_PAGE) {
			const page = await call(projectCatalogSource(offset));
			if (!Array.isArray(page.projects)) break;
			out.push(...(page.projects as ProjectInfo[]));
			if (!page.more) break;
		}
	} catch {
		/* Placement falls back to the closest projects by words. */
	}
	return out;
}

/**
 * Code Mode program: read projects and Work, score each candidate title
 * against them, return only the closest few. Reads only; writes nothing.
 */
export function boardMatchSource(input: {
	/** Key, title and the titles of the sessions behind it. */
	candidates: Array<{ k: string; t: string; q?: string }>;
	dispositions: string[];
	projects: boolean;
}): string {
	return `async () => {
	const input = ${asciiJson(input)};
	const STOP = new Set(${asciiJson([...STOP])});
	const SUFFIX = new RegExp(${JSON.stringify(SUFFIX.source)});
	const words = (text) => String(text || "").toLowerCase().replace(/[^\\p{L}\\p{N}\\s]/gu, " ").split(/\\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => { if (w.length <= 4) return w; const stem = w.replace(SUFFIX, ""); return stem.length >= 3 ? stem : w; });
	let me = null;
	try { const p = await user.get_mine({}); if (p && p.id) me = { id: p.id, name: String(p.name || "") }; } catch {}
	const items = [];
	const scanned = {};
	for (const disposition of input.dispositions) {
		scanned[disposition] = 0;
		if (disposition === "completed" || disposition === "cancelled") continue;
		for (let offset = 0; offset < 30000; offset += 100) {
			const r = await work.list_work_items({ limit: 100, offset, disposition });
			if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "listing Work Items failed: " + String(r?.error ?? "no data") };
			for (const w of r.data) {
				items.push({ id: w.id, t: w.title, p: w.projectId || null, d: w.disposition, par: w.parentWorkItemId || null, ws: new Set(words(w.title)) });
			}
			scanned[disposition] += r.data.length;
			if (!r.pagination?.hasMore) break;
		}
	}
	// Older finished work still prevents duplicates; search it by topic rather
	// than scanning the organization's entire history in one gateway call.
	if (input.dispositions.includes("completed")) {
		const seen = new Set(items.map((w) => w.id));
		const terms = new Set(input.candidates.flatMap((c) => words(c.t).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 3)));
		for (const titleContains of terms) {
			for (let offset = 0; ; offset += 100) {
				const r = await work.list_work_items({ titleContains, limit: 100, offset });
				if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "searching older Work Items failed: " + String(r?.error ?? "no data") };
				for (const w of r.data) {
					if (seen.has(w.id) || !input.dispositions.includes(w.disposition)) continue;
					seen.add(w.id);
					scanned[w.disposition]++;
					items.push({ id: w.id, t: w.title, p: w.projectId || null, d: w.disposition, par: w.parentWorkItemId || null, ws: new Set(words(w.title)) });
				}
				if (!r.pagination?.hasMore || r.data.length === 0) break;
			}
		}
	}
	const plist = [];
	if (input.projects) {
		for (let offset = 0; offset < 2000; offset += 100) {
			const r = await projects.list_projects({ limit: 100, offset });
			if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "listing projects failed: " + String(r?.error ?? "no data") };
			for (const p of r.data) if (p.status !== "archived" && p.status !== "done" && !p.archivedAt) plist.push({ id: p.id, key: p.key, name: p.name, ws: new Set(words(p.key.replace(/[-_]/g, " ") + " " + p.name)), ds: new Set(words((p.description || "").slice(0, 400))) });
			if (!r.pagination?.hasMore) break;
		}
		scanned.projects = plist.length;
	}
	const df = new Map();
	for (const x of [...items, ...plist]) for (const w of new Set([...x.ws, ...(x.ds ?? [])])) df.set(w, (df.get(w) || 0) + 1);
	const total = items.length + plist.length + 1;
	const idf = (w) => Math.log(1 + total / (1 + (df.get(w) || 0)));
	const weight = (ws) => { let s = 0; for (const w of ws) s += idf(w); return s; };
	// Half how alike the two titles are, half how much of the candidate the item explains.
	const score = (cw, cWeight, x) => {
		let shared = 0, described = 0;
		for (const w of cw) { if (x.ws.has(w)) shared += idf(w); else if (x.ds?.has(w)) described += idf(w); }
		if (!cWeight) return 0;
		const dice = shared ? (2 * shared) / (cWeight + (x.wt ??= weight(x.ws))) : 0;
		return Math.max((dice + shared / cWeight) / 2, (0.6 * (shared + described)) / cWeight * 0.5);
	};
	const matches = {};
	for (const c of input.candidates) {
		const cw = new Set(words(c.t));
		const cWeight = weight(cw);
		const qw = new Set(words(c.t + " " + (c.q || "")));
		const qWeight = weight(qw);
		const top = (list, n) => list.map((x) => [x, Math.max(score(cw, cWeight, x), 0.9 * score(qw, qWeight, x))]).filter(([, s]) => s > 0.12).sort((a, b) => b[1] - a[1]).slice(0, n);
		matches[c.k] = {
			w: top(items, 6).map(([x, s]) => [x.id, String(x.t).slice(0, 120), x.p, x.d, x.par, Math.round(s * 100) / 100]),
			p: top(plist, 3).map(([x, s]) => [x.id, x.key, x.name, Math.round(s * 100) / 100]),
		};
	}
	return { me, scanned, matches };
}`;
}

/**
 * Candidates per program: the gateway truncates a Code Mode result past about
 * six thousand tokens, and each candidate returns up to nine matches.
 */
const MATCH_CHUNK = 8;
// Topic searches make more inner calls; keep their gateway telemetry below
// the Analytics Engine per-request write limit.
const HISTORY_MATCH_CHUNK = 2;

/**
 * Run the match as programs over open and over finished Work, each inside the
 * gateway's wait and under its result cap.
 */
export async function matchBoard(
	candidates: Candidate[],
	call: (source: string) => Promise<Json>,
	/** Also read every open project (for a model to place work with). */
	withCatalog = false,
): Promise<BoardMatches> {
	const out: BoardMatches = { me: null, scanned: {}, matches: {} };
	const open: Json = {};
	const closed: Json = {};
	const catalog = withCatalog ? projectCatalog(call) : Promise.resolve([]);
	for (let i = 0; i < candidates.length; i += MATCH_CHUNK) {
		const list = candidates.slice(i, i + MATCH_CHUNK).map((c) => ({
			k: c.key,
			t: c.title,
			...(c.context ? { q: c.context } : {}),
		}));
		const jobs = [
			{
				candidates: list,
				dispositions: ["proposed", "accepted"],
				projects: true,
			},
		];
		for (let j = 0; j < list.length; j += HISTORY_MATCH_CHUNK)
			jobs.push({
				candidates: list.slice(j, j + HISTORY_MATCH_CHUNK),
				dispositions: ["completed", "cancelled"],
				projects: false,
			});
		await inPool(jobs, 4, async (job) => {
			const result = await call(boardMatchSource(job));
			if (!result.matches || typeof result.matches !== "object")
				throw new Error("the board match returned no matches");
			Object.assign(job.projects ? open : closed, result.matches);
			out.me ??= result.me ?? null;
			Object.assign(out.scanned, result.scanned);
		});
	}
	for (const c of candidates) {
		const a = open[c.key] ?? { w: [], p: [] };
		const b = closed[c.key] ?? { w: [], p: [] };
		out.matches[c.key] = {
			w: [...a.w, ...b.w]
				.sort((x: WorkMatch, y: WorkMatch) => y[5] - x[5])
				.slice(0, 8),
			p: a.p,
		};
	}
	const projects = await catalog;
	if (projects.length) out.projects = projects;
	return out;
}

// ---------------------------------------------------------------------------
// Judge and propose
// ---------------------------------------------------------------------------

export type ProposalAction = "tracked" | "create" | "unplaced" | "nested";

export interface Proposal {
	key: string;
	kind: CandidateKind;
	title: string;
	confidence: number;
	sessions: number;
	from: string;
	to: string;
	action: ProposalAction;
	/** The existing item that already covers it (tracked). */
	workId?: string;
	workTitle?: string;
	workDisposition?: string;
	projectId?: string;
	projectKey?: string;
	parentId?: string;
	/** Closest existing item, shown to the reviewer. */
	nearest?: { id: string; title: string; score: number };
	reason: string;
	/** An epic proposal's tasks, created under it on acceptance. */
	children?: Proposal[];
	/** The epic proposal a nested task belongs to. */
	epicKey?: string;
	/** The sessions it came from (the evidence the reviewer sees). */
	citations?: Citation[];
	/** Title of the open item it goes under, when it has one. */
	parentTitle?: string;
}

export const THRESHOLDS = {
	/** Score at which an existing item covers a candidate without a model. */
	same: 0.6,
	/** A covering item's project is the candidate's project from here. */
	workProject: 0.3,
	/** A project's own words place a candidate from here. */
	project: 0.25,
	/** Below this confidence a task is listed, never proposed. */
	propose: 0.6,
	/** A proposal this close to an existing item gets a second, focused look. */
	confirm: 0.35,
	/** With a model, a match on words alone below this gets a second look. */
	clear: 0.75,
};

export const JUDGE_PROMPT = `Each numbered candidate below is work one person did in coding-agent sessions, with the titles of the sessions it came from. Under it are existing Work Items (W1..) on their team's board; the team's projects (P1..) are listed first.
For each candidate decide:
- "same": the W that already is this deliverable or outcome, even if worded differently or scoped a little differently (a completed item counts: the work is done). It must cover the requested platform, client and output: a generic getting-started guide does not establish that a Windows install guide exists. An item for a whole area, period or program that only includes this work is not the same; neither is an item for one part of a larger candidate. Empty if none is.
- "parent": when not "same", an OPEN W that is a broader effort this belongs under, else empty.
- "project": the P this work most likely belongs to: its product, client, program or kind of work (outreach to leads belongs with go-to-market work). A word in common is not enough (a "catalog" screen in someone's own app is not an MCP catalog). Empty when no project is about this kind of work.
When unsure about "same" or "parent", leave it empty.
Return ONLY a JSON array: [{"c":<number>,"same":"W<n> or empty","parent":"W<n> or empty","project":"P<n> or empty"}].

`;

const JUDGE_CHUNK = 10;
const OPEN = new Set(["proposed", "accepted"]);

/** What the model chose for one candidate. */
interface Choice {
	same?: WorkMatch;
	/** Both votes named the same covering item. */
	agreed?: boolean;
	/** The covering item came from the focused second look. */
	second?: boolean;
	/** The second look found no item the same, whatever the words say. */
	rejected?: boolean;
	parent?: WorkMatch;
	project?: ProjectMatch;
}

function decide(
	candidate: Candidate,
	match: { w: WorkMatch[]; p: ProjectMatch[] },
	projectKeys: Map<string, string>,
	pick?: Choice,
): Proposal {
	const base = {
		key: candidate.key,
		kind: candidate.kind,
		title: candidate.title,
		confidence: candidate.confidence,
		sessions: candidate.sessions.length,
		from: candidate.from.slice(0, 10),
		to: candidate.to.slice(0, 10),
	};
	const nearestWork = match.w[0];
	const nearest = nearestWork
		? { id: nearestWork[0], title: nearestWork[1], score: nearestWork[5] }
		: undefined;
	// Either the model or a clear score is enough to call it covered: a missed
	// match costs a duplicate on a shared board, a false one only a proposal.
	const same =
		pick?.same ??
		(nearestWork && nearestWork[5] >= THRESHOLDS.same && !pick?.rejected
			? nearestWork
			: undefined);
	if (same)
		return {
			...base,
			action: "tracked",
			workId: same[0],
			workTitle: same[1],
			workDisposition: same[3],
			...(same[2]
				? { projectId: same[2], projectKey: projectKeys.get(same[2]) }
				: {}),
			reason: pick?.second
				? "the model matched an existing item on a second look"
				: pick?.same
					? "the model matched an existing item"
					: `similarity ${same[5]}`,
		};
	const parent =
		pick?.parent && OPEN.has(pick.parent[3]) ? pick.parent : undefined;
	let projectId = pick?.project?.[0] ?? parent?.[2] ?? undefined;
	if (!pick) {
		const workWithProject = match.w.find(
			(w) => w[2] && w[5] >= THRESHOLDS.workProject,
		);
		const project = match.p[0];
		projectId =
			workWithProject?.[2] ??
			(project && project[3] >= THRESHOLDS.project ? project[0] : undefined);
	}
	// A project or a standing goal is context for the board (its project or
	// epic), never a new Work Item of its own.
	if (candidate.kind === "project" || candidate.kind === "goal") {
		const id = pick?.project?.[0] ?? projectId;
		return id
			? {
					...base,
					action: "tracked",
					projectId: id,
					projectKey: projectKeys.get(id),
					reason: "an existing project",
				}
			: {
					...base,
					action: "unplaced",
					...(nearest ? { nearest } : {}),
					reason: "no project on the board fits",
				};
	}
	if (!projectId)
		return {
			...base,
			action: "unplaced",
			...(nearest ? { nearest } : {}),
			reason: "no project on the board fits",
		};
	if (candidate.confidence < THRESHOLDS.propose || candidate.done)
		return {
			...base,
			action: "unplaced",
			projectId,
			projectKey: projectKeys.get(projectId),
			...(nearest ? { nearest } : {}),
			reason: candidate.done
				? "finished in the sessions, not on the board"
				: "too uncertain to propose",
		};
	return {
		...base,
		action: "create",
		projectId,
		projectKey: projectKeys.get(projectId),
		...(parent ? { parentId: parent[0], parentTitle: parent[1] } : {}),
		...(nearest ? { nearest } : {}),
		reason: "nothing on the board covers it yet",
	};
}

export async function judge(
	candidates: Candidate[],
	board: BoardMatches,
	runModel: RunModel | null,
	projectKeys: Map<string, string>,
): Promise<Proposal[]> {
	for (const match of Object.values(board.matches))
		for (const p of match.p) projectKeys.set(p[0], p[1]);
	const empty = { w: [], p: [] };
	if (!runModel)
		return proposeEpics(
			candidates,
			placeByProjects(
				candidates,
				candidates.map((c) =>
					decide(c, board.matches[c.key] ?? empty, projectKeys),
				),
			),
		);
	const catalog = board.projects ?? [];
	for (const p of catalog) projectKeys.set(p[0], p[1]);
	const catalogText = catalog.length
		? `Projects:\n${catalog
				.map(
					(p, j) =>
						`P${j + 1} ${p[1]}: ${p[2]}${p[3] && p[3] !== p[2] ? `. ${p[3]}` : ""}`,
				)
				.join("\n")}\n\nCandidates:\n`
		: "";
	const picks = new Map<string, Choice>();
	const chunks: Candidate[][] = [];
	for (let i = 0; i < candidates.length; i += JUDGE_CHUNK)
		chunks.push(candidates.slice(i, i + JUDGE_CHUNK));
	// Two independent votes: an item either vote calls covering is covering
	// until the second look below says otherwise.
	await inPool([...chunks, ...chunks], 4, async (chunk) => {
		const prompt =
			JUDGE_PROMPT +
			catalogText +
			chunk
				.map((c, i) => {
					const m = board.matches[c.key] ?? empty;
					return [
						`${i + 1}. ${c.title}${c.context ? ` (sessions: ${c.context.slice(0, 200)})` : ""}${c.ask ? ` (first ask: ${c.ask})` : ""}`,
						...m.w.map(
							(w, j) =>
								`   W${j + 1} [${w[3]}${w[2] ? `, ${projectKeys.get(w[2]) ?? "project"}` : ""}] ${w[1].slice(0, 160)}`,
						),
						...(catalog.length
							? []
							: m.p.map(
									(p, j) => `   P${j + 1} ${p[1]}: ${p[2].slice(0, 120)}`,
								)),
					].join("\n");
				})
				.join("\n");
		let raw: string;
		try {
			raw = await runModel(prompt);
		} catch {
			return;
		}
		for (const entry of parseArray(raw) as Json[]) {
			const c = Number.isInteger(entry?.c) ? chunk[entry.c - 1] : undefined;
			if (!c) continue;
			const m = board.matches[c.key] ?? empty;
			const ref = <T>(value: unknown, prefix: string, list: T[]) => {
				const n = new RegExp(`^${prefix}(\\d+)$`).exec(
					String(value ?? "").trim(),
				);
				return n ? list[Number(n[1]) - 1] : undefined;
			};
			const placed = ref(entry.project, "P", catalog);
			const project: ProjectMatch | undefined = catalog.length
				? placed && [placed[0], placed[1], placed[2], 1]
				: ref(entry.project, "P", m.p);
			const same = ref(entry.same, "W", m.w);
			const prior = picks.get(c.key);
			picks.set(c.key, {
				same: prior?.same ?? same,
				agreed: Boolean(prior?.same && same && prior.same[0] === same[0]),
				parent: prior?.parent ?? ref(entry.parent, "W", m.w),
				project: prior?.project ?? project,
			});
		}
	});
	// Confirm each match and each new task on its own first, so an epic only
	// ever holds tasks that passed the same duplicate check as a single
	// proposal. A candidate the model did not answer falls back to the
	// thresholds.
	const first = candidates.map((c) =>
		decide(c, board.matches[c.key] ?? empty, projectKeys, picks.get(c.key)),
	);
	await secondLook(candidates, first, picks, board, runModel);
	return proposeEpics(
		candidates,
		placeByProjects(
			candidates,
			candidates.map((c) =>
				decide(c, board.matches[c.key] ?? empty, projectKeys, picks.get(c.key)),
			),
		),
	);
}

export const CONFIRM_PROMPT = `Below is a piece of work one person did, then the existing Work Items on their team's board closest to it. Does one of those items already cover this work?
- It covers it when it is the same problem, fix or deliverable, even if worded differently, or when this work is just a step toward the item's own deliverable (writing the slides for "Prepare and give the keynote at the summit").
- It is BROADER when it spans several separate deliverables, periods, clients or a whole program, and this work is one distinct piece of it that is worth tracking on its own (matching the August card payments within "Close the books for January to September").
- An item for only one part of this work does not cover it.
Reply with exactly one token and nothing else: the number of the item that covers it, B and the number of a broader item (for example B2), or 0.

`;

/** Second looks per run, the closest first, so the cost stays bounded. */
const SECOND_LOOKS = 24;

/**
 * One focused question per candidate whose fate rests on a close call: a new
 * task with a close item on the board (a batch of ten misses matches one pair
 * at a time does not), and a covering match only the batch saw (a broad item
 * such as "reconcile January to September" is not the September payout
 * task). The answer updates the candidate's pick: the same item, a broader
 * open item to go under, or nothing. A match both batch votes agreed on
 * stands unless the item turns out broader.
 */
async function secondLook(
	candidates: Candidate[],
	proposals: Proposal[],
	picks: Map<string, Choice>,
	board: BoardMatches,
	runModel: RunModel,
): Promise<void> {
	const doubtful = proposals
		.map((p, i) => {
			const c = candidates[i]!;
			const best = board.matches[c.key]?.w[0]?.[5] ?? 0;
			const same = picks.get(c.key)?.same;
			// A match only the batch saw, or only the words saw.
			const unsure =
				p.action === "tracked" &&
				Boolean(p.workId) &&
				(same ? same[5] < THRESHOLDS.same : best < THRESHOLDS.clear);
			const open =
				(p.action === "create" || mayJoinEpic(c, p)) &&
				(best >= THRESHOLDS.confirm || Boolean(picks.get(c.key)?.parent));
			return { i, c, best, unsure, open };
		})
		.filter((d) => d.unsure || d.open)
		.sort((a, b) => b.best - a.best)
		.slice(0, SECOND_LOOKS);
	await inPool(doubtful, 4, async ({ c, unsure }) => {
		const pick = picks.get(c.key) ?? {};
		const options = (board.matches[c.key]?.w ?? []).slice(0, 3);
		if (pick.same && !options.some((w) => w[0] === pick.same![0]))
			options.push(pick.same);
		if (pick.parent && !options.some((w) => w[0] === pick.parent![0]))
			options.push(pick.parent);
		const prompt = `${CONFIRM_PROMPT}Work: ${c.title}${c.context ? `\nIts sessions: ${c.context.slice(0, 300)}` : ""}${c.ask ? `\nFirst ask: ${c.ask}` : ""}\n\nExisting items:\n${options
			.map((w, j) => `${j + 1}. [${w[3]}] ${w[1]}`)
			.join("\n")}`;
		let raw: string;
		try {
			raw = await runModel(prompt);
		} catch {
			return;
		}
		// Only a bare answer counts; anything else changes nothing.
		const answer = /^[`*"\s]*(B)?\s*(\d+)[`*".\s]*$/i.exec(raw);
		if (!answer) return;
		const n = Number(answer[2]);
		const same = !answer[1] && n >= 1 ? options[n - 1] : undefined;
		const wider = answer[1] ? options[n - 1] : undefined;
		const next: Choice = { ...pick };
		if (same) {
			next.same = same;
			next.second = true;
		} else if (wider) {
			// Finished broad work includes this; open broad work is its parent.
			const agreed = unsure && pick.agreed && c.kind === "task";
			if (OPEN.has(wider[3]) && !agreed) {
				if (unsure) {
					next.same = undefined;
					next.rejected = true;
				}
				next.parent ??= wider;
			}
		} else if (unsure && (!pick.agreed || c.kind !== "task")) {
			next.same = undefined;
			next.rejected = true;
		}
		picks.set(c.key, next);
	});
}

/**
 * An unplaced task whose sessions mostly belong to a project the board knows
 * ("Acme client work" → ACME) goes under that project.
 */
export function placeByProjects(
	candidates: Candidate[],
	proposals: Proposal[],
): Proposal[] {
	const projectOf = new Map<string, Proposal>();
	proposals.forEach((p, i) => {
		if (candidates[i]!.kind !== "task" && p.action === "tracked" && p.projectId)
			for (const id of candidates[i]!.sessions) projectOf.set(id, p);
	});
	return proposals.map((p, i) => {
		const c = candidates[i]!;
		if (
			p.action !== "unplaced" ||
			c.kind !== "task" ||
			c.confidence < THRESHOLDS.propose ||
			c.done
		)
			return p;
		const counts = new Map<Proposal, number>();
		for (const id of c.sessions) {
			const project = projectOf.get(id);
			if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
		}
		const [project, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
		if (!project || !n || n * 2 < c.sessions.length) return p;
		return {
			...p,
			action: "create",
			projectId: project.projectId,
			projectKey: project.projectKey,
			reason:
				"nothing on the board covers it; its sessions belong to this project",
		};
	});
}

/** Tasks a body of work needs before it is proposed as one epic. */
export const EPIC_MIN_TASKS = 3;
const EPIC_MAX_TASKS = 25;

/**
 * Could become part of an epic: a project or goal no existing item covers,
 * or a confident, unfinished task that no project fits.
 */
function mayJoinEpic(c: Candidate, p: Proposal): boolean {
	if (c.kind !== "task")
		return !p.workId && (p.action === "unplaced" || p.action === "tracked");
	return (
		p.action === "unplaced" &&
		!p.projectId &&
		c.confidence >= THRESHOLDS.propose &&
		!c.done
	);
}

/**
 * A project or goal from the sessions that the board has no item for, with
 * at least {@link EPIC_MIN_TASKS} of its own tasks (most of each task's
 * sessions are its sessions) that would otherwise go up one by one or not at
 * all, becomes ONE epic proposal with those tasks under it: in its project
 * when it has one, else unfiled. Every task already passed the duplicate
 * checks a single proposal does.
 */
export function proposeEpics(
	candidates: Candidate[],
	proposals: Proposal[],
): Proposal[] {
	const out = [...proposals];
	const taken = new Set<number>();
	const heads = candidates
		.map((_, i) => i)
		.filter((i) => {
			const c = candidates[i]!;
			return (
				c.kind !== "task" &&
				mayJoinEpic(c, out[i]!) &&
				c.confidence >= THRESHOLDS.propose &&
				!c.done
			);
		})
		.sort(
			(a, b) => candidates[b]!.sessions.length - candidates[a]!.sessions.length,
		);
	for (const h of heads) {
		const head = out[h]!;
		const own = new Set(candidates[h]!.sessions);
		const members = candidates
			.map((_, i) => i)
			.filter((i) => {
				const c = candidates[i]!;
				const p = out[i]!;
				if (i === h || taken.has(i) || c.kind !== "task") return false;
				// A task of a body of work the board lacks belongs with it, even
				// when a word it shares with some board project placed it there:
				// its sessions say where it belongs.
				const fits =
					mayJoinEpic(c, p) || (p.action === "create" && !p.parentId);
				return (
					fits &&
					c.sessions.filter((id) => own.has(id)).length * 2 >= c.sessions.length
				);
			})
			.slice(0, EPIC_MAX_TASKS);
		if (members.length < EPIC_MIN_TASKS) continue;
		// Unplaced, the epic goes where most of its tasks were placed, if
		// anywhere; its tasks go where the epic goes.
		let place = head.projectId
			? { projectId: head.projectId, projectKey: head.projectKey }
			: undefined;
		if (!place) {
			const counts = new Map<string, number>();
			for (const i of members) {
				const id = out[i]!.projectId;
				if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
			}
			const [id, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
			const owner = members.find((i) => out[i]!.projectId === id);
			if (id && n && n * 2 > members.length && owner !== undefined)
				place = { projectId: id, projectKey: out[owner]!.projectKey };
		}
		taken.add(h);
		for (const i of members) {
			taken.add(i);
			const { projectId: _id, projectKey: _key, ...task } = out[i]!;
			out[i] = { ...task, ...place, action: "nested", epicKey: head.key };
		}
		const { projectId: _id, projectKey: _key, ...epic } = head;
		out[h] = {
			...epic,
			...place,
			action: "create",
			children: members.map((i) => out[i]!),
			reason: place
				? `${members.length} tasks in this project and no epic on the board for them`
				: `${members.length} related tasks and no project on the board fits them`,
		};
	}
	return out;
}

// ---------------------------------------------------------------------------
// Local state: proposals and the person's decisions
// ---------------------------------------------------------------------------

export interface Decision {
	decision: "accepted" | "rejected";
	title: string;
	workId?: string;
	at: string;
}

export interface ContextState {
	version: 1;
	target: OrganizationTarget;
	userId: string | null;
	userName: string | null;
	generatedAt: string;
	proposals: Proposal[];
	unplaced: Proposal[];
	tracked: Proposal[];
	decided: Record<string, Decision>;
}

export function stateDirectory(env = process.env, home = homedir()): string {
	return join(env.TEDIX_CONFIG_DIR || join(home, ".tedix"), "learn");
}

export function statePath(
	target: OrganizationTarget,
	directory: string,
): string {
	const name = targetKey(target).replace(/[^\w.-]+/g, "_");
	return join(directory, `context-${name}.json`);
}

export function readState(path: string): ContextState | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ContextState;
	} catch {
		return null;
	}
}

const CACHE_ENTRIES = 2000;

/**
 * The model's earlier answer to the same prompt, so a re-run over the same
 * sessions proposes the same things instead of a fresh sample. Kept on this
 * machine beside the proposals; a dry run reads it but never writes it.
 */
export function cachedModel(
	runModel: RunModel,
	path: string,
	persist: boolean,
): { run: RunModel; save: () => void } {
	let cache: Record<string, string> = {};
	try {
		cache = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		/* First run. */
	}
	let dirty = false;
	return {
		run: async (prompt) => {
			const key = createHash("sha256").update(prompt).digest("hex");
			const hit = cache[key];
			if (hit !== undefined) return hit;
			const answer = await runModel(prompt);
			cache[key] = answer;
			dirty = true;
			return answer;
		},
		save: () => {
			if (!persist || !dirty) return;
			const keys = Object.keys(cache);
			for (const key of keys.slice(0, Math.max(0, keys.length - CACHE_ENTRIES)))
				delete cache[key];
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temp = `${path}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
			renameSync(temp, path);
		},
	};
}

export function writeState(path: string, state: ContextState) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** A proposal the person already decided, by key or by a near-identical title. */
export function decidedFor(
	proposal: Pick<Proposal, "key" | "title">,
	decided: Record<string, Decision>,
): Decision | undefined {
	if (decided[proposal.key]) return decided[proposal.key];
	const set = new Set(words(proposal.title));
	return Object.values(decided).find(
		(d) => jaccard(new Set(words(d.title)), set) >= 0.6,
	);
}

/** Already in the member's inbox (any state), by key or a near-identical title. */
export function askedFor(
	proposal: Pick<Proposal, "key" | "title">,
	asked: AskedProposal[],
): AskedProposal | undefined {
	const set = new Set(words(proposal.title));
	return (
		asked.find((a) => a.key === proposal.key) ??
		asked.find((a) => jaccard(new Set(words(a.title)), set) >= 0.6)
	);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface ContextDeps extends LearnDeps {
	runModel?: RunModel;
	files?: SessionFile[];
	readFile?: (path: string) => Json[];
	originOf?: (directory: string) => string | null | undefined;
	/** Where proposals and decisions are kept (tests). */
	stateDir?: string;
	/** Asks the person one review question (tests); a terminal otherwise. */
	ask?: (question: string) => Promise<string>;
	/** Starts the background onboarding worker (tests); a detached CLI otherwise. */
	startWorker?: (args: string[], log: string) => number | undefined;
	/** Whether a process is still running (tests). */
	alive?: (pid: number) => boolean;
}

function contextOptions(args: string[], allowed: string[]) {
	const options = {
		dryRun: false,
		json: false,
		noModel: false,
		withModel: false,
		wait: false,
		worker: false,
		since: undefined as string | undefined,
		accept: undefined as string | undefined,
		reject: undefined as string | undefined,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!allowed.includes(arg)) throw new Error(`Unknown option ${arg}`);
		const value = () => {
			const next = args[++i];
			if (!next || next.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--no-model") options.noModel = true;
		else if (arg === "--with-model") options.withModel = true;
		else if (arg === "--wait") options.wait = true;
		else if (arg === "--worker") options.worker = true;
		else if (arg === "--since") {
			const since = new Date(value());
			if (Number.isNaN(since.getTime()))
				throw new Error("--since must be a date, e.g. 2026-01-01");
			options.since = since.toISOString();
		} else if (arg === "--accept") options.accept = value();
		else if (arg === "--reject") options.reject = value();
	}
	return options;
}

function codeCommand(target: OrganizationTarget): string[] {
	return [
		"-w",
		target.workspace,
		...(target.organization ? ["--organization", target.organization] : []),
		"code",
	];
}

const MATCH_TIMEOUT_MS = 240_000;

export function caller(read: ReadJson, target: OrganizationTarget) {
	return async (source: string): Promise<Json> => {
		const result = await read(codeCommand(target), MATCH_TIMEOUT_MS, source);
		// Code Mode reports a failed tool call as a value, not an exit code.
		if (result.ok === false)
			throw new Error(String(result.error ?? "tool call failed"));
		return result;
	};
}

async function askedProposals(
	call: (source: string) => Promise<Json>,
	openOnly: boolean,
): Promise<{ me: { id: string; name: string } | null; rows: AskedProposal[] }> {
	const result = await call(listProposalsSource(openOnly));
	if (!Array.isArray(result.rows))
		throw new Error("reading your inbox returned no rows");
	return { me: result.me ?? null, rows: result.rows };
}

/**
 * The key of a project a proposal names that the board match did not return
 * (a covering item's project), so the member reads "FINANCE", not an id.
 */
async function withProjectKeys(
	proposals: Proposal[],
	call: (source: string) => Promise<Json>,
): Promise<Proposal[]> {
	const missing = [
		...new Set(
			proposals
				.flatMap((p) => [p, ...(p.children ?? [])])
				.filter((p) => p.projectId && !p.projectKey)
				.map((p) => p.projectId!),
		),
	];
	if (!missing.length) return proposals;
	let keys: Record<string, string> = {};
	try {
		keys =
			(
				await call(`async () => {
	const want = new Set(${asciiJson(missing)});
	const keys = {};
	for (let offset = 0; offset < 2000; offset += 100) {
		const r = await projects.list_projects({ limit: 100, offset });
		if (r?.ok === false || !Array.isArray(r?.data)) break;
		for (const p of r.data) if (want.has(p.id)) keys[p.id] = p.key;
		if (!r.pagination?.hasMore) break;
	}
	return { keys };
}`)
			).keys ?? {};
	} catch {
		return proposals;
	}
	const fill = (p: Proposal): Proposal => ({
		...p,
		...(p.projectId && !p.projectKey && keys[p.projectId]
			? { projectKey: keys[p.projectId] }
			: {}),
		...(p.children ? { children: p.children.map(fill) } : {}),
	});
	return proposals.map(fill);
}

function where(p: Proposal): string {
	return p.projectKey ?? p.projectId?.slice(0, 8) ?? "no project";
}

function renderTarget(key: string, entry: Json): string[] {
	if (entry.error) return [`${key}: ${entry.error}`];
	const lines = [
		`${key}: ${entry.sessions} sessions, ${entry.candidates} topics`,
	];
	if (entry.tracked.length) {
		lines.push(
			`  Already on the board (${entry.tracked.length}), nothing to file:`,
		);
		for (const p of entry.tracked as Proposal[])
			lines.push(
				`    - ${p.title} -> ${p.workTitle ? `${p.workTitle} (${p.workId!.slice(0, 8)}, ${p.workDisposition})` : `project ${where(p)}`}`,
			);
	}
	if (entry.proposals.length) {
		lines.push(
			entry.published
				? `  Proposed (${entry.proposals.length}), now in your Tedix inbox; nothing reaches the board until you accept:`
				: `  Proposed (${entry.proposals.length}); nothing reaches the board until you accept:`,
			...renderProposals(entry.proposals),
		);
	}
	if (entry.unplaced.length) {
		lines.push(`  Not filed (${entry.unplaced.length}):`);
		for (const p of entry.unplaced as Proposal[])
			lines.push(`    - ${p.title} (${p.reason})`);
	}
	if (entry.alreadyDecided)
		lines.push(
			`  Asked or decided earlier and not asked again: ${entry.alreadyDecided}`,
		);
	return lines;
}

function renderProposals(proposals: Proposal[]): string[] {
	return proposals.flatMap((p, i) => [
		`    ${i + 1}. ${p.children?.length ? `New epic: ${p.title} (${p.children.length} tasks)` : p.title} -> ${where(p)} (${p.sessions} session${p.sessions === 1 ? "" : "s"}, ${p.from} to ${p.to})${p.nearest ? `; closest existing: ${p.nearest.title.slice(0, 80)}` : ""}`,
		...(p.children ?? []).map((c) => `         - ${c.title}`),
	]);
}

/** `tedix learn context`: match local work against the board, propose the rest. */
export async function runContext(
	args: string[],
	deps: ContextDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = contextOptions(args, [
		"--dry-run",
		"--json",
		"--no-model",
		"--since",
	]);
	const home = deps.home ?? homedir();
	const plan = planContext({
		files: deps.files ?? sessionFiles(home),
		since: options.since,
		targets: deps.targets ?? repositoryTargetsByOrigin(),
		defaultTarget:
			"defaultTarget" in deps
				? deps.defaultTarget
				: defaultOrganizationTarget(),
		titles: codexThreadNames(home),
		goals: await codexGoals(home),
		originOf: deps.originOf,
		read: deps.readFile,
	});
	const read = deps.read ?? cliRead;
	const stateDir = deps.stateDir ?? stateDirectory();
	// The person's own claude, else their codex; neither means no model.
	const local = options.noModel
		? undefined
		: (deps.runModel ?? localModel()?.run);
	const model = local
		? cachedModel(local, join(stateDir, "model-cache.json"), !options.dryRun)
		: null;
	const runModel = model?.run ?? null;
	const report: Json = {
		files: plan.files,
		unrouted: plan.unrouted,
		targets: {},
	};
	let failed = false;
	for (const [key, { target, sessions }] of plan.byTarget) {
		const entry: Json = { sessions: sessions.length };
		report.targets[key] = entry;
		try {
			const call = caller(read, target);
			const candidates = await extractCandidates(sessions, runModel);
			entry.candidates = candidates.length;
			const board: BoardMatches = candidates.length
				? await matchBoard(candidates, call, Boolean(runModel))
				: { me: null, scanned: {}, matches: {} };
			const digests = new Map(sessions.map((s) => [s.sessionId, s]));
			const citations = new Map(
				candidates.map((c) => [
					c.key,
					c.sessions.flatMap((id) => {
						const s = digests.get(id);
						return s
							? [
									{
										harness: s.harness,
										session: s.sessionId,
										title: s.title,
										at: s.from,
									},
								]
							: [];
					}),
				]),
			);
			const cite = (p: Proposal): Proposal => ({
				...p,
				citations: citations.get(p.key) ?? [],
				...(p.children ? { children: p.children.map(cite) } : {}),
			});
			const proposals = await withProjectKeys(
				(await judge(candidates, board, runModel, new Map())).map(cite),
				call,
			);
			const path = statePath(target, stateDir);
			const prior = readState(path);
			// Decisions belong to the person who made them.
			const decided =
				prior && (!board.me || prior.userId === board.me.id)
					? prior.decided
					: {};
			// What the member was already asked, in any state, on any machine.
			const asked = candidates.length
				? (await askedProposals(call, false)).rows
				: [];
			const fresh = (p: Proposal) =>
				!decidedFor(p, decided) && !askedFor(p, asked);
			const open = proposals.filter((p) => p.action === "create");
			const pending = open
				.filter(fresh)
				.map((p) =>
					p.children ? { ...p, children: p.children.filter(fresh) } : p,
				);
			let published = false;
			if (pending.length && !options.dryRun) {
				if (!board.me)
					throw new Error(
						"your Tedix profile could not be read, so proposals cannot be addressed to you",
					);
				const me = board.me;
				const who = me.name.split(/\s+/)[0] || "a member";
				const result = await call(
					publishSource(
						pending.map((p) => ({
							key: p.key,
							request: proposalRequest(p, who, me.id),
						})),
					),
				);
				const problems = pending
					.map((p) => result[p.key])
					.filter((r: Json | undefined) => !r?.id)
					.map((r: Json | undefined) =>
						String(r?.error ?? r?.skipped ?? "not sent"),
					);
				if (problems.some((_, i) => !result[pending[i]!.key]?.skipped))
					failed = true;
				if (problems.length)
					entry.publishErrors = [...new Set(problems)].slice(0, 3);
				published = problems.length < pending.length;
			}
			Object.assign(entry, {
				tracked: proposals.filter((p) => p.action === "tracked"),
				proposals: pending,
				published,
				unplaced: proposals.filter((p) => p.action === "unplaced"),
				alreadyDecided: open.length - pending.length,
				scanned: board.scanned,
				state: path,
			});
			if (!options.dryRun)
				writeState(path, {
					version: 1,
					target,
					userId: board.me?.id ?? prior?.userId ?? null,
					userName: board.me?.name ?? prior?.userName ?? null,
					generatedAt: new Date().toISOString(),
					proposals: pending,
					unplaced: entry.unplaced,
					tracked: entry.tracked,
					decided,
				});
		} catch (error) {
			failed = true;
			entry.error = (
				error instanceof Error ? error.message : String(error)
			).slice(0, 300);
		}
	}
	model?.save();
	if (options.json) {
		write(JSON.stringify(report));
		return failed ? 2 : 0;
	}
	const lines: string[] = [];
	for (const [key, entry] of Object.entries<Json>(report.targets)) {
		lines.push(...renderTarget(key, entry));
		if (entry.publishErrors)
			lines.push(`  Not sent: ${entry.publishErrors.join("; ")}`);
		lines.push("");
	}
	const unbound = Object.keys(plan.unrouted.unboundRepository);
	if (unbound.length)
		lines.push(
			`Skipped repositories not bound to an organization: ${unbound.join(", ")} (bind one with tedix setup agents context bind).`,
		);
	const pending = Object.values<Json>(report.targets).reduce(
		(n, e) => n + (e.proposals?.length ?? 0),
		0,
	);
	if (!plan.byTarget.size) lines.push("No sessions found to learn from.");
	else if (options.dryRun) lines.push("Dry run: nothing was saved or sent.");
	else if (pending)
		lines.push(
			"Next: open Tedix > Work > Needs you and accept or decline your proposals.",
		);
	else if (
		Object.values<Json>(report.targets).some((e) => e.alreadyDecided > 0)
	)
		lines.push(
			"Nothing new to propose. Earlier proposals you have not answered stay in your Tedix inbox (tedix learn review lists them).",
		);
	else lines.push("Nothing to review: the board already covers your work.");
	write(lines.join("\n"));
	return failed ? 2 : 0;
}

function pick(spec: string | undefined, count: number): Set<number> {
	if (!spec) return new Set();
	if (spec === "all")
		return new Set(Array.from({ length: count }, (_, i) => i));
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const n = Number(part.trim());
		if (!Number.isInteger(n) || n < 1 || n > count)
			throw new Error(`No proposal ${part.trim()}; there are ${count}`);
		out.add(n - 1);
	}
	return out;
}

async function terminalAsk(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

function stateFiles(directory: string): string[] {
	try {
		return readdirSync(directory)
			.filter((f) => f.startsWith("context-") && f.endsWith(".json"))
			.map((f) => join(directory, f));
	} catch {
		return [];
	}
}

/**
 * `tedix learn review`: answer the proposals waiting in your Tedix inbox.
 * The same items are answerable in Tedix OS and in chat; accepting one makes
 * Tedix create its Work, declining it is remembered there.
 */
export async function runReview(
	args: string[],
	deps: ContextDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = contextOptions(args, ["--accept", "--reject", "--json"]);
	const read = deps.read ?? cliRead;
	const ask =
		deps.ask ??
		(process.stdin.isTTY && !options.json ? terminalAsk : undefined);
	const stateDir = deps.stateDir ?? stateDirectory();
	// Every organization onboarding ran for, plus the default one.
	const targets = new Map<string, OrganizationTarget>();
	const states = new Map<string, string>();
	for (const path of stateFiles(stateDir)) {
		const state = readState(path);
		if (!state?.target) continue;
		targets.set(targetKey(state.target), state.target);
		states.set(targetKey(state.target), path);
	}
	const fallback =
		"defaultTarget" in deps ? deps.defaultTarget : defaultOrganizationTarget();
	if (fallback && !targets.size) targets.set(targetKey(fallback), fallback);
	const results: Json = {};
	let failed = false;
	let any = false;
	for (const [key, target] of targets) {
		const call = caller(read, target);
		let rows: AskedProposal[];
		try {
			rows = (await askedProposals(call, true)).rows;
		} catch (error) {
			failed = true;
			results[key] = {
				error: (error instanceof Error ? error.message : String(error)).slice(
					0,
					300,
				),
			};
			if (!options.json) write(`${key}: ${results[key].error}`);
			continue;
		}
		if (!rows.length) continue;
		any = true;
		const accept = pick(options.accept, rows.length);
		const reject = pick(options.reject, rows.length);
		for (const i of accept)
			if (reject.has(i))
				throw new Error(`Proposal ${i + 1} is both accepted and rejected`);
		const interactive = !options.accept && !options.reject;
		const listing = rows.map((r, i) => `    ${i + 1}. ${r.subject}`);
		if (interactive && !ask) {
			write(
				[
					`${key}: ${rows.length} proposal(s) in your Tedix inbox`,
					...listing,
					"Choose with --accept <numbers|all> and --reject <numbers|all>, or answer them in Tedix (Work > Interactions).",
				].join("\n"),
			);
			continue;
		}
		if (interactive && ask) {
			write(
				`${key}: ${rows.length} proposal(s). y = create it, n = never ask again, s = skip for now, q = stop.`,
			);
			for (let i = 0; i < rows.length; i++) {
				const answer = (
					await ask(
						`${listing[i]}\n${rows[i]!.prompt.replace(/^/gm, "       ")}\n   Create it? [y/n/s/q] `,
					)
				)
					.trim()
					.toLowerCase();
				if (answer === "q") break;
				if (answer === "y") accept.add(i);
				else if (answer === "n") reject.add(i);
			}
		}
		const answers = [
			...[...accept].map((i) => ({ row: rows[i]!, accept: true })),
			...[...reject].map((i) => ({ row: rows[i]!, accept: false })),
		];
		const outcome = {
			accepted: 0,
			rejected: 0,
			created: 0,
			started: [] as Array<{ title: string; summary: string; link: string }>,
			errors: [] as string[],
		};
		let answered: Json = {};
		if (answers.length) {
			try {
				answered = await call(
					respondSource(
						answers.map(({ row, accept }) => ({
							id: row.id,
							version: row.version,
							accept,
						})),
					),
				);
			} catch (error) {
				outcome.errors.push(
					(error instanceof Error ? error.message : String(error)).slice(
						0,
						200,
					),
				);
			}
		}
		const statePathFor = states.get(key);
		const state = statePathFor ? readState(statePathFor) : null;
		const now = new Date().toISOString();
		for (const { row, accept } of answers) {
			const r = answered[row.id];
			if (!r || r.error) {
				if (r?.error) outcome.errors.push(String(r.error).slice(0, 200));
				continue;
			}
			if (accept) {
				outcome.accepted++;
				outcome.created += r.workItemIds.length;
				if (r.started?.summary)
					outcome.started.push({
						title: row.title,
						summary: String(r.started.summary),
						link: String(r.started.link ?? ""),
					});
			} else outcome.rejected++;
			if (state)
				state.decided[row.key] = {
					decision: accept ? "accepted" : "rejected",
					title: row.title,
					...(r.workItemIds[0] ? { workId: r.workItemIds[0] } : {}),
					at: now,
				};
		}
		if (state && statePathFor) {
			state.proposals = state.proposals.filter((p) => !state.decided[p.key]);
			writeState(statePathFor, state);
		}
		if (outcome.errors.length) failed = true;
		const stillPending = rows.length - outcome.accepted - outcome.rejected;
		results[key] = { ...outcome, stillPending };
		if (!options.json)
			write(
				[
					`${key}: accepted ${outcome.accepted} (${outcome.created} Work Items created), declined ${outcome.rejected}, ${stillPending} still in your inbox${outcome.errors.length ? `; errors: ${outcome.errors.join("; ")}` : ""}`,
					...outcome.started.map(
						(s) => `  ${s.summary}${s.link ? ` ${s.link}` : ""}`,
					),
				].join("\n"),
			);
	}
	if (options.json) write(JSON.stringify(results));
	else if (!any && !failed)
		write(
			"No proposals to review. tedix learn onboard puts new ones in your Tedix inbox.",
		);
	return failed ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Onboarding: in the background, resumable
// ---------------------------------------------------------------------------

export interface OnboardProgress {
	pid: number;
	args: string[];
	startedAt: string;
	/** Steps finished in this run, so a restarted run skips them. */
	done: Record<string, string>;
	finishedAt?: string;
	exitCode?: number;
}

const ONBOARD_STEPS = ["import", "profile", "analyze", "context"] as const;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readProgress(path: string): OnboardProgress | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as OnboardProgress;
	} catch {
		return null;
	}
}

function writeProgress(path: string, progress: OnboardProgress) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(progress, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(temp, path);
}

/** A detached `tedix learn onboard --worker`, signed in as the member. */
function detachedWorker(args: string[], log: string): number | undefined {
	const [command, prefix] = selfCommand();
	const env = { ...process.env };
	for (const name of AGENT_IDENTITY_ENV) delete env[name];
	mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
	const fd = openSync(log, "a", 0o600);
	try {
		const child = spawn(command, [...prefix, "learn", "onboard", ...args], {
			detached: process.platform !== "win32",
			stdio: ["ignore", fd, fd],
			env,
		});
		child.unref();
		return child.pid;
	} finally {
		closeSync(fd);
	}
}

/**
 * `tedix learn onboard`: what a new member runs once. It starts a background
 * worker and returns; the worker runs, in order, the personal import (lessons
 * only they see), their own section of the shared session lists, and Work
 * context, whose proposals arrive in their Tedix inbox. A worker that stops
 * part way is resumed by the next run, skipping finished steps. --wait runs
 * in the foreground.
 */
export async function runOnboard(
	args: string[],
	deps: ContextDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = contextOptions(args, [
		"--dry-run",
		"--with-model",
		"--no-model",
		"--since",
		"--wait",
		"--worker",
	]);
	if (options.withModel && (!options.dryRun || options.noModel))
		throw new Error(
			"--with-model requires --dry-run and cannot be combined with --no-model",
		);
	if (options.dryRun && !options.withModel) {
		const home = deps.home ?? homedir();
		const targets = deps.targets ?? repositoryTargetsByOrigin();
		const defaultTarget =
			"defaultTarget" in deps
				? deps.defaultTarget
				: defaultOrganizationTarget();
		const plan = planContext({
			files: deps.files ?? sessionFiles(home),
			since: options.since,
			targets,
			defaultTarget,
			titles: codexThreadNames(home),
			goals: await codexGoals(home),
			originOf: deps.originOf,
			read: deps.readFile,
		});
		const notes = planNotes({
			notes: memoryNotes(home),
			targets,
			defaultTarget,
			locate: sessionLocator(deps.originOf),
			unrouted: plan.unrouted,
		});
		write(
			"Local preview: topic candidates from titles only; no model or board matching.",
		);
		for (const key of new Set([...plan.byTarget.keys(), ...notes.keys()])) {
			const sessions = plan.byTarget.get(key)?.sessions ?? [];
			write(
				`${key}: ${sessions.length} sessions (claude-code: ${sessions.filter((s) => s.harness === "claude-code").length}, codex: ${sessions.filter((s) => s.harness === "codex").length}), ${notes.get(key)?.decisions.length ?? 0} preference notes`,
			);
			const candidates = await extractCandidates(
				sessions.filter((s) => s.title).map((s) => ({ ...s, asks: [] })),
				null,
				{ threshold: 0.5, minSessions: 1, confident: 0.8 },
			);
			write(`  Topic candidates (${candidates.length}):`);
			for (const candidate of candidates)
				write(
					`    - ${candidate.title} (${candidate.sessions.length} sessions)`,
				);
		}
		write(`Skipped/unrouted: ${JSON.stringify(plan.unrouted)}`);
		write(
			"Dry run: nothing was saved or sent. For the full preview, use --dry-run --with-model; it takes a few minutes.",
		);
		return 0;
	}
	if (options.dryRun && options.withModel)
		write(
			"Full model preview: this takes a few minutes; nothing will be saved or sent.",
		);
	const stateDir = deps.stateDir ?? stateDirectory();
	const progressPath = join(stateDir, "onboard.json");
	const log = join(stateDir, "onboard.log");
	const alive = deps.alive ?? processAlive;
	const pass = [
		...(options.dryRun ? ["--dry-run"] : []),
		...(options.since ? ["--since", options.since.slice(0, 10)] : []),
	];
	const stepArgs = [...pass, ...(options.noModel ? ["--no-model"] : [])];
	const prior = options.dryRun ? null : readProgress(progressPath);
	if (!options.dryRun && !options.wait && !options.worker) {
		if (prior && !prior.finishedAt && prior.pid && alive(prior.pid)) {
			write(
				`Onboarding is already running (since ${prior.startedAt}). Progress: ${log}`,
			);
			return 0;
		}
		const pid = (deps.startWorker ?? detachedWorker)(
			[...stepArgs, "--worker"],
			log,
		);
		if (!pid) {
			write(
				"Could not start onboarding in the background; run it with --wait.",
			);
			return 2;
		}
		write(
			[
				"Onboarding runs in the background; you can close this terminal.",
				"Next: open Tedix > Work > Needs you; your proposals will arrive in your Tedix inbox there to accept or decline.",
				`Progress: ${log}`,
			].join("\n"),
		);
		return 0;
	}
	// Resume an unfinished run with the same options; otherwise start over.
	const resume =
		prior &&
		!prior.finishedAt &&
		JSON.stringify(prior.args) === JSON.stringify(stepArgs)
			? prior
			: null;
	const progress: OnboardProgress = {
		pid: process.pid,
		args: stepArgs,
		startedAt: resume?.startedAt ?? new Date().toISOString(),
		done: resume?.done ?? {},
	};
	const save = () => {
		if (!options.dryRun) writeProgress(progressPath, progress);
	};
	save();
	const captured = (into: string[]) => ({
		...deps,
		write: (line: string) => into.push(line),
	});
	const steps: Record<(typeof ONBOARD_STEPS)[number], () => Promise<number>> = {
		import: async () => {
			write(
				"1/4 Personal: your decisions and preference notes become lessons only you see.",
			);
			const imported: string[] = [];
			const code = await runLearnCommand(
				["import-sessions", ...pass, "--json"],
				captured(imported),
			);
			try {
				const report = JSON.parse(imported[imported.length - 1] ?? "{}");
				const results = Object.values<Json>(report.results ?? {});
				const recorded = results.reduce(
					(n, r) => n + Number(r.recorded ?? 0),
					0,
				);
				const lessons = results.reduce(
					(n, r) => n + Number(r.mining?.factsWritten ?? 0),
					0,
				);
				write(
					options.dryRun
						? `    ${report.pairs ?? 0} decisions and ${report.preferenceNotes ?? 0} preference notes found; nothing sent.`
						: `    ${report.pairs ?? 0} decisions and ${report.preferenceNotes ?? 0} notes read, ${recorded} new; ${lessons} lessons written.`,
				);
			} catch {
				write(`    ${imported.join(" ").slice(0, 300)}`);
			}
			return code;
		},
		profile: async () => {
			write(
				"2/4 What Tedix knows about you: a document in your own Tedix space, and three things it can do now.",
			);
			if (options.noModel) {
				write("    Skipped: it needs your local model.");
				return 0;
			}
			const { runProfile } = await import("./learn-profile");
			return runProfile(pass, deps);
		},
		analyze: async () => {
			write(
				"3/4 Your own section of the shared session lists (repeated requests, friction, decisions).",
			);
			const analyzed: string[] = [];
			const code = await runAnalyzeSessions(
				[...stepArgs, "--json"],
				captured(analyzed),
			);
			try {
				const report = JSON.parse(analyzed[analyzed.length - 1] ?? "{}");
				for (const [key, entry] of Object.entries<Json>(report.targets ?? {}))
					write(
						`    ${key}: ${
							Object.entries<Json>(entry.workItems ?? {})
								.map(
									([category, r]) =>
										`${category} ${r.action ?? r.error ?? "?"}`,
								)
								.join(", ") || "nothing sent"
						}`,
					);
			} catch {
				write(`    ${analyzed.join(" ").slice(0, 300)}`);
			}
			return code;
		},
		context: async () => {
			write(
				"4/4 Work context: matched against the board; anything new goes to your Tedix inbox as a proposal.",
			);
			return runContext(stepArgs, deps);
		},
	};
	let exitCode = 0;
	for (const step of ONBOARD_STEPS) {
		if (progress.done[step]) {
			write(`${step}: finished in the earlier run, skipped.`);
			continue;
		}
		const code = await steps[step]();
		exitCode = Math.max(exitCode, code);
		// A failed step stays unfinished, so the next run retries it.
		if (code === 0) progress.done[step] = new Date().toISOString();
		save();
	}
	if (exitCode === 0) progress.finishedAt = new Date().toISOString();
	progress.exitCode = exitCode;
	save();
	write(
		exitCode === 0
			? options.dryRun
				? "Preview finished. Nothing was saved or sent."
				: "Onboarding finished. Next: open Tedix > Work > Needs you and accept or decline your proposals."
			: "Onboarding stopped with errors; run tedix learn onboard again to resume.",
	);
	return exitCode;
}
