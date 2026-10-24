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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
	existsSync,
	readdirSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
	openSync,
	closeSync,
} from "node:fs";
import {
	parseLines,
	parseLearningDate,
	targetKey,
	type LearnDeps,
	type SessionFile,
	sessionFiles,
	sessionLocator,
	runLearnCommand,
} from "./learn-import";
import {
	memoryNotes,
	planNotes,
	planContext,
	statePath,
	readState,
	decidedFor,
	writeState,
} from "./learn-context-notes";
import {
	type OrganizationTarget,
	repositoryTargetsByOrigin,
	defaultOrganizationTarget,
} from "./agent-context";
import {
	type Json,
	jaccard,
	type Proposal,
	words,
	extractCandidates,
} from "./learn-context-candidates";
import {
	type BoardMatches,
	matchBoard,
	withProjectKeys,
} from "./learn-context-board";
import { judge } from "./learn-context-judge";
import {
	type AskedProposal,
	listProposalsSource,
	publishSource,
	proposalRequest,
	respondSource,
} from "./learn-proposals";
import { type RunModel, localModel, runAnalyzeSessions } from "./learn-analyze";
import { createHash } from "node:crypto";
import { type ReadJson, cliRead, AGENT_IDENTITY_ENV } from "./hooks/hook-io";
import { selfCommand } from "./shared";
import { spawn } from "node:child_process";
import { unknownOptionError } from "./unknown-option";

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

export function stateDirectory(env = process.env, home = homedir()): string {
	return join(env.TEDIX_CONFIG_DIR || join(home, ".tedix"), "learn");
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

function contextOptions(command: string, args: string[], allowed: string[]) {
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
		if (!allowed.includes(arg)) throw unknownOptionError(command, arg, allowed);
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
			const since = parseLearningDate(value(), "--since");
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
	const options = contextOptions("learn context", args, [
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
	const options = contextOptions("learn review", args, [
		"--accept",
		"--reject",
		"--json",
	]);
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
	const options = contextOptions("learn onboard", args, [
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
