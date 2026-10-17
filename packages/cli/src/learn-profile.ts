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
 * 5. Upload: the document (to the member's private workspace: it may name
 *    people and customers, so only they can see it) and the three
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
	type ProjectInfo,
	type Proposal,
	projectCatalog,
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
	withdrawSource,
} from "./learn-proposals";
import type { ProposalStart } from "@tedix/api-contract/schemas/work-interactions";

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
	workstreams?: Record<string, WorkstreamIdentity>;
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

const workstreamOrder = (a: Workstream, b: Workstream) =>
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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

// ---------------------------------------------------------------------------
// 3b. What to do now, and the week in one paragraph
// ---------------------------------------------------------------------------

const DEADLINE =
	/\b(?:deadline|due|overdue|by (?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|end of|\d)|before (?:the )?(?:talk|demo|launch|meeting|\d)|today|tomorrow|this week|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b/i;
const REVENUE =
	/\b(?:billing|pricing|price|revenue|paid|payments?|invoices?|wallet|sales|deal|contract|pilot|procurement|subscription|credits?|customers?|leads?|onboarding)\b/i;
const BLOCKING =
	/\b(?:blocked|blocks|blocking|waiting|awaits|awaiting|stuck|outage|down for|everyone|all users|needs (?:his|her|their) (?:approval|reply)|pending (?:reply|approval))\b/i;

/** How a profile describes an organisation the person works for or with. */
const CUSTOMER =
	/\b(?:customer|client|pilot|tenant|prospect|partner|buyer|investor|accelerator)\b/i;

/** Work that only tidies up: it belongs in open loops, never in the top three. */
export const HOUSEKEEPING =
	/^(?:verify|confirm|check|commit|push|run|re-?run|rebase|restart|update|clean|remove|delete|cancel|close|complete (?:the )?work|file (?:a )?work|settle|review (?:and|then) (?:commit|push|decide)|review the .*(?:patch|diff|changes)|re-?test|re-?verify|test|monitor|investigate why)\b/i;

export interface Priority {
	workstream: Workstream;
	score: number;
	signals: string[];
	customers: string[];
	daysAgo: number;
}

/**
 * Rank open workstreams by importance and recency: a customer, a deadline,
 * revenue or someone blocked raises the stakes; weight is days worked and
 * outcomes; recency decays over about a week.
 */
export function priorities(
	workstreams: Workstream[],
	summaries: Map<string, SessionSummary>,
	today: string,
	/** Organisations the profile names as customers, clients or partners. */
	known?: string[],
): Priority[] {
	const open = workstreams.filter((w) => w.status !== "done");
	// The organisation most workstreams mention is the person's own, not a customer.
	const mentions = countMap(
		workstreams.flatMap((w) => [
			...new Set(w.sessions.flatMap((f) => summaries.get(f.key)?.orgs ?? [])),
		]),
	);
	const ownOrgs = new Set(
		mentions
			.filter(([, n]) => n / (workstreams.length || 1) >= 0.4)
			.map(([o]) => o.toLowerCase()),
	);
	const maxWeight = Math.max(1, ...open.map((w) => w.weight));
	return open
		.map((w) => {
			const text = [
				w.state,
				w.next,
				...w.openLoops,
				...w.sessions
					.slice(0, 10)
					.flatMap((f) => summaries.get(f.key)?.openLoops ?? []),
			].join(" ");
			const customers = countMap(
				w.sessions.flatMap((f) => summaries.get(f.key)?.orgs ?? []),
			)
				.map(([o]) => o)
				.filter(
					(o) =>
						!ownOrgs.has(o.toLowerCase()) &&
						(!known || known.some((k) => k.toLowerCase() === o.toLowerCase())),
				)
				.slice(0, 3);
			const signals = [
				...(customers.length ? [`customer: ${customers.join(", ")}`] : []),
				...(DEADLINE.test(text) ? ["deadline"] : []),
				...(REVENUE.test(text) ? ["revenue"] : []),
				...(BLOCKING.test(text) ? ["blocking others"] : []),
			];
			const daysAgo = Math.max(
				0,
				Math.round((Date.parse(today) - Date.parse(day(w.to))) / 86_400_000),
			);
			const score =
				(0.5 + w.weight / maxWeight) *
				(1 + 0.5 * signals.length) *
				(1 / (1 + daysAgo / 7));
			return { workstream: w, score, signals, customers, daysAgo };
		})
		.sort((a, b) => b.score - a.score);
}

export const PLAN_PROMPT = `You are an assistant that has just read one person's whole agent history and now meets them for the first time. Below: the goals they set their agents, notes their agents keep, and their open workstreams ranked by stakes (customer, deadline, revenue, blocking others) and recency, with where each stands.
Only state names, numbers and versions that appear in the input below.
Return ONLY one JSON object, no prose:
{"week":"<3-4 plain sentences addressed to them as you, starting \"This week you\": the two or three biggest things they built or moved and for whom (customers, users, their team), then the one or two stuck things that matter most. A story, not a list of every fix; concrete product and customer names; no buzzwords, no praise>","actions":[{"title":"<starts with a verb, at most 12 words>","why":"<one sentence: which goal or stake it serves, citing the evidence>","workstream":"<workstream name>","kind":"delegate|factory|doc","start":"<what Tedix does first, at most 20 words>","tedi":"<for delegate: the slug of the best-fit tedi from the list, else empty>"}]}
Give 5 actions, best first. Each is one concrete, valuable step Tedix can start today on its own: "delegate" hands a piece of real work to an AI teammate (a tedi), "factory" sets up a recurring scheduled run that produces something, "doc" drafts a document they need (a plan, a proposal, a customer brief). Call an organisation a customer only when the ranked list marks it "customer". Pick from their stated goals and the highest-stakes open work: moving a customer, a deadline, revenue or unblocking others beats internal polish. Never housekeeping: no verifying, confirming, committing, pushing, re-running tests or tidying the board. Never invent facts.

`;

const WEEK_VERSION =
	/(?<![\w.-])v?\d+\.\d+(?:\.\d+)*(?:-\w+(?:[.-]\w+)*)?(?:\+\w+(?:[.-]\w+)*)?(?![\w]|[.-]\w)/g;
const WEEK_NUMBER = /(?<![\w])\d+(?:[.,]\d+)*(?:%)?(?![\w])/g;
const WEEK_DATE =
	/\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|(?:19|20)\d{2})\b/g;
const WEEK_GENERIC = new Set(
	(
		"Tedix This That These Those You Your I We The A An It Its They Their There " +
		"But And Or With Without For From In On At By To As After Before Now Next Then " +
		"Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
		"January February March April May June July August September October November December"
	)
		.toLowerCase()
		.split(/\s+/),
);

export function weekCorpus(
	sessions: SessionFacts[],
	summaries: Map<string, SessionSummary>,
	workstreams: Workstream[],
	board: Pick<Board, "items">,
): string {
	return [
		...sessions.map((f) => JSON.stringify(f)),
		...[...summaries.values()].map((s) => JSON.stringify(s)),
		...[...board.items.values()].map((item) => item.title),
		...workstreams.map((w) =>
			[w.name, w.description, w.state, w.next, ...w.openLoops].join("\n"),
		),
	].join("\n");
}

export function groundWeek(
	text: string,
	corpus: string,
	counts: number[] = [],
): string {
	const present = (token: string, insensitive = false) =>
		new RegExp(
			`(?<![\\p{L}\\p{N}_])${escape(token)}(?![\\p{L}\\p{N}_])`,
			insensitive ? "iu" : "u",
		).test(corpus);
	const versions = new Set(
		[...corpus.matchAll(WEEK_VERSION)].map(([token]) => token),
	);
	const numbers = new Set(
		[...corpus.replace(WEEK_VERSION, " ").matchAll(WEEK_NUMBER)].map(
			([token]) => token,
		),
	);
	const unsupportedNumber = (fragment: string) => {
		let unsupported = false;
		const rest = fragment
			.replace(WEEK_VERSION, (token) => {
				if (!versions.has(token)) unsupported = true;
				return " ";
			})
			.replace(WEEK_DATE, " ");
		for (const [token] of rest.matchAll(WEEK_NUMBER))
			if (
				!numbers.has(token) &&
				!counts.some((count) => String(count) === token)
			)
				unsupported = true;
		return unsupported;
	};
	return text
		.split(/(?<=[.!?])\s+(?=[\p{Lu}"“])/u)
		.flatMap((original) => {
			const sentence = original
				.replace(/\([^()]*\)/g, (fragment) =>
					unsupportedNumber(fragment) ? "" : fragment,
				)
				.replace(
					/,\s*v\d+\.\d+(?:\.\d+)*(?:-\w+(?:[.-]\w+)*)?(?:\+\w+(?:[.-]\w+)*)?,?/g,
					(fragment) => (unsupportedNumber(fragment) ? "" : fragment),
				)
				.replace(/\s+([,.;!?])/g, "$1")
				.replace(/ {2,}/g, " ")
				.trim();
			if (unsupportedNumber(sentence)) return [];
			const tokens = [
				...sentence.matchAll(/[\p{L}][\p{L}\p{N}]*(?:[-'][\p{L}\p{N}]+)*/gu),
			];
			for (const [index, match] of tokens.entries()) {
				const token = match[0];
				if (
					index === 0 ||
					!/\p{Lu}/u.test(token) ||
					WEEK_GENERIC.has(token.toLowerCase())
				)
					continue;
				if (!present(token, true)) return [];
			}
			return sentence ? [sentence] : [];
		})
		.join(" ");
}

export interface Plan {
	week: string;
	actions: PersonProfile["actions"];
}

export async function planNow(input: {
	ranked: Priority[];
	/** Titles of earlier profile proposals still open in the inbox. */
	pending?: string[];
	/** The organization's tedis a delegated action can name. */
	team?: Array<{ slug: string; name: string }>;
	/** True for an action the member already answered in their inbox. */
	answered?: (title: string) => boolean;
	goals: string[];
	notes: string[];
	run: RunModel;
	today: string;
}): Promise<Plan> {
	const sections = [
		`TODAY: ${input.today}`,
		"GOALS THEY SET THEIR AGENTS (newest first):",
		...input.goals.slice(0, 25).map((g) => `- ${g.slice(0, 240)}`),
		"",
		"NOTES THEIR AGENTS KEEP ABOUT PRIORITIES:",
		...input.notes
			.filter((n) =>
				/\b(?:goal|strateg|priorit|customer|revenue|launch|pilot|deadline|investor|pitch|sales|lead)/i.test(
					n,
				),
			)
			.slice(0, 40)
			.map((n) => `- ${n.slice(0, 220)}`),
		"",
		...(input.pending?.length
			? [
					"ALREADY IN THEIR INBOX FROM AN EARLIER RUN (keep one, with its exact title, while it is still among the best; drop it when newer work matters more):",
					...input.pending.slice(0, 6).map((t) => `- ${t.slice(0, 200)}`),
					"",
				]
			: []),
		...(input.team?.length
			? [
					"TEDIS (AI TEAMMATES) WHO CAN TAKE DELEGATED WORK, slug: name:",
					...input.team.slice(0, 30).map((t) => `- ${t.slug}: ${t.name}`),
					"",
				]
			: []),
		"OPEN WORKSTREAMS, HIGHEST STAKES FIRST:",
		...input.ranked.slice(0, 8).map(({ workstream: w, signals, daysAgo }) =>
			[
				`- ${w.name} (${w.days} days worked, ${w.shipped} sessions shipped, last ${daysAgo === 0 ? "today" : `${daysAgo} days ago`}${signals.length ? `; ${signals.join("; ")}` : ""}${w.project ? `; project ${w.project.key}` : ""}): ${w.state || w.description}`,
				...w.parts
					.slice(0, 4)
					.filter((p) => p.line)
					.map((p) => `  - ${p.name}: ${p.line}`),
				...(w.next ? [`  Next: ${w.next}`] : []),
				...(w.openLoops.length ? [`  Open: ${w.openLoops.join("; ")}`] : []),
			].join("\n"),
		),
	];
	let parsed: Json | null = null;
	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		try {
			parsed = parseJson(
				await input.run(PLAN_PROMPT + sections.join("\n")),
				"{",
			);
		} catch {
			parsed = null;
		}
	}
	const proposed: PersonProfile["actions"] = Array.isArray(parsed?.actions)
		? parsed.actions
				.filter((a: Json) => a && typeof a.title === "string")
				.map((a: Json) => ({
					title: one(a.title, 140),
					why: one(String(a.why ?? ""), 300),
					workstream: one(String(a.workstream ?? ""), 60),
					kind: ["delegate", "factory", "doc"].includes(a.kind)
						? a.kind
						: "delegate",
					start: one(String(a.start ?? ""), 200),
					...(a.kind === "delegate" &&
					input.team?.some((t) => t.slug === a.tedi)
						? { tedi: String(a.tedi) }
						: {}),
				}))
		: [];
	// Strategic only; different workstreams first, so the three cover different work.
	const strategic = proposed.filter(
		(a) => a.title && !HOUSEKEEPING.test(a.title) && !input.answered?.(a.title),
	);
	const actions: PersonProfile["actions"] = [];
	for (const a of strategic)
		if (
			actions.length < 3 &&
			!actions.some(
				(b) => b.workstream.toLowerCase() === a.workstream.toLowerCase(),
			)
		)
			actions.push(a);
	for (const a of strategic)
		if (actions.length < 3 && !actions.includes(a)) actions.push(a);
	// Too few strategic actions: a plan for the highest-stakes workstreams.
	for (const { workstream: w, signals } of input.ranked) {
		if (actions.length >= 3) break;
		if (
			actions.some((a) => a.workstream.toLowerCase() === w.name.toLowerCase())
		)
			continue;
		actions.push({
			title: `Draft a one-page plan to move ${w.name} forward`,
			why: `${w.name} was worked on ${w.days} days${signals.length ? ` (${signals.join("; ")})` : ""} and still has open work.`,
			workstream: w.name,
			kind: "doc",
			start:
				"Collect its open loops and Work Items into a short plan with owners and dates.",
		});
	}
	return { week: one(String(parsed?.week ?? ""), 1200), actions };
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
	/** "Your week in Tedix": what they built, for whom, and what is stuck. */
	week: string;
	actions: Array<{
		title: string;
		why: string;
		workstream: string;
		kind: "delegate" | "factory" | "doc";
		/** What Tedix does first. */
		start: string;
		/** For delegate: the slug of the tedi it names. */
		tedi?: string;
	}>;
}

export const PROFILE_PROMPT = `You are writing down what an assistant has learned about one person from their own coding-agent history, so it can start helping them at once. Below: their workstreams with status, usage statistics, requests they repeat, failures they keep hitting, preference notes their agents keep, things they said about how they want work done, and the people and organisations their sessions mention.
Return ONLY one JSON object, no prose:
{"role":"<one sentence: what they do, inferred from the work>","focus":["<current focus areas, at most 6>"],"style":["<how they like to work: concrete preferences and habits, each with its evidence; at most 8>"],"workflows":[{"name":"<a workflow they repeat>","evidence":"<how often and where it shows>","kind":"skill|factory","proposal":"<what Tedix would run for them, at most 20 words>"}],"people":[{"name":"<name>","context":"<how they relate to the work, at most 12 words>"}],"orgs":[{"name":"<company, customer or partner>","context":"<at most 12 words>"}],"tools":["<tools and services they rely on>"]}
At most 6 workflows, only things they actually repeat; a "factory" is a recurring scheduled run, a "skill" a reusable procedure. Never invent facts.

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
		week: "",
		actions: [],
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
		"WORKSTREAMS (most days worked first):",
		...input.workstreams.map(
			(w) =>
				`- ${w.name} [${w.status}] ${w.days} days worked ${day(w.from)}..${day(w.to)}${w.project ? ` project ${w.project.key}` : ""}: ${w.state || w.description}${w.next ? ` Next: ${w.next}` : ""}${w.openLoops.length ? ` Open: ${w.openLoops.join("; ")}` : ""}`,
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
	kind: PersonProfile["actions"][number]["kind"];
	start: string;
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
	if (profile.week) {
		h(2, "Your week in Tedix");
		p(profile.week);
	}
	if (profile.role) p(profile.role);

	h(2, "3 things I can do for you right now");
	const how = {
		delegate: "I hand it to a tedi",
		factory: "I set up a factory",
		doc: "I draft it",
	} as const;
	list(
		input.actions.map((a) => {
			const where =
				a.state === "proposed" || a.state === "asked"
					? `Accept it in your inbox and I start at once: ${a.link}`
					: a.state === "on-board"
						? `Already on the board: ${a.link}`
						: (a.note ?? "Ask me in chat to start it.");
			const first = a.start
				? ` ${how[a.kind]}: ${a.start.replace(/[.\s]+$/, "")}.`
				: "";
			return `${a.title}. ${a.why}${first} ${where}`;
		}),
		true,
	);

	const open = workstreams
		.filter((w) => w.status !== "done")
		.sort(workstreamOrder);
	h(2, "Your active projects");
	for (const w of open) {
		h(3, w.name);
		p(w.state || w.description);
		const repos = [
			...new Set(w.sessions.map((f) => f.repository).filter(Boolean)),
		].slice(0, 3);
		const facts = [
			`${w.status === "paused" ? "Paused" : "Active"}: worked on ${w.days} day${w.days === 1 ? "" : "s"} between ${day(w.from)} and ${day(w.to)}; ${w.shipped} of ${w.sessions.length} sessions shipped something${repos.length ? `; in ${repos.join(", ")}` : ""}.`,
			w.project
				? `Tedix project ${w.project.key} (${w.project.name}): ${OS_URL}/work/projects/${w.project.id}`
				: w.spread
					? `No board link: its Work is spread over ${w.spread} projects, none clearly its own.`
					: "No board link: none of its sessions named a Tedix project or touched Work in one.",
		];
		for (const item of w.items.slice(0, 3))
			facts.push(
				`Work: ${item.title} (${item.disposition}): ${OS_URL}/work/items/${item.id}`,
			);
		if (w.next) facts.push(`Next: ${w.next}`);
		list(facts);
		if (w.parts.length > 1)
			list(
				w.parts
					.slice(0, 6)
					.map(
						(part) =>
							`${part.name} (${weigh(part.sessions, summaries).days} days, last ${day(part.sessions[0]?.to ?? "")})${part.line ? `: ${part.line}` : ""}`,
					),
			);
	}
	const finished = workstreams
		.filter((w) => w.status === "done")
		.sort(workstreamOrder);
	if (finished.length) {
		h(3, "Finished");
		list(
			finished.map(
				(w) =>
					`${w.name}: ${w.days} day${w.days === 1 ? "" : "s"}, ${day(w.from)} to ${day(w.to)}.${w.state ? ` ${w.state}` : ""}`,
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
		`Built for ${input.who} on ${input.today} from ${stats.sessions} agent sessions on this machine (${stats.byHarness.map(([k, v]) => `${v} ${k}`).join(", ")}; ${stats.subagents} sub-agent runs folded in), ${day(stats.from)} to ${day(stats.to)}: ${stats.asks} things you typed, ${stats.toolCalls} tool calls, ${stats.commits} commits, ${stats.workItems} Tedix Work Items touched. Run tedix learn profile again to refresh it.`,
	);
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
	let space;
	if (workspaceId) {
		const w = await os.get_os_workspace({ workspaceId });
		space = w && (w.workspace || w);
		if (!w || w.ok === false || !space.id) workspaceId = undefined;
	}
	if (!workspaceId) {
		const list = await os.list_os_workspaces({ status: "active", limit: 200 });
		space = (list.items || []).find((w) => String(w.description || "").includes(marker));
		if (space) workspaceId = space.id;
	}
	if (!workspaceId) {
		const made = await os.create_os_workspace({ name: input.spaceName, visibility: "private", description: "Your own space: what Tedix learned from your agent sessions. Only you can see it. (" + marker + ")" });
		space = made && (made.workspace || made);
		workspaceId = space && space.id;
		if (!workspaceId) return { ok: false, error: "creating your space failed: " + JSON.stringify(made).slice(0, 300) };
	}
	if (space && space.visibility !== "private") {
		// The document names people and customers: it lives where only you can see it.
		const r = await os.update_os_workspace({ workspaceId, visibility: "private" });
		const updated = r && (r.workspace || r);
		if (!updated || updated.visibility !== "private") return { ok: false, error: "making your space private failed: " + JSON.stringify(r).slice(0, 300) };
		if (String(updated.name || "").endsWith("(personal)")) await os.update_os_workspace({ workspaceId, name: input.spaceName }).catch(() => undefined);
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
	/** Goals set in Codex threads, by thread id. */
	goals?: Map<string, string>;
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
	const read = sessions.filter((f) => summaries.has(f.key));
	const threads = await groupWorkstreams(read, summaries, rollups.run);
	rollups.save();
	const target: OrganizationTarget | undefined =
		"defaultTarget" in deps ? deps.defaultTarget : defaultOrganizationTarget();
	const upload = !options.noUpload && Boolean(target);
	const call = target ? caller(deps.read ?? cliRead, target) : null;
	let board: Board = { me: null, items: new Map(), projects: [] };
	if (call) {
		write(
			`  ${threads.length} threads of work. Reading the board (read-only)...`,
		);
		board = await readBoard(read, call, write);
	}
	const me = board.me;
	const merged = await mergeWorkstreams(
		threads,
		summaries,
		board,
		rollups.run,
		state.workstreams,
	);
	rollups.save();
	write(`  Merged into ${merged.length} workstreams. Describing them...`);
	await describeWorkstreams(merged, summaries, rollups.run, today);
	rollups.save();
	const { workstreams, registry } = stabilizeWorkstreams(
		merged,
		state.workstreams,
	);
	state.workstreams = registry;
	save();
	write("  Writing your profile...");
	const notes = deps.notes ?? memoryNotes(home).map((n) => n.text);
	const profile = await buildProfile({
		sessions,
		summaries,
		workstreams,
		notes,
		run: rollups.run,
	});
	// Your inbox first: an open proposal from an earlier run is kept while it still fits.
	let asked: AskedProposal[] = [];
	let inboxRead = false;
	if (call && upload)
		try {
			const r = await call(listProposalsSource(false));
			if (r.ok === false || !Array.isArray(r.rows))
				throw new Error(r.error ?? "No inbox data");
			asked = r.rows;
			inboxRead = true;
		} catch (error) {
			write(
				`  reading your inbox failed: ${(error as Error).message.slice(0, 160)}`,
			);
		}
	let team: Array<{ slug: string; name: string }> = [];
	if (call && upload)
		try {
			const r = await call(TEAM_SOURCE);
			team = Array.isArray(r.team) ? r.team : [];
		} catch {
			/* Without the roster, a delegated start goes to the default tedi. */
		}
	const goals = deps.goals ?? (await codexGoals(home));
	const names = new Set(
		[
			...profile.people.map((x) => x.name),
			...[...summaries.values()].flatMap((s) => s.people),
		]
			.flatMap((n) => n.split(/\s+/))
			.map((n) => n.toLowerCase())
			.filter((n) => n.length > 1),
	);
	const plan = await planNow({
		team,
		// Answered before (accepted, declined or withdrawn): never offered again.
		answered: (title) => {
			const prior = askedFor(
				{
					key: `profile:${sha(title.toLowerCase())}`,
					title: withoutNames(title, names),
				},
				asked,
			);
			return Boolean(prior && prior.state !== "open");
		},
		pending: asked
			.filter((row) => row.key.startsWith("profile:") && row.state === "open")
			.map((row) => row.title),
		ranked: priorities(
			workstreams,
			summaries,
			today,
			profile.orgs.filter((o) => CUSTOMER.test(o.context)).map((o) => o.name),
		),
		goals: [
			...new Set(
				[...sessions]
					.sort((a, b) => (a.to < b.to ? 1 : -1))
					.map((f) => goals.get(f.sessionId))
					.filter((g): g is string => Boolean(g)),
			),
		],
		notes,
		run: rollups.run,
		today,
	});
	profile.week = groundWeek(
		plan.week,
		weekCorpus(sessions, summaries, workstreams, board),
		[sessions.length, new Set(sessions.map((f) => day(f.to))).size],
	);
	profile.actions = plan.actions;
	rollups.save();
	const actions: ActionLink[] = [];
	const proposalsMade: Json = {};
	const withdrawn: string[] = [];
	if (call && upload && me && inboxRead) {
		const open = asked.filter(
			(row) => row.key.startsWith("profile:") && row.state === "open",
		);
		// Missing from this plan (or the sampled history) is not evidence of
		// resolution. Only a known finished workstream retires its proposals.
		const relevant = open.filter(
			(row) =>
				!workstreams.some(
					(w) => w.key === row.workstreamId && w.status === "done",
				),
		);
		const retained = new Set(relevant.slice(0, 3).map((row) => row.id));
		const superseded = open.filter((row) => !retained.has(row.id));
		if (superseded.length) {
			try {
				const r = await call(withdrawSource(superseded));
				withdrawn.push(
					...superseded.filter((row) => r[row.id]?.ok).map((row) => row.id),
				);
			} catch (error) {
				write(
					`  withdrawing superseded proposals failed: ${(error as Error).message.slice(0, 160)}`,
				);
			}
		}
		const remaining = open.filter((row) => !withdrawn.includes(row.id));
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
		let found: Awaited<ReturnType<typeof matchBoard>> = {
			me,
			scanned: {},
			matches: {},
		};
		try {
			if (candidates.length) found = await matchBoard(candidates, call);
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
			if (ws?.status === "done") return;
			const covering = found.matches[c.key]?.w.find(
				(m) =>
					m[5] >= THRESHOLDS.same &&
					(m[3] === "proposed" || m[3] === "accepted"),
			);
			if (covering) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: `${OS_URL}/work/items/${covering[0]}`,
					state: "on-board",
				});
				return;
			}
			const prior = askedFor(
				c,
				remaining.filter(
					(row) =>
						(!row.workstreamId || row.workstreamId === ws?.key) &&
						(!row.startKind || row.startKind === a.kind),
				),
			);
			if (prior) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: `${OS_URL}/work/interactions/${prior.id}`,
					state: "asked",
				});
				return;
			}
			if (remaining.length + publish.length >= 3) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: null,
					state: "not-filed",
					note: "Three profile proposals are already open in your inbox; answer one to make room.",
				});
				return;
			}
			if (!found.matches[c.key]) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
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
			const brief = publicText(
				withoutNames(a.start || a.title, names),
				600,
			).replace(/[.\s]+$/, "");
			const tedi = team.find((t) => t.slug === a.tedi);
			const plan: ProposalStart | null =
				brief.length < 10
					? null
					: a.kind === "delegate"
						? { kind: "delegate", brief, ...(tedi ? { tedi: tedi.slug } : {}) }
						: a.kind === "factory"
							? {
									kind: "factory",
									brief,
									...(ws ? { name: ws.name.slice(0, 60) } : {}),
								}
							: {
									kind: "doc",
									brief,
									...(state.space?.workspaceId
										? { workspaceId: state.space.workspaceId }
										: {}),
								};
			const request = proposalRequest(
				proposal,
				me!.name || "you",
				me!.id,
				plan ? { plan, ...(tedi ? { tediName: tedi.name } : {}) } : undefined,
			);
			if (ws) request.metadata.profile = { workstreamId: ws.key };
			publish.push({ key: c.key, request });
			actions.push({
				title: a.title,
				why: a.why,
				kind: a.kind,
				start: a.start,
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
				kind: a.kind,
				start: a.start,
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
		withdrawn,
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
					spaceName: `${(me?.name || "My").split(/\s+/)[0]} (private)`,
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
