import { createHash } from "node:crypto";
import {
	type Candidate,
	type Json,
	words,
	withoutNames,
} from "./learn-context";
import { type SessionDigest, short, substantive } from "./learn-context-notes";
import { type RunModel } from "./learn-analyze";
import { EPIC_MIN_TASKS } from "./learn-context-judge";

export const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

export type CandidateKind = "task" | "goal" | "project";

export const STOP = new Set(
	"a an the to and or of for in on at is are be it this that these those please can could would will you we i me my our us now then just ok so do its with from what how also all any into by as about via per new make get set use using".split(
		" ",
	),
);

/** Crude suffix folding so "adopt", "adoption" and "adopting" meet. */
export const SUFFIX =
	/(?:abilities|ability|ations|ation|ings|ing|ions|ion|able|ers|er|ed|es|s|ly|e)$/;

export function jaccard(a: Set<string>, b: Set<string>): number {
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

export function parseArray(raw: string): unknown[] {
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

export async function inPool<T>(
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
