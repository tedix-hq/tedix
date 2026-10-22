import { asciiJson } from "./hooks/agent-status";
import {
	type Candidate,
	inPool,
	type Json,
	type Proposal,
	STOP,
	SUFFIX,
} from "./learn-context-candidates";

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
export const CATALOG_PAGE = 40;

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

export const CATALOG_MAX = 400;

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
export const MATCH_CHUNK = 8;
// Topic searches make more inner calls; keep their gateway telemetry below
// the Analytics Engine per-request write limit.
export const HISTORY_MATCH_CHUNK = 2;

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

/**
 * The key of a project a proposal names that the board match did not return
 * (a covering item's project), so the member reads "FINANCE", not an id.
 */
export async function withProjectKeys(
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
