import { and, desc, eq, like, ne, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import { type SkillEntry, skillEntries } from "../../schema/cognitive";
import { applySupersedes, readableSkillCondition } from "./skill-crud";

const MAX_SKILL_SEARCH_TERMS = 8;
const SHORT_SKILL_SEARCH_TERMS = new Set([
	"ai",
	"api",
	"cms",
	"crm",
	"d1",
	"r2",
	"seo",
	"ui",
	"ux",
]);
const SKILL_SEARCH_STOP_WORDS = new Set([
	"a",
	"about",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"by",
	"can",
	"for",
	"from",
	"has",
	"have",
	"help",
	"in",
	"into",
	"is",
	"it",
	"of",
	"on",
	"or",
	"own",
	"that",
	"the",
	"their",
	"this",
	"to",
	"use",
	"via",
	"when",
	"with",
	"you",
	"your",
]);

export function normalizeSkillSearchTerms(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const rawTerm of query
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(/\s+/)) {
		const term = rawTerm.trim();
		if (!term || SKILL_SEARCH_STOP_WORDS.has(term) || seen.has(term)) {
			continue;
		}
		if (term.length < 3 && !SHORT_SKILL_SEARCH_TERMS.has(term)) {
			continue;
		}
		seen.add(term);
		terms.push(term);
		if (terms.length >= MAX_SKILL_SEARCH_TERMS) {
			break;
		}
	}
	return terms;
}

export async function findSkillForTask(
	db: DbClient,
	orgId: string,
	query: string,
	options?: { tediId?: string; appId?: string; limit?: number },
): Promise<SkillEntry[]> {
	const words = normalizeSkillSearchTerms(query);
	if (words.length === 0) {
		return [];
	}
	const wordConditions = words.map((word) => {
		const term = `%${word}%`;
		return or(
			like(skillEntries.title, term),
			like(skillEntries.description, term),
			like(skillEntries.content, term),
		)!;
	});
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		...(wordConditions.length > 0 ? wordConditions : []),
	];
	// Scope to app if provided
	if (options?.appId) {
		conditions.push(eq(skillEntries.appId, options.appId));
	}
	conditions.push(readableSkillCondition(options?.tediId));
	const results = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(
			desc(skillEntries.tediId),
			desc(skillEntries.successCount),
			desc(skillEntries.createdAt),
		)
		.limit(options?.limit ?? 10);
	return applySupersedes(results);
}

/** Bounded projection used by the create-vs-modify adjacency gate. */
export interface SkillAdjacencyRow {
	id: string;
	slug: string | null;
	title: string;
	description: string | null;
	/** Lineage parent, when this row is itself a derivative (proposal). */
	sourceSkillId: string | null;
}

/** Hard ceiling on rows scored per create — keeps one D1 read bounded. */
const MAX_ADJACENCY_CANDIDATES = 500;

/**
 * List non-archived skill titles for duplicate detection.
 *
 * Deliberately NOT `findSkillForTask`: that is a CONJUNCTIVE keyword filter
 * (every normalized term must appear in title/description/content), which makes
 * it useless as a similarity source — adding one unmatched word to the query
 * drops every candidate. A gate built on it silently never fires, which is
 * exactly what happened on the first live probe: recording a skill
 * whose title exactly matched an existing one returned zero candidates and the
 * duplicate was created.
 *
 * Selects the four columns the scorer needs so a create pays one bounded read
 * rather than hydrating full skill bodies.
 */
export async function listSkillsForAdjacency(
	db: DbClient,
	orgId: string,
	options?: { tediId?: string; limit?: number },
): Promise<SkillAdjacencyRow[]> {
	const rows = await db
		.select({
			id: skillEntries.id,
			slug: skillEntries.slug,
			title: skillEntries.title,
			description: skillEntries.description,
			sourceSkillId: skillEntries.sourceSkillId,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, orgId),
				// Adjacency uses a WIDER lens than `readableSkillCondition`, which
				// only returns org-level rows (`tediId IS NULL`). Most skills are
				// tedi-OWNED but org-VISIBLE, so that condition hid the very rows a
				// duplicate check needs, letting a twin of a tedi-owned skill through.
				// Duplicates matter org-wide; only ANOTHER tedi's private skills stay
				// invisible, so a refusal can never leak a title the author may not
				// see.
				options?.tediId
					? or(
							ne(skillEntries.visibility, "private"),
							eq(skillEntries.tediId, options.tediId),
						)!
					: ne(skillEntries.visibility, "private"),
			),
		)
		.orderBy(desc(skillEntries.createdAt))
		.limit(
			Math.min(
				options?.limit ?? MAX_ADJACENCY_CANDIDATES,
				MAX_ADJACENCY_CANDIDATES,
			),
		);
	return rows;
}
