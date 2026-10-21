import { asciiJson } from "./hooks/agent-status";
import { type ProjectInfo, projectCatalog } from "./learn-context";
import type { SessionFacts } from "./learn-facts";
import type { Workstream } from "./learn-profile-workstreams";
import type { Json } from "./learn-profile-model";
import { escape } from "./learn-profile-digest";

/** Code Mode program: titles and states of Work Items by id. Reads only. */
export function workItemsSource(ids: string[]): string {
	return `async () => {
	const ids = ${asciiJson(ids)};
	const out = [];
	await Promise.all(ids.map(async (id) => {
		const r = await work.get_work_items_by_id({ id });
		const w = r && r.workItem;
		if (w && w.id) out.push([w.id, String(w.title || "").slice(0, 140), String(w.disposition || ""), w.projectId || null]);
	}));
	return { items: out };
}`;
}

/** Code Mode program: who is calling. Reads only. */
export const WHO_AM_I_SOURCE = `async () => {
	const p = await user.get_mine({});
	return { me: p && p.id ? { id: p.id, name: String(p.name || "") } : null };
}`;

/** Code Mode program: the organization's tedis by slug and name. Reads only. */
export const TEAM_SOURCE = `async () => {
	const team = [];
	for (let offset = 0; offset < 500; offset += 100) {
		const r = await tedis.list_tedis({ limit: 100, offset });
		if (!Array.isArray(r?.data)) break;
		for (const t of r.data) if (t && t.slug) team.push({ slug: String(t.slug), name: String(t.displayName || t.name || t.slug) });
		if (!r.pagination?.hasMore) break;
	}
	return { team };
}`;

export interface Board {
	me: { id: string; name: string } | null;
	items: Map<string, Workstream["items"][number]>;
	projects: ProjectInfo[];
}

/** Read the board once: who you are, the Work Items your sessions touched, open projects. */
export async function readBoard(
	sessions: SessionFacts[],
	call: (source: string) => Promise<Json>,
	log: (line: string) => void,
): Promise<Board> {
	const wanted = new Map<string, number>();
	for (const f of sessions)
		for (const id of Object.keys(f.workItems))
			wanted.set(id, (wanted.get(id) ?? 0) + 1);
	const ids = [...wanted]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 160)
		.map(([id]) => id);
	const items: Board["items"] = new Map();
	let unreadable = 0;
	// One id another organization owns fails the whole program: halve and retry.
	const read = async (chunk: string[]): Promise<void> => {
		try {
			const r = await call(workItemsSource(chunk));
			for (const [id, title, disposition, projectId] of r.items ?? [])
				items.set(id, { id, title, disposition, projectId });
		} catch {
			if (chunk.length === 1) {
				unreadable++;
				return;
			}
			const half = Math.ceil(chunk.length / 2);
			await read(chunk.slice(0, half));
			await read(chunk.slice(half));
		}
	};
	for (let i = 0; i < ids.length; i += 30) await read(ids.slice(i, i + 30));
	if (unreadable)
		log(
			`    ${unreadable} Work Items not visible in this organization, left out.`,
		);
	for (const [id, item] of items)
		if (
			item.disposition === "cancelled" ||
			/\b(?:scratch|e2e|test item|\(delete\))/i.test(item.title)
		)
			items.delete(id);
	let me: Board["me"] = null;
	try {
		me = (await call(WHO_AM_I_SOURCE)).me ?? null;
	} catch (error) {
		log(
			`    reading who you are failed: ${(error as Error).message.slice(0, 160)}`,
		);
	}
	return { me, items, projects: await projectCatalog(call) };
}

/** Everything a session says in its own words: where a project key or id can appear. */
const sessionText = (f: SessionFacts) =>
	[
		f.title,
		f.brief,
		...f.asks.map((a) => a.text),
		...f.delegated,
		...f.commits.map((c) => c.subject),
		f.lastAgent,
	]
		.filter(Boolean)
		.join("\n");

/** Repository paths a project description names, such as packages/cli. */
const repoPaths = (text: string) =>
	[
		...text.matchAll(
			/(?:^|[\s(`"'])((?:apps|packages|src|services|libs?)\/[\w.-]+)/g,
		),
	].map((m) => m[1]!);

/**
 * Board projects a set of sessions shows evidence for, by the number of
 * sessions carrying it: a Work Item of the project touched, the project's
 * key or id written, or a repository path its description names written to.
 * Words alone never count.
 */
export function projectEvidence(
	sessions: SessionFacts[],
	board: Pick<Board, "items" | "projects">,
): Map<string, number> {
	const keys = board.projects
		.filter(([, key]) => key && key.length >= 3)
		.map(([id, key, , description]) => ({
			id,
			pattern: new RegExp(
				`(?<![\\w-])(?:${escape(key)}|${escape(id)})(?![\\w-])`,
			),
			paths: repoPaths(description ?? ""),
		}));
	const out = new Map<string, number>();
	for (const f of sessions) {
		const hit = new Set<string>();
		for (const id of Object.keys(f.workItems)) {
			const projectId = board.items.get(id)?.projectId;
			if (projectId) hit.add(projectId);
		}
		const text = sessionText(f);
		for (const p of keys) {
			if (p.pattern.test(text)) hit.add(p.id);
			else if (
				p.paths.length &&
				f.filesWritten.some((file) =>
					p.paths.some((path) => file.includes(`${path}/`)),
				)
			)
				hit.add(p.id);
		}
		for (const id of hit) out.set(id, (out.get(id) ?? 0) + 1);
	}
	return out;
}

/** Link a workstream to the board on evidence only; otherwise leave it unlinked. */
export function linkWorkstream(
	w: Workstream,
	board: Pick<Board, "items" | "projects">,
) {
	const projects = new Map(
		board.projects.map(([id, key, name]) => [id, { id, key, name }]),
	);
	const evidence = [...projectEvidence(w.sessions, board)]
		.filter(([id]) => projects.has(id))
		.sort((a, b) => b[1] - a[1]);
	const total = evidence.reduce((n, [, v]) => n + v, 0);
	const [best, support] = evidence[0] ?? [];
	w.spread = evidence.length;
	// The leading project needs two sessions (or every session of a small
	// workstream) and at least 40% of the evidence; a scatter links nothing.
	w.project =
		best &&
		support! >= Math.min(2, w.sessions.length) &&
		support! / total >= 0.4
			? projects.get(best)
			: undefined;
	const touched = new Map<string, { sessions: number; last: string }>();
	for (const f of w.sessions)
		for (const id of Object.keys(f.workItems)) {
			if (!board.items.has(id)) continue;
			const prior = touched.get(id) ?? { sessions: 0, last: "" };
			prior.sessions++;
			if (f.to > prior.last) prior.last = f.to;
			touched.set(id, prior);
		}
	const open = (id: string) =>
		["proposed", "accepted"].includes(board.items.get(id)!.disposition) ? 1 : 0;
	w.items = [...touched]
		.sort(
			([a, x], [b, y]) =>
				open(b) - open(a) ||
				y.sessions - x.sessions ||
				(x.last < y.last ? 1 : -1),
		)
		.slice(0, 8)
		.map(([id]) => board.items.get(id)!);
}
