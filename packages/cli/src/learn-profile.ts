/**
 * `tedix learn profile`: read a member's whole local agent history and write
 * "What Tedix knows about you", a document in their own Tedix space, plus
 * up to three inbox proposals they can accept in one click.
 *
 * 1. Facts (local, no model): every transcript, sub-agents folded into their
 *    session, read by learn-facts.ts.
 * 2. Per session (local model): a short structured summary (goal, outcome,
 *    status, artifacts, open loops, workstream), batched and cached by a
 *    hash of the session's digest, so a re-run only summarises new or
 *    changed sessions.
 * 3. Per workstream (local model): sessions grouped into bodies of work,
 *    linked to the board's projects and Work (read-only), with where each
 *    stands and what is next.
 * 4. Person (local model): role, focus, working style, recurring workflows,
 *    people and organisations, tools, and three things to do now.
 * 5. Upload: the document (personal: it may name people) and the three
 *    actions as proposals addressed to the member (names taken out, since an
 *    accepted proposal becomes shared Work). Raw transcripts never leave the
 *    machine; every uploaded string is scrubbed of secrets, email addresses
 *    and phone numbers.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	defaultOrganizationTarget,
	type OrganizationTarget,
} from "./agent-context";
import { asciiJson } from "./hooks/agent-status";
import { redact } from "./hooks/decision-capture";
import { cliRead } from "./hooks/hook-io";
import {
	codexModel,
	onPath,
	repeatedRequests,
	type RunModel,
} from "./learn-analyze";
import {
	askedFor,
	cachedModel,
	caller,
	type Candidate,
	type ContextDeps,
	codexGoals,
	codexThreadNames,
	matchBoard,
	memoryNotes,
	type Proposal,
	stateDirectory,
	THRESHOLDS,
	withoutNames,
	words,
} from "./learn-context";
import {
	claudeFacts,
	codexFacts,
	foldSubagents,
	type SessionFacts,
	type TranscriptFile,
	transcriptFiles,
	trivial,
} from "./learn-facts";
import { scrub } from "./learn-import";
import {
	type AskedProposal,
	listProposalsSource,
	proposalRequest,
	publishSource,
} from "./learn-proposals";

type Json = Record<string, any>;

export const OS_URL = "https://os.tedix.dev";
const DOC_TITLE = "What Tedix knows about you";
const SPACE_MARKER = "tedix learn personal space";

const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);
const day = (iso: string) => iso.slice(0, 10);
const one = (text: string, limit: number) =>
	redact(scrub(text).replace(/\s+/g, " ").trim(), limit)[0];

/** Phone numbers: a + prefix, or nine or more digits in separated groups. */
const PHONE =
	/(?<![\w/.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){2,4}(?![\w/.-])/g;

/** Links this command builds itself: Tedix OS pages and commits. */
const OWN_LINK =
	/https:\/\/(?:os\.tedix\.dev\/(?:work\/(?:items|projects|interactions)|outputs)\/[0-9a-f-]{36}|github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40})/g;

/** What may leave the machine: no secrets, email addresses or phone numbers. */
export function publicText(text: string, limit = 2000): string {
	const links: string[] = [];
	const held = String(text ?? "").replace(OWN_LINK, (link) => {
		links.push(link);
		return `\u0001${links.length - 1}\u0001`;
	});
	const cleaned = scrub(held).replace(PHONE, (match) =>
		match.replace(/\D/g, "").length >= 9 && !/^\d{4}-\d{2}-\d{2}/.test(match)
			? "[phone]"
			: match,
	);
	return redact(cleaned.replace(/\s+/g, " ").trim(), limit)[0].replace(
		/\u0001(\d+)\u0001/g,
		(_, i) => links[Number(i)] ?? "",
	);
}

// ---------------------------------------------------------------------------
// Models, metered
// ---------------------------------------------------------------------------

export interface Meter {
	calls: number;
	cached: number;
	failed: number;
	ms: number;
	costUsd: number;
}

export function newMeter(): Meter {
	return { calls: 0, cached: 0, failed: 0, ms: 0, costUsd: 0 };
}

/**
 * The member's own `claude` (haiku), headless and isolated like the other
 * learn steps, with its JSON envelope read for the cost of the call.
 */
export function claudeHaiku(meter: Meter): RunModel {
	return (prompt) =>
		new Promise((resolve, reject) => {
			const started = Date.now();
			const child = spawn(
				"claude",
				[
					"-p",
					"--model",
					"haiku",
					"--no-session-persistence",
					"--output-format",
					"json",
					"--tools",
					"",
					"--setting-sources",
					"project",
				],
				{ cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
			);
			let out = "";
			const timer = setTimeout(() => child.kill(), 300_000);
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				meter.calls++;
				meter.ms += Date.now() - started;
				try {
					const envelope = JSON.parse(out);
					meter.costUsd += Number(envelope.total_cost_usd ?? 0);
					if (code === 0 && !envelope.is_error)
						return resolve(String(envelope.result ?? ""));
				} catch {
					/* Not an envelope. */
				}
				meter.failed++;
				reject(new Error(`claude exited ${code}`));
			});
			child.stdin.end(prompt);
		});
}

function meteredCodex(meter: Meter): RunModel {
	return async (prompt) => {
		const started = Date.now();
		try {
			return await codexModel(prompt);
		} catch (error) {
			meter.failed++;
			throw error;
		} finally {
			meter.calls++;
			meter.ms += Date.now() - started;
		}
	};
}

export function profileModel(
	meter: Meter,
	has: (command: string) => boolean = (c) => onPath(c),
): { name: string; run: RunModel } | null {
	if (has("claude")) return { name: "claude haiku", run: claudeHaiku(meter) };
	if (has("codex"))
		return { name: "codex (low effort)", run: meteredCodex(meter) };
	return null;
}

function parseJson(raw: string, open: "[" | "{"): any {
	const close = open === "[" ? "]" : "}";
	const start = raw.indexOf(open);
	const end = raw.lastIndexOf(close);
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
}

async function pool<T>(
	items: T[],
	size: number,
	work: (item: T) => Promise<void>,
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await work(items[next++]!);
		}),
	);
}

const strings = (value: unknown, limit: number, chars: number): string[] =>
	Array.isArray(value)
		? value
				.filter((v) => typeof v === "string" && v.trim())
				.slice(0, limit)
				.map((v) => one(v, chars))
		: [];

// ---------------------------------------------------------------------------
// 1. Facts, cached by file size and time
// ---------------------------------------------------------------------------

export interface ProfileState {
	version: 1;
	facts: Record<string, { sig: string; facts: SessionFacts | null }>;
	summaries: Record<string, { hash: string; summary: SessionSummary }>;
	space?: { organization: string; workspaceId: string; outputId?: string };
}

export function readProfileState(path: string): ProfileState {
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (state?.version === 1) return state;
	} catch {
		/* First run. */
	}
	return { version: 1, facts: {}, summaries: {} };
}

export function writeProfileState(path: string, state: ProfileState) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
	renameSync(temp, path);
}

export async function readAllFacts(
	files: TranscriptFile[],
	state: ProfileState,
	home = homedir(),
): Promise<SessionFacts[]> {
	const goals = await codexGoals(home);
	const names = codexThreadNames(home);
	const out: SessionFacts[] = [];
	const live = new Set<string>();
	for (const file of files) {
		live.add(file.path);
		const sig = `${file.bytes}:${Math.round(file.mtimeMs)}`;
		const hit = state.facts[file.path];
		let facts: SessionFacts | null;
		if (hit && hit.sig === sig) facts = hit.facts;
		else {
			try {
				facts =
					file.harness === "codex"
						? await codexFacts(file, undefined, goals, names)
						: await claudeFacts(file);
			} catch {
				facts = null;
			}
			state.facts[file.path] = { sig, facts };
		}
		if (facts) out.push(facts);
	}
	for (const path of Object.keys(state.facts))
		if (!live.has(path)) delete state.facts[path];
	// A forked Codex rollout repeats its root session: keep the fullest copy.
	const byKey = new Map<string, SessionFacts>();
	for (const f of out) {
		const prior = byKey.get(f.key);
		if (!prior || f.toolCalls + f.askCount > prior.toolCalls + prior.askCount)
			byKey.set(f.key, structuredClone(f));
	}
	return foldSubagents([...byKey.values()]);
}

// ---------------------------------------------------------------------------
// 2. Per-session summaries
// ---------------------------------------------------------------------------

export interface SessionSummary {
	goal: string;
	outcome: string;
	status: "done" | "open" | "abandoned" | "unclear";
	artifacts: string[];
	openLoops: string[];
	workstream: string;
	people: string[];
	orgs: string[];
	preferences: string[];
}

const top = (record: Record<string, number>, n: number) =>
	Object.entries(record)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, v]) => `${k}×${v}`)
		.join(", ");

/** One session as the local model reads it. Stays on the machine. */
export function sessionDigest(f: SessionFacts, n: number): string {
	const lines = [
		`#${n} ${f.harness} ${f.kind}${f.subagents ? ` (+${f.subagents} sub-agents)` : ""} | repo ${f.repository ?? "-"}${f.branch ? `@${f.branch}` : ""} | ${day(f.from)}..${day(f.to)} | ${f.activeMinutes} active min | ${f.askCount} asks`,
	];
	if (f.title) lines.push(`Title: ${f.title}`);
	if (f.brief) lines.push(`Assignment: ${f.brief.slice(0, 500)}`);
	const asks =
		f.asks.length > 9 ? [...f.asks.slice(0, 7), ...f.asks.slice(-2)] : f.asks;
	for (const ask of asks) lines.push(`- typed: ${ask.text.slice(0, 260)}`);
	if (f.delegated.length)
		lines.push(`Delegated: ${f.delegated.slice(0, 6).join(" | ")}`);
	lines.push(`Tools: ${top(f.tools, 6)}`);
	if (Object.keys(f.mcp).length)
		lines.push(`MCP/Tedix calls: ${top(f.mcp, 8)}`);
	if (Object.keys(f.skills).length) lines.push(`Skills: ${top(f.skills, 5)}`);
	if (Object.keys(f.commands).length)
		lines.push(`Commands: ${top(f.commands, 8)}`);
	if (f.filesWritten.length)
		lines.push(
			`Wrote ${f.filesWritten.length} files: ${f.filesWritten.slice(0, 10).join(", ")}`,
		);
	if (f.commits.length)
		lines.push(
			`Commits (${f.commits.length}): ${f.commits
				.slice(0, 8)
				.map((c) => c.subject)
				.join(" | ")}`,
		);
	if (f.pushes) lines.push(`Pushes: ${f.pushes}`);
	const items = Object.keys(f.workItems);
	if (items.length) lines.push(`Tedix Work Items touched: ${items.length}`);
	if (f.outputs.length)
		lines.push(`Tedix outputs touched: ${f.outputs.length}`);
	if (f.artifacts.length)
		lines.push(`Artifacts: ${f.artifacts.slice(0, 5).join(", ")}`);
	const domains = [
		...new Set(f.urls.map((u) => u.replace(/^https?:\/\/([^/]+).*$/, "$1"))),
	];
	if (domains.length) lines.push(`Fetched: ${domains.slice(0, 6).join(", ")}`);
	if (f.searches.length)
		lines.push(`Searched: ${f.searches.slice(0, 4).join(" | ")}`);
	if (f.errorCount)
		lines.push(
			`Errors: ${f.errorCount}; e.g. ${[...new Set(f.errors.map((e) => `${e.head}: ${e.error}`))].slice(0, 3).join(" | ")}`,
		);
	if (f.lastAgent) lines.push(`Ended with: ${f.lastAgent.slice(-400)}`);
	return lines.join("\n").slice(0, 4000);
}

export const SUMMARY_PROMPT = `Below are numbered digests of one person's coding-agent sessions on their own machine: what they typed, what the agents ran and produced, and how each session ended. An "Assignment" is what a supervisor run or sub-agent was told to do for them; they did not type it.
For each session say what it was for and where it stands. Return ONLY a JSON array, one object per session, no prose:
[{"n":<number>,"goal":"<what was wanted, at most 20 words>","outcome":"<what was actually achieved or produced, at most 25 words>","status":"done|open|abandoned|unclear","artifacts":["<what it produced: commits, docs, decks, outputs, releases; at most 5, short>"],"openLoops":["<a concrete unfinished item worth picking up, at most 15 words>"],"workstream":"<2-5 word name of the body of work it belongs to, e.g. billing exports, Acme onboarding, dependency upgrades>","people":["<names of people mentioned>"],"orgs":["<companies, customers or partners mentioned>"],"preferences":["<how the person wants work done, only when they said so, at most 15 words>"]}]
"done": shipped, merged, answered or closed. "open": stopped with work left. Open loops only for real unfinished work, never "monitor" or "wait". Do not invent; do not copy secrets, tokens, email addresses or phone numbers.

`;

const SUMMARY_BATCH = 6;
const STATUSES = new Set(["done", "open", "abandoned", "unclear"]);

export function toSummary(raw: Json): SessionSummary {
	return {
		goal: one(String(raw.goal ?? ""), 200),
		outcome: one(String(raw.outcome ?? ""), 240),
		status: STATUSES.has(raw.status) ? raw.status : "unclear",
		artifacts: strings(raw.artifacts, 5, 120),
		openLoops: strings(raw.openLoops, 4, 160),
		workstream: one(String(raw.workstream ?? "Misc"), 60) || "Misc",
		people: strings(raw.people, 10, 60),
		orgs: strings(raw.orgs, 10, 60),
		preferences: strings(raw.preferences, 4, 160),
	};
}

/** Summaries for every session, from the cache when its digest is unchanged. */
export async function summarise(
	sessions: SessionFacts[],
	state: ProfileState,
	run: RunModel,
	meter: Meter,
	save: () => void,
	log: (line: string) => void,
): Promise<Map<string, SessionSummary>> {
	const out = new Map<string, SessionSummary>();
	const pending: Array<{ f: SessionFacts; digest: string; hash: string }> = [];
	for (const f of sessions) {
		const digest = sessionDigest(f, 0);
		const hash = sha(digest);
		const hit = state.summaries[f.key];
		if (hit && hit.hash === hash) {
			out.set(f.key, hit.summary);
			meter.cached++;
		} else pending.push({ f, digest, hash });
	}
	const batches: Array<typeof pending> = [];
	for (let i = 0; i < pending.length; i += SUMMARY_BATCH)
		batches.push(pending.slice(i, i + SUMMARY_BATCH));
	let done = 0;
	await pool(batches, 4, async (batch) => {
		const prompt =
			SUMMARY_PROMPT +
			batch.map((b, i) => sessionDigest(b.f, i + 1)).join("\n\n");
		let parsed: unknown = null;
		for (let attempt = 0; attempt < 2 && !Array.isArray(parsed); attempt++) {
			try {
				parsed = parseJson(await run(prompt), "[");
			} catch {
				parsed = null;
			}
		}
		if (Array.isArray(parsed))
			for (const raw of parsed) {
				const b = batch[Number(raw?.n) - 1];
				if (!b) continue;
				const summary = toSummary(raw);
				out.set(b.f.key, summary);
				state.summaries[b.f.key] = { hash: b.hash, summary };
			}
		done += batch.length;
		save();
		log(`    summarised ${done}/${pending.length} new or changed sessions`);
	});
	for (const key of Object.keys(state.summaries))
		if (!sessions.some((f) => f.key === key)) delete state.summaries[key];
	return out;
}

// ---------------------------------------------------------------------------
// 3. Workstreams
// ---------------------------------------------------------------------------

export interface Workstream {
	key: string;
	name: string;
	description: string;
	sessions: SessionFacts[];
	from: string;
	to: string;
	status: "active" | "paused" | "done";
	state: string;
	next: string;
	openLoops: string[];
	project?: { id: string; key: string; name: string };
	items: Array<{
		id: string;
		title: string;
		disposition: string;
		projectId: string | null;
	}>;
}

export const GROUP_PROMPT = `Below are one person's agent sessions, one per line: number, date, repository, a suggested workstream name, then the goal and its status.
Group them into the person's workstreams: durable bodies of work such as a product area, a customer, an initiative or a recurring duty (for example "dependency upgrades" or "Acme onboarding"). Use the narrowest grouping that still collects related sessions, and at most 20 workstreams in all; put a one-off with the workstream it serves, or in "Misc" if none fits.
Return ONLY JSON, no prose: [{"name":"<2-5 words>","description":"<one sentence: what this body of work is>","sessions":[<numbers>]}]. Every session number appears exactly once.

`;

const GROUP_CHUNK = 220;

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
	return groups.map((g) => {
		const times = g.members
			.flatMap((f) => [f.from, f.to])
			.filter(Boolean)
			.sort();
		return {
			key: `ws:${sha(g.name.toLowerCase())}`,
			name: g.name,
			description: g.description,
			sessions: g.members.sort((a, b) => (a.to < b.to ? 1 : -1)),
			from: times[0] ?? "",
			to: times[times.length - 1] ?? "",
			status: "active",
			state: "",
			next: "",
			openLoops: [],
			items: [],
		};
	});
}

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

/** Link each workstream to the board: its own Work Items first, else by words. */
export async function linkBoard(
	workstreams: Workstream[],
	call: (source: string) => Promise<Json>,
	since: string,
	log: (line: string) => void,
): Promise<{ me: { id: string; name: string } | null }> {
	const wanted = new Map<string, number>();
	for (const w of workstreams)
		for (const f of w.sessions)
			for (const [id, n] of Object.entries(f.workItems))
				wanted.set(id, (wanted.get(id) ?? 0) + n);
	const ids = [...wanted]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 120)
		.map(([id]) => id);
	const items = new Map<string, Workstream["items"][number]>();
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
	const candidates: Candidate[] = workstreams.map((w) => ({
		key: w.key,
		kind: "project",
		title: w.name,
		confidence: 1,
		sessions: [],
		from: w.from,
		to: w.to,
		goal: false,
		context: w.description,
	}));
	let board: Awaited<ReturnType<typeof matchBoard>> = {
		me: null,
		scanned: {},
		matches: {},
	};
	try {
		board = await matchBoard(candidates, since, call, true);
	} catch (error) {
		log(`    board match failed: ${(error as Error).message.slice(0, 160)}`);
	}
	const projects = new Map(
		(board.projects ?? []).map(([id, key, name]) => [id, { id, key, name }]),
	);
	for (const w of workstreams) {
		const own = new Map<string, number>();
		for (const f of w.sessions)
			for (const [id, n] of Object.entries(f.workItems))
				if (items.has(id)) own.set(id, (own.get(id) ?? 0) + n);
		w.items = [...own]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([id]) => items.get(id)!);
		const votes = new Map<string, number>();
		for (const item of w.items)
			if (item.projectId)
				votes.set(item.projectId, (votes.get(item.projectId) ?? 0) + 1);
		const voted = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
		const match = board.matches[w.key];
		const byWords =
			match?.p[0] && match.p[0][3] >= THRESHOLDS.project
				? match.p[0]
				: undefined;
		if (voted && projects.has(voted)) w.project = projects.get(voted);
		else if (byWords)
			w.project = { id: byWords[0], key: byWords[1], name: byWords[2] };
		if (!w.items.length && match?.w[0] && match.w[0][5] >= THRESHOLDS.same) {
			const [id, title, projectId, disposition] = match.w[0];
			w.items = [{ id, title, disposition, projectId }];
		}
	}
	return { me: board.me };
}

export const STATE_PROMPT = `Each numbered block below is one workstream of one person: its sessions newest first (date, goal, outcome, status, open loops) and the Work Items on their team's board that its sessions touched. Today is TODAY.
For each workstream say where it stands now. Return ONLY JSON, no prose:
[{"w":<number>,"status":"active|paused|done","state":"<two sentences: where it stands now, concrete>","next":"<the single most useful next step, at most 20 words; empty when done>","openLoops":["<unfinished item still open, at most 15 words; at most 4>"]}]
"done" when its latest sessions finished it and nothing is left; "paused" when untouched for over a week with work left; otherwise "active". Drop open loops a later session closed. Do not invent.

`;

export async function describeWorkstreams(
	workstreams: Workstream[],
	summaries: Map<string, SessionSummary>,
	run: RunModel,
	today: string,
) {
	const batches: Workstream[][] = [];
	for (let i = 0; i < workstreams.length; i += 4)
		batches.push(workstreams.slice(i, i + 4));
	await pool(batches, 4, async (batch) => {
		const blocks = batch.map((w, i) => {
			const lines = [`W${i + 1}. ${w.name}: ${w.description}`];
			for (const f of w.sessions.slice(0, 12)) {
				const s = summaries.get(f.key);
				if (!s) continue;
				lines.push(
					`- ${day(f.to)} ${s.goal} -> ${s.outcome} [${s.status}]${s.openLoops.length ? ` open: ${s.openLoops.join("; ")}` : ""}`,
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
		}
	});
}

// ---------------------------------------------------------------------------
// 4. The person
// ---------------------------------------------------------------------------

export interface PersonProfile {
	role: string;
	focus: string[];
	style: string[];
	workflows: Array<{
		name: string;
		evidence: string;
		kind: string;
		proposal: string;
	}>;
	people: Array<{ name: string; context: string }>;
	orgs: Array<{ name: string; context: string }>;
	tools: string[];
	actions: Array<{
		title: string;
		why: string;
		workstream: string;
		kind: string;
	}>;
}

export const PROFILE_PROMPT = `You are writing down what an assistant has learned about one person from their own coding-agent history, so it can start helping them at once. Below: their workstreams with status, usage statistics, requests they repeat, failures they keep hitting, preference notes their agents keep, things they said about how they want work done, and the people and organisations their sessions mention.
Return ONLY one JSON object, no prose:
{"role":"<one sentence: what they do, inferred from the work>","focus":["<current focus areas, at most 6>"],"style":["<how they like to work: concrete preferences and habits, each with its evidence; at most 8>"],"workflows":[{"name":"<a workflow they repeat>","evidence":"<how often and where it shows>","kind":"skill|factory","proposal":"<what Tedix would run for them, at most 20 words>"}],"people":[{"name":"<name>","context":"<how they relate to the work, at most 12 words>"}],"orgs":[{"name":"<company, customer or partner>","context":"<at most 12 words>"}],"tools":["<tools and services they rely on>"],"actions":[{"title":"<starts with a verb, at most 12 words>","why":"<one sentence citing the evidence>","workstream":"<workstream name>","kind":"finish|skill|factory"}]}
At most 6 workflows, only things they actually repeat; a "factory" is a recurring scheduled run, a "skill" a reusable procedure. Exactly 3 actions: concrete things an assistant could start today in one step, either finishing an open loop or setting up a repeated workflow; prefer the ones with the most evidence. Never invent facts.

`;

export function toProfile(raw: Json | null): PersonProfile {
	const pairs = (value: unknown, limit: number) =>
		Array.isArray(value)
			? value
					.filter((v) => v && typeof v.name === "string")
					.slice(0, limit)
					.map((v) => ({
						name: one(v.name, 80),
						context: one(String(v.context ?? ""), 140),
					}))
			: [];
	return {
		role: one(String(raw?.role ?? ""), 300),
		focus: strings(raw?.focus, 6, 160),
		style: strings(raw?.style, 8, 240),
		workflows: Array.isArray(raw?.workflows)
			? raw.workflows.slice(0, 6).map((w: Json) => ({
					name: one(String(w?.name ?? ""), 100),
					evidence: one(String(w?.evidence ?? ""), 200),
					kind: w?.kind === "factory" ? "factory" : "skill",
					proposal: one(String(w?.proposal ?? ""), 200),
				}))
			: [],
		people: pairs(raw?.people, 25),
		orgs: pairs(raw?.orgs, 25),
		tools: strings(raw?.tools, 15, 80),
		actions: Array.isArray(raw?.actions)
			? raw.actions
					.filter((a: Json) => a && typeof a.title === "string")
					.slice(0, 3)
					.map((a: Json) => ({
						title: one(a.title, 140),
						why: one(String(a.why ?? ""), 300),
						workstream: one(String(a.workstream ?? ""), 60),
						kind: ["finish", "skill", "factory"].includes(a.kind)
							? a.kind
							: "finish",
					}))
			: [],
	};
}

const countMap = (values: string[]) => {
	const counts = new Map<string, number>();
	for (const v of values) {
		const key = v.trim();
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]);
};

/** Usage that says how someone works, from facts alone. */
export function usageStats(sessions: SessionFacts[]) {
	const sum = (pick: (f: SessionFacts) => Record<string, number>) => {
		const out: Record<string, number> = {};
		for (const f of sessions)
			for (const [k, v] of Object.entries(pick(f))) out[k] = (out[k] ?? 0) + v;
		return out;
	};
	const hours = new Array(24).fill(0);
	for (const f of sessions) for (const h of f.hours) hours[h]++;
	const errors = new Map<string, { n: number; sessions: Set<string> }>();
	for (const f of sessions)
		for (const e of f.errors) {
			const key = `${e.head}: ${e.error}`;
			const entry = errors.get(key) ?? { n: 0, sessions: new Set() };
			entry.n++;
			entry.sessions.add(f.key);
			errors.set(key, entry);
		}
	return {
		sessions: sessions.length,
		byHarness: countMap(sessions.map((f) => f.harness)),
		byKind: countMap(sessions.map((f) => f.kind)),
		subagents: sessions.reduce((n, f) => n + f.subagents, 0),
		asks: sessions.reduce((n, f) => n + f.askCount, 0),
		toolCalls: sessions.reduce((n, f) => n + f.toolCalls, 0),
		activeHours: Math.round(
			sessions.reduce((n, f) => n + f.activeMinutes, 0) / 60,
		),
		commits: sessions.reduce((n, f) => n + f.commits.length, 0),
		filesWritten: sessions.reduce((n, f) => n + f.filesWritten.length, 0),
		workItems: new Set(sessions.flatMap((f) => Object.keys(f.workItems))).size,
		outputs: new Set(sessions.flatMap((f) => f.outputs)).size,
		artifacts: sessions.reduce((n, f) => n + f.artifacts.length, 0),
		repositories: countMap(sessions.map((f) => f.repository ?? "(none)")).slice(
			0,
			8,
		),
		tools: top(
			sum((f) => f.tools),
			12,
		),
		mcp: top(
			sum((f) => f.mcp),
			20,
		),
		skills: top(
			sum((f) => f.skills),
			12,
		),
		commands: top(
			sum((f) => f.commands),
			25,
		),
		cliWorkspaces: countMap(sessions.flatMap((f) => f.cliWorkspaces)).slice(
			0,
			8,
		),
		domains: countMap(
			sessions.flatMap((f) => [
				...new Set(
					f.urls.map((u) => u.replace(/^https?:\/\/([^/]+).*$/, "$1")),
				),
			]),
		).slice(0, 12),
		hours,
		friction: [...errors]
			.filter(([, e]) => e.sessions.size >= 2)
			.sort((a, b) => b[1].n - a[1].n)
			.slice(0, 10)
			.map(([k, e]) => `${k} (${e.n}× in ${e.sessions.size} sessions)`),
		from:
			sessions
				.map((f) => f.from)
				.filter(Boolean)
				.sort()[0] ?? "",
		to:
			sessions
				.map((f) => f.to)
				.filter(Boolean)
				.sort()
				.at(-1) ?? "",
	};
}

export async function buildProfile(input: {
	sessions: SessionFacts[];
	summaries: Map<string, SessionSummary>;
	workstreams: Workstream[];
	notes: string[];
	run: RunModel;
}): Promise<PersonProfile> {
	const stats = usageStats(input.sessions);
	const summaries = [...input.summaries.values()];
	const repeated = repeatedRequests(
		input.sessions.flatMap((f) =>
			f.asks.map((a) => ({ text: a.text, at: a.at, session: f.key })),
		),
		{ minCount: 3, minSessions: 2, top: 12 },
	);
	const sections = [
		"WORKSTREAMS (newest first):",
		...input.workstreams.map(
			(w) =>
				`- ${w.name} [${w.status}] ${w.sessions.length} sessions ${day(w.from)}..${day(w.to)}${w.project ? ` project ${w.project.key}` : ""}: ${w.state || w.description}${w.next ? ` Next: ${w.next}` : ""}${w.openLoops.length ? ` Open: ${w.openLoops.join("; ")}` : ""}`,
		),
		"",
		"USAGE:",
		JSON.stringify({ ...stats, hours: stats.hours.join(" ") }),
		"",
		"REPEATED REQUESTS:",
		...repeated.map(
			(r) =>
				`- "${r.label}" ${r.count}× in ${r.sessions} sessions, last ${r.last}`,
		),
		"",
		"PREFERENCE NOTES THEIR AGENTS KEEP:",
		...input.notes.slice(0, 120).map((n) => `- ${n.slice(0, 220)}`),
		"",
		"SAID ABOUT HOW THEY WANT WORK DONE:",
		...countMap(summaries.flatMap((s) => s.preferences))
			.slice(0, 60)
			.map(([p]) => `- ${p}`),
		"",
		"PEOPLE MENTIONED (count):",
		countMap(summaries.flatMap((s) => s.people))
			.slice(0, 40)
			.map(([n, c]) => `${n} ${c}`)
			.join(", "),
		"ORGANISATIONS MENTIONED (count):",
		countMap(summaries.flatMap((s) => s.orgs))
			.slice(0, 40)
			.map(([n, c]) => `${n} ${c}`)
			.join(", "),
	];
	let parsed: Json | null = null;
	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		try {
			parsed = parseJson(
				await input.run(PROFILE_PROMPT + sections.join("\n")),
				"{",
			);
		} catch {
			parsed = null;
		}
	}
	return toProfile(parsed);
}

// ---------------------------------------------------------------------------
// 5. Document and proposals
// ---------------------------------------------------------------------------

export type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered?: boolean; items: string[] };

export interface ActionLink {
	title: string;
	why: string;
	/** Where to act: an inbox proposal, an existing item, or nothing yet. */
	link: string | null;
	state: "proposed" | "asked" | "on-board" | "not-filed";
	note?: string;
}

const resume = (f: SessionFacts) =>
	f.harness === "codex"
		? `codex resume ${f.sessionId}`
		: `claude --resume ${f.sessionId}`;

function sessionRef(f: SessionFacts): string {
	const commit = f.commits.find((c) => c.sha);
	return `${f.harness === "codex" ? "Codex" : "Claude Code"} session ${f.sessionId.slice(0, 8)} on ${day(f.to)}${f.repository ? ` in ${f.repository}` : ""} (resume: ${resume(f)})${commit && f.repoUrl ? `; last commit ${f.repoUrl}/commit/${commit.sha}` : ""}`;
}

export function renderDocument(input: {
	who: string;
	sessions: SessionFacts[];
	files: number;
	summaries: Map<string, SessionSummary>;
	workstreams: Workstream[];
	profile: PersonProfile;
	actions: ActionLink[];
	model: string;
	meter: Meter;
	seconds: number;
	today: string;
}): Block[] {
	const { profile, workstreams, summaries } = input;
	const stats = usageStats(input.sessions);
	const t = (text: string, limit = 1900) => publicText(text, limit);
	const blocks: Block[] = [];
	const h = (level: number, text: string) =>
		blocks.push({ type: "heading", level, text: t(text, 300) });
	const p = (text: string) =>
		text.trim() && blocks.push({ type: "paragraph", text: t(text, 4000) });
	const list = (items: string[], ordered = false) => {
		const clean = items.map((i) => t(i)).filter(Boolean);
		if (clean.length)
			blocks.push({ type: "list", ordered, items: clean.slice(0, 60) });
	};
	h(1, DOC_TITLE);
	p(
		`Built for ${input.who} on ${input.today} from ${stats.sessions} agent sessions on this machine (${stats.byHarness.map(([k, v]) => `${v} ${k}`).join(", ")}; ${stats.subagents} sub-agent runs folded in), ${day(stats.from)} to ${day(stats.to)}: ${stats.asks} things you typed, ${stats.toolCalls} tool calls, ${stats.commits} commits, ${stats.workItems} Tedix Work Items touched. Your transcripts stayed on this machine; only this summary was uploaded. Run tedix learn profile again to refresh it.`,
	);
	if (profile.role) p(profile.role);
	if (profile.focus.length)
		p(`Right now you focus on: ${profile.focus.join("; ")}.`);

	h(2, "3 things I can do for you right now");
	list(
		input.actions.map((a) => {
			const where =
				a.state === "proposed" || a.state === "asked"
					? `Accept it in your inbox: ${a.link}`
					: a.state === "on-board"
						? `Already on the board: ${a.link}`
						: (a.note ?? "Ask me in chat to start it.");
			return `${a.title}. ${a.why} ${where}`;
		}),
		true,
	);

	const open = workstreams.filter((w) => w.status !== "done");
	// The latest work, and the biggest bodies of work however old they are.
	const recent = [...open].sort((a, b) => (a.to < b.to ? 1 : -1)).slice(0, 9);
	const biggest = [...open]
		.sort((a, b) => b.sessions.length - a.sessions.length)
		.filter((w) => !recent.includes(w))
		.slice(0, 6);
	const active = [...recent, ...biggest].sort((a, b) => (a.to < b.to ? 1 : -1));
	h(2, "Your active projects");
	for (const w of active) {
		h(3, w.name);
		p(w.state || w.description);
		const facts = [
			`${w.status === "paused" ? "Paused" : "Active"}; last worked on ${day(w.to)}; ${w.sessions.length} session${w.sessions.length === 1 ? "" : "s"} since ${day(w.from)}${[...new Set(w.sessions.map((f) => f.repository).filter(Boolean))].length ? ` in ${[...new Set(w.sessions.map((f) => f.repository).filter(Boolean))].slice(0, 3).join(", ")}` : ""}.`,
		];
		if (w.project)
			facts.push(
				`Tedix project ${w.project.key} (${w.project.name}): ${OS_URL}/work/projects/${w.project.id}`,
			);
		for (const item of w.items.slice(0, 4))
			facts.push(
				`Work: ${item.title} (${item.disposition}): ${OS_URL}/work/items/${item.id}`,
			);
		if (w.next) facts.push(`Next: ${w.next}`);
		list(facts);
	}
	const rest = workstreams.filter((w) => !active.includes(w));
	if (rest.length) {
		h(3, "Other bodies of work");
		list(
			rest
				.slice(0, 30)
				.map(
					(w) =>
						`${w.name}: ${w.status}, ${w.sessions.length} session${w.sessions.length === 1 ? "" : "s"}, ${day(w.from)} to ${day(w.to)}.${w.next ? ` Next: ${w.next}` : ""}`,
				),
		);
	}

	h(2, "Open loops you left unfinished");
	// Two per workstream at most, taken in turn, so one busy day does not crowd out the rest.
	const queues = open.map((w) =>
		w.openLoops.slice(0, 2).map((loop) => {
			const source =
				w.sessions.find((f) =>
					summaries
						.get(f.key)
						?.openLoops.some((l) =>
							words(l).some((x) => words(loop).includes(x)),
						),
				) ?? w.sessions[0];
			return `${loop} [${w.name}]${source ? ` From ${sessionRef(source)}.` : ""}`;
		}),
	);
	const loops: string[] = [];
	for (let round = 0; round < 2; round++)
		for (const queue of queues) if (queue[round]) loops.push(queue[round]!);
	list(loops.slice(0, 30));
	if (!loops.length) p("None found.");

	h(2, "Workflows Tedix could take over");
	list(
		profile.workflows.map(
			(w) =>
				`${w.name} (${w.kind === "factory" ? "a scheduled factory" : "a skill"}): ${w.proposal} Seen: ${w.evidence}`,
		),
	);

	h(2, "People and customers you work with");
	list(profile.people.map((x) => `${x.name}: ${x.context}`));
	list(profile.orgs.map((x) => `${x.name}: ${x.context}`));

	h(2, "How you like to work");
	list(profile.style);
	const busy = stats.hours
		.map((n, hour) => [hour, n] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([hour]) => `${hour}:00`)
		.sort();
	p(
		`You ran ${stats.byKind.map(([k, v]) => `${v} ${k}`).join(", ")} sessions, delegated to ${stats.subagents} sub-agents, and typed most around ${busy.join(", ")} (this machine's time).`,
	);

	h(2, "Tools you rely on");
	list(profile.tools);
	if (stats.skills) p(`Skills used most: ${stats.skills}.`);
	if (stats.mcp) p(`Tedix and MCP calls used most: ${stats.mcp}.`);
	if (stats.friction.length) {
		h(3, "Where your tools keep failing");
		list(stats.friction.slice(0, 6));
	}

	h(2, "Where this came from");
	p(
		`${input.files} transcript files read in full (sub-agents and supervisor runs included). ${input.sessions.length} sessions summarised by your local model (${input.model}): ${input.meter.calls} model calls, ${input.meter.cached} sessions reused from the last run, about $${input.meter.costUsd.toFixed(2)}, ${Math.round(input.seconds / 60)} minutes in all. Nothing here is shared with your team until you accept a proposal; this document lives in your own space.`,
	);
	return blocks.slice(0, 480);
}

/** Markdown of the same blocks, kept on the machine as a preview. */
export function markdown(blocks: Block[]): string {
	return blocks
		.map((b) =>
			b.type === "heading"
				? `${"#".repeat(b.level)} ${b.text}`
				: b.type === "paragraph"
					? b.text
					: b.items
							.map((item, i) => `${b.ordered ? `${i + 1}.` : "-"} ${item}`)
							.join("\n"),
		)
		.join("\n\n");
}

/** Code Mode program: find or make the member's space and write the document. */
export function publishDocSource(input: {
	workspaceId?: string;
	outputId?: string;
	spaceName: string;
	blocks: Block[];
}): string {
	return `async () => {
	const input = ${asciiJson(input)};
	const me = await user.get_mine({});
	if (!me || !me.id) return { ok: false, error: "could not read who you are" };
	const marker = ${JSON.stringify(SPACE_MARKER)} + " for " + me.id;
	let workspaceId = input.workspaceId;
	if (workspaceId) {
		const w = await os.get_os_workspace({ workspaceId });
		if (!w || w.ok === false || !(w.workspace || w).id) workspaceId = undefined;
	}
	if (!workspaceId) {
		const list = await os.list_os_workspaces({ status: "active", limit: 200 });
		const found = (list.items || []).find((w) => String(w.description || "").includes(marker));
		if (found) workspaceId = found.id;
	}
	if (!workspaceId) {
		const made = await os.create_os_workspace({ name: input.spaceName, description: "Your own space: what Tedix learned from your agent sessions. (" + marker + ")" });
		workspaceId = made && (made.workspace || made).id;
		if (!workspaceId) return { ok: false, error: "creating your space failed: " + JSON.stringify(made).slice(0, 300) };
	}
	const content = { kind: "document", blocks: input.blocks };
	let outputId = input.outputId;
	if (outputId) {
		const current = await os.get_os_output({ outputId });
		const output = current && (current.output || current);
		if (!output || current.ok === false || !output.id || output.workspaceId && output.workspaceId !== workspaceId) outputId = undefined;
	}
	if (outputId) {
		const r = await os.revise_os_output({ outputId, content });
		if (r && r.ok === false) return { ok: false, error: "updating the document failed: " + String(r.error).slice(0, 300) };
		return { workspaceId, outputId, revised: true };
	}
	const made = await os.create_os_output({ kind: "document", title: ${JSON.stringify(DOC_TITLE)}, workspaceId, content });
	outputId = made && (made.output || made).id;
	if (!outputId) return { ok: false, error: "creating the document failed: " + JSON.stringify(made).slice(0, 300) };
	return { workspaceId, outputId, revised: false };
}`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface ProfileDeps extends ContextDeps {
	transcripts?: TranscriptFile[];
	model?: { name: string; run: RunModel } | null;
	notes?: string[];
	now?: () => Date;
}

function profileOptions(args: string[]) {
	const options = {
		dryRun: false,
		noUpload: false,
		json: false,
		since: "",
		space: "",
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const value = () => {
			const v = args[++i];
			if (!v || v.startsWith("--")) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--no-upload") options.noUpload = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--since") options.since = new Date(value()).toISOString();
		else if (arg === "--space") options.space = value();
		else if (arg === "--no-model")
			throw new Error(
				"learn profile needs your local model; use --dry-run to count without it",
			);
		else throw new Error(`Unknown option ${arg}`);
	}
	return options;
}

export async function runProfile(
	args: string[],
	deps: ProfileDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = profileOptions(args);
	const started = Date.now();
	const now = deps.now?.() ?? new Date();
	const today = now.toISOString().slice(0, 10);
	const home = deps.home ?? homedir();
	const stateDir = join(deps.stateDir ?? stateDirectory(), "profile");
	const statePath = join(stateDir, "state.json");
	const state = readProfileState(statePath);
	const save = () => {
		if (!options.dryRun) writeProfileState(statePath, state);
	};
	const files = deps.transcripts ?? transcriptFiles(home);
	write(
		`Reading ${files.length} transcript files (${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1e6)} MB) on this machine...`,
	);
	const all = await readAllFacts(files, state, home);
	save();
	const sessions = all.filter(
		(f) => !trivial(f) && (!options.since || f.to >= options.since),
	);
	const kinds = countMap(sessions.map((f) => `${f.harness} ${f.kind}`));
	write(
		`  ${sessions.length} sessions worth reading (${kinds.map(([k, v]) => `${v} ${k}`).join(", ")}); ${all.length - sessions.length} trivial or older skipped; ${sessions.reduce((n, f) => n + f.subagents, 0)} sub-agent runs folded in.`,
	);
	if (!sessions.length) {
		write("  No sessions to learn from on this machine; nothing written.");
		return 0;
	}
	if (options.dryRun) {
		const stats = usageStats(sessions);
		const pending = sessions.filter(
			(f) => state.summaries[f.key]?.hash !== sha(sessionDigest(f, 0)),
		).length;
		const report = {
			files: files.length,
			sessions: sessions.length,
			kinds: Object.fromEntries(kinds),
			pendingSummaries: pending,
			modelCalls: Math.ceil(pending / SUMMARY_BATCH) + 3,
			commits: stats.commits,
			workItems: stats.workItems,
			from: stats.from,
			to: stats.to,
		};
		write(
			options.json
				? JSON.stringify(report)
				: `  ${pending} need a summary (about ${report.modelCalls} model calls); ${stats.commits} commits and ${stats.workItems} Work Items seen. Dry run: nothing sent.`,
		);
		return 0;
	}
	const meter = newMeter();
	const model =
		deps.model !== undefined
			? deps.model
			: deps.runModel
				? { name: "local model", run: deps.runModel }
				: profileModel(meter);
	if (!model) {
		write(
			"learn profile needs your local claude or codex CLI to summarise sessions; neither is installed.",
		);
		return 2;
	}
	const rollups = cachedModel(
		model.run,
		join(stateDir, "model-cache.json"),
		true,
	);
	write(`  Summarising with ${model.name}...`);
	const summaries = await summarise(
		sessions,
		state,
		model.run,
		meter,
		save,
		write,
	);
	write(
		`  ${summaries.size} sessions summarised (${meter.cached} reused). Grouping into workstreams...`,
	);
	const workstreams = await groupWorkstreams(
		sessions.filter((f) => summaries.has(f.key)),
		summaries,
		rollups.run,
	);
	workstreams.sort((a, b) => (a.to < b.to ? 1 : -1));
	rollups.save();
	const target: OrganizationTarget | undefined =
		"defaultTarget" in deps ? deps.defaultTarget : defaultOrganizationTarget();
	const upload = !options.noUpload && Boolean(target);
	const call = target ? caller(deps.read ?? cliRead, target) : null;
	let me: { id: string; name: string } | null = null;
	if (call) {
		write(
			`  ${workstreams.length} workstreams. Linking them to the board (read-only)...`,
		);
		const earliest =
			sessions
				.map((f) => f.from)
				.filter(Boolean)
				.sort()[0] ?? today;
		me = (
			await linkBoard(
				workstreams,
				call,
				new Date(Date.parse(earliest) - 30 * 86_400_000).toISOString(),
				write,
			)
		).me;
	}
	await describeWorkstreams(workstreams, summaries, rollups.run, today);
	rollups.save();
	write("  Writing your profile...");
	const notes = deps.notes ?? memoryNotes(home).map((n) => n.text);
	const profile = await buildProfile({
		sessions,
		summaries,
		workstreams,
		notes,
		run: rollups.run,
	});
	rollups.save();
	const names = new Set(
		[
			...profile.people.map((x) => x.name),
			...[...summaries.values()].flatMap((s) => s.people),
		]
			.flatMap((n) => n.split(/\s+/))
			.map((n) => n.toLowerCase())
			.filter((n) => n.length > 1),
	);
	const actions: ActionLink[] = [];
	const proposalsMade: Json = {};
	if (call && upload && me) {
		let asked: AskedProposal[] = [];
		try {
			const r = await call(listProposalsSource(false));
			asked = Array.isArray(r.rows) ? r.rows : [];
		} catch (error) {
			write(
				`  reading your inbox failed: ${(error as Error).message.slice(0, 160)}`,
			);
		}
		const candidates: Candidate[] = profile.actions.map((a) => ({
			key: `profile:${sha(a.title.toLowerCase())}`,
			kind: "task",
			title: withoutNames(a.title, names),
			confidence: 0.8,
			sessions: [],
			from: today,
			to: today,
			goal: false,
			context: withoutNames(a.why, names),
		}));
		let board: Awaited<ReturnType<typeof matchBoard>> = {
			me,
			scanned: {},
			matches: {},
		};
		try {
			if (candidates.length)
				board = await matchBoard(candidates, `${today}T00:00:00.000Z`, call);
		} catch {
			/* Proposing without the check would risk a duplicate; skip below. */
		}
		const publish: Array<{ key: string; request: Json }> = [];
		profile.actions.forEach((a, i) => {
			const c = candidates[i]!;
			const ws =
				workstreams.find(
					(w) => w.name.toLowerCase() === a.workstream.toLowerCase(),
				) ??
				workstreams.find((w) =>
					words(w.name).some((x) => words(a.workstream).includes(x)),
				);
			const covering = board.matches[c.key]?.w.find(
				(m) =>
					m[5] >= THRESHOLDS.same &&
					(m[3] === "proposed" || m[3] === "accepted"),
			);
			if (covering) {
				actions.push({
					title: a.title,
					why: a.why,
					link: `${OS_URL}/work/items/${covering[0]}`,
					state: "on-board",
				});
				return;
			}
			const prior = askedFor(c, asked);
			if (prior) {
				actions.push({
					title: a.title,
					why: a.why,
					link: `${OS_URL}/work/interactions/${prior.id}`,
					state: "asked",
				});
				return;
			}
			if (!board.matches[c.key]) {
				actions.push({
					title: a.title,
					why: a.why,
					link: null,
					state: "not-filed",
					note: "The board could not be checked, so nothing was filed; ask me in chat to start it.",
				});
				return;
			}
			const proposal: Proposal = {
				key: c.key,
				kind: "task",
				title: publicText(c.title, 300),
				confidence: 0.8,
				sessions: ws?.sessions.length ?? 0,
				from: day(ws?.from ?? today),
				to: day(ws?.to ?? today),
				action: "create",
				...(ws?.project
					? { projectId: ws.project.id, projectKey: ws.project.key }
					: {}),
				reason: publicText(c.context ?? "", 600).replace(/[.\s]+$/, ""),
				citations: (ws?.sessions ?? []).slice(0, 4).map((f) => ({
					harness: f.harness,
					session: f.sessionId,
					title: f.title ? publicText(withoutNames(f.title, names), 140) : null,
					at: day(f.to),
				})),
			};
			publish.push({
				key: c.key,
				request: proposalRequest(proposal, me!.name || "you", me!.id),
			});
			actions.push({
				title: a.title,
				why: a.why,
				link: null,
				state: "proposed",
			});
		});
		if (publish.length) {
			try {
				Object.assign(proposalsMade, await call(publishSource(publish)));
			} catch (error) {
				write(
					`  filing proposals failed: ${(error as Error).message.slice(0, 160)}`,
				);
			}
			for (const a of actions) {
				if (a.state !== "proposed") continue;
				const key = `profile:${sha(a.title.toLowerCase())}`;
				const made = proposalsMade[key];
				if (made?.id) a.link = `${OS_URL}/work/interactions/${made.id}`;
				else {
					a.state = "not-filed";
					a.note = `Not filed (${made?.skipped ?? made?.error ?? "no answer"}); ask me in chat to start it.`;
				}
			}
		}
	} else
		for (const a of profile.actions)
			actions.push({
				title: a.title,
				why: a.why,
				link: null,
				state: "not-filed",
				note: "Not filed (no upload); ask me in chat to start it.",
			});
	const blocks = renderDocument({
		who: me?.name || "you",
		sessions,
		files: files.length,
		summaries,
		workstreams,
		profile,
		actions,
		model: model.name,
		meter,
		seconds: (Date.now() - started) / 1000,
		today,
	});
	const preview = join(stateDir, "what-tedix-knows.md");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	writeFileSync(preview, `${markdown(blocks)}\n`, { mode: 0o600 });
	const report: Json = {
		files: files.length,
		sessions: sessions.length,
		workstreams: workstreams.length,
		active: workstreams.filter((w) => w.status !== "done").length,
		openLoops: workstreams.reduce(
			(n, w) => n + (w.status === "done" ? 0 : w.openLoops.length),
			0,
		),
		workflows: profile.workflows.length,
		people: profile.people.length,
		proposals: actions.filter((a) => a.state === "proposed").length,
		actions: actions.map((a) => ({
			title: a.title,
			state: a.state,
			link: a.link,
		})),
		model: model.name,
		modelCalls: meter.calls,
		failedCalls: meter.failed,
		reused: meter.cached,
		costUsd: Math.round(meter.costUsd * 100) / 100,
		seconds: Math.round((Date.now() - started) / 1000),
		preview,
	};
	if (call && upload) {
		try {
			const result = await call(
				publishDocSource({
					workspaceId: options.space || state.space?.workspaceId,
					outputId:
						options.space && options.space !== state.space?.workspaceId
							? undefined
							: state.space?.outputId,
					spaceName: `${(me?.name || "My").split(/\s+/)[0]} (personal)`,
					blocks,
				}),
			);
			state.space = {
				organization: target!.organization ?? target!.org,
				workspaceId: result.workspaceId,
				outputId: result.outputId,
			};
			save();
			report.document = `${OS_URL}/outputs/${result.outputId}`;
			report.workspaceId = result.workspaceId;
		} catch (error) {
			report.documentError = (error as Error).message.slice(0, 300);
		}
	}
	report.seconds = Math.round((Date.now() - started) / 1000);
	if (options.json) write(JSON.stringify(report));
	else {
		write(
			`  ${report.workstreams} workstreams (${report.active} active), ${report.openLoops} open loops, ${report.workflows} workflows, ${report.proposals} new proposals; ${report.modelCalls} model calls, $${report.costUsd}, ${report.seconds}s.`,
		);
		write(
			report.document
				? `What Tedix knows about you: ${report.document}`
				: `Not uploaded${report.documentError ? ` (${report.documentError})` : ""}; local preview: ${preview}`,
		);
	}
	return report.documentError ? 1 : 0;
}
