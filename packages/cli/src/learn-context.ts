/**
 * `tedix learn context` and `tedix learn review`: turn a person's local Claude
 * Code and Codex sessions into proposals for the shared Work board, without
 * creating duplicates.
 *
 * 1. Extract (local). Each session becomes a short digest: the host's own
 *    session title (Claude Code ai-title, Codex thread name or Codex goal) and
 *    the first few things the person typed, scrubbed and bounded. The
 *    person's own `claude` CLI groups the digests into typed candidates
 *    (task, goal, project) with a confidence and the sessions that cite them;
 *    without a model each titled session is a candidate. A candidate survives
 *    when two or more sessions share it, it carries a Codex goal, or the model
 *    is confident.
 * 2. Match (read-only). One Code Mode program reads the organization's
 *    projects and its proposed, accepted, completed and cancelled Work (the
 *    last two since the earliest session) and returns, per candidate, the
 *    closest items by IDF-weighted word overlap. Only candidate titles go up;
 *    nothing is stored.
 * 3. Judge (local). The model decides per candidate whether an existing item
 *    already covers it, and otherwise which project (and open parent item) it
 *    belongs under; without a model, score thresholds decide.
 * 4. Propose. Covered candidates are reported, never written. A candidate
 *    with a project becomes a proposal in a local file; one that fits no
 *    project is listed for the person and never filed. Nothing reaches the
 *    shared board until `tedix learn review` accepts it, and a decision is
 *    remembered so a re-run never asks or creates twice.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
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
import { cliRead, type ReadJson } from "./hooks/hook-io";
import {
	claudeModel,
	claudeSignals,
	codexSignals,
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
		const firsts = [
			...said.slice(0, 2),
			...(said.length > 2 ? [said[said.length - 1]!] : []),
		].map((text) => short(text, 200));
		if (!title && !firsts.length) continue;
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
- "project": a named product area, client or body of work.
Merge sessions only when they work on the same deliverable or outcome; related but different deliverables stay separate entries. Skip status checks, one-off questions, small talk, personal errands unrelated to their work, and tests or demos of the agent itself.
Each summary ends with the last thing typed; mark "done" true when the sessions show the work finished (shipped, merged, closed, answered).
Return ONLY a JSON array, no prose: [{"kind":"task|goal|project","title":"<at most 12 words; a task starts with a verb>","sessions":[<numbers>],"confidence":<0 to 1>,"done":<true|false>}].
Paraphrase. Keep product, client and project names; never include people's names, email addresses, secrets, tokens or URLs.
Return [] if nothing qualifies.

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

/** Raw candidates per session group, from the model or from titles alone. */
async function rawCandidates(
	sessions: SessionDigest[],
	runModel: RunModel | null,
): Promise<Array<Omit<Candidate, "key" | "from" | "to" | "goal">>> {
	if (!runModel)
		return sessions
			.filter((s) => s.title || s.asks[0])
			.map((s) => ({
				kind: s.goal ? "goal" : "task",
				title: s.title ?? s.asks[0]!,
				confidence: s.goal ? 0.9 : 0.5,
				sessions: [s.sessionId],
			}));
	const chunks: SessionDigest[][] = [];
	for (let i = 0; i < sessions.length; i += EXTRACT_CHUNK)
		chunks.push(sessions.slice(i, i + EXTRACT_CHUNK));
	const out: Array<Omit<Candidate, "key" | "from" | "to" | "goal">> = [];
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
	return out;
}

/** Merge near-identical candidates and keep the ones with real support. */
export async function extractCandidates(
	sessions: SessionDigest[],
	runModel: RunModel | null,
	options = { threshold: 0.5, minSessions: 2, confident: 0.8 },
): Promise<Candidate[]> {
	const byId = new Map(sessions.map((s) => [s.sessionId, s]));
	const raw = await rawCandidates(sessions, runModel);
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
			kind: goal ? "goal" : best.kind,
			title: best.title,
			confidence,
			sessions: ids,
			from: times[0] ?? "",
			to: times[times.length - 1] ?? "",
			goal,
			// Finished only when every entry merged here says so.
			...(cluster.items.every((i) => i.done) ? { done: true } : {}),
			...(context ? { context } : {}),
		});
	}
	return withoutUmbrellas(out).sort(
		(a, b) => b.sessions.length - a.sessions.length,
	);
}

/**
 * Drop a broad entry whose sessions are mostly explained by narrower ones
 * ("the open-source project" over its three concrete tasks): it would only
 * restate them on the board. A project stays, as context for placement.
 */
function withoutUmbrellas(candidates: Candidate[]): Candidate[] {
	return candidates.filter((c) => {
		if (c.kind === "project" || c.sessions.length < 3) return true;
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
		return (
			c.sessions.filter((id) => covered.has(id)).length * 3 <
			c.sessions.length * 2
		);
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

export interface BoardMatches {
	me: { id: string; name: string } | null;
	scanned: Record<string, number>;
	matches: Record<string, { w: WorkMatch[]; p: ProjectMatch[] }>;
}

/**
 * Code Mode program: read projects and Work, score each candidate title
 * against them, return only the closest few. Reads only; writes nothing.
 */
export function boardMatchSource(input: {
	/** Key, title and the titles of the sessions behind it. */
	candidates: Array<{ k: string; t: string; q?: string }>;
	since: string;
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
		const dated = disposition === "completed" || disposition === "cancelled";
		for (let offset = 0; offset < 30000; offset += 100) {
			const r = await work.list_work_items({ limit: 100, offset, disposition });
			if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "listing Work Items failed: " + String(r?.error ?? "no data") };
			let fresh = 0;
			for (const w of r.data) {
				if (dated && String(w.createdAt || "") < input.since) continue;
				fresh++;
				items.push({ id: w.id, t: w.title, p: w.projectId || null, d: w.disposition, par: w.parentWorkItemId || null, ws: new Set(words(w.title)) });
			}
			scanned[disposition] += fresh;
			if (!r.pagination?.hasMore || (dated && fresh === 0)) break;
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

/**
 * Run the match as programs over open and over finished Work, each inside the
 * gateway's wait and under its result cap.
 */
export async function matchBoard(
	candidates: Candidate[],
	since: string,
	call: (source: string) => Promise<Json>,
): Promise<BoardMatches> {
	const out: BoardMatches = { me: null, scanned: {}, matches: {} };
	const open: Json = {};
	const closed: Json = {};
	for (let i = 0; i < candidates.length; i += MATCH_CHUNK) {
		const list = candidates.slice(i, i + MATCH_CHUNK).map((c) => ({
			k: c.key,
			t: c.title,
			...(c.context ? { q: c.context } : {}),
		}));
		const results = await Promise.all(
			(
				[
					[["proposed", "accepted"], true],
					[["completed", "cancelled"], false],
				] as const
			).map(([dispositions, projects]) =>
				call(
					boardMatchSource({
						candidates: list,
						since,
						dispositions: [...dispositions],
						projects,
					}),
				),
			),
		);
		results.forEach((result, side) => {
			if (!result.matches || typeof result.matches !== "object")
				throw new Error("the board match returned no matches");
			Object.assign(side === 0 ? open : closed, result.matches);
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
	return out;
}

// ---------------------------------------------------------------------------
// Judge and propose
// ---------------------------------------------------------------------------

export type ProposalAction = "tracked" | "create" | "unplaced";

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
};

export const JUDGE_PROMPT = `Each numbered candidate below is work one person did in coding-agent sessions. Under it are existing Work Items (W1..) and projects (P1..) on their team's board.
For each candidate decide:
- "same": the W that already covers the same deliverable or outcome, even if worded differently or scoped a little differently (a broader item that clearly includes it counts; a completed item counts, the work is done). Empty if none does.
- "parent": when not "same", an OPEN W that is a broader effort this belongs under, else empty.
- "project": the P it belongs to, else empty.
When unsure, leave a field empty: a wrong match hides real work.
Return ONLY a JSON array: [{"c":<number>,"same":"W<n> or empty","parent":"W<n> or empty","project":"P<n> or empty"}].

`;

const JUDGE_CHUNK = 10;
const OPEN = new Set(["proposed", "accepted"]);

function decide(
	candidate: Candidate,
	match: { w: WorkMatch[]; p: ProjectMatch[] },
	projectKeys: Map<string, string>,
	pick?: { same?: WorkMatch; parent?: WorkMatch; project?: ProjectMatch },
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
		(nearestWork && nearestWork[5] >= THRESHOLDS.same
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
			reason: pick?.same
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
		...(parent ? { parentId: parent[0] } : {}),
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
		return placeByProjects(
			candidates,
			candidates.map((c) =>
				decide(c, board.matches[c.key] ?? empty, projectKeys),
			),
		);
	const picks = new Map<string, Parameters<typeof decide>[3]>();
	const chunks: Candidate[][] = [];
	for (let i = 0; i < candidates.length; i += JUDGE_CHUNK)
		chunks.push(candidates.slice(i, i + JUDGE_CHUNK));
	// Two independent votes: an item either vote calls covering is covering.
	await inPool([...chunks, ...chunks], 4, async (chunk) => {
		const prompt =
			JUDGE_PROMPT +
			chunk
				.map((c, i) => {
					const m = board.matches[c.key] ?? empty;
					return [
						`${i + 1}. ${c.title}`,
						...m.w.map(
							(w, j) =>
								`   W${j + 1} [${w[3]}${w[2] ? `, ${projectKeys.get(w[2]) ?? "project"}` : ""}] ${w[1].slice(0, 160)}`,
						),
						...m.p.map((p, j) => `   P${j + 1} ${p[1]}: ${p[2].slice(0, 120)}`),
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
			const prior = picks.get(c.key);
			picks.set(c.key, {
				same: prior?.same ?? ref(entry.same, "W", m.w),
				parent: prior?.parent ?? ref(entry.parent, "W", m.w),
				project: prior?.project ?? ref(entry.project, "P", m.p),
			});
		}
	});
	// A candidate the model did not answer falls back to the thresholds.
	return placeByProjects(
		candidates,
		candidates.map((c) =>
			decide(c, board.matches[c.key] ?? empty, projectKeys, picks.get(c.key)),
		),
	);
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

// ---------------------------------------------------------------------------
// Apply accepted proposals (the only org-shared write)
// ---------------------------------------------------------------------------

export function intentId(userId: string | null, key: string): string {
	return `learn-context:${userId ?? "anonymous"}:${key}`;
}

export function proposalDescription(proposal: Proposal, who: string): string {
	return [
		`Proposed from ${who}'s local agent sessions by tedix learn review: ${proposal.sessions} session${proposal.sessions === 1 ? "" : "s"} between ${proposal.from} and ${proposal.to} (${proposal.kind}, confidence ${proposal.confidence.toFixed(2)}).`,
		proposal.nearest
			? `Closest existing item when proposed: ${proposal.nearest.title} (${proposal.nearest.id.slice(0, 8)}, similarity ${proposal.nearest.score}).`
			: "No similar existing item when proposed.",
		"Only a short paraphrase left the machine; no transcript was uploaded.",
	].join("\n\n");
}

/**
 * Code Mode program: create each accepted proposal unless the board already
 * has it (same intent id, or the same title in the same project).
 */
export function applySource(
	items: Array<{
		key: string;
		title: string;
		description: string;
		projectId: string;
		parentId?: string;
		intent: string;
	}>,
): string {
	return `async () => {
	const items = ${asciiJson(items)};
	const norm = (t) => String(t || "").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();
	const out = {};
	for (const item of items) {
		const page = await work.list_work_items({ projectId: item.projectId, titleContains: item.title.slice(0, 40), limit: 50 });
		if (page?.ok === false || !Array.isArray(page?.data)) { out[item.key] = { error: "listing Work Items failed: " + String(page?.error ?? "no data") }; continue; }
		const existing = page.data.find((r) => r.sourceIntentId === item.intent || norm(r.title) === norm(item.title));
		if (existing) { out[item.key] = { id: existing.id, action: "exists" }; continue; }
		const made = await work.create_work_items({ title: item.title, description: item.description, workKind: "other", priority: "medium", projectId: item.projectId, ...(item.parentId ? { parentWorkItemId: item.parentId } : {}), sourceIntentId: item.intent });
		if (made?.ok === false || !made?.id) { out[item.key] = { error: String(made?.error ?? "create failed") }; continue; }
		out[item.key] = { id: made.id, action: "created" };
	}
	return out;
}`;
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
}

function contextOptions(args: string[], allowed: string[]) {
	const options = {
		dryRun: false,
		json: false,
		noModel: false,
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

function caller(read: ReadJson, target: OrganizationTarget) {
	return async (source: string): Promise<Json> => {
		const result = await read(codeCommand(target), MATCH_TIMEOUT_MS, source);
		// Code Mode reports a failed tool call as a value, not an exit code.
		if (result.ok === false)
			throw new Error(String(result.error ?? "tool call failed"));
		return result;
	};
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
			`  Proposed (${entry.proposals.length}); nothing reaches the board until you accept:`,
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
			`  Decided earlier and not asked again: ${entry.alreadyDecided}`,
		);
	return lines;
}

function renderProposals(proposals: Proposal[]): string[] {
	return proposals.map(
		(p, i) =>
			`    ${i + 1}. ${p.title} -> ${where(p)} (${p.sessions} session${p.sessions === 1 ? "" : "s"}, ${p.from} to ${p.to})${p.nearest ? `; closest existing: ${p.nearest.title.slice(0, 80)}` : ""}`,
	);
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
	const runModel = options.noModel ? null : (deps.runModel ?? claudeModel);
	const read = deps.read ?? cliRead;
	const stateDir = deps.stateDir ?? stateDirectory();
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
			const candidates = await extractCandidates(sessions, runModel);
			entry.candidates = candidates.length;
			const earliest = sessions.map((s) => s.from).sort()[0]!;
			const since = new Date(
				Date.parse(earliest) - 30 * 86_400_000,
			).toISOString();
			const board: BoardMatches = candidates.length
				? await matchBoard(candidates, since, caller(read, target))
				: { me: null, scanned: {}, matches: {} };
			const proposals = await judge(candidates, board, runModel, new Map());
			const path = statePath(target, stateDir);
			const prior = readState(path);
			// Decisions belong to the person who made them.
			const decided =
				prior && (!board.me || prior.userId === board.me.id)
					? prior.decided
					: {};
			const open = proposals.filter((p) => p.action === "create");
			const pending = open.filter((p) => !decidedFor(p, decided));
			Object.assign(entry, {
				tracked: proposals.filter((p) => p.action === "tracked"),
				proposals: pending,
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
	if (options.json) {
		write(JSON.stringify(report));
		return failed ? 2 : 0;
	}
	const lines: string[] = [];
	for (const [key, entry] of Object.entries<Json>(report.targets))
		lines.push(...renderTarget(key, entry), "");
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
			"Next: tedix learn review  (asks about each proposal; or --accept all, --accept 1,3, --reject 2)",
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

/** `tedix learn review`: accept or reject proposals, then file the accepted. */
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
	const results: Json = {};
	let failed = false;
	let any = false;
	for (const path of stateFiles(deps.stateDir ?? stateDirectory())) {
		const state = readState(path);
		if (!state?.proposals.length) continue;
		any = true;
		const key = targetKey(state.target);
		const accept = pick(options.accept, state.proposals.length);
		const reject = pick(options.reject, state.proposals.length);
		for (const i of accept)
			if (reject.has(i))
				throw new Error(`Proposal ${i + 1} is both accepted and rejected`);
		const interactive = !options.accept && !options.reject;
		if (interactive && !ask) {
			write(
				[
					`${key}: ${state.proposals.length} proposal(s)`,
					...renderProposals(state.proposals),
					"Choose with --accept <numbers|all> and --reject <numbers|all>.",
				].join("\n"),
			);
			continue;
		}
		if (interactive && ask) {
			write(
				`${key}: ${state.proposals.length} proposal(s). y = file it, n = never ask again, s = skip for now, q = stop.`,
			);
			for (let i = 0; i < state.proposals.length; i++) {
				const p = state.proposals[i]!;
				const answer = (
					await ask(
						`${renderProposals([p])[0]!.replace(/^\s+1\./, `${i + 1}.`)}\n   File it? [y/n/s/q] `,
					)
				)
					.trim()
					.toLowerCase();
				if (answer === "q") break;
				if (answer === "y") accept.add(i);
				else if (answer === "n") reject.add(i);
			}
		}
		const now = new Date().toISOString();
		const who = state.userName?.split(/\s+/)[0] || "a member";
		const chosen = [...accept].map((i) => state.proposals[i]!);
		const outcome = {
			accepted: chosen.length,
			rejected: reject.size,
			created: 0,
			existing: 0,
			errors: [] as string[],
		};
		if (chosen.length) {
			let filed: Json = {};
			try {
				filed = await caller(
					read,
					state.target,
				)(
					applySource(
						chosen.map((p) => ({
							key: p.key,
							title: p.title,
							description: proposalDescription(p, who),
							projectId: p.projectId!,
							...(p.parentId ? { parentId: p.parentId } : {}),
							intent: intentId(state.userId, p.key),
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
			for (const p of chosen) {
				const r = filed[p.key];
				if (!r?.id) {
					if (r?.error) outcome.errors.push(String(r.error).slice(0, 200));
					continue;
				}
				if (r.action === "created") outcome.created++;
				else outcome.existing++;
				state.decided[p.key] = {
					decision: "accepted",
					title: p.title,
					workId: r.id,
					at: now,
				};
			}
		}
		for (const i of reject)
			state.decided[state.proposals[i]!.key] = {
				decision: "rejected",
				title: state.proposals[i]!.title,
				at: now,
			};
		state.proposals = state.proposals.filter((p) => !state.decided[p.key]);
		writeState(path, state);
		if (outcome.errors.length) failed = true;
		results[key] = { ...outcome, stillPending: state.proposals.length };
		if (!options.json)
			write(
				`${key}: filed ${outcome.created} new, ${outcome.existing} already there, rejected ${outcome.rejected}, ${state.proposals.length} still pending${outcome.errors.length ? `; errors: ${outcome.errors.join("; ")}` : ""}`,
			);
	}
	if (options.json) write(JSON.stringify(results));
	else if (!any)
		write("No proposals to review. Run tedix learn context first.");
	return failed ? 2 : 0;
}

/**
 * `tedix learn onboard`: what a new member runs once, in order. Personal
 * first (lessons only they see), then their own section of the shared
 * session lists, then Work context as proposals.
 */
export async function runOnboard(
	args: string[],
	deps: ContextDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = contextOptions(args, ["--dry-run", "--no-model", "--since"]);
	const pass = [
		...(options.dryRun ? ["--dry-run"] : []),
		...(options.since ? ["--since", options.since.slice(0, 10)] : []),
	];
	const captured = (into: string[]) => ({
		...deps,
		write: (line: string) => into.push(line),
	});
	write(
		"1/3 Personal: your decisions and preference notes become lessons only you see.",
	);
	const imported: string[] = [];
	const importCode = await runLearnCommand(
		["import-sessions", ...pass, "--json"],
		captured(imported),
	);
	try {
		const report = JSON.parse(imported[imported.length - 1] ?? "{}");
		const results = Object.values<Json>(report.results ?? {});
		const recorded = results.reduce((n, r) => n + Number(r.recorded ?? 0), 0);
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
	write(
		"2/3 Your own section of the shared session lists (repeated requests, friction, decisions).",
	);
	const analyzed: string[] = [];
	const analyzeCode = await runAnalyzeSessions(
		[...pass, ...(options.noModel ? ["--no-model"] : []), "--json"],
		captured(analyzed),
	);
	try {
		const report = JSON.parse(analyzed[analyzed.length - 1] ?? "{}");
		for (const [key, entry] of Object.entries<Json>(report.targets ?? {}))
			write(
				`    ${key}: ${
					Object.entries<Json>(entry.workItems ?? {})
						.map(([category, r]) => `${category} ${r.action ?? r.error ?? "?"}`)
						.join(", ") || "nothing sent"
				}`,
			);
	} catch {
		write(`    ${analyzed.join(" ").slice(0, 300)}`);
	}
	write(
		"3/3 Work context: matched against the board; anything new is only proposed.",
	);
	const contextCode = await runContext(
		[...pass, ...(options.noModel ? ["--no-model"] : [])],
		deps,
	);
	return Math.max(importCode, analyzeCode, contextCode);
}
