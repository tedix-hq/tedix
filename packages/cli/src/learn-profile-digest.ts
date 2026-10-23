import { createHash } from "node:crypto";
import { redact } from "./hooks/decision-capture";
import { scrub } from "./learn-import";
import type { SessionFacts } from "./learn-facts";
import type { RunModel } from "./learn-analyze";
import { type Json, type Meter, pool, parseJson } from "./learn-profile-model";
import type { ProfileState } from "./learn-profile-state";

export const sha = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

export const day = (iso: string) => iso.slice(0, 10);

export const one = (text: string, limit: number) =>
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

export const strings = (
	value: unknown,
	limit: number,
	chars: number,
): string[] =>
	Array.isArray(value)
		? value
				.filter((v) => typeof v === "string" && v.trim())
				.slice(0, limit)
				.map((v) => one(v, chars))
		: [];

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

export const top = (record: Record<string, number>, n: number) =>
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

export const SUMMARY_BATCH = 6;

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
		if (Array.isArray(parsed)) {
			const indexCounts = new Map<number, number>();
			for (const raw of parsed)
				if (typeof raw?.n === "number" && Number.isInteger(raw.n))
					indexCounts.set(raw.n, (indexCounts.get(raw.n) ?? 0) + 1);
			for (const raw of parsed) {
				if (
					typeof raw?.n !== "number" ||
					!Number.isInteger(raw.n) ||
					indexCounts.get(raw.n) !== 1
				)
					continue;
				const b = batch[raw.n - 1];
				if (!b) continue;
				const summary = toSummary(raw);
				out.set(b.f.key, summary);
				state.summaries[b.f.key] = { hash: b.hash, summary };
			}
		}
		done += batch.length;
		save();
		log(`    summarised ${done}/${pending.length} new or changed sessions`);
	});
	for (const key of Object.keys(state.summaries))
		if (!sessions.some((f) => f.key === key)) delete state.summaries[key];
	return out;
}

export const escape = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const countMap = (values: string[]) => {
	const counts = new Map<string, number>();
	for (const v of values) {
		const key = v.trim();
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]);
};
