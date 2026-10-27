import type { SessionFacts } from "./learn-facts";
import { type RunModel, repeatedRequests } from "./learn-analyze";
import type { Workstream } from "./learn-profile-workstreams";
import {
	type SessionSummary,
	countMap,
	day,
	one,
	strings,
	top,
} from "./learn-profile-digest";
import { type Json, parseJson } from "./learn-profile-model";

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
export const CUSTOMER =
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
{"actions":[{"title":"<starts with a verb, at most 12 words>","why":"<one sentence: which goal or stake it serves, citing the evidence>","workstream":"<workstream name>","kind":"delegate|factory|doc","start":"<what Tedix does first, at most 20 words>","tedi":"<for delegate: the slug of the best-fit tedi from the list, else empty>"}]}
Give 5 actions, best first. Each is one concrete, valuable step Tedix can start today on its own: "delegate" hands a piece of real work to an AI teammate (a tedi), "factory" sets up a recurring scheduled run that produces something, "doc" drafts a document they need (a plan, a proposal, a customer brief). Call an organisation a customer only when the ranked list marks it "customer". Pick from their stated goals and the highest-stakes open work: moving a customer, a deadline, revenue or unblocking others beats internal polish. Never housekeeping: no verifying, confirming, committing, pushing, re-running tests or tidying the board. Never invent facts.

`;

/** The last seven UTC dates, using only recorded session activity. */
export function weekSummary(
	sessions: SessionFacts[],
	today: string,
): { text: string; sources: string[] } {
	const end = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
	const start = end - 7 * 86_400_000;
	const recent = new Map<string, SessionFacts>();
	for (const f of sessions) {
		const time = Date.parse(f.to);
		if (time >= start && time < end) {
			const old = recent.get(f.key);
			if (!old || f.to > old.to) recent.set(f.key, f);
		}
	}
	if (!recent.size) return { text: "", sources: [] };
	const from = new Date(start).toISOString().slice(0, 10);
	return {
		text: `From ${from} through ${today}, ${recent.size} recorded agent session${recent.size === 1 ? " had its" : "s had their"} latest activity in this period.`,
		sources: [...recent.values()]
			.sort((a, b) => a.key.localeCompare(b.key))
			.map(
				(f) =>
					`${f.harness} session ${f.sessionId} on ${day(f.to)} (resume: ${f.harness === "codex" ? "codex resume" : "claude --resume"} ${f.sessionId})`,
			),
	};
}

export interface Plan {
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
	return { actions };
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
	/** Recorded activity for the last seven UTC dates, with session sources. */
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
