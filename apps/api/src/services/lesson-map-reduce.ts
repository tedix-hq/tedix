/**
 * Map-reduce distillation of a person's whole decision history into lessons.
 *
 * The per-scope distiller (`lesson-distiller.ts`) reads only a few hundred
 * replies, so a rule a person restated across hundreds of sessions could be
 * missed. This reads ALL of one person's decision replies (live decision
 * capture and imported historic sessions), as Workflow steps:
 *
 *   MAP     the replies in chunks of CHUNK_REPLIES, newest first; the
 *           distiller model lists candidate rules per chunk, each with a
 *           subject and the replies that state it (cited, so it is checked).
 *   REDUCE  candidates from every chunk merged by meaning in two model passes
 *           (word overlap when the model is unavailable), the second ordering
 *           rules by importance; a merged rule counts the distinct sessions
 *           behind it and, on conflict, the newer one wins. A rule survives
 *           when two or more sessions state it, or one states it as standing
 *           ("always", "never", ...); a thinly supported rule nobody restated
 *           for FADE_DAYS fades.
 *   WRITE   a standing "how the user works" lesson (cross-subject rules,
 *           delivered first in every session), one standing lesson per
 *           repository (its most supported rules, delivered first there), and
 *           one lesson per subject and scope for the rest: a rule from one
 *           repository stays in that repository; anything else is outside any.
 *
 * INCREMENTAL  a new decision re-distils only what it touches: the person's
 *           current lessons (their rules, as stored) plus the decisions
 *           since the last run, mapped in one call and merged against the
 *           existing rules that share its topic. Seconds, not minutes; the
 *           nightly run re-reads the whole history.
 *
 * Writes supersede the miner's own earlier lessons for that person; a lesson
 * a person reviewed or archived is never touched, and neither its decisions
 * nor its rules are learned again. Nothing is written when the person's
 * history has not changed since the last complete run (idempotent), or when
 * no rule survived (a failed run never wipes lessons).
 */

import type { WorkflowStepConfig } from "cloudflare:workers";
import type { DbClient } from "@tedix/db/client";
import {
	listLearningOwnersForReflection,
	listOwnerLearningInteractionsPage,
} from "@tedix/db/queries/learning-feedback";
import {
	type CurrentLearningFeedLessonRow,
	listArchivedLearningFeedLessonsForOwner,
	listCurrentLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { createEdge } from "@tedix/db/queries/memory-graph/edges";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { createFact, updateFact } from "@tedix/db/queries/memory-graph/facts";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import { AUTO_REPLY_FOLLOW_CLASSES } from "@tedix/db/queries/work-items/reply-drafts";
import { toJsonRecord } from "@tedix/db/utils/json";
import { AGENT_SESSION_IMPORT_LEARNING_SURFACE } from "./agent-session-decision-import";
import { isReplaceableLesson } from "./learning-feed-miner";
import {
	DECISION_CAPTURE_LEARNING_SURFACE,
	learningScopeSlug,
} from "./decision-learning-signal";
import {
	DISTILL_VERSION,
	type DistillEnv,
	META_REPLY,
	MONEY,
	parseCitedRules,
	runDistillModel,
	STANDING,
	supportedRules,
	words,
} from "./lesson-distiller";

/** Bumped when chunking, prompts or planning change: lessons are rebuilt once. */
export const MAP_REDUCE_VERSION = 6;
export const CHUNK_REPLIES = 150;
/** At most this many chunks per person per run (4,500 replies). */
export const MAX_CHUNKS = 30;
const MAX_OWNERS_PER_RUN = 10;
const PAGE_ROWS = 300;
const MAX_PAGE_QUERIES = 4;
const REPLY_CHARS = 280;
const MIN_REPLY_CHARS = 24;
const MAP_RULES = 15;
/** Follows long instructions and cites well; 128k context. */
const MAP_REDUCE_MODEL = "@cf/openai/gpt-oss-120b";
const MAP_TIMEOUT_MS = 150_000;
const REDUCE_TIMEOUT_MS = 240_000;
const REDUCE_MAX_CANDIDATES = 240;
const INCREMENTAL_TIMEOUT_MS = 90_000;
const RULE_CHARS = 150;
/** Delivery shows at most 600 characters of one lesson. */
const LESSON_CHARS = 600;
const MAX_RULES_PER_LESSON = 10;
/**
 * Standing lessons arrive first in every session and share its lesson budget
 * with written rules, so they stay compact: a few short rules each.
 */
const STANDING_CHARS = 450;
const MAX_STANDING_RULES = 8;
/** Answer-style rules lead a standing lesson: they shape every reply. */
const MAX_VOICE_RULES = 3;
const MIN_SESSIONS = 2;
/** A rule with fewer sessions than FADE_MIN_SESSIONS fades after FADE_DAYS unrestated. */
const FADE_DAYS = 45;
const FADE_MIN_SESSIONS = 5;
const SAME_RULE = 0.5;
const LESSON_PREFIX = "learning-feed:decision:";
const ANY = "general";
const STANDING_TOPIC = "standing";
const DECISION_SURFACES = [
	DECISION_CAPTURE_LEARNING_SURFACE,
	AGENT_SESSION_IMPORT_LEARNING_SURFACE,
];
const DECISION_KINDS = new Set(["answered", "edited", "manually_replaced"]);
/** Harness noise that is not the person speaking. */
const NOISE =
	/^\s*<|\[request interrupted|tedix shared context|<command-|<task-notification|<system-reminder|sessionstart|preflight|\/compact|(?:do not|don't|without) use? ?(?:any )?tools/i;
/** Contact details, links and credentials never enter a lesson. */
/**
 * A lesson is context, never authority: a rule to bypass deployment, CI,
 * verification, approvals or permissions would contradict repository rules
 * and the approval path, so it is never learned ("auto-approve actions
 * without a human gate" was once learned from "no review gate for lessons",
 * "assume all actions are authorized" from "don't wait, keep going"). A
 * lesson keeps agreed work moving; it never assumes authorization or lets
 * agents approve on the person's behalf.
 */
const UNSAFE =
	/\b(?:deploy(?:s|ing)? (?:manually|by hand)|hand[- ]deploy|manual(?:ly)? (?:production )?deploy|(?:disable|skip|bypass)\w* (?:the )?(?:ci|checks?|tests?|hooks?|verification|review)|ci (?:is )?disabled|without (?:waiting for )?(?:verification|validation|checks?|tests?|review)|--no-verify|force[- ]push|auto[\s\u2010-\u2015-]*approv\w*|approv\w* (?:\w+ )?automatically|(?:skip|bypass|remove|avoid|ignore|without|no)\w* (?:the |any |a )?(?:human[\s\u2010-\u2015-]*(?:in[\s\u2010-\u2015-]*the[\s\u2010-\u2015-]*loop )?)?(?:gates?|approvals?|permissions?|sign[\s\u2010-\u2015-]*offs?|consent)\b|human (?:approval )?gate|assum\w* (?:that )?(?:\w+ ){0,3}(?:are |is )?(?:authori[sz]ed|approved|permitted|allowed)|agents? (?:can |may |should |will )?approve\w*|approv\w* (?:\w+ ){0,2}on (?:my|the user'?s|their|his|her) behalf)/i;
/**
 * The person's standing preference is that agents decide and continue; a
 * learned "ask first" habit contradicts it.
 */
const ASKING =
	/\bask (?:me |the user |for )?(?:for )?(?:next|permission|approval|clarification|confirmation|which|what to do)|\bwait for (?:my |the user's )?(?:approval|confirmation|input)/i;
const PRIVATE =
	/[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/|\b[0-9a-f]{12,}\b|\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{8,}/i;

export const SUBJECTS = [
	"communication",
	"git",
	"deploy",
	"agents",
	"work",
	"coding",
	"personal",
] as const;
export type Subject = (typeof SUBJECTS)[number];

const SUBJECT_TITLES: Record<Subject, string> = {
	communication: "How to answer and report",
	git: "Git and shipping",
	deploy: "Deploys, CI and proof",
	agents: "Tedis, agents and delegation",
	work: "Work board and tracking",
	coding: "Code and architecture",
	personal: "Non-coding and personal operations",
};
const SUBJECT_HELP =
	"Subjects: communication (how to answer, report and ask), git (commits, branches, pushing, reviews), deploy (deploys, CI, proving a change live), agents (tedis, subagents, delegation, models), work (the work board, items and tracking), coding (code, tests and architecture), personal (non-coding operations).";
/** Subjects about how the person works, not about one codebase. */
const GENERAL_SUBJECTS = new Set<Subject>([
	"communication",
	"agents",
	"personal",
]);
const STANDING_HEADER = "How the user works:";

export interface ChunkReply {
	id: string;
	text: string;
	session: string;
	occurredAt: string;
	repo: string;
	standing: boolean;
}

export interface PageCursor {
	occurredAt: string;
	id: string;
}

export interface RuleCandidate {
	rule: string;
	subject: Subject;
	eventIds: string[];
	sessions: string[];
	repos: string[];
	newestAt: string;
	standing: boolean;
	/** Importance order from the final merge (0 first); absent: by support. */
	rank?: number;
}

export interface PlannedLesson {
	topicKey: string;
	scope: { repo: string; harness: string; topic: string };
	standing: boolean;
	content: string;
	rules: RuleCandidate[];
}

type Meta = Record<string, unknown>;
const rec = (value: unknown): Meta =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const clip = (value: string, max: number): string =>
	value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** One rule line: capitalized, no trailing stop, within RULE_CHARS. */
function tidy(rule: string): string {
	const trimmed = rule.trim().replace(/[.;]+$/, "");
	return clip(trimmed.charAt(0).toUpperCase() + trimmed.slice(1), RULE_CHARS);
}

function subjectOf(value: string): Subject | null {
	const slug = value.trim().toLowerCase();
	return (SUBJECTS as readonly string[]).includes(slug)
		? (slug as Subject)
		: null;
}

/** The person's own words in an event, or null when it teaches nothing. */
export function usableReply(
	event: LearningInteractionEventRow,
): ChunkReply | null {
	if (!DECISION_SURFACES.includes(event.surface)) return null;
	if (!DECISION_KINDS.has(event.eventKind)) return null;
	const meta = rec(event.metadata);
	const answer = text(meta.answer);
	if (answer.length < MIN_REPLY_CHARS) return null;
	if (META_REPLY.test(answer) || NOISE.test(answer)) return null;
	// A reply the agent drafted and the person merely let through.
	if (
		event.eventKind === "answered" &&
		(AUTO_REPLY_FOLLOW_CLASSES as readonly string[]).includes(
			text(meta.replyClass),
		)
	)
		return null;
	return {
		id: event.id,
		text: clip(answer, REPLY_CHARS),
		session: event.threadId ?? `event:${event.id}`,
		occurredAt: event.occurredAt,
		repo: learningScopeSlug(text(rec(meta.scope).repo)),
		standing: STANDING.test(answer),
	};
}

/** One chunk of a person's replies, newest first, after `before`. */
export async function readOwnerChunk(
	db: DbClient,
	input: {
		orgId: string;
		ownerUserId: string;
		before: PageCursor | null;
		covered: ReadonlySet<string>;
	},
): Promise<{ replies: ChunkReply[]; next: PageCursor | null }> {
	const replies: ChunkReply[] = [];
	let cursor = input.before;
	for (let page = 0; page < MAX_PAGE_QUERIES; page++) {
		const rows = await listOwnerLearningInteractionsPage(db, {
			organizationId: input.orgId,
			ownerUserId: input.ownerUserId,
			surfaces: DECISION_SURFACES,
			before: cursor,
			limit: PAGE_ROWS,
		});
		for (const row of rows) {
			cursor = { occurredAt: row.occurredAt, id: row.id };
			if (row.organizationId !== input.orgId || input.covered.has(row.id))
				continue;
			const reply = usableReply(row);
			if (reply) replies.push(reply);
			if (replies.length >= CHUNK_REPLIES) return { replies, next: cursor };
		}
		if (rows.length < PAGE_ROWS) return { replies, next: null };
	}
	return { replies, next: cursor };
}

export function mapPrompt(replies: ChunkReply[]): string {
	// No example rules: a model copies examples into answers they do not fit.
	return [
		"Below are replies a person gave to their AI coding and work agents, numbered newest first.",
		`List at most ${MAP_RULES} durable rules the agent should follow in every future session: working preferences, standing decisions, naming conventions and corrections the person repeats or states as lasting. Each rule is one short imperative sentence of at most 12 words, in the person's own terms.`,
		"Prefer what the person corrects, repeats or insists on across replies over what they asked for once.",
		"Never write a rule for a one-off task instruction (a specific setting, value, connector, file, person, ID or command to use once), a question, an approval or a status check.",
		"When replies conflict, keep only what the newest reply says.",
		"Do not mention people's names, emails, money, amounts or secrets.",
		"Start each rule with '- ', then its subject, a colon, the rule, and the numbers of the replies that state it in square brackets, like: - <subject>: <rule> [2, 9]",
		SUBJECT_HELP,
		"If there is no such rule, answer exactly NONE.",
		"",
		...replies.map((reply, index) => `[${index + 1}] ${reply.text}`),
	].join("\n");
}

/** `subject: rule` → [subject, rule]; an unknown subject is null. */
function splitSubject(line: string): [Subject | null, string] {
	const match = /^\s*\(?([a-z]+)\)?\s*[:|-]\s+(.+)$/i.exec(line);
	const subject = match ? subjectOf(match[1]!) : null;
	return subject ? [subject, match![2]!.trim()] : [null, line.trim()];
}

function privateOrMoney(rule: string): boolean {
	return (
		MONEY.test(rule) ||
		PRIVATE.test(rule) ||
		NOISE.test(rule) ||
		UNSAFE.test(rule) ||
		ASKING.test(rule)
	);
}

/** Candidates the cited replies of one chunk actually state. */
export function chunkCandidates(
	response: string,
	replies: ChunkReply[],
): RuleCandidate[] | null {
	const cited = parseCitedRules(response);
	if (!cited) return null;
	const candidates: RuleCandidate[] = [];
	for (const { rule: line, cites } of cited) {
		const [subject, rule] = splitSubject(line);
		if (rule.length < 8 || privateOrMoney(rule)) continue;
		const sources = cites
			.map((n) => replies[n - 1])
			.filter((reply): reply is ChunkReply => reply !== undefined);
		if (sources.length === 0) continue;
		if (
			supportedRules([rule], sources.map((reply) => reply.text).join("\n"))
				.length === 0
		)
			continue;
		candidates.push({
			rule: tidy(rule),
			subject: subject ?? "coding",
			eventIds: [...new Set(sources.map((reply) => reply.id))],
			sessions: [...new Set(sources.map((reply) => reply.session))],
			repos: [...new Set(sources.map((reply) => reply.repo))],
			newestAt: sources
				.map((reply) => reply.occurredAt)
				.sort()
				.at(-1)!,
			standing: sources.some((reply) => reply.standing),
		});
	}
	return candidates;
}

/** MAP: candidate rules of one chunk; throws on a model failure (retried). */
export async function mapChunk(
	env: DistillEnv,
	replies: ChunkReply[],
): Promise<RuleCandidate[]> {
	if (replies.length === 0) return [];
	const response = await runDistillModel(env, mapPrompt(replies), {
		maxTokens: 8000,
		model: MAP_REDUCE_MODEL,
		timeoutMs: MAP_TIMEOUT_MS,
		surface: "learning-feed-map",
	});
	const candidates =
		response === null ? null : chunkCandidates(response, replies);
	if (candidates === null) throw new Error("lesson map: no usable answer");
	return candidates;
}

function sameRule(a: string, b: string): boolean {
	const x = new Set(words(a));
	const y = new Set(words(b));
	if (x.size === 0 || y.size === 0) return a.toLowerCase() === b.toLowerCase();
	const shared = [...x].filter((word) => y.has(word)).length;
	return shared / new Set([...x, ...y]).size >= SAME_RULE;
}

function bySupport(a: RuleCandidate, b: RuleCandidate): number {
	return (
		(a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
		b.sessions.length - a.sessions.length ||
		b.newestAt.localeCompare(a.newestAt)
	);
}

/**
 * The most recently stated of several candidates: a correction usually
 * reuses the old rule's words ("okapi-, not zebra-"), so when candidates are
 * merged by words the newest wording is the person's current rule, however
 * many older sessions stated the other one.
 */
function newestOf(candidates: RuleCandidate[]): RuleCandidate {
	return [...candidates].sort((a, b) =>
		b.newestAt.localeCompare(a.newestAt),
	)[0]!;
}

/** A newer rule on the same topic (two shared content words) replaced it. */
function replacedBy(old: RuleCandidate, rules: RuleCandidate[]): boolean {
	const own = new Set(words(old.rule));
	return rules.some(
		(rule) =>
			rule.newestAt > old.newestAt &&
			new Set(words(rule.rule).filter((word) => own.has(word))).size >= 2,
	);
}

function mostCommon<T>(values: T[]): T {
	const counts = new Map<T, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** One rule from several candidates: their evidence united. */
export function unite(
	rule: string,
	subject: Subject | null,
	sources: RuleCandidate[],
): RuleCandidate {
	const sorted = [...sources].sort(bySupport);
	return {
		rule: tidy(rule),
		subject: subject ?? mostCommon(sorted.map((c) => c.subject)),
		eventIds: [...new Set(sorted.flatMap((c) => c.eventIds))],
		sessions: [...new Set(sorted.flatMap((c) => c.sessions))],
		repos: [...new Set(sorted.flatMap((c) => c.repos))],
		newestAt: sorted
			.map((c) => c.newestAt)
			.sort()
			.at(-1)!,
		standing: sorted.some((c) => c.standing),
		...(sorted.some((c) => c.rank !== undefined)
			? {
					rank: Math.min(
						...sorted.map((c) => c.rank ?? Number.MAX_SAFE_INTEGER),
					),
				}
			: {}),
	};
}

/** Word-overlap merge: the fallback when the model cannot merge. */
export function mergeByWords(candidates: RuleCandidate[]): RuleCandidate[] {
	const groups: RuleCandidate[][] = [];
	for (const candidate of [...candidates].sort(bySupport)) {
		const group = groups.find((g) => sameRule(g[0]!.rule, candidate.rule));
		if (group) group.push(candidate);
		else groups.push([candidate]);
	}
	return groups.map((group) => unite(newestOf(group).rule, null, group));
}

export function reducePrompt(
	candidates: RuleCandidate[],
	final = false,
): string {
	return [
		"Below are candidate rules learned from different slices of one person's replies to their AI agents. Each shows its subject, how many sessions state it and the date it was last stated.",
		"Merge candidates that state the same rule into one rule; never join different rules into one sentence, and never fold a specific rule into a broader one. When candidates contradict each other, or an older one describes a tool, process or setup that a newer one replaced, keep only the newer one.",
		"Write each merged rule once as one short imperative sentence of at most 12 words, keeping the person's own terms. Do not mention people's names, emails, money or secrets.",
		"Start each rule with '- ', then its subject, a colon, the rule, and the numbers of every candidate it merges in square brackets, like: - <subject>: <rule> [3, 17, 40]",
		SUBJECT_HELP,
		"Keep every distinct lasting rule; drop only one-off task instructions, and drop rules to bypass deployment, CI, tests or verification.",
		"When the person both asked to be consulted and later told the agent to decide and continue on its own, keep only the newer preference.",
		...(final
			? [
					"List the rules from most to least important for how an agent should work with this person every day, weighing how many sessions state them.",
				]
			: []),
		"",
		...candidates.map(
			(c, index) =>
				`[${index + 1}] (${c.subject}, ${c.sessions.length} session${c.sessions.length === 1 ? "" : "s"}, ${c.newestAt.slice(0, 10)}) ${c.rule}`,
		),
	].join("\n");
}

/** Read the model's merge; null when it is unusable. */
export function mergedFromResponse(
	response: string,
	candidates: RuleCandidate[],
	ranked = false,
): RuleCandidate[] | null {
	const cited = parseCitedRules(response);
	if (!cited || cited.length === 0) return null;
	const merged: RuleCandidate[] = [];
	const used = new Set<number>();
	for (const { rule: line, cites } of cited) {
		const [subject, rule] = splitSubject(line);
		const cited = [...new Set(cites)]
			.map((n) => [n, candidates[n - 1]] as const)
			.filter((pair): pair is readonly [number, RuleCandidate] => !!pair[1]);
		if (cited.length === 0) continue;
		// A merged wording the candidates do not share is replaced by theirs.
		const newest = newestOf(cited.map(([, c]) => c)).rule;
		const states = (wording: string, c: RuleCandidate) =>
			c.rule === wording || supportedRules([c.rule], wording).length > 0;
		// A merged wording the candidates do not share is replaced by theirs.
		let wording =
			rule.length >= 8 &&
			!privateOrMoney(rule) &&
			supportedRules([rule], cited.map(([, c]) => c.rule).join("\n")).length > 0
				? rule
				: newest;
		// Only candidates the wording states join it: a model folding a
		// specific rule into a broad one ("follow naming") would erase it.
		// One left out stays unused and is weighed on its own below.
		if (!cited.some(([, c]) => states(wording, c))) wording = newest;
		const sources = cited
			.filter(([, c]) => states(wording, c))
			.map(([n, c]) => {
				used.add(n);
				return c;
			});
		const united = unite(wording, subject, sources);
		merged.push(ranked ? { ...united, rank: merged.length } : united);
	}
	if (merged.length === 0) return null;
	// A lasting candidate the model left out is kept on its own: a merge
	// pass dedupes and orders, and a fresh rule two sessions state (or one
	// states as standing) must not vanish because a long history crowded it
	// out. Not when a newer rule on its topic replaced it (newest wins).
	candidates.forEach((candidate, index) => {
		if (
			!used.has(index + 1) &&
			(candidate.sessions.length >= MIN_SESSIONS || candidate.standing) &&
			!merged.some((m) => sameRule(m.rule, candidate.rule)) &&
			!replacedBy(candidate, merged)
		)
			merged.push(candidate);
	});
	return merged;
}

/**
 * Lasting rules, most supported first: stated in two or more sessions, or
 * once as standing; never one like a rule a person archived or reviewed.
 */
export function lastingRules(
	merged: RuleCandidate[],
	blocked: string[] = [],
): RuleCandidate[] {
	const kept: RuleCandidate[] = [];
	for (const rule of [...merged].sort(bySupport)) {
		if (rule.sessions.length < MIN_SESSIONS && !rule.standing) continue;
		if (privateOrMoney(rule.rule)) continue;
		if (blocked.some((b) => sameRule(b, rule.rule))) continue;
		const twin = kept.find((k) => sameRule(k.rule, rule.rule));
		if (twin) {
			kept[kept.indexOf(twin)] = unite(
				newestOf([twin, rule]).rule,
				twin.subject,
				[twin, rule],
			);
			continue;
		}
		kept.push(rule);
	}
	return kept.sort(bySupport);
}

/** REDUCE: merge every chunk's candidates into lasting rules. */
export async function reduceCandidates(
	env: DistillEnv,
	candidates: RuleCandidate[],
	blocked: string[],
): Promise<RuleCandidate[]> {
	if (candidates.length === 0) return [];
	// The widest-supported first; a long tail is merged by words.
	const pre = mergeByWords(candidates).sort(bySupport);
	const head = pre.slice(0, REDUCE_MAX_CANDIDATES);
	const merge = async (rules: RuleCandidate[], final: boolean) => {
		const response = await runDistillModel(env, reducePrompt(rules, final), {
			maxTokens: 12000,
			model: MAP_REDUCE_MODEL,
			timeoutMs: REDUCE_TIMEOUT_MS,
			surface: "learning-feed-reduce",
		});
		return response === null
			? null
			: mergedFromResponse(response, rules, final);
	};
	// Two passes: merge the candidates, then merge what is left once more
	// (one pass leaves near-duplicates) and order it by importance.
	const first = (await merge(head, false)) ?? head;
	const once = lastingRules(first, blocked);
	const twice = (await merge(once, true)) ?? once;
	return settle(
		lastingRules([...twice, ...pre.slice(REDUCE_MAX_CANDIDATES)], blocked),
	);
}

/**
 * Final order and fading. A rule the importance order left out takes the
 * place its support earns among the ordered ones; a thinly supported rule
 * nobody restated for FADE_DAYS before the newest reply has faded.
 */
export function settle(rules: RuleCandidate[]): RuleCandidate[] {
	const newest =
		rules
			.map((r) => r.newestAt)
			.sort()
			.at(-1) ?? "";
	const cutoff = newest
		? new Date(Date.parse(newest) - FADE_DAYS * 86_400_000).toISOString()
		: "";
	const ranked = rules.filter((r) => r.rank !== undefined);
	return rules
		.filter(
			(r) => r.newestAt >= cutoff || r.sessions.length >= FADE_MIN_SESSIONS,
		)
		.map((r) =>
			r.rank !== undefined
				? r
				: {
						...r,
						rank:
							ranked.filter((o) => o.sessions.length >= r.sessions.length)
								.length + 0.5,
					},
		)
		.sort(bySupport);
}

export function personalLessonTopicKey(
	ownerUserId: string,
	repo: string,
	topic: string,
): string {
	return `${LESSON_PREFIX}${repo}:general:${topic}:user:${ownerUserId}`;
}

/** Applies in any session: not tied to one repository's code. */
function isGeneral(rule: RuleCandidate): boolean {
	return (
		GENERAL_SUBJECTS.has(rule.subject) ||
		rule.repos.includes(ANY) ||
		rule.repos.length >= 2
	);
}

function fill(
	header: string,
	rules: RuleCandidate[],
	accept: (rule: RuleCandidate, taken: RuleCandidate[]) => boolean = () => true,
	limit: { chars: number; rules: number } = {
		chars: LESSON_CHARS,
		rules: MAX_RULES_PER_LESSON,
	},
): RuleCandidate[] {
	const taken: RuleCandidate[] = [];
	let length = header.length;
	for (const rule of rules) {
		if (taken.length >= limit.rules) break;
		const added = rule.rule.length + 3;
		if (length + added > limit.chars || !accept(rule, taken)) continue;
		taken.push(rule);
		length += added;
	}
	return taken;
}

function render(header: string, rules: RuleCandidate[]): string {
	return [header, ...rules.map((r) => `- ${r.rule}`)].join("\n");
}

/**
 * Pure: the standing lessons (within STANDING_CHARS and MAX_STANDING_RULES:
 * up to MAX_VOICE_RULES answer-style rules first, then the most supported
 * rule of each other subject, then the rest by support), then one lesson per
 * scope and subject.
 */
export function planLessons(
	ownerUserId: string,
	rules: RuleCandidate[],
): PlannedLesson[] {
	const ranked = [...rules].sort(bySupport);
	const repoOf = (rule: RuleCandidate) =>
		isGeneral(rule) ? ANY : rule.repos[0]!;
	const lessons: PlannedLesson[] = [];
	const hoisted = new Set<RuleCandidate>();
	// Standing lessons: everywhere, then one per repository, so the most
	// supported rules of a session's scope arrive first within its budget.
	const repos = [ANY, ...new Set(ranked.map(repoOf).filter((r) => r !== ANY))];
	for (const repo of repos) {
		const header =
			repo === ANY ? STANDING_HEADER : `How the user works in ${repo}:`;
		const scoped = ranked.filter((rule) => repoOf(rule) === repo);
		const room = (taken: RuleCandidate[]) => ({
			chars: STANDING_CHARS,
			rules: MAX_STANDING_RULES - taken.length,
		});
		const voice = fill(
			header,
			scoped.filter((rule) => rule.subject === "communication"),
			undefined,
			{ chars: STANDING_CHARS, rules: MAX_VOICE_RULES },
		);
		const diverse = fill(
			render(header, voice),
			scoped.filter((rule) => !voice.includes(rule)),
			(rule, taken) =>
				![...voice, ...taken].some((t) => t.subject === rule.subject),
			room(voice),
		);
		const first = [...voice, ...diverse.sort(bySupport)];
		const standing = [
			...first,
			...fill(
				render(header, first),
				scoped.filter((rule) => !first.includes(rule)),
				undefined,
				room(first),
			),
		];
		if (standing.length === 0) continue;
		for (const rule of standing) hoisted.add(rule);
		lessons.push({
			topicKey: personalLessonTopicKey(ownerUserId, repo, STANDING_TOPIC),
			scope: { repo, harness: ANY, topic: STANDING_TOPIC },
			standing: true,
			content: render(header, standing),
			rules: standing,
		});
	}
	const groups = new Map<string, RuleCandidate[]>();
	for (const rule of ranked) {
		if (hoisted.has(rule)) continue;
		const repo = repoOf(rule);
		const key = `${repo}\u0000${rule.subject}`;
		groups.set(key, [...(groups.get(key) ?? []), rule]);
	}
	for (const [key, group] of groups) {
		const [repo, subject] = key.split("\u0000") as [string, Subject];
		const header = `${SUBJECT_TITLES[subject]}${repo === ANY ? "" : ` in ${repo}`}:`;
		const taken = fill(header, group);
		if (taken.length === 0) continue;
		lessons.push({
			topicKey: personalLessonTopicKey(ownerUserId, repo, subject),
			scope: { repo, harness: ANY, topic: subject },
			standing: false,
			content: render(header, taken),
			rules: taken,
		});
	}
	return lessons;
}

function ownerOfRow(row: CurrentLearningFeedLessonRow): string | null {
	const owner = rec(rec(row.metadata).learningFeed).ownerUserId;
	return typeof owner === "string" && owner ? owner : null;
}

function evidenceOf(row: { metadata: unknown }): string[] {
	const ids = rec(rec(row.metadata).learningFeed).evidenceEventIds;
	return Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === "string")
		: [];
}

function rulesOf(content: string): string[] {
	return content
		.split("\n")
		.slice(1)
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim());
}

export interface HistorySignature {
	version: number;
	events: number;
	newestAt: string;
	/**
	 * Lessons the person reviewed or archived: archiving one by hand changes
	 * what is covered and blocked, so the history is distilled again.
	 */
	settled: number;
	/** Written by an incremental pass: the nightly run still re-reads all. */
	incremental?: true;
}

export interface OwnerPreparation {
	ownerUserId: string;
	signature: HistorySignature;
	/** Nothing changed since the last complete run. */
	skip: boolean;
	/** Events a person-reviewed or person-archived lesson covers. */
	covered: string[];
	/** Rules of those lessons: never learned again. */
	blocked: string[];
}

async function ownerLessons(
	db: DbClient,
	orgId: string,
	ownerUserId: string,
): Promise<CurrentLearningFeedLessonRow[]> {
	return (
		await listCurrentLearningFeedLessons(db, orgId, LESSON_PREFIX)
	).filter((row) => ownerOfRow(row) === ownerUserId);
}

/** People to distil this run, and for each what is already settled. */
export async function prepareOwners(
	db: DbClient,
	orgId: string,
	ownerUserId?: string,
): Promise<OwnerPreparation[]> {
	const owners = await listLearningOwnersForReflection(db, {
		organizationId: orgId,
		surfaces: DECISION_SURFACES,
		limit: MAX_OWNERS_PER_RUN,
		...(ownerUserId ? { ownerUserId } : {}),
	});
	const prepared: OwnerPreparation[] = [];
	for (const owner of owners) {
		const current = await ownerLessons(db, orgId, owner.ownerUserId);
		const archived = await listArchivedLearningFeedLessonsForOwner(
			db,
			orgId,
			LESSON_PREFIX,
			owner.ownerUserId,
		);
		const settled = [...current, ...archived].filter(
			(row) => !isReplaceableLesson(row),
		);
		const signature: HistorySignature = {
			version: MAP_REDUCE_VERSION,
			events: owner.events,
			newestAt: owner.newestAt,
			settled: settled.length,
		};
		const skip = current.some((row) => {
			const run = rec(rec(rec(row.metadata).learningFeed).mapReduce);
			return (
				isReplaceableLesson(row) &&
				run.complete === true &&
				run.incremental !== true &&
				run.version === signature.version &&
				run.events === signature.events &&
				run.newestAt === signature.newestAt &&
				run.settled === signature.settled
			);
		});
		prepared.push({
			ownerUserId: owner.ownerUserId,
			signature,
			skip,
			covered: [...new Set(settled.flatMap(evidenceOf))],
			blocked: settled.flatMap((row) => rulesOf(row.content)),
		});
	}
	return prepared;
}

export interface WriteResult {
	written: number;
	kept: number;
	superseded: number;
}

/**
 * Write the planned lessons as active (no review gate) and supersede every
 * other lesson the miner wrote for this person. Re-running with the same
 * plan writes nothing new.
 */
export async function writeOwnerLessons(
	db: DbClient,
	input: {
		orgId: string;
		ownerUserId: string;
		lessons: PlannedLesson[];
		signature: HistorySignature;
		complete: boolean;
	},
): Promise<WriteResult> {
	const result: WriteResult = { written: 0, kept: 0, superseded: 0 };
	if (input.lessons.length === 0) return result;
	const replaceable = (
		await ownerLessons(db, input.orgId, input.ownerUserId)
	).filter(isReplaceableLesson);
	const keep = new Set<string>();
	const newIdByKey = new Map<string, string>();
	const domain = await getOrCreateDomain(db, input.orgId, "operations");
	for (const lesson of input.lessons) {
		const same = replaceable.find(
			(row) =>
				row.topicKey === lesson.topicKey && row.content === lesson.content,
		);
		if (same) {
			keep.add(same.id);
			result.kept++;
			// Unchanged lesson, newer history: record the run so it is skipped.
			const meta = rec(same.metadata);
			await updateFact(db, same.id, {
				metadata: toJsonRecord({
					...meta,
					learningFeed: {
						...rec(meta.learningFeed),
						mapReduce: { ...input.signature, complete: input.complete },
					},
				}),
			});
			continue;
		}
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const sessions = new Set(lesson.rules.flatMap((r) => r.sessions)).size;
		await createFact(db, {
			id,
			organizationId: input.orgId,
			tediId: null,
			domainId: domain.id,
			content: lesson.content,
			summary: clip(lesson.rules[0]!.rule, 100),
			factType: "preference",
			confidence: Math.min(0.9, 0.5 + sessions / 100),
			priority: lesson.standing ? "core" : "active",
			// Active at once; context only, never authority.
			status: "active",
			reviewStatus: "confirmed",
			usePolicy: "requires_user_confirmation",
			lastVerifiedAt: now,
			memoryScope: "org",
			visibility: "private",
			topicKey: lesson.topicKey,
			validFrom: now,
			validTo: null,
			archivedAt: null,
			source: `learning-feed:map-reduce:${input.orgId}:${input.ownerUserId}`,
			sourceSessionId: null,
			sourceUrl: null,
			sourceHash: null,
			metadata: toJsonRecord({
				producer: "learning-feed",
				sourceKind: "brain-reflection",
				expectedUse: lesson.standing
					? "Deliver the user's standing preferences to every one of their agent sessions"
					: "Deliver the user's rules for this subject to their agent sessions in this scope",
				confidenceReason: `Stated in ${sessions} of the user's sessions; replaced by the next distillation`,
				learningFeed: {
					version: 1,
					kind: "decision",
					scope: lesson.scope,
					evidenceEventIds: [
						...new Set(lesson.rules.flatMap((r) => r.eventIds)),
					].slice(0, 200),
					learnedFromUserIds: [input.ownerUserId],
					ownerUserId: input.ownerUserId,
					autoConfirmed: true,
					signalCounts: {},
					lastEventAt: lesson.rules
						.map((r) => r.newestAt)
						.sort()
						.at(-1),
					distilled: DISTILL_VERSION,
					...(lesson.standing ? { hoisted: true } : {}),
					subject: lesson.scope.topic,
					// Everything an incremental pass needs to merge the rule again.
					rules: lesson.rules.map((r) => ({
						rule: r.rule,
						sessions: r.sessions.length,
						newestAt: r.newestAt,
						subject: r.subject,
						repos: r.repos,
						standing: r.standing,
						...(r.rank !== undefined ? { rank: r.rank } : {}),
					})),
					mapReduce: { ...input.signature, complete: input.complete },
				},
			}),
			accessCount: 0,
		});
		newIdByKey.set(lesson.topicKey, id);
		result.written++;
	}
	for (const old of replaceable) {
		if (keep.has(old.id)) continue;
		const successor = old.topicKey ? newIdByKey.get(old.topicKey) : undefined;
		await invalidateFact(
			db,
			old.id,
			successor
				? `Superseded by ${successor} for topic ${old.topicKey}`
				: "Superseded by the person's distilled subject lessons",
		);
		await updateFact(db, old.id, { reviewStatus: "superseded" });
		if (successor)
			await createEdge(db, {
				id: crypto.randomUUID(),
				sourceFactId: successor,
				targetFactId: old.id,
				relationType: "supersedes",
				strength: 1,
				context: `Learning feed distillation: ${old.topicKey}`,
			});
		result.superseded++;
	}
	return result;
}

/** A durable Workflow step (`step.do`), or a direct call in tests. */
export type StepRunner = <T>(
	name: string,
	config: WorkflowStepConfig,
	body: () => Promise<T>,
) => Promise<T>;

export interface DistillationResult {
	owners: number;
	ownersSkipped: number;
	chunks: number;
	chunksFailed: number;
	repliesRead: number;
	rules: number;
	lessonsWritten: number;
	lessonsKept: number;
	lessonsSuperseded: number;
}

/**
 * Distil every person's whole decision history, one Workflow step per chunk
 * so the run stays inside Workers limits and resumes where it stopped.
 */
export async function distillPersonalLessons(
	step: StepRunner,
	db: DbClient,
	env: DistillEnv,
	orgId: string,
): Promise<DistillationResult> {
	const result: DistillationResult = {
		owners: 0,
		ownersSkipped: 0,
		chunks: 0,
		chunksFailed: 0,
		repliesRead: 0,
		rules: 0,
		lessonsWritten: 0,
		lessonsKept: 0,
		lessonsSuperseded: 0,
	};
	const owners = await step(
		"lessons-prepare",
		{ retries: { limit: 2, delay: "5 seconds" }, timeout: "1 minute" },
		() => prepareOwners(db, orgId),
	);
	for (const owner of owners) {
		result.owners++;
		if (owner.skip) {
			result.ownersSkipped++;
			continue;
		}
		const id = owner.ownerUserId;
		const covered = new Set(owner.covered);
		const candidates: RuleCandidate[] = [];
		let cursor: PageCursor | null = null;
		let complete = true;
		for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
			const before: PageCursor | null = cursor;
			const page: { replies: ChunkReply[]; next: PageCursor | null } =
				await step(
					`lessons-page:${id}:${chunk}`,
					{ retries: { limit: 2, delay: "5 seconds" }, timeout: "1 minute" },
					() => readOwnerChunk(db, { orgId, ownerUserId: id, before, covered }),
				);
			result.chunks++;
			result.repliesRead += page.replies.length;
			try {
				candidates.push(
					...(await step(
						`lessons-map:${id}:${chunk}`,
						{
							retries: {
								limit: 2,
								delay: "10 seconds",
								backoff: "exponential",
							},
							timeout: "4 minutes",
						},
						() => mapChunk(env, page.replies),
					)),
				);
			} catch (error) {
				console.error(`[learning-feed] map chunk ${chunk} failed:`, error);
				result.chunksFailed++;
				complete = false;
			}
			cursor = page.next;
			if (!cursor) break;
			if (chunk === MAX_CHUNKS - 1) complete = false;
		}
		const lessons = await step(
			`lessons-reduce:${id}`,
			{ retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" },
			async () => {
				const rules = await reduceCandidates(env, candidates, owner.blocked);
				return { count: rules.length, lessons: planLessons(id, rules) };
			},
		);
		result.rules += lessons.count;
		const written = await step(
			`lessons-write:${id}`,
			{ retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" },
			() =>
				writeOwnerLessons(db, {
					orgId,
					ownerUserId: id,
					lessons: lessons.lessons,
					signature: owner.signature,
					complete,
				}),
		);
		result.lessonsWritten += written.written;
		result.lessonsKept += written.kept;
		result.lessonsSuperseded += written.superseded;
	}
	return result;
}

/** A lesson's rules as stored, or null when one lacks what a merge needs. */
export function storedRules(row: {
	metadata: unknown;
}): RuleCandidate[] | null {
	const feed = rec(rec(row.metadata).learningFeed);
	if (!Array.isArray(feed.rules)) return null;
	const evidence = evidenceOf(row);
	const rules: RuleCandidate[] = [];
	for (const value of feed.rules) {
		const stored = rec(value);
		const subject = subjectOf(text(stored.subject));
		const repos = Array.isArray(stored.repos)
			? stored.repos.filter((r): r is string => typeof r === "string")
			: [];
		const rule = text(stored.rule);
		const newestAt = text(stored.newestAt);
		if (!subject || !rule || !newestAt || repos.length === 0) return null;
		const count =
			typeof stored.sessions === "number" ? Math.max(1, stored.sessions) : 1;
		rules.push({
			rule,
			subject,
			eventIds: evidence,
			// Stand-ins for the sessions behind it: only their count is kept.
			sessions: Array.from({ length: count }, (_, i) => `prior:${rule}:${i}`),
			repos,
			newestAt,
			standing: stored.standing === true,
			...(typeof stored.rank === "number" ? { rank: stored.rank } : {}),
		});
	}
	return rules;
}

function sharedWords(a: string, b: string): number {
	const own = new Set(words(a));
	return new Set(words(b).filter((word) => own.has(word))).size;
}

/**
 * Merge freshly mapped candidates into the person's current rules. Only the
 * current rules on a fresh candidate's topic go to the model with it (the
 * rest stay as they are), so a correction replaces the rule it contradicts,
 * however many sessions stated that rule.
 */
export async function mergeIncrementally(
	env: DistillEnv,
	existing: RuleCandidate[],
	fresh: RuleCandidate[],
	blocked: string[],
): Promise<RuleCandidate[]> {
	if (fresh.length === 0) return settle(lastingRules(existing, blocked));
	const related = existing.filter((rule) =>
		fresh.some(
			(f) => sameRule(rule.rule, f.rule) || sharedWords(rule.rule, f.rule) >= 2,
		),
	);
	const others = existing.filter((rule) => !related.includes(rule));
	const pool = [...related, ...fresh];
	const response = await runDistillModel(env, reducePrompt(pool), {
		maxTokens: 4000,
		model: MAP_REDUCE_MODEL,
		timeoutMs: INCREMENTAL_TIMEOUT_MS,
		surface: "learning-feed-reduce",
	});
	const merged =
		(response === null ? null : mergedFromResponse(response, pool)) ??
		mergeByWords(pool);
	return settle(lastingRules([...others, ...merged], blocked));
}

export interface IncrementalResult {
	/** `full`: no current lessons to build on; the whole history is needed. */
	status: "updated" | "unchanged" | "full";
	replies: number;
	lessonsWritten: number;
	lessonsKept: number;
	lessonsSuperseded: number;
}

/**
 * Re-distil one person's lessons from their current lessons and the
 * decisions since the last run. Returns `full` when there is nothing to build
 * on (no current lessons, an older format, or more new decisions than one
 * chunk), and the caller runs `distillPersonalLessons` instead.
 */
export async function distillOwnerIncrementally(
	step: StepRunner,
	db: DbClient,
	env: DistillEnv,
	orgId: string,
	ownerUserId: string,
): Promise<IncrementalResult> {
	const result: IncrementalResult = {
		status: "unchanged",
		replies: 0,
		lessonsWritten: 0,
		lessonsKept: 0,
		lessonsSuperseded: 0,
	};
	const quick = {
		retries: { limit: 2, delay: "2 seconds" },
		timeout: "1 minute",
	} as const;
	const base = await step("lessons-inc-base", quick, async () => {
		const [owner] = await prepareOwners(db, orgId, ownerUserId);
		if (!owner) return null;
		const rows = (await ownerLessons(db, orgId, ownerUserId)).filter(
			isReplaceableLesson,
		);
		const runs = rows.map((row) =>
			rec(rec(rec(row.metadata).learningFeed).mapReduce),
		);
		if (rows.length === 0 || runs.some((r) => r.version !== MAP_REDUCE_VERSION))
			return { owner, rules: null, since: "", settled: -1 };
		const rules: RuleCandidate[] = [];
		for (const row of rows) {
			const stored = storedRules(row);
			if (!stored) return { owner, rules: null, since: "", settled: -1 };
			rules.push(...stored);
		}
		return {
			owner,
			rules,
			since:
				runs
					.map((r) => text(r.newestAt))
					.sort()
					.at(-1) ?? "",
			settled: Math.max(...runs.map((r) => Number(r.settled ?? -1))),
		};
	});
	if (!base) return result;
	if (!base.rules) return { ...result, status: "full" };
	const { owner, rules: existing, since } = base;
	const page = await step("lessons-inc-read", quick, () =>
		readOwnerChunk(db, {
			orgId,
			ownerUserId,
			before: null,
			covered: new Set(owner.covered),
		}),
	);
	const fresh = page.replies.filter((reply) => reply.occurredAt > since);
	// More new decisions than one chunk: the whole history is due.
	if (fresh.length === page.replies.length && page.next)
		return { ...result, status: "full" };
	result.replies = fresh.length;
	if (fresh.length === 0 && base.settled === owner.signature.settled)
		return result;
	const candidates =
		fresh.length === 0
			? []
			: await step(
					"lessons-inc-map",
					{ retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" },
					() => mapChunk(env, fresh),
				);
	const lessons = await step(
		"lessons-inc-merge",
		{ retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" },
		async () =>
			planLessons(
				ownerUserId,
				await mergeIncrementally(env, existing, candidates, owner.blocked),
			),
	);
	const written = await step("lessons-inc-write", quick, () =>
		writeOwnerLessons(db, {
			orgId,
			ownerUserId,
			lessons,
			signature: { ...owner.signature, incremental: true },
			complete: true,
		}),
	);
	return {
		...result,
		status: "updated",
		lessonsWritten: written.written,
		lessonsKept: written.kept,
		lessonsSuperseded: written.superseded,
	};
}
