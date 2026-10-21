import type { SessionFacts } from "./learn-facts";
import type { RunModel } from "./learn-analyze";
import { words } from "./learn-context";
import {
	sha,
	type SessionSummary,
	day,
	one,
	countMap,
	strings,
} from "./learn-profile-digest";
import { parseJson, pool } from "./learn-profile-model";
import { type Board, linkWorkstream } from "./learn-profile-board";

// ---------------------------------------------------------------------------
// 3. Workstreams
// ---------------------------------------------------------------------------

export interface WorkstreamPart {
	name: string;
	sessions: SessionFacts[];
	/** One line from the model: where this thread stands. */
	line: string;
}

export interface Workstream {
	key: string;
	order?: number;
	name: string;
	description: string;
	sessions: SessionFacts[];
	/** The finer threads merged into this workstream, heaviest first. */
	parts: WorkstreamPart[];
	from: string;
	to: string;
	/** Distinct days with a session. */
	days: number;
	/** Sessions that finished something or committed. */
	shipped: number;
	/** Days active and outcomes, not message volume. */
	weight: number;
	status: "active" | "paused" | "done";
	state: string;
	next: string;
	openLoops: string[];
	project?: { id: string; key: string; name: string };
	/** Board projects with any evidence, when none is clearly its own. */
	spread?: number;
	items: Array<{
		id: string;
		title: string;
		disposition: string;
		projectId: string | null;
	}>;
}

export interface WorkstreamIdentity {
	name: string;
	description: string;
	project?: string;
	repository?: string;
	items: string[];
	sessions: string[];
	order: number;
}

export const workstreamOrder = (a: Workstream, b: Workstream) =>
	(a.order ?? Infinity) - (b.order ?? Infinity) || b.weight - a.weight;

export function stabilizeWorkstreams(
	workstreams: Workstream[],
	prior: Record<string, WorkstreamIdentity> = {},
): { workstreams: Workstream[]; registry: Record<string, WorkstreamIdentity> } {
	const evidence = workstreams.map((w) => {
		const repositories = new Map<string, number>();
		for (const f of w.sessions)
			if (f.repository)
				repositories.set(
					f.repository,
					(repositories.get(f.repository) ?? 0) + 1,
				);
		return {
			project: w.project?.id,
			repository: [...repositories].sort(
				(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
			)[0]?.[0],
			items: [...new Set(w.items.map((item) => item.id))].sort(),
			sessions: [...new Set(w.sessions.map((f) => f.key))],
		};
	});
	const overlap = (a: string[], b: string[]) => {
		const other = new Set(b);
		return a.filter((key) => other.has(key)).length / (a.length || 1);
	};
	const candidates = evidence
		.flatMap((e, index) =>
			Object.entries(prior).flatMap(([key, old]) => {
				if (e.project && old.project && e.project !== old.project) return [];
				const sessions = overlap(e.sessions, old.sessions);
				const items = overlap(e.items, old.items);
				const project = Boolean(e.project && e.project === old.project);
				const repository = Boolean(
					e.repository && e.repository === old.repository,
				);
				const sharedRepo =
					repository &&
					(evidence.filter((other) => other.repository === e.repository)
						.length > 1 ||
						Object.values(prior).filter(
							(other) => other.repository === e.repository,
						).length > 1);
				if (!project && !items && sessions < 0.5 && (!repository || sharedRepo))
					return [];
				return [{ index, key, project, sessions, items, repository }];
			}),
		)
		.sort(
			(a, b) =>
				Number(b.project) - Number(a.project) ||
				b.sessions - a.sessions ||
				b.items - a.items ||
				Number(b.repository) - Number(a.repository) ||
				prior[a.key]!.order - prior[b.key]!.order ||
				a.index - b.index,
		);
	const matches = new Map<number, string>();
	const used = new Set<string>();
	for (const match of candidates) {
		if (matches.has(match.index) || used.has(match.key)) continue;
		matches.set(match.index, match.key);
		used.add(match.key);
	}
	let nextOrder = Math.max(-1, ...Object.values(prior).map((e) => e.order)) + 1;
	const registry = { ...prior };
	const result = workstreams
		.map((w, index) => ({ w, index }))
		.sort((a, b) => b.w.weight - a.w.weight || a.index - b.index)
		.map(({ w, index }) => {
			const e = evidence[index]!;
			let key = matches.get(index);
			const old = key ? prior[key] : undefined;
			if (!key) {
				const seed = e.project
					? `project:${e.project}`
					: e.repository
						? `repository:${e.repository}`
						: e.items.length
							? `items:${e.items.join("|")}`
							: `sessions:${[...e.sessions].sort().join("|")}`;
				key = `ws:${sha(seed)}`;
				let collision = 0;
				while (registry[key] || used.has(key))
					key = `ws:${sha(`${seed}:${[...e.sessions].sort().join("|")}:${++collision}`)}`;
			}
			used.add(key);
			const stable = {
				...w,
				key,
				name: old?.name ?? w.name,
				description: w.description || old?.description || "",
				order: old?.order ?? nextOrder++,
			};
			registry[key] = {
				...e,
				name: stable.name,
				description: stable.description,
				sessions: e.sessions.slice(0, 200),
				order: stable.order,
			};
			return stable;
		});
	// A session belongs to the workstream it is in now, not to an earlier one.
	const current = new Set(result.flatMap((w) => w.sessions.map((f) => f.key)));
	const kept = new Set(result.map((w) => w.key));
	for (const [key, entry] of Object.entries(registry))
		if (!kept.has(key))
			registry[key] = {
				...entry,
				sessions: entry.sessions.filter((k) => !current.has(k)),
			};
	return { workstreams: result.sort(workstreamOrder), registry };
}

/** Most workstreams a profile shows; finer threads become sub-bullets. */
export const MAX_WORKSTREAMS = 12;

/** What the model is asked to merge down to. */
const TARGET_WORKSTREAMS = 10;

const shippedBy = (f: SessionFacts, s: SessionSummary | undefined) =>
	s?.status === "done" || f.commits.length > 0 || f.pushes > 0;

/** Weight a body of work by the days it was worked on and what it shipped. */
export function weigh(
	sessions: SessionFacts[],
	summaries: Map<string, SessionSummary>,
): { days: number; shipped: number; weight: number } {
	const days = new Set(sessions.map((f) => day(f.to))).size;
	const shipped = sessions.filter((f) =>
		shippedBy(f, summaries.get(f.key)),
	).length;
	// A session's message count never enters: a busy day weighs one day.
	return { days, shipped, weight: days * 2 + Math.min(shipped, days * 2) };
}

function workstream(
	name: string,
	description: string,
	parts: Array<{ name: string; sessions: SessionFacts[] }>,
	summaries: Map<string, SessionSummary>,
): Workstream {
	const sessions = [...new Set(parts.flatMap((p) => p.sessions))].sort(
		(a, b) => (a.to < b.to ? 1 : -1),
	);
	const times = sessions
		.flatMap((f) => [f.from, f.to])
		.filter(Boolean)
		.sort();
	const byName = new Map<string, WorkstreamPart>();
	for (const part of parts) {
		const key = part.name.toLowerCase();
		const prior = byName.get(key);
		if (prior) prior.sessions.push(...part.sessions);
		else
			byName.set(key, {
				name: part.name,
				sessions: [...part.sessions],
				line: "",
			});
	}
	return {
		key: `ws:${sha(
			sessions
				.map((f) => f.key)
				.sort()
				.join("|"),
		)}`,
		name,
		description,
		sessions,
		parts: [...byName.values()]
			.map((part) => ({
				...part,
				sessions: [...new Set(part.sessions)].sort((a, b) =>
					a.to < b.to ? 1 : -1,
				),
			}))
			.sort(
				(a, b) =>
					weigh(b.sessions, summaries).weight -
					weigh(a.sessions, summaries).weight,
			),
		from: times[0] ?? "",
		to: times[times.length - 1] ?? "",
		...weigh(sessions, summaries),
		status: "active",
		state: "",
		next: "",
		openLoops: [],
		items: [],
	};
}

export const GROUP_PROMPT = `Below are one person's agent sessions, one per line: number, date, repository, a suggested workstream name, then the goal and its status.
Group them into threads of work: a feature, a fix campaign, a customer task or a recurring duty (for example "billing exports" or "Acme onboarding"). Use the narrowest grouping that still collects related sessions, and at most 30 threads in all; put a one-off with the thread it serves, or in "Misc" if none fits.
Return ONLY JSON, no prose: [{"name":"<2-5 words>","description":"<one sentence: what this thread is>","sessions":[<numbers>]}]. Every session number appears exactly once.

`;

const GROUP_CHUNK = 220;

/** Fine threads of work, one per model group; merged later into workstreams. */
export async function groupWorkstreams(
	sessions: SessionFacts[],
	summaries: Map<string, SessionSummary>,
	run: RunModel,
): Promise<Workstream[]> {
	const groups: Array<{
		name: string;
		description: string;
		members: SessionFacts[];
	}> = [];
	const place = (
		name: string,
		description: string,
		members: SessionFacts[],
	) => {
		const set = new Set(words(name));
		const same = groups.find((g) => {
			const other = new Set(words(g.name));
			let shared = 0;
			for (const w of set) if (other.has(w)) shared++;
			return shared / (set.size + other.size - shared || 1) >= 0.6;
		});
		if (same) same.members.push(...members);
		else groups.push({ name, description, members: [...members] });
	};
	const ordered = [...sessions].sort((a, b) => (a.from < b.from ? -1 : 1));
	for (let i = 0; i < ordered.length; i += GROUP_CHUNK) {
		const chunk = ordered.slice(i, i + GROUP_CHUNK);
		const lines = chunk.map((f, j) => {
			const s = summaries.get(f.key);
			return `${j + 1}. ${day(f.from)} | ${f.repository ?? "-"} | ${s?.workstream ?? "?"} | ${s?.goal ?? f.title ?? ""} (${s?.status ?? "unclear"})`;
		});
		let parsed: unknown = null;
		try {
			parsed = parseJson(await run(GROUP_PROMPT + lines.join("\n")), "[");
		} catch {
			parsed = null;
		}
		const used = new Set<number>();
		if (Array.isArray(parsed))
			for (const raw of parsed) {
				const members = (Array.isArray(raw?.sessions) ? raw.sessions : [])
					.map(Number)
					.filter((n: number) => chunk[n - 1] && !used.has(n));
				for (const n of members) used.add(n);
				if (!members.length) continue;
				place(
					one(String(raw.name ?? "Misc"), 60) || "Misc",
					one(String(raw.description ?? ""), 240),
					members.map((n: number) => chunk[n - 1]!),
				);
			}
		// Whatever the model left out keeps its own suggested name.
		chunk.forEach((f, j) => {
			if (!used.has(j + 1))
				place(summaries.get(f.key)?.workstream ?? "Misc", "", [f]);
		});
	}
	return groups.map((g) =>
		workstream(
			g.name,
			g.description,
			[{ name: g.name, sessions: g.members }],
			summaries,
		),
	);
}

export const MERGE_PROMPT = `Below are one person's threads of work, numbered, already clustered where the evidence (same board project, same Work Items, same repository) joins them. Each line: number, the thread names in it, days worked, last day, repository, board project.
Merge them into the person's main workstreams: at most ${TARGET_WORKSTREAMS}, each a durable body of work a colleague would recognise, such as a product area, a customer or an initiative. Merge whole numbered clusters only; never split one. Name each in 2-4 plain words, specific to this person's work, never a generic name like "Tedix work" or "Misc".
Return ONLY JSON, no prose: [{"name":"<2-4 words>","description":"<one sentence: what this body of work is and for whom>","clusters":[<numbers>]}]. Every number appears exactly once.

`;

/**
 * Merge fine threads into at most MAX_WORKSTREAMS workstreams. A thread
 * whose sessions mostly belong to a workstream from an earlier run stays in
 * it, under its name, so a re-run keeps its sections; only the rest is
 * merged afresh.
 */
export async function mergeWorkstreams(
	fine: Workstream[],
	summaries: Map<string, SessionSummary>,
	board: Pick<Board, "items" | "projects">,
	run: RunModel,
	prior: Record<string, WorkstreamIdentity> = {},
): Promise<Workstream[]> {
	const owner = new Map<string, string>();
	for (const [id, entry] of Object.entries(prior))
		for (const key of entry.sessions) owner.set(key, id);
	const anchored = new Map<string, Workstream[]>();
	const rest: Workstream[] = [];
	for (const w of fine) {
		const [id, votes] =
			countMap(w.sessions.map((f) => owner.get(f.key) ?? ""))[0] ?? [];
		if (id && votes! * 2 >= w.sessions.length)
			anchored.set(id, [...(anchored.get(id) ?? []), w]);
		else rest.push(w);
	}
	if (!anchored.size) return mergeFresh(fine, summaries, board, run);
	const merged = [
		...[...anchored].map(([id, members]) =>
			workstream(
				prior[id]!.name,
				prior[id]!.description,
				members.flatMap((w) => w.parts),
				summaries,
			),
		),
		...(rest.length ? await mergeFresh(rest, summaries, board, run) : []),
	].sort((a, b) => b.weight - a.weight);
	if (merged.length > MAX_WORKSTREAMS) {
		const tail = merged.splice(MAX_WORKSTREAMS - 1);
		merged.push(
			workstream(
				"Other work",
				"Smaller threads that fit no main workstream.",
				tail.flatMap((w) => w.parts),
				summaries,
			),
		);
	}
	for (const w of merged) linkWorkstream(w, board);
	return merged;
}

/**
 * Merge fine threads afresh: evidence first (shared board project, shared
 * Work Items, a repository of their own), then the model names and merges
 * the clusters, and code holds the cap.
 */
async function mergeFresh(
	fine: Workstream[],
	summaries: Map<string, SessionSummary>,
	board: Pick<Board, "items" | "projects">,
	run: RunModel,
): Promise<Workstream[]> {
	const total = fine.reduce((n, w) => n + w.sessions.length, 0) || 1;
	const parent = fine.map((_, i) => i);
	const size = fine.map((w) => w.sessions.length);
	const find = (i: number): number =>
		parent[i] === i ? i : (parent[i] = find(parent[i]!));
	const join = (a: number, b: number) => {
		const [x, y] = [find(a), find(b)];
		// No cluster may swallow a fifth of the history by evidence alone.
		if (x === y || (size[x]! + size[y]!) / total > 0.2) return;
		parent[y] = x;
		size[x]! += size[y]!;
	};
	for (const w of fine) linkWorkstream(w, board);
	// Same evidenced project.
	const byProject = new Map<string, number>();
	fine.forEach((w, i) => {
		if (!w.project) return;
		const prior = byProject.get(w.project.id);
		if (prior === undefined) byProject.set(w.project.id, i);
		else join(prior, i);
	});
	// A Work Item touched in two threads, unless it is a hub most threads touch.
	const holders = new Map<string, Set<number>>();
	fine.forEach((w, i) => {
		for (const f of w.sessions)
			for (const id of Object.keys(f.workItems))
				if (board.items.has(id))
					holders.set(id, (holders.get(id) ?? new Set()).add(i));
	});
	for (const set of holders.values())
		if (set.size >= 2 && set.size <= 3) {
			const [first, ...rest] = [...set];
			for (const i of rest) join(first!, i);
		}
	// A repository of its own: one that is not most of the history.
	const repoCounts = countMap(
		fine.flatMap((w) => w.sessions.map((f) => f.repository ?? "")),
	);
	const own = (w: Workstream) => {
		const [repo, n] =
			countMap(w.sessions.map((f) => f.repository ?? ""))[0] ?? [];
		const everywhere = repoCounts.find(([r]) => r === repo)?.[1] ?? 0;
		return repo && n! / w.sessions.length >= 0.6 && everywhere / total < 0.5
			? repo
			: null;
	};
	const byRepo = new Map<string, number>();
	fine.forEach((w, i) => {
		const repo = own(w);
		if (!repo) return;
		const prior = byRepo.get(repo);
		if (prior === undefined) byRepo.set(repo, i);
		else join(prior, i);
	});
	const clusters = new Map<number, Workstream[]>();
	fine.forEach((w, i) => {
		const root = find(i);
		clusters.set(root, [...(clusters.get(root) ?? []), w]);
	});
	const list = [...clusters.values()].sort(
		(a, b) =>
			weigh(
				b.flatMap((w) => w.sessions),
				summaries,
			).weight -
			weigh(
				a.flatMap((w) => w.sessions),
				summaries,
			).weight,
	);
	const lines = list.map((members, i) => {
		const sessions = members.flatMap((w) => w.sessions);
		const { days } = weigh(sessions, summaries);
		const last =
			sessions
				.map((f) => f.to)
				.sort()
				.at(-1) ?? "";
		const project = members.find((w) => w.project)?.project;
		const repo = countMap(sessions.map((f) => f.repository ?? "-"))[0]?.[0];
		return `${i + 1}. ${members.map((w) => w.name).join("; ")} | ${days} days | last ${day(last)} | ${repo} | ${project ? `${project.key} ${project.name}` : "no project"}`;
	});
	let parsed: unknown = null;
	try {
		parsed = parseJson(await run(MERGE_PROMPT + lines.join("\n")), "[");
	} catch {
		parsed = null;
	}
	const used = new Set<number>();
	const merged: Workstream[] = [];
	const build = (name: string, description: string, members: Workstream[]) =>
		workstream(
			name,
			description,
			members.flatMap((w) => w.parts),
			summaries,
		);
	if (Array.isArray(parsed))
		for (const raw of parsed) {
			const picked: number[] = [
				...new Set<number>(
					(Array.isArray(raw?.clusters) ? raw.clusters : []).map(Number),
				),
			].filter((n) => list[n - 1] && !used.has(n));
			if (!picked.length) continue;
			const members = picked.flatMap((n) => list[n - 1]!);
			// A merge that swallows most of the history says nothing; keep its clusters apart.
			const size = members.reduce((n, w) => n + w.sessions.length, 0);
			if (picked.length > 1 && total >= 30 && size / total > 0.35) continue;
			for (const n of picked) used.add(n);
			merged.push(
				build(
					one(String(raw.name ?? ""), 60) || members[0]!.name,
					one(String(raw.description ?? ""), 240),
					members,
				),
			);
		}
	// What the model left out stays a workstream of its own, named after its heaviest thread.
	list.forEach((members, i) => {
		if (used.has(i + 1)) return;
		const lead = [...members].sort((a, b) => b.weight - a.weight)[0]!;
		merged.push(build(lead.name, lead.description, members));
	});
	merged.sort((a, b) => b.weight - a.weight);
	if (merged.length > MAX_WORKSTREAMS) {
		const tail = merged.splice(MAX_WORKSTREAMS - 1);
		merged.push(
			workstream(
				"Other work",
				"Smaller threads that fit no main workstream.",
				tail.flatMap((w) => w.parts),
				summaries,
			),
		);
	}
	for (const w of merged) linkWorkstream(w, board);
	return merged;
}

export const STATE_PROMPT = `Each numbered block below is one workstream of one person: its threads (P1, P2...), then its sessions newest first, one per day worked (date, thread, goal, outcome, status, open loops), and the Work Items on their team's board that its sessions touched. Today is TODAY.
For each workstream say where it stands now. Return ONLY JSON, no prose:
[{"w":<number>,"status":"active|paused|done","state":"<two sentences: what was built or decided, for whom, and what is stuck; concrete>","next":"<the single most useful next step, at most 20 words; empty when done>","openLoops":["<unfinished item still open, at most 15 words; at most 4>"],"parts":[{"p":<number>,"line":"<one line, at most 18 words: where this thread stands>"}]}]
"done" when its latest sessions finished it and nothing is left; "paused" when untouched for over a week with work left; otherwise "active". Drop open loops a later session closed. Do not invent.

`;

/**
 * Sessions to show the model: the newest of each thread, then the newest of
 * each day worked, then the rest.
 */
function spread(
	sessions: SessionFacts[],
	parts: WorkstreamPart[],
	limit: number,
): SessionFacts[] {
	const seen = new Set<string>();
	const first: SessionFacts[] = parts
		.map((part) => part.sessions[0])
		.filter((f): f is SessionFacts => Boolean(f));
	const rest: SessionFacts[] = [];
	for (const f of sessions) {
		if (first.includes(f)) continue;
		const d = day(f.to);
		if (seen.has(d)) rest.push(f);
		else {
			seen.add(d);
			first.push(f);
		}
	}
	return [...first, ...rest]
		.slice(0, limit)
		.sort((a, b) => (a.to < b.to ? 1 : -1));
}

export async function describeWorkstreams(
	workstreams: Workstream[],
	summaries: Map<string, SessionSummary>,
	run: RunModel,
	today: string,
) {
	const batches: Workstream[][] = [];
	for (let i = 0; i < workstreams.length; i += 3)
		batches.push(workstreams.slice(i, i + 3));
	await pool(batches, 4, async (batch) => {
		const blocks = batch.map((w, i) => {
			const lines = [`W${i + 1}. ${w.name}: ${w.description}`];
			const parts = w.parts.slice(0, 8);
			parts.forEach((part, j) =>
				lines.push(
					`P${j + 1}. ${part.name} (${part.sessions.length} sessions, last ${day(part.sessions[0]?.to ?? "")})`,
				),
			);
			const partOf = (f: SessionFacts) =>
				parts.findIndex((part) => part.sessions.includes(f));
			for (const f of spread(w.sessions, parts, 18)) {
				const s = summaries.get(f.key);
				if (!s) continue;
				const p = partOf(f);
				lines.push(
					`- ${day(f.to)}${p >= 0 ? ` P${p + 1}` : ""} ${s.goal} -> ${s.outcome} [${s.status}]${s.openLoops.length ? ` open: ${s.openLoops.join("; ")}` : ""}`,
				);
			}
			for (const item of w.items.slice(0, 6))
				lines.push(`- board: ${item.title} (${item.disposition})`);
			return lines.join("\n");
		});
		let parsed: unknown = null;
		try {
			parsed = parseJson(
				await run(STATE_PROMPT.replace("TODAY", today) + blocks.join("\n\n")),
				"[",
			);
		} catch {
			parsed = null;
		}
		if (!Array.isArray(parsed)) return;
		for (const raw of parsed) {
			const w = batch[Number(String(raw?.w).replace(/^W/i, "")) - 1];
			if (!w) continue;
			w.status =
				raw.status === "done" || raw.status === "paused"
					? raw.status
					: "active";
			w.state = one(String(raw.state ?? ""), 400);
			w.next = one(String(raw.next ?? ""), 200);
			w.openLoops = strings(raw.openLoops, 4, 160);
			if (Array.isArray(raw.parts))
				for (const p of raw.parts) {
					const part = w.parts[Number(String(p?.p).replace(/^P/i, "")) - 1];
					if (part) part.line = one(String(p?.line ?? ""), 200);
				}
		}
	});
}
