import { redact } from "./hooks/decision-capture";
import {
	scrub,
	parseLines,
	type SessionFile,
	type Unrouted,
	sessionLocator,
	routedTarget,
	targetKey,
} from "./learn-import";
import { type AgentSessionDecision } from "@tedix/api-contract/schemas/agent-session-decisions";
import { type Json, type Proposal, words } from "./learn-context";
import {
	readdirSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { type OrganizationTarget } from "./agent-context";
import {
	type SessionSignals,
	codexSignals,
	claudeSignals,
} from "./learn-analyze";
import { jaccard } from "./learn-context-candidates";

export const short = (text: string, limit: number) =>
	redact(scrub(text).replace(/\s+/g, " "), limit)[0];

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

export function frontmatter(text: string): Record<string, string> {
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
export function preferenceBullets(markdown: string): string[] {
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

export const MIN_NOTE_CHARS = 24;
export const NOTE_CHARS = 900;

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

export function substantive(text: string): boolean {
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
