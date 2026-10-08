/**
 * Keyed lesson rules.
 *
 * Every rule a distilled lesson stores (`metadata.learningFeed.rules`) has a
 * stable subject key: a facet of the small vocabulary below (`git.push`,
 * `comms.length`), with a leaf when that facet is taken (`git.push.sync-main`).
 * One key holds one active rule per person. When a newer rule takes a key
 * (it restates or revises the old one), the old rule is kept as revoked
 * history (`metadata.learningFeed.revokedRules`) with its reason.
 *
 * Delivery uses the same vocabulary on the session's repo and branch words
 * to pick the rules relevant to it, and renders them grouped by subject.
 */

import { words } from "./lesson-distiller";
import type { RuleCandidate, Subject } from "./lesson-map-reduce";

const SAME_RULE = 0.5;
/** Revoked rules kept as history per person. */
const REVOKED_HISTORY = 40;

const PREFIX: Record<Subject, string> = {
	communication: "comms",
	git: "git",
	deploy: "deploy",
	agents: "agents",
	work: "work",
	coding: "coding",
	personal: "personal",
};

/** Facets in priority order; a rule's first match within its subject wins. */
const FACETS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		"comms.length",
		/\b(?:short\w*|concise|brief\w*|too long|verbose|lead with)\b/i,
	],
	[
		"comms.plain-language",
		/\b(?:plain[- ](?:english|language)|jargon|user stor\w*)\b/i,
	],
	[
		"comms.autonomy",
		/\b(?:ask\w*|confirm\w*|autonom\w*|proceed\w*|decide\w*|wait\w*)\b/i,
	],
	["git.pull-requests", /\b(?:pull requests?|prs?)\b/i],
	["git.push", /\b(?:push\w*|rebas\w*|sync\w*|fast-?forward)\b/i],
	["git.branches", /\b(?:branch\w*|worktrees?)\b/i],
	["git.commits", /\bcommit\w*\b/i],
	["deploy.verification", /\b(?:verif\w*|validat\w*|live|proof|evaluat\w*)\b/i],
	["deploy.ci", /\b(?:ci|pipelines?|checks?|lint\w*)\b/i],
	["deploy.release", /\b(?:deploy\w*|releas\w*|ship\w*|prod\w*)\b/i],
	["agents.naming", /\btedis?\b/i],
	[
		"agents.delegation",
		/\b(?:sub-?agents?|delegat\w*|fan[- ]?out|parallel\w*)\b/i,
	],
	["agents.models", /\b(?:models?|llm)\b/i],
	["work.board", /\b(?:work items?|board|backlog|sprints?|claim\w*)\b/i],
	["work.docs", /\b(?:notion|docs?|pages?)\b/i],
	[
		"coding.simplicity",
		/\b(?:simpl\w*|over-?engineer\w*|legacy|lean|refactor\w*)\b/i,
	],
	["coding.tests", /\btests?\b/i],
	["coding.naming", /\b(?:nam(?:e|es|ing)|renam\w*|prefix\w*)\b/i],
	["coding.cleanup", /\b(?:clean\w*|stale|remov\w*|unused)\b/i],
	["personal.email", /\b(?:emails?|inbox)\b/i],
	["personal.calendar", /\b(?:calendar|meetings?)\b/i],
];
const KEY = /^[a-z]+(?:\.[a-z0-9][a-z0-9-]{0,39}){1,2}$/;

/** The vocabulary facets a text names (repo and branch words, a rule). */
export function facetsIn(value: string): string[] {
	return FACETS.filter(([, pattern]) => pattern.test(value)).map(([f]) => f);
}

export function facetOf(key: string): string {
	return key.split(".").slice(0, 2).join(".");
}

export function sameRule(a: string, b: string): boolean {
	const x = new Set(words(a));
	const y = new Set(words(b));
	if (x.size === 0 || y.size === 0) return a.toLowerCase() === b.toLowerCase();
	const shared = [...x].filter((word) => y.has(word)).length;
	return shared / new Set([...x, ...y]).size >= SAME_RULE;
}

export function sharedWords(a: string, b: string): number {
	const own = new Set(words(a));
	return new Set(words(b).filter((word) => own.has(word))).size;
}

/** A key for a rule: its subject's first facet, plus a leaf when taken. */
export function deriveRuleKey(
	rule: string,
	subject: Subject,
	taken: ReadonlySet<string>,
): string {
	const prefix = PREFIX[subject] ?? "coding";
	const facet =
		facetsIn(rule).find((f) => f.startsWith(`${prefix}.`)) ??
		`${prefix}.general`;
	if (!taken.has(facet)) return facet;
	const own = new Set(facet.split(/[.-]/));
	const leaf =
		words(rule)
			.filter((word) => !own.has(word))
			.slice(0, 2)
			.join("-")
			.slice(0, 36) || "rule";
	let key = `${facet}.${leaf}`;
	for (let n = 2; taken.has(key); n++) key = `${facet}.${leaf}-${n}`;
	return key;
}

/** A rule a newer one replaced, kept as history. */
export interface RevokedRule {
	key: string;
	rule: string;
	subject: Subject;
	createdAt: string;
	newestAt: string;
	revokedAt: string;
	reason: string;
	replacedBy: string | null;
}

/**
 * Keys for `rules` (order kept). A rule keeps a valid key it has; one that
 * restates a previous rule takes its key; one that revises a previous rule
 * (same subject, two shared content words, newer) takes its key and revokes
 * it; the rest get a derived key. Previous rules no new rule took are
 * revoked too, so a rule never disappears without a trace.
 */
export function assignRuleKeys(
	rules: RuleCandidate[],
	previous: RuleCandidate[] = [],
): { rules: RuleCandidate[]; revoked: RevokedRule[] } {
	const taken = new Set<string>();
	const out = rules.map((rule) =>
		rule.key && KEY.test(rule.key) && !taken.has(rule.key)
			? (taken.add(rule.key), rule)
			: undefined,
	);
	const open = () => previous.filter((p) => p.key && !taken.has(p.key));
	const revoked: RevokedRule[] = [];
	const revoke = (old: RuleCandidate, at: string, by: string | null) =>
		revoked.push({
			key: old.key!,
			rule: old.rule,
			subject: old.subject,
			createdAt: old.createdAt ?? old.newestAt,
			newestAt: old.newestAt,
			revokedAt: at,
			reason: by
				? `Replaced by a newer rule stated ${at.slice(0, 10)}`
				: "No longer among the person's lasting rules",
			replacedBy: by,
		});
	// A rule that kept its key in new words (a merge) replaced the old wording.
	for (const rule of out) {
		const old = rule && previous.find((p) => p.key === rule.key);
		if (old && old.rule !== rule.rule && !sameRule(old.rule, rule.rule))
			revoke(old, rule!.newestAt, rule!.rule);
	}
	rules.forEach((rule, index) => {
		if (out[index]) return;
		const same = open().find(
			(p) => p.rule === rule.rule || sameRule(p.rule, rule.rule),
		);
		const revised =
			same ??
			open().find(
				(p) =>
					p.subject === rule.subject &&
					p.newestAt <= rule.newestAt &&
					sharedWords(p.rule, rule.rule) >= 2,
			);
		if (revised && !same) revoke(revised, rule.newestAt, rule.rule);
		const key = revised?.key ?? deriveRuleKey(rule.rule, rule.subject, taken);
		taken.add(key);
		out[index] = {
			...rule,
			key,
			createdAt: same
				? (same.createdAt ?? same.newestAt)
				: (rule.createdAt ?? rule.newestAt),
		};
	});
	const newest =
		rules
			.map((r) => r.newestAt)
			.sort()
			.at(-1) ?? new Date().toISOString();
	for (const old of open()) revoke(old, newest, null);
	return { rules: out as RuleCandidate[], revoked };
}

/** Newest first, at most REVOKED_HISTORY, each revocation once. */
export function mergeRevoked(...lists: RevokedRule[][]): RevokedRule[] {
	const seen = new Set<string>();
	return lists
		.flat()
		.sort((a, b) => b.revokedAt.localeCompare(a.revokedAt))
		.filter((entry) => {
			const id = `${entry.key}\u0000${entry.rule}`;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		})
		.slice(0, REVOKED_HISTORY);
}

type Meta = Record<string, unknown>;
const rec = (value: unknown): Meta =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export function revokedRulesOf(metadata: unknown): RevokedRule[] {
	const list = rec(rec(metadata).learningFeed).revokedRules;
	return Array.isArray(list)
		? (list.filter(
				(entry) => KEY.test(text(rec(entry).key)) && text(rec(entry).rule),
			) as RevokedRule[])
		: [];
}

/** A stored rule as delivery reads it. */
export interface DeliverableRule {
	key: string;
	rule: string;
	subject: string;
}

/** A lesson's stored rules, keyed (derived for rules stored before keys). */
export function deliverableRules(metadata: unknown): DeliverableRule[] | null {
	const rules = rec(rec(metadata).learningFeed).rules;
	if (!Array.isArray(rules) || rules.length === 0) return null;
	const taken = new Set<string>();
	const out: DeliverableRule[] = [];
	for (const value of rules) {
		const rule = text(rec(value).rule);
		const subject = text(rec(value).subject) as Subject;
		if (!rule || !subject) return null;
		const stored = text(rec(value).key);
		const key =
			KEY.test(stored) && !taken.has(stored)
				? stored
				: deriveRuleKey(rule, subject, taken);
		taken.add(key);
		out.push({ key, rule, subject });
	}
	return out;
}

const LABELS: Record<string, string> = {
	communication: "Answers",
	git: "Git",
	deploy: "Deploys",
	agents: "Agents",
	work: "Work",
	coding: "Code",
	personal: "Personal",
};

/** Rules as a short bullet list under the header, grouped by subject. */
export function renderRules(header: string, rules: DeliverableRule[]): string {
	const groups = new Map<string, string[]>();
	for (const rule of rules)
		groups.set(rule.subject, [...(groups.get(rule.subject) ?? []), rule.rule]);
	if (groups.size <= 1)
		return [header, ...rules.map((rule) => `- ${rule.rule}`)].join("\n");
	return [
		header,
		...[...groups].map(
			([subject, list]) =>
				`- ${LABELS[subject] ?? subject}: ${list.join("; ")}`,
		),
	].join("\n");
}
