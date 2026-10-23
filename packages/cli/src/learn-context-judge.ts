import {
	type WorkMatch,
	type ProjectMatch,
	type BoardMatches,
} from "./learn-context-board";
import {
	type Candidate,
	EPIC_MIN_TASKS,
	inPool,
	type Json,
	parseArray,
	type Proposal,
	THRESHOLDS,
} from "./learn-context-candidates";
import { type RunModel } from "./learn-analyze";

// ---------------------------------------------------------------------------
// Judge and propose
// ---------------------------------------------------------------------------

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
		if (n > options.length || (answer[1] && n === 0)) return;
		const same = !answer[1] ? options[n - 1] : undefined;
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
